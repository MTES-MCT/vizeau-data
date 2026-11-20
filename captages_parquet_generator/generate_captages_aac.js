#!/usr/bin/env node
/**
 * Rattache les captages du référentiel DGS aux AAC (étape 3 de
 * plan-captages.md). C'est le seul endroit où ce lien est calculé :
 * aac/fiches lit la table produite ici.
 *
 * Sortie : data/captages/captages_aac.parquet, une ligne par couple (AAC, captage).
 *
 * Sources de liens, de la plus sûre à la moins sûre :
 *   1. sandre     PTP de l'AAC dans le référentiel AAC du Sandre (champ `PTP`
 *                 d'AAC.gpkg), résolus en captages par le code BSS que leur
 *                 donne la couche des PTP du Sandre ; et captages des OPR de
 *                 l'export auxquels le Sandre donne cette AAC
 *   2. export     captages des OPR de l'export des captages prioritaires, pour
 *                 les OPR auxquels le Sandre ne donne pas d'AAC (code_aac de
 *                 l'OPR, ou de son porteur pour un rattaché)
 *   champ_captant captages qui partagent le PPR d'un captage rattaché par les
 *                 sources 1 ou 2 (même champ captant, point 4 de bilan.md) ;
 *                 lien non sûr, affiché comme un recroisement
 *   3. point      point du captage dans la géométrie de l'AAC
 *   4. perimetre  périmètre de protection rapprochée ou immédiate (PPR,
 *                 PPI) du captage dont 40 % au moins de la surface est dans
 *                 l'AAC (PART_MIN_PP_DANS_AAC) ; les PPE ne servent pas
 *                 (TYPES_PP_DANS_AAC)
 *   5. proximite  seul captage dont le point est à moins de
 *                 DISTANCE_MAX_PROXIMITE_M du bord de l'AAC, pour les AAC
 *                 qu'aucune autre source ne rattache
 *
 * Les sources 1 et 2 (liens sûrs, donnés par une table) sont gardées sans
 * contrôle de distance. Elles ne sont pas exhaustives : le Sandre et l'export
 * citent les points pour lesquels l'AAC a été délimitée, ou ses captages
 * prioritaires, pas tous les captages de l'AAC. Les sources 3 et 4
 * (recroisement géographique) s'appliquent donc à toutes les AAC, qu'elles
 * aient des liens sûrs ou non (décision du 16 novembre 2026, question 4 de
 * plan-captages.md), pour les captages à moins de DISTANCE_MAX_AAC_KM de
 * l'AAC. Un captage sans point n'a de lien géographique que par un périmètre
 * presque entièrement dans l'AAC (PART_MIN_PP_SANS_POINT). Les liens
 * `champ_captant` partent des liens sûrs, avec le même contrôle de distance ;
 * sans point, ils sont gardés. La source 5 ne sert qu'aux AAC qu'aucune autre
 * ne rattache.
 *
 * Une AAC de prise d'eau de surface (tous ses points de prélèvement connus en
 * eau de surface, ou AAC de AAC_PRISES_EAU_SURFACE) ne reçoit par les sources
 * 3 et 4 que des captages en eau de surface : sinon, son AAC, qui couvre tout
 * un bassin versant, recevrait tous les captages souterrains du bassin (point
 * 1 de bilan.md).
 *
 * Deux alertes, qui ne retirent aucun lien (colonne `alerte`, règles dans
 * regles_aac.js) : `captage_eloigne_aac` pour un lien sûr à plus de
 * DISTANCE_MAX_AAC_KM, `captage_dans_autre_aac` pour tout lien dont le captage
 * est dans une autre AAC.
 *
 * Entrées :
 *   - data/aac/AAC.gpkg (couche AAC_FRA)                 géométries et PTP des AAC
 *   - data/captages/sandre_prl/PointPrelevement.csv      code BSS de chaque PTP
 *   - data/captages/captages_identifiants.parquet        code BSS → captage
 *   - data/captages/captages_new.parquet                 points et périmètres des captages
 *   - data/captages/captages_prioritaires.parquet        OPR de l'export → AAC, captages, nature de l'eau
 *   - data/captages/ppr_hilbert.parquet, ppi_hilbert.parquet
 *
 * À lancer après generate_captages_parquet.js et generate_prioritaires.js.
 *
 * Usage : node generate_captages_aac.js
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { dataPath } from '../data-dir.mjs'
import { NORMALISATION_MACROS } from './normalisation.js'
import {
  DISTANCE_MAX_AAC_KM,
  DISTANCE_MAX_AAC_M,
  DISTANCE_MIN_AUTRE_AAC_M,
  aacSandreSql,
  autresAacSql,
  natureEauPtpSql,
} from './regles_aac.js'

// Part minimale de la surface d'un périmètre de protection qui doit être dans
// l'AAC pour que ses captages y soient rattachés (source `perimetre`).
// L'ancien aac_pp_zones.parquet, utilisé par aac/fiches jusqu'en novembre
// 2026, retenait tout périmètre qui touchait l'AAC, même pour une part infime
// de sa surface. 0,4 plutôt que 0,5 (« majoritairement ») : pour les PPR et
// PPI, la tranche de 40 à 50 % donne encore 5 liens sur 31 dans les tables,
// celle de 30 à 40 % 1 sur 32 (mesure décrite sous TYPES_PP_DANS_AAC).
const PART_MIN_PP_DANS_AAC = 0.4

// Types de périmètres qui peuvent rattacher un captage (source `perimetre`).
// Les PPE sont exclus : grands, ils débordent sur les AAC voisines. Mesuré en
// novembre 2026 sur les 760 AAC qui ont des liens sûrs, en comparant les liens
// `perimetre` qu'elles recevraient à ceux des tables : 3 vrais liens sur 73
// pour les PPE à 50 % au moins dans l'AAC, 40 sur 77 pour les PPR et PPI (la
// source `point` fait 30 %). Détail dans plan-captages.md, étape 3.
const TYPES_PP_DANS_AAC = ['ppr', 'ppi']

// Part minimale de la surface du périmètre dans l'AAC pour garder un lien
// `perimetre` vers un captage sans point (coordonnées absentes du référentiel
// DGS). Sans point, la distance au captage ne peut pas être contrôlée : on
// demande que le périmètre soit presque entièrement dans l'AAC. Exemple : AAC
// 840 (Villemaur-sur-Vanne), dont le PPR 010_R_0177, dans l'AAC à 99,8 %, est
// celui du captage 010000448, sans point.
const PART_MIN_PP_SANS_POINT = 0.9

// Distance maximale, en mètres, entre le point d'un captage et le bord d'une
// AAC pour la source `proximite`. Elle ne sert que pour les AAC qu'aucune autre
// source ne rattache, et seulement quand un seul captage est à cette distance
// (sinon le lien serait ambigu). Cas typique : une source dont le point tombe
// quelques mètres en aval de l'AAC dessinée en amont de l'émergence.
const DISTANCE_MAX_PROXIMITE_M = 100

// AAC de prise d'eau de surface qu'aucune donnée ne signale comme telles : ni
// l'export ni le Sandre ne leur donnent de point de prélèvement. Elles
// recevaient en novembre 2026 tous les captages de leur bassin versant (point 1
// de bilan.md) :
//   1600  Prise de Mathay, 280 captages dont 7 en eau de surface
//   490   AAC de l'Orne (prise d'eau), 93 captages dont 2 en eau de surface
const AAC_PRISES_EAU_SURFACE = ['1600', '490']

const path = (name) => dataPath('captages', name)

const AAC_GPKG = dataPath('aac', 'AAC.gpkg')
const PTP_CSV = path('sandre_prl/PointPrelevement.csv')
const IDENTIFIANTS = path('captages_identifiants.parquet')
const CAPTAGES = path('captages_new.parquet')
const PRIORITAIRES = path('captages_prioritaires.parquet')
const OUTPUT = path('captages_aac.parquet')

for (const file of [AAC_GPKG, PTP_CSV, IDENTIFIANTS, CAPTAGES, PRIORITAIRES, ...TYPES_PP_DANS_AAC.map((pp) => path(`${pp}_hilbert.parquet`))]) {
  if (!existsSync(file)) {
    console.error(`Fichier introuvable : ${file}`)
    if (file === IDENTIFIANTS || file === CAPTAGES) console.error('Lancer d\'abord : npm start')
    if (file === PRIORITAIRES || file === PTP_CSV) console.error('Lancer d\'abord : npm run prioritaires (voir README pour PointPrelevement.csv)')
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

console.log('═══ Rattachement des captages aux AAC ═══\n')

// ─── AAC et captages ──────────────────────────────────────────────────────────

let t = Date.now()
await run(aacSandreSql(AAC_GPKG))
await run(`
  CREATE TABLE captages AS
  SELECT t1_code_ins AS code_installation, t1_ins_nat_code AS nature_eau,
         t2_code_ppe, NULLIF(trim(t2_code_ppr), '') AS t2_code_ppr, t2_code_ppi,
         CASE WHEN t1_psv_x IS NOT NULL AND t1_psv_y IS NOT NULL
                   AND NOT (t1_psv_x = 0 AND t1_psv_y = 0)
              THEN ST_Point(t1_psv_x, t1_psv_y) END AS point_l93
  FROM read_parquet('${CAPTAGES}')
`)
const [nb] = await q(`
  SELECT (SELECT COUNT(*) FROM aac_sandre) AS aac,
         (SELECT COUNT(*) FROM captages) AS captages,
         (SELECT COUNT(point_l93) FROM captages) AS points
`)
console.log(`  ${nb.aac} AAC, ${nb.captages} captages dont ${nb.points} avec un point (${Date.now() - t}ms)`)

// ─── 1. Référentiel AAC du Sandre ─────────────────────────────────────────────
//
// Chaque PTP cité par une AAC est résolu en captage par son code BSS
// (`CdNationalPTE` de la couche des PTP), cherché dans la table des
// identifiants. Même préférence que generate_prioritaires.js pour un code BSS
// partagé par plusieurs captages : celui qui le porte côté BRGM
// (`cap_2026_brgm`), les doublons venant des saisies ARS. Les PTP d'eaux de
// surface n'ont pas de code BSS : ils ne donnent un captage que par un OPR de
// l'export (ci-dessous).
//
// S'y ajoutent les captages des OPR de l'export auxquels le Sandre donne une
// AAC (code_aac_source `sandre` ou `sandre_porteur` de captages_prioritaires).

t = Date.now()
await run(`
  CREATE TABLE ptp_bss AS
  SELECT DISTINCT trim(CdPointPrelevement) AS code_ptp,
         CASE WHEN norm_bss_id(CdNationalPTE) IS NOT NULL THEN 'BSS_ID' ELSE 'BSS_INDICE' END AS type_code,
         COALESCE(norm_bss_id(CdNationalPTE), norm_bss_indice(CdNationalPTE)) AS code
  FROM read_csv('${PTP_CSV}', header=true, all_varchar=true)
  WHERE COALESCE(norm_bss_id(CdNationalPTE), norm_bss_indice(CdNationalPTE)) IS NOT NULL
`)
await run(`
  CREATE TABLE prioritaires AS
  SELECT p.* FROM read_parquet('${PRIORITAIRES}') p
  WHERE p.code_aac IN (SELECT cdaac FROM aac_sandre)
    AND p.code_installation IS NOT NULL -- OPR non résolus : aucun captage à rattacher
`)
await run(`
  CREATE TABLE liens_surs AS
  SELECT DISTINCT a.cdaac, i.code_installation, 'sandre' AS source, 'PTP ' || a.code_ptp AS detail
  FROM aac_ptp a
  JOIN ptp_bss p USING (code_ptp)
  JOIN read_parquet('${IDENTIFIANTS}') i ON i.type_code = p.type_code AND i.code = p.code
  QUALIFY list_contains(i.sources, 'cap_2026_brgm')
       OR NOT bool_or(list_contains(i.sources, 'cap_2026_brgm')) OVER (PARTITION BY a.cdaac, a.code_ptp, p.type_code, p.code)

  UNION ALL
  SELECT code_aac, code_installation,
         CASE WHEN code_aac_source LIKE 'sandre%' THEN 'sandre' ELSE 'export' END,
         'OPR ' || code_opr
  FROM prioritaires
`)
const [surs] = await q(`
  SELECT COUNT(DISTINCT (cdaac, code_installation)) FILTER (WHERE source = 'sandre') AS sandre,
         COUNT(DISTINCT (cdaac, code_installation)) FILTER (WHERE source = 'sandre' AND starts_with(detail, 'PTP')) AS sandre_ptp,
         COUNT(DISTINCT (cdaac, code_installation)) FILTER (WHERE source = 'export') AS export,
         COUNT(DISTINCT cdaac) AS aac
  FROM liens_surs
`)
console.log(
  `  Liens sûrs : ${surs.sandre} par le Sandre (dont ${surs.sandre_ptp} par le code BSS des PTP), ` +
    `${surs.export} par l'export ; ${surs.aac} AAC couvertes (${Date.now() - t}ms)`
)

// ─── Même champ captant ───────────────────────────────────────────────────────
//
// Le Sandre et l'export ne citent souvent qu'un ouvrage d'un champ captant :
// les autres puits, protégés par le même PPR, manquaient sur la fiche de l'AAC
// (point 4 de bilan.md ; AAC 1694 La Couyère : l'export cite le puits n°1,
// suspendu, pas les n°2 et n°3, actifs). Ils sont ajoutés comme liens non sûrs
// (`champ_captant`), distincts des liens des tables. Seul le PPR compte : un
// mélange (`t1_ins_cap_ref`) peut réunir des ressources éloignées (AAC 926 →
// 077000641 Congis-sur-Thérouanne 1, à 86 km du captage cité). Le contrôle de
// distance est celui des liens géographiques (table des liens, ci-dessous).

t = Date.now()
await run(`
  CREATE TABLE liens_champ AS
  SELECT DISTINCT s.cdaac, c.code_installation, 'champ_captant' AS source,
         'PPR ' || cs.t2_code_ppr || ' de ' || s.code_installation AS detail
  FROM (SELECT DISTINCT cdaac, code_installation FROM liens_surs) s
  JOIN captages cs ON cs.code_installation = s.code_installation
  JOIN captages c ON c.t2_code_ppr = cs.t2_code_ppr AND c.code_installation <> cs.code_installation
`)
console.log(
  `  Même champ captant : ${(await q('SELECT COUNT(DISTINCT (cdaac, code_installation)) n FROM liens_champ'))[0].n} couples ` +
    `(AAC, captage) candidats, avant contrôle de distance (${Date.now() - t}ms)`
)

// ─── 3 et 4. Recroisement géographique ────────────────────────────────────────
//
// Pour toutes les AAC, y compris celles dont une table donne des captages : les
// tables ne sont pas exhaustives. Jusqu'au 16 novembre 2026, une AAC qui avait
// un lien sûr ne recevait aucun lien géographique : l'AAC 1569 Le Bain ne
// gardait que BAINS ANCIEN, suspendu, cité par l'export, et perdait BAINS et
// MOLLARD CHEVAL, actifs et dans l'AAC. Sur l'ensemble, 2 421 installations
// de la version d'octobre 2026 disparaissaient ainsi.
//
// Périmètres : un même code_pp peut avoir plusieurs lignes dans les
// *_hilbert.parquet (une par captage, variantes de géométrie) ; elles sont
// réunies avant de calculer la part de la surface dans l'AAC. Le périmètre du
// captage est celui de captages_new.parquet (psv_code pour les PPE et PPR,
// intersection pour les PPI, cf. generate_captages_parquet.js).

t = Date.now()
await run(`
  CREATE TABLE pp AS
  ${TYPES_PP_DANS_AAC.map(
    (pp) => `
    SELECT '${pp}' AS type_pp, code_pp,
           ST_MakeValid(ST_Transform(ST_Union_Agg(ST_MakeValid(geom)), 'EPSG:4326', 'EPSG:2154', true)) AS geom_l93
    FROM read_parquet('${path(`${pp}_hilbert.parquet`)}')
    GROUP BY code_pp`
  ).join('\n    UNION ALL')}
`)
await run(`
  CREATE TABLE pp_dans_aac AS
  SELECT a.cdaac, p.type_pp, p.code_pp,
         ST_Area(ST_Intersection(p.geom_l93, a.geom_l93)) / ST_Area(p.geom_l93) AS part
  FROM pp p
  JOIN aac_sandre a ON ST_Intersects(p.geom_l93, a.geom_l93)
  WHERE ST_Area(p.geom_l93) > 0
`)
await run(`
  CREATE TABLE liens_geo AS
  SELECT a.cdaac, c.code_installation, 'point' AS source, NULL AS detail, NULL::DOUBLE AS part
  FROM aac_sandre a
  JOIN captages c ON c.point_l93 IS NOT NULL AND ST_Intersects(c.point_l93, a.geom_l93)

  UNION ALL
  SELECT p.cdaac, c.code_installation, 'perimetre',
         upper(p.type_pp) || ' ' || p.code_pp || ' (' || CAST(round(p.part * 100) AS INTEGER) || ' %)',
         p.part
  FROM pp_dans_aac p
  JOIN captages c ON p.code_pp = CASE p.type_pp WHEN 'ppe' THEN c.t2_code_ppe WHEN 'ppr' THEN c.t2_code_ppr ELSE c.t2_code_ppi END
  WHERE p.part >= ${PART_MIN_PP_DANS_AAC}
`)
console.log(
  `  Recroisement géographique : ${(await q('SELECT COUNT(DISTINCT cdaac) n FROM liens_geo'))[0].n} AAC, ` +
    `${(await q(`SELECT COUNT(*) n FROM pp_dans_aac WHERE part >= ${PART_MIN_PP_DANS_AAC}`))[0].n} périmètres ` +
    `(${TYPES_PP_DANS_AAC.join(', ').toUpperCase()}) à ${PART_MIN_PP_DANS_AAC * 100} % au moins dans une AAC (${Date.now() - t}ms)`
)

// ─── AAC de prise d'eau de surface ────────────────────────────────────────────
//
// L'export cite l'ouvrage d'une prise en rivière ou en retenue, mais ne le
// résout presque jamais en captage (pas de code BSS pour une eau de surface) :
// l'AAC recevait par le recroisement géographique tous les captages de son
// bassin versant (point 1 de bilan.md : AAC 1549 Prise de
// Maquens, 296 captages, dont des sources à 40 km de la prise). Pour ces AAC,
// seuls les liens `point` et `perimetre` vers des captages en eau de surface
// (`t1_ins_nat_code` ESU) sont gardés. Des prises d'autres réseaux, en amont,
// restent rattachées (Maquens : 10 prises, dont celle du lac d'Estany Gros).
//
// Une AAC de prise d'eau de surface est une AAC :
//   - dont tous les points de prélèvement connus sont en eau de surface : nature
//     de l'eau des OPR de l'export qui lui sont donnés (`nature_eau` de
//     captages_prioritaires, d'après l'origine et les PTP de l'OPR) et type des
//     PTP que lui donne le référentiel AAC du Sandre ;
//   - ou citée dans AAC_PRISES_EAU_SURFACE (aucun point connu).
// Les liens sûrs sont gardés, quelle que soit la nature de l'eau. Une AAC sans
// lien sûr qu'aucun captage en eau de surface ne rattache garde ses liens
// géographiques tels quels, pour ne pas la vider : l'AAC 5966 Puits Bannie
// calcaire a un PTP de type CONT, mais son seul captage est un puits.

t = Date.now()
await run(`
  CREATE TABLE aac_eau_surface AS
  WITH natures AS (
    SELECT code_aac AS cdaac, unnest(nature_eau) AS nature_eau
    FROM read_parquet('${PRIORITAIRES}')
    WHERE code_aac IS NOT NULL
    UNION ALL
    SELECT a.cdaac, ${natureEauPtpSql('p.TypePointPrelevement')}
    FROM aac_ptp a
    JOIN (SELECT DISTINCT trim(CdPointPrelevement) AS code_ptp, TypePointPrelevement
          FROM read_csv('${PTP_CSV}', header=true, all_varchar=true)) p USING (code_ptp)
  )
  SELECT cdaac, 'points' AS critere FROM natures
  WHERE nature_eau IS NOT NULL
  GROUP BY cdaac
  HAVING bool_and(nature_eau = 'ESU')
  UNION ALL
  SELECT cdaac, 'liste' FROM aac_sandre WHERE cdaac IN (${AAC_PRISES_EAU_SURFACE.map((c) => `'${c}'`).join(', ')})
`)
await run(`
  CREATE TABLE aac_eau_surface_sans_esu AS
  SELECT cdaac FROM aac_eau_surface
  WHERE cdaac NOT IN (SELECT l.cdaac FROM liens_geo l JOIN captages c USING (code_installation) WHERE c.nature_eau = 'ESU')
    AND cdaac NOT IN (SELECT cdaac FROM liens_surs)
`)
const [esu] = await q(`
  SELECT (SELECT COUNT(*) FROM aac_eau_surface) AS aac,
         (SELECT COUNT(*) FROM aac_eau_surface WHERE critere = 'liste') AS aac_liste,
         COUNT(DISTINCT (l.cdaac, l.code_installation)) AS couples,
         COUNT(DISTINCT (l.cdaac, l.code_installation)) FILTER (WHERE c.nature_eau IS DISTINCT FROM 'ESU') AS ecartes,
         (SELECT string_agg(cdaac, ', ' ORDER BY cdaac) FROM aac_eau_surface_sans_esu) AS sans_esu
  FROM liens_geo l
  JOIN captages c USING (code_installation)
  WHERE l.cdaac IN (SELECT cdaac FROM aac_eau_surface)
    AND l.cdaac NOT IN (SELECT cdaac FROM aac_eau_surface_sans_esu)
`)
await run(`
  CREATE OR REPLACE TABLE liens_geo AS
  SELECT l.* FROM liens_geo l
  JOIN captages c USING (code_installation)
  WHERE c.nature_eau = 'ESU'
     OR l.cdaac NOT IN (SELECT cdaac FROM aac_eau_surface)
     OR l.cdaac IN (SELECT cdaac FROM aac_eau_surface_sans_esu)
`)
console.log(
  `  Prises d'eau de surface : ${esu.aac} AAC (dont ${esu.aac_liste} par AAC_PRISES_EAU_SURFACE), ` +
    `${esu.ecartes} captages sur ${esu.couples} écartés (hors eau de surface) ; ` +
    `liens gardés faute de captage en eau de surface : ${esu.sans_esu ?? 'aucune AAC'} (${Date.now() - t}ms)`
)

// ─── Table des liens ──────────────────────────────────────────────────────────
//
// Un couple (AAC, captage) trouvé par plusieurs sources garde la plus sûre ;
// `detail` réunit les éléments qui l'ont donné (PTP, OPR, périmètre).
// La distance est mesurée entre le point du captage et l'AAC (0 dans l'AAC,
// NULL sans point). Un lien non sûr (géographique ou `champ_captant`) au-delà
// de DISTANCE_MAX_AAC_M n'est pas créé ; un lien sûr est gardé et signalé
// (alerte `captage_eloigne_aac`). Sans point pour mesurer la distance, un lien
// géographique n'est gardé que s'il vient d'un périmètre presque entièrement
// dans l'AAC (PART_MIN_PP_SANS_POINT) : le captage est alors forcément proche.
// Un lien `champ_captant` sans point est gardé : le PPR qu'il partage avec un
// captage cité par une table suffit.

t = Date.now()
await run(`
  CREATE TABLE candidats AS
  WITH tous AS (
    SELECT *, CASE source WHEN 'sandre' THEN 1 WHEN 'export' THEN 2 WHEN 'champ_captant' THEN 3
                          WHEN 'point' THEN 4 ELSE 5 END AS rang
    FROM (SELECT *, NULL::DOUBLE AS part FROM liens_surs
          UNION ALL SELECT *, NULL::DOUBLE FROM liens_champ
          UNION ALL SELECT * FROM liens_geo)
  )
  SELECT cdaac, code_installation, source, rang <= 2 AS lien_sur,
         string_agg(DISTINCT detail, ', ' ORDER BY detail) AS detail,
         MAX(part) AS part_pp
  FROM tous
  GROUP BY cdaac, code_installation, source, rang
  QUALIFY rang = MIN(rang) OVER (PARTITION BY cdaac, code_installation)
`)
await run(`
  CREATE TABLE liens AS
  SELECT l.cdaac, l.code_installation, l.source, l.lien_sur,
         CAST(round(ST_Distance(c.point_l93, a.geom_l93)) AS INTEGER) AS distance_m,
         CASE WHEN l.lien_sur AND ST_Distance(c.point_l93, a.geom_l93) > ${DISTANCE_MAX_AAC_M}
              THEN 'captage_eloigne_aac' END AS alerte,
         NULL::VARCHAR[] AS autres_aac,
         l.detail, l.part_pp
  FROM candidats l
  JOIN aac_sandre a USING (cdaac)
  JOIN captages c USING (code_installation)
`)
const SANS_POINT_GARDE = `(source = 'perimetre' AND part_pp >= ${PART_MIN_PP_SANS_POINT}) OR source = 'champ_captant'`
const [ecartes] = await q(`
  SELECT COUNT(*) FILTER (WHERE distance_m > ${DISTANCE_MAX_AAC_M}) AS loin,
         COUNT(*) FILTER (WHERE distance_m IS NULL AND NOT (${SANS_POINT_GARDE})) AS sans_point,
         COUNT(*) FILTER (WHERE distance_m IS NULL AND (${SANS_POINT_GARDE})) AS sans_point_gardes
  FROM liens WHERE NOT lien_sur
`)
await run(`
  DELETE FROM liens
  WHERE NOT lien_sur
    AND (distance_m > ${DISTANCE_MAX_AAC_M} OR (distance_m IS NULL AND NOT (${SANS_POINT_GARDE})))
`)
console.log(
  `  Liens non sûrs écartés : ${ecartes.loin} à plus de ${DISTANCE_MAX_AAC_KM.toLocaleString('fr-FR')} km, ` +
    `${ecartes.sans_point} sans point ; ${ecartes.sans_point_gardes} sans point gardés ` +
    `(périmètre dans l'AAC à ${PART_MIN_PP_SANS_POINT * 100} % au moins, ou même champ captant) (${Date.now() - t}ms)`
)

// ─── 5. Proximité ─────────────────────────────────────────────────────────────
//
// Dernier recours, pour les AAC qu'aucune table ni le point ni les
// périmètres ne rattachent : le captage dont le point est à moins de
// DISTANCE_MAX_PROXIMITE_M du bord de l'AAC, s'il est le seul. Avec plusieurs
// captages à cette distance, l'AAC reste sans lien.

t = Date.now()
await run(`
  CREATE TABLE proximite AS
  SELECT a.cdaac, COUNT(DISTINCT c.code_installation) AS candidats,
         MIN(c.code_installation) AS code_installation,
         CAST(round(MIN(ST_Distance(c.point_l93, a.geom_l93))) AS INTEGER) AS distance_m
  FROM aac_sandre a
  JOIN captages c ON c.point_l93 IS NOT NULL
                 AND ST_DWithin(c.point_l93, a.geom_l93, ${DISTANCE_MAX_PROXIMITE_M})
  WHERE a.cdaac NOT IN (SELECT cdaac FROM liens)
  GROUP BY a.cdaac
`)
await run(`
  INSERT INTO liens (cdaac, code_installation, source, lien_sur, distance_m, alerte, detail)
  SELECT cdaac, code_installation, 'proximite', false, distance_m, NULL,
         'seul captage à moins de ${DISTANCE_MAX_PROXIMITE_M} m'
  FROM proximite WHERE candidats = 1
`)
const [prox] = await q(`
  SELECT COUNT(*) FILTER (WHERE candidats = 1) AS rattachees,
         COUNT(*) FILTER (WHERE candidats > 1) AS ambigues
  FROM proximite
`)
console.log(
  `  Proximité : ${prox.rattachees} AAC rattachées à leur seul captage à moins de ` +
    `${DISTANCE_MAX_PROXIMITE_M} m, ${prox.ambigues} laissées sans lien (plusieurs captages) (${Date.now() - t}ms)`
)

// ─── Alerte : captage dans une autre AAC ──────────────────────────────────────
//
// Sur tout lien, sûr ou géographique, dont le captage est à plus de
// DISTANCE_MIN_AUTRE_AAC_M de l'AAC et dans une autre AAC validée qui n'englobe
// pas la sienne (autresAacSql, regles_aac.js). Le lien est gardé ; les autres
// AAC sont dans `autres_aac`. Un lien qui porte aussi `captage_eloigne_aac` a
// les deux alertes, séparées par une virgule.

t = Date.now()
await run(
  autresAacSql(
    'dans_autre_aac',
    `SELECT l.cdaac, l.code_installation, c.point_l93
     FROM liens l
     JOIN captages c USING (code_installation)
     WHERE l.distance_m > ${DISTANCE_MIN_AUTRE_AAC_M}`
  )
)
await run(`
  UPDATE liens
  SET alerte = concat_ws(', ', liens.alerte, 'captage_dans_autre_aac'), autres_aac = d.autres_aac
  FROM dans_autre_aac d
  WHERE d.cdaac = liens.cdaac AND d.code_installation = liens.code_installation
`)
const [autres] = await q(`
  SELECT COUNT(*) FILTER (WHERE lien_sur) AS surs, COUNT(*) FILTER (WHERE NOT lien_sur) AS geo
  FROM liens WHERE autres_aac IS NOT NULL
`)
console.log(
  `  Captage dans une autre AAC : ${autres.surs} liens sûrs, ${autres.geo} liens géographiques ` +
    `(alerte captage_dans_autre_aac, liens gardés) (${Date.now() - t}ms)`
)

await run(`
  COPY (SELECT * EXCLUDE (part_pp) FROM liens ORDER BY TRY_CAST(cdaac AS INTEGER), cdaac, code_installation)
  TO '${OUTPUT}' (FORMAT PARQUET)
`)
console.log(`  Fichier écrit : ${OUTPUT}`)

// ─── Résumé ───────────────────────────────────────────────────────────────────

console.log('\n═══ Résumé ═══')
console.table(
  await q(`
    SELECT source, lien_sur, COUNT(*) AS liens, COUNT(DISTINCT cdaac) AS aac,
           COUNT(DISTINCT code_installation) AS captages,
           COUNT(*) FILTER (WHERE contains(alerte, 'captage_eloigne_aac')) AS eloignes,
           COUNT(*) FILTER (WHERE contains(alerte, 'captage_dans_autre_aac')) AS autre_aac
    FROM liens
    GROUP BY source, lien_sur
    ORDER BY lien_sur DESC, source DESC
  `)
)
const [total] = await q(`
  SELECT COUNT(*) AS liens, COUNT(DISTINCT cdaac) AS aac, COUNT(DISTINCT code_installation) AS captages,
         (SELECT COUNT(*) FROM aac_sandre) - COUNT(DISTINCT cdaac) AS aac_sans_captage
  FROM liens
`)
console.log(
  `  ${total.liens} liens, ${total.aac} AAC, ${total.captages} captages ; ${total.aac_sans_captage} AAC sans captage`
)
