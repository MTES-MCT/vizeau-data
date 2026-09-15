#!/usr/bin/env node
/**
 * Génère un `captages.parquet` candidat à partir du référentiel CSV
 * (ref_captages_25avril2025) plutôt que de la source privée ARS actuelle.
 *
 * ⚠️ Script de transition, PAS branché sur le pipeline `generate_aac_infos.js`.
 * Il écrit `data/captages_new.parquet` (fichier séparé) pour permettre une
 * comparaison avant bascule — cf. `csv-to-parquet-schema-mapping.md`.
 *
 * Ne mappe QUE les colonnes de `captages.parquet` réellement lues par
 * `generate_aac_infos.js` (voir mapping ci-dessus pour le détail
 * colonne par colonne et les approximations/limites connues) :
 *
 *   t1_code_ins, t1_ins_nom, t1_com_nom, t1_com_insee, t1_ins_etat_lib,
 *   t1_uge_mo_nom, t1_dep_geo_lib, t1_cap_type_lib, t1_ins_nat_code,
 *   t1_ins_usage_lib, t1_ins_etat, t1_ins_cap_ref, t1_ins_cap_ref_lib,
 *   t1_ins_code_bss, t2_code_ppe, t2_code_ppr, t2_code_ppi,
 *   t1_psv_x, t1_psv_y
 *
 * Sources :
 *   - ref_captages_25avril2025/ref_cap_avr25-Tableau 1.csv   (référentiel captages)
 *   - ref_captages_25avril2025/ref_mca_avr25-Tableau 1.csv   (mélanges de captages, pour t1_ins_cap_ref)
 *   - ppe_hilbert.parquet / ppr_hilbert.parquet / ppi_hilbert.parquet
 *     (zonage des périmètres de protection, pour t2_code_ppe/ppr/ppi par
 *     intersection spatiale avec le point du captage)
 *
 * Usage : node generate_captages_parquet.js
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const path = (name) => join(__dirname, name)

const REF_CAP_CSV = path("data/ref_captages_25avril2025/ref_cap_avr25-Tableau 1.csv")
const REF_MCA_CSV = path("data/ref_captages_25avril2025/ref_mca_avr25-Tableau 1.csv")
const OUTPUT = path('data/captages_new.parquet')

// ─── Référentiel des départements (code → nom) ───────────────────────────────
// Absent du CSV source (qui ne donne que le code `dept_gestionnaire`), requis
// pour reconstruire `t1_dep_geo_lib`.
const DEPARTEMENTS = [
  ['001', 'AIN'], ['002', 'AISNE'], ['003', 'ALLIER'],
  ['004', 'ALPES-DE-HAUTE-PROVENCE'], ['005', 'HAUTES-ALPES'],
  ['006', 'ALPES-MARITIMES'], ['007', 'ARDECHE'], ['008', 'ARDENNES'],
  ['009', 'ARIEGE'], ['010', 'AUBE'], ['011', 'AUDE'], ['012', 'AVEYRON'],
  ['013', 'BOUCHES-DU-RHONE'], ['014', 'CALVADOS'], ['015', 'CANTAL'],
  ['016', 'CHARENTE'], ['017', 'CHARENTE-MARITIME'], ['018', 'CHER'],
  ['019', 'CORREZE'], ['02A', 'CORSE-DU-SUD'], ['02B', 'HAUTE-CORSE'],
  ['021', "COTE-D'OR"], ['022', "COTES-D'ARMOR"], ['023', 'CREUSE'],
  ['024', 'DORDOGNE'], ['025', 'DOUBS'], ['026', 'DROME'], ['027', 'EURE'],
  ['028', 'EURE-ET-LOIR'], ['029', 'FINISTERE'], ['030', 'GARD'],
  ['031', 'HAUTE-GARONNE'], ['032', 'GERS'], ['033', 'GIRONDE'],
  ['034', 'HERAULT'], ['035', 'ILLE-ET-VILAINE'], ['036', 'INDRE'],
  ['037', 'INDRE-ET-LOIRE'], ['038', 'ISERE'], ['039', 'JURA'],
  ['040', 'LANDES'], ['041', 'LOIR-ET-CHER'], ['042', 'LOIRE'],
  ['043', 'HAUTE-LOIRE'], ['044', 'LOIRE-ATLANTIQUE'], ['045', 'LOIRET'],
  ['046', 'LOT'], ['047', 'LOT-ET-GARONNE'], ['048', 'LOZERE'],
  ['049', 'MAINE-ET-LOIRE'], ['050', 'MANCHE'], ['051', 'MARNE'],
  ['052', 'HAUTE-MARNE'], ['053', 'MAYENNE'], ['054', 'MEURTHE-ET-MOSELLE'],
  ['055', 'MEUSE'], ['056', 'MORBIHAN'], ['057', 'MOSELLE'], ['058', 'NIEVRE'],
  ['059', 'NORD'], ['060', 'OISE'], ['061', 'ORNE'], ['062', 'PAS-DE-CALAIS'],
  ['063', 'PUY-DE-DOME'], ['064', 'PYRENEES-ATLANTIQUES'],
  ['065', 'HAUTES-PYRENEES'], ['066', 'PYRENEES-ORIENTALES'],
  ['067', 'BAS-RHIN'], ['068', 'HAUT-RHIN'], ['069', 'RHONE'],
  ['070', 'HAUTE-SAONE'], ['071', 'SAONE-ET-LOIRE'], ['072', 'SARTHE'],
  ['073', 'SAVOIE'], ['074', 'HAUTE-SAVOIE'], ['075', 'PARIS'],
  ['076', 'SEINE-MARITIME'], ['077', 'SEINE-ET-MARNE'], ['078', 'YVELINES'],
  ['079', 'DEUX-SEVRES'], ['080', 'SOMME'], ['081', 'TARN'],
  ['082', 'TARN-ET-GARONNE'], ['083', 'VAR'], ['084', 'VAUCLUSE'],
  ['085', 'VENDEE'], ['086', 'VIENNE'], ['087', 'HAUTE-VIENNE'],
  ['088', 'VOSGES'], ['089', 'YONNE'], ['090', 'TERRITOIRE DE BELFORT'],
  ['091', 'ESSONNE'], ['092', 'HAUTS-DE-SEINE'], ['093', 'SEINE-SAINT-DENIS'],
  ['094', 'VAL-DE-MARNE'], ['095', "VAL-D'OISE"],
  ['971', 'GUADELOUPE'], ['972', 'MARTINIQUE'], ['973', 'GUYANE'],
  ['974', 'LA REUNION'], ['976', 'MAYOTTE'],
]

// ─── DuckDB ───────────────────────────────────────────────────────────────────

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()
await conn.run('INSTALL spatial; LOAD spatial')
const run = (sql) => conn.run(sql)
const q = (sql) => conn.runAndReadAll(sql).then((r) => r.getRowObjects())

console.log('═══ Génération de captages_new.parquet depuis le CSV ═══\n')

// ─── Table des départements ───────────────────────────────────────────────────

await run(`CREATE TABLE dept_lookup (code VARCHAR, nom VARCHAR)`)
const deptValues = DEPARTEMENTS.map(([code, nom]) => `('${code}', '${nom.replace(/'/g, "''")}')`).join(', ')
await run(`INSERT INTO dept_lookup VALUES ${deptValues}`)

// ─── Référentiel captages ─────────────────────────────────────────────────────

let t = Date.now()
await run(`
  CREATE TABLE cap_raw AS
  SELECT * FROM read_csv('${REF_CAP_CSV}', header=true, delim=';')
`)
const [{ n: nbCapRaw }] = await q(`SELECT COUNT(*) n FROM cap_raw`)
console.log(`  ${nbCapRaw} lignes chargées depuis ref_cap_avr25 (${Date.now() - t}ms)`)

// ─── Regroupements "mélanges de captages" (t1_ins_cap_ref) ───────────────────
//
// ref_mca liste, pour chaque code_mca_national, les code_captage_principal_sise
// (SISE) qui en sont membres. Faute de documentation exacte sur le membre à
// choisir comme "référence" d'un groupe, on prend arbitrairement (mais de
// façon déterministe) le plus petit code du groupe — approximation à valider,
// cf. csv-to-parquet-schema-mapping.md. Les captages absents de ref_mca (la
// grande majorité) n'ont pas de cap_ref : le pipeline retombe alors sur leur
// propre code (`t1_ins_cap_ref || t1_code_ins`), comme aujourd'hui.

// Un même code_installation peut apparaître dans plusieurs code_mca_national
// (mélanges qui se recoupent, cas rare) : on ne garde qu'un seul rattachement
// par captage, choisi arbitrairement (le plus petit ref_code), pour rester
// 1:1 avec le schéma attendu par `generate_aac_infos.js`.
t = Date.now()
await run(`
  CREATE TABLE cap_ref_map AS
  WITH membres AS (
    SELECT DISTINCT code_mca_national, code_captage_principal_sise AS code_installation
    FROM read_csv('${REF_MCA_CSV}', header=true, delim=';')
    WHERE code_captage_principal_sise IS NOT NULL AND code_captage_principal_sise != ''
  ),
  ref_par_groupe AS (
    SELECT code_mca_national, MIN(code_installation) AS ref_code
    FROM membres
    GROUP BY code_mca_national
  ),
  candidats AS (
    SELECT m.code_installation, g.ref_code AS t1_ins_cap_ref, r.nom_installation AS t1_ins_cap_ref_lib,
           ROW_NUMBER() OVER (PARTITION BY m.code_installation ORDER BY g.ref_code ASC) AS rn
    FROM membres m
    JOIN ref_par_groupe g ON g.code_mca_national = m.code_mca_national
    JOIN cap_raw r ON r.code_installation = g.ref_code
  )
  SELECT code_installation, t1_ins_cap_ref, t1_ins_cap_ref_lib FROM candidats WHERE rn = 1
`)
const [{ n: nbCapRef }] = await q(`SELECT COUNT(*) n FROM cap_ref_map`)
console.log(`  ${nbCapRef} captages rattachés à un groupe via ref_mca (${Date.now() - t}ms)`)

// ─── Points de captage en WGS84 (pour la jointure spatiale PPE/PPR/PPI) ──────

t = Date.now()
await run(`
  CREATE TABLE cap_points AS
  SELECT code_installation,
         TRY_CAST(x_l93_installation AS DOUBLE) AS x_l93,
         TRY_CAST(y_l93_installation AS DOUBLE) AS y_l93,
         ST_Transform(
           ST_Point(TRY_CAST(x_l93_installation AS DOUBLE), TRY_CAST(y_l93_installation AS DOUBLE)),
           'EPSG:2154', 'EPSG:4326', true
         ) AS geom_wgs
  FROM cap_raw
  WHERE TRY_CAST(x_l93_installation AS DOUBLE) IS NOT NULL
    AND TRY_CAST(y_l93_installation AS DOUBLE) IS NOT NULL
    AND NOT (TRY_CAST(x_l93_installation AS DOUBLE) = 0 AND TRY_CAST(y_l93_installation AS DOUBLE) = 0)
`)
console.log(`  Points de captage projetés en WGS84 (${Date.now() - t}ms)`)

// ─── Rattachement captage → périmètre de protection (PPE / PPR / PPI) ────────
//
// Reconstruit par intersection spatiale point de captage / zone, faute de
// lien direct dans le CSV (cf. csv-to-parquet-schema-mapping.md). En cas de
// chevauchement de zones (rare), on ne garde qu'un seul code par captage,
// choisi arbitrairement (le plus petit), pour rester 1:1 avec le schéma
// attendu par `generate_aac_infos.js`.
async function buildPpMap(table, outCol) {
  t = Date.now()
  await run(`
    CREATE TABLE ${table}_map AS
    SELECT code_installation, ${outCol}
    FROM (
      SELECT p.code_installation, z.code_pp AS ${outCol},
             ROW_NUMBER() OVER (PARTITION BY p.code_installation ORDER BY z.code_pp ASC) AS rn
      FROM cap_points p
      JOIN read_parquet('${path(`data/${table}_hilbert.parquet`)}') z ON ST_Intersects(p.geom_wgs, z.geom)
    )
    WHERE rn = 1
  `)
  const [{ n }] = await q(`SELECT COUNT(*) n FROM ${table}_map`)
  console.log(`  ${n} captages rattachés à un périmètre ${table.toUpperCase()} (${Date.now() - t}ms)`)
}

await buildPpMap('ppe', 't2_code_ppe')
await buildPpMap('ppr', 't2_code_ppr')
await buildPpMap('ppi', 't2_code_ppi')

// ─── Assemblage final ─────────────────────────────────────────────────────────

t = Date.now()
await run(`
  COPY (
    SELECT
      r.code_installation                          AS t1_code_ins,
      r.nom_installation                            AS t1_ins_nom,
      COALESCE(NULLIF(r.nom_commune_actuelle, ''), NULLIF(r.nom_commune_dans_sise, '')) AS t1_com_nom,
      r.code_insee_commune_sise                     AS t1_com_insee,
      UPPER(r.libel_etat)                           AS t1_ins_etat_lib,
      NULL                                          AS t1_uge_mo_nom,
      d.nom                                         AS t1_dep_geo_lib,
      UPPER(r.nature_point_eau)                     AS t1_cap_type_lib,
      r.type_eau                                    AS t1_ins_nat_code,
      r.libel_usage                                 AS t1_ins_usage_lib,
      r.code_etat                                   AS t1_ins_etat,
      cr.t1_ins_cap_ref                             AS t1_ins_cap_ref,
      cr.t1_ins_cap_ref_lib                         AS t1_ins_cap_ref_lib,
      NULLIF(r.indice_bss_sise, '')                 AS t1_ins_code_bss,
      ppe.t2_code_ppe                                AS t2_code_ppe,
      ppr.t2_code_ppr                                AS t2_code_ppr,
      ppi.t2_code_ppi                                AS t2_code_ppi,
      p.x_l93                                       AS t1_psv_x,
      p.y_l93                                       AS t1_psv_y
    FROM cap_raw r
    LEFT JOIN dept_lookup d ON d.code = r.dept_gestionnaire
    LEFT JOIN cap_ref_map cr ON cr.code_installation = r.code_installation
    LEFT JOIN cap_points p ON p.code_installation = r.code_installation
    LEFT JOIN ppe_map ppe ON ppe.code_installation = r.code_installation
    LEFT JOIN ppr_map ppr ON ppr.code_installation = r.code_installation
    LEFT JOIN ppi_map ppi ON ppi.code_installation = r.code_installation
  ) TO '${OUTPUT}' (FORMAT PARQUET)
`)
console.log(`\n  Fichier écrit : ${OUTPUT} (${Date.now() - t}ms)`)

// ─── Résumé ───────────────────────────────────────────────────────────────────

const [stats] = await q(`
  SELECT COUNT(*) n, COUNT(DISTINCT t1_code_ins) distinct_ins,
         COUNT(t2_code_ppe) n_ppe, COUNT(t2_code_ppr) n_ppr, COUNT(t2_code_ppi) n_ppi
  FROM read_parquet('${OUTPUT}')
`)
console.log('\n═══ Résumé ═══')
console.log(stats)
console.log(
  '\nÀ comparer avec data/captages.parquet (53 775 lignes / 50 823 t1_code_ins distincts, cf. analyse précédente) avant toute bascule.'
)
