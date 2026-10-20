#!/usr/bin/env node
/**
 * Résout les ouvrages de prélèvement (OPR) de l'export des captages
 * prioritaires en captages du référentiel DGS, et liste les lignes de l'export
 * qui posent problème.
 *
 * Sorties (dans data/captages/) :
 *   - captages_prioritaires.parquet  une ligne par couple (OPR, captage) : sert à
 *     poser le flag `prioritaire` des installations dans aac/fiches
 *   - anomalies_prioritaires.csv     lignes de l'export non résolues ou
 *     incohérentes, à renvoyer au producteur de l'export
 *
 * Sources :
 *   - data/captages/20260901-export_source_list_ouvragespourVizeau.csv
 *   - data/captages/captages_identifiants.parquet et captages_new.parquet
 *     (produits par generate_captages_parquet.js, à lancer avant)
 *   - data/aac/AAC.gpkg (couche AAC_FRA), pour vérifier les codes AAC et
 *     mesurer la distance entre un captage et son AAC
 *
 * Usage : node generate_prioritaires.js
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { dataPath } from '../data-dir.mjs'
import { NORMALISATION_MACROS } from './normalisation.js'

const path = (name) => dataPath('captages', name)

const EXPORT_CSV = path('20260901-export_source_list_ouvragespourVizeau.csv')
const IDENTIFIANTS = path('captages_identifiants.parquet')
const CAPTAGES = path('captages_new.parquet')
const AAC_GPKG = dataPath('aac', 'AAC.gpkg')
const OUTPUT = path('captages_prioritaires.parquet')
const OUTPUT_ANOMALIES = path('anomalies_prioritaires.csv')

// Au-delà de cette distance entre le point du captage et la géométrie de son
// AAC, le lien donné par l'export est jugé suspect (question 4 de plan-captages.md).
const DISTANCE_MAX_AAC_M = 10_000

for (const file of [EXPORT_CSV, IDENTIFIANTS, CAPTAGES, AAC_GPKG]) {
  if (!existsSync(file)) {
    console.error(`Fichier introuvable : ${file}`)
    if (file === IDENTIFIANTS || file === CAPTAGES) console.error('Lancer d\'abord : node generate_captages_parquet.js')
    process.exit(1)
  }
}

// ─── DuckDB ───────────────────────────────────────────────────────────────────

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()
await conn.run('INSTALL spatial; LOAD spatial')
const run = (sql) => conn.run(sql)
const q = (sql) => conn.runAndReadAll(sql).then((r) => r.getRowObjects())

await run(NORMALISATION_MACROS)

console.log('═══ Résolution de l\'export des captages prioritaires ═══\n')

// ─── Export OPR ───────────────────────────────────────────────────────────────
//
// Un OPR est « seul », « porteur » ou « rattaché » à un porteur (`opr_rattach`).
// Seuls les OPR seuls ou porteurs ont un `code_aac` : un rattaché hérite de
// celui de son porteur (hypothèse de la question 3 de plan-captages.md).

let t = Date.now()
await run(`
  CREATE TABLE export_raw AS
  SELECT * FROM read_csv('${EXPORT_CSV}', header=true, all_varchar=true)
`)
await run(`
  CREATE TABLE opr AS
  SELECT e.code_opr, e.statut_opr, NULLIF(trim(e.opr_rattach), '') AS opr_rattach, e.nom_sandre,
         e.code_ins, e.code_psv, e.code_bss, e.code_ptp_sandre, e.coord_x_wgs84, e.coord_y_wgs84,
         NULLIF(trim(e.code_aac), '') AS code_aac_export,
         COALESCE(NULLIF(trim(e.code_aac), ''), NULLIF(trim(p.code_aac), '')) AS code_aac,
         CASE
           WHEN NULLIF(trim(e.code_aac), '') IS NOT NULL THEN 'export'
           WHEN NULLIF(trim(p.code_aac), '') IS NOT NULL THEN 'porteur'
         END AS code_aac_source,
         p.code_opr IS NOT NULL AS porteur_trouve
  FROM export_raw e
  LEFT JOIN export_raw p ON p.code_opr = NULLIF(trim(e.opr_rattach), '')
`)
const [{ n: nbOpr }] = await q(`SELECT COUNT(*) n FROM opr`)
console.log(`  ${nbOpr} OPR chargés depuis l'export (${Date.now() - t}ms)`)

// ─── Résolution des codes en captages ─────────────────────────────────────────
//
// `code_ins`, `code_psv` et `code_bss` sont des listes séparées par `|`, dont
// les longueurs ne concordent pas toujours : elles sont traitées comme des
// ensembles de codes par OPR, normalisés puis cherchés dans la table des
// identifiants.
//
// Un OPR est rattaché aux captages trouvés par le type de code le plus sûr qui
// en trouve au moins un : INS, sinon PSV, sinon BSS (ancien ou nouveau). Un
// code d'un type moins sûr qui désigne un autre captage n'ajoute pas de lien :
// il est signalé dans le rapport d'anomalies. Un code PSV ou BSS qui désigne
// encore plusieurs captages après la préférence BRGM ci-dessous les rattache
// tous, et est aussi signalé.

t = Date.now()
await run(`
  CREATE TABLE codes_opr AS
  WITH brut AS (
    SELECT code_opr, 'INS' AS type_brut, trim(unnest(string_split(code_ins, '|'))) AS code_brut FROM opr
    UNION ALL
    SELECT code_opr, 'PSV', trim(unnest(string_split(code_psv, '|'))) FROM opr
    UNION ALL
    SELECT code_opr, 'BSS', trim(unnest(string_split(code_bss, '|'))) FROM opr
  )
  SELECT DISTINCT code_opr, type_brut, code_brut,
         CASE type_brut
           WHEN 'INS' THEN 'INS'
           WHEN 'PSV' THEN 'PSV'
           ELSE CASE WHEN norm_bss_id(code_brut) IS NOT NULL THEN 'BSS_ID' ELSE 'BSS_INDICE' END
         END AS type_code,
         CASE type_brut
           WHEN 'INS' THEN norm_ins(code_brut)
           WHEN 'PSV' THEN norm_psv(code_brut)
           ELSE COALESCE(norm_bss_id(code_brut), norm_bss_indice(code_brut))
         END AS code,
         CASE type_brut WHEN 'INS' THEN 1 WHEN 'PSV' THEN 2 ELSE 3 END AS rang
  FROM brut
  WHERE code_brut <> ''
`)
// Un code BSS partagé par plusieurs captages l'est presque toujours à cause
// d'une saisie côté ARS (captage recodé, voisin, abandonné) : quand l'un de ces
// captages porte le code dans les champs du BRGM (source `cap_2026_brgm`), seul
// celui-là est retenu. La désignation de l'ancien code (`/P1`) ne départage
// pas : l'export ne la donne jamais, et les codes du BRGM partagés le restent
// avec elle.
await run(`
  CREATE TABLE correspondances AS
  SELECT c.code_opr, c.type_code, c.code_brut, c.rang, i.code_installation
  FROM codes_opr c
  JOIN read_parquet('${IDENTIFIANTS}') i ON i.type_code = c.type_code AND i.code = c.code
  QUALIFY list_contains(i.sources, 'cap_2026_brgm')
       OR NOT bool_or(list_contains(i.sources, 'cap_2026_brgm')) OVER (PARTITION BY c.code_opr, c.type_code, c.code)
`)
await run(`
  CREATE TABLE liens AS
  WITH rang_retenu AS (
    SELECT code_opr, MIN(rang) AS rang FROM correspondances GROUP BY code_opr
  )
  SELECT c.code_opr, c.code_installation, c.rang,
         list_sort(list_distinct(list(c.type_code))) AS resolu_par
  FROM correspondances c
  JOIN rang_retenu r ON r.code_opr = c.code_opr AND r.rang = c.rang
  GROUP BY c.code_opr, c.code_installation, c.rang
`)
await run(`
  COPY (
    SELECT o.code_opr, o.statut_opr, o.opr_rattach, o.code_aac, o.code_aac_source,
           l.code_installation, l.resolu_par
    FROM liens l
    JOIN opr o USING (code_opr)
    ORDER BY o.code_opr, l.code_installation
  ) TO '${OUTPUT}' (FORMAT PARQUET)
`)
const [stats] = await q(`
  SELECT COUNT(*) AS liens, COUNT(DISTINCT code_opr) AS opr, COUNT(DISTINCT code_installation) AS captages
  FROM liens
`)
console.log(
  `  ${stats.liens} liens : ${stats.opr} OPR sur ${nbOpr} rattachés à ${stats.captages} captages (${Date.now() - t}ms)`
)
console.log(`  Fichier écrit : ${OUTPUT}`)

// ─── Rapport d'anomalies ──────────────────────────────────────────────────────
//
// Une ligne par anomalie :
//   aac_inconnue        code_aac absent d'AAC.gpkg (signalé sur l'OPR qui le porte,
//                       pas sur ses rattachés)
//   porteur_absent      OPR rattaché dont le porteur n'est pas dans l'export
//   opr_sans_captage    aucun code de l'OPR ne mène à un captage du référentiel
//                       (PTP seul, coordonnées seules, codes inconnus)
//   captage_eloigne_aac captage à plus de DISTANCE_MAX_AAC_M de l'AAC de son OPR
//   code_autre_captage  code PSV ou BSS de l'OPR qui désigne un captage autre que
//                       ceux retenus pour l'OPR (cf. résolution ci-dessus)
//   code_ambigu         code PSV ou BSS retenu pour l'OPR qui désigne plusieurs
//                       captages, tous rattachés à l'OPR

t = Date.now()
await run(`
  CREATE TABLE aac AS
  SELECT CAST(cdaac AS VARCHAR) AS cdaac, ST_Transform(geom, 'EPSG:4326', 'EPSG:2154', true) AS geom_l93
  FROM ST_Read('${AAC_GPKG}', layer='AAC_FRA')
`)
await run(`
  CREATE TABLE anomalies AS
  SELECT 'aac_inconnue' AS anomalie, o.code_opr, NULL::VARCHAR AS code_installation, NULL::INTEGER AS distance_m,
         'code_aac « ' || o.code_aac_export || ' » absent d''AAC.gpkg' AS detail
  FROM opr o
  WHERE o.code_aac_export IS NOT NULL AND o.code_aac_export NOT IN (SELECT cdaac FROM aac)

  UNION ALL
  SELECT 'porteur_absent', o.code_opr, NULL, NULL,
         'porteur « ' || o.opr_rattach || ' » absent de l''export'
  FROM opr o
  WHERE o.statut_opr = 'rattaché' AND NOT o.porteur_trouve

  UNION ALL
  SELECT 'opr_sans_captage', o.code_opr, NULL, NULL,
         concat_ws(' ; ',
           'INS : ' || o.code_ins, 'PSV : ' || o.code_psv, 'BSS : ' || o.code_bss,
           'PTP : ' || o.code_ptp_sandre,
           CASE WHEN o.coord_x_wgs84 IS NOT NULL THEN 'coordonnées : ' || o.coord_x_wgs84 || ', ' || o.coord_y_wgs84 END)
  FROM opr o
  WHERE o.code_opr NOT IN (SELECT code_opr FROM liens)

  UNION ALL
  SELECT 'captage_eloigne_aac', o.code_opr, l.code_installation,
         CAST(round(ST_Distance(ST_Point(c.t1_psv_x, c.t1_psv_y), a.geom_l93)) AS INTEGER),
         'AAC ' || o.code_aac || CASE WHEN o.code_aac_source = 'porteur' THEN ' (héritée du porteur)' ELSE '' END
  FROM liens l
  JOIN opr o USING (code_opr)
  JOIN aac a ON a.cdaac = o.code_aac
  JOIN read_parquet('${CAPTAGES}') c ON c.t1_code_ins = l.code_installation
  WHERE c.t1_psv_x IS NOT NULL AND c.t1_psv_y IS NOT NULL
    AND ST_Distance(ST_Point(c.t1_psv_x, c.t1_psv_y), a.geom_l93) > ${DISTANCE_MAX_AAC_M}

  UNION ALL
  SELECT 'code_autre_captage', c.code_opr, c.code_installation, NULL,
         c.type_code || ' ' || c.code_brut || ' désigne ' || c.code_installation
           || ', hors des captages retenus pour l''OPR (' || r.retenus || ')'
  FROM correspondances c
  JOIN (
    SELECT code_opr, string_agg(code_installation, ', ' ORDER BY code_installation) AS retenus
    FROM liens GROUP BY code_opr
  ) r USING (code_opr)
  WHERE NOT EXISTS (
    SELECT 1 FROM liens l WHERE l.code_opr = c.code_opr AND l.code_installation = c.code_installation
  )

  UNION ALL
  SELECT 'code_ambigu', c.code_opr, NULL, NULL,
         c.type_code || ' ' || c.code_brut || ' désigne plusieurs captages, tous retenus ('
           || string_agg(DISTINCT c.code_installation, ', ' ORDER BY c.code_installation) || ')'
  FROM correspondances c
  JOIN (SELECT DISTINCT code_opr, rang FROM liens) r USING (code_opr, rang)
  WHERE c.rang > 1
  GROUP BY c.code_opr, c.type_code, c.code_brut
  HAVING COUNT(DISTINCT c.code_installation) > 1
`)
await run(`
  COPY (
    SELECT a.anomalie, a.code_opr, o.statut_opr, o.opr_rattach, o.nom_sandre, o.code_aac,
           a.code_installation, a.distance_m, a.detail
    FROM anomalies a
    JOIN opr o USING (code_opr)
    ORDER BY a.anomalie, a.code_opr, a.code_installation, a.detail
  ) TO '${OUTPUT_ANOMALIES}' (FORMAT CSV, HEADER true)
`)
console.log(`  Fichier écrit : ${OUTPUT_ANOMALIES} (${Date.now() - t}ms)`)

// ─── Résumé ───────────────────────────────────────────────────────────────────

console.log('\n═══ Résumé ═══')
console.table(
  await q(`
    SELECT o.statut_opr, COUNT(*) AS opr,
           COUNT(*) FILTER (WHERE o.code_opr IN (SELECT code_opr FROM liens)) AS resolus,
           COUNT(o.code_aac) AS avec_aac
    FROM opr o
    GROUP BY o.statut_opr
    ORDER BY o.statut_opr
  `)
)
console.table(
  await q(`
    SELECT anomalie, COUNT(*) AS lignes, COUNT(DISTINCT code_opr) AS opr
    FROM anomalies
    GROUP BY anomalie
    ORDER BY anomalie
  `)
)
