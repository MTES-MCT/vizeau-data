#!/usr/bin/env node
/**
 * Résout les ouvrages de prélèvement (OPR) de l'export des captages
 * prioritaires en captages du référentiel DGS, et liste les lignes de l'export
 * qui posent problème.
 *
 * Sorties (dans data/captages/) :
 *   - captages_prioritaires.parquet  une ligne par OPR, AAC et captage (captage
 *     vide pour un OPR non résolu) : sert à poser le flag `prioritaire` des AAC
 *     et des installations dans aac/fiches, et donne à generate_captages_aac.js
 *     les liens captage → AAC de l'export
 *   - anomalies_prioritaires.csv     lignes de l'export non résolues ou
 *     incohérentes, à renvoyer au producteur de l'export
 *
 * Sources :
 *   - data/captages/20260901-export_source_list_ouvragespourVizeau.csv
 *   - data/captages/sandre_prl/PointPrelevement.csv  couche WFS des points de
 *     prélèvement (PTP) du Sandre, pour leurs codes BSS (cf. PTP_URL)
 *   - data/captages/captages_identifiants.parquet et captages_new.parquet
 *     (produits par generate_captages_parquet.js, à lancer avant)
 *   - data/aac/AAC.gpkg (couche AAC_FRA), pour les PTP de chaque AAC
 *     (référentiel AAC du Sandre, qui prime sur le code AAC de l'export), pour
 *     vérifier les codes AAC et mesurer la distance entre un captage et son AAC
 *
 * Usage : node generate_prioritaires.js
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { dataPath } from '../data-dir.mjs'
import { NORMALISATION_MACROS } from './normalisation.js'
import { DISTANCE_MAX_AAC_M, aacSandreSql, autresAacSql } from './regles_aac.js'

const path = (name) => dataPath('captages', name)

const EXPORT_CSV = path('20260901-export_source_list_ouvragespourVizeau.csv')
const PTP_CSV = path('sandre_prl/PointPrelevement.csv')
const PTP_URL =
  'https://services.sandre.eaufrance.fr/geo/prl?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
  '&TYPENAMES=sa:PointPrelevement&OUTPUTFORMAT=text/csv'
const IDENTIFIANTS = path('captages_identifiants.parquet')
const CAPTAGES = path('captages_new.parquet')
const AAC_GPKG = dataPath('aac', 'AAC.gpkg')
const OUTPUT = path('captages_prioritaires.parquet')
const OUTPUT_ANOMALIES = path('anomalies_prioritaires.csv')

for (const file of [EXPORT_CSV, PTP_CSV, IDENTIFIANTS, CAPTAGES, AAC_GPKG]) {
  if (!existsSync(file)) {
    console.error(`Fichier introuvable : ${file}`)
    if (file === IDENTIFIANTS || file === CAPTAGES) console.error('Lancer d\'abord : node generate_captages_parquet.js')
    if (file === PTP_CSV) console.error(`Le télécharger : mkdir -p "${dataPath('captages', 'sandre_prl')}" && curl -o "${PTP_CSV}" "${PTP_URL}"`)
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
// celui de son porteur (question 3 de plan-captages.md). Ce code AAC de
// l'export (`code_aac_export`) ne sert que si le référentiel AAC du Sandre ne
// donne pas d'AAC à l'OPR (voir « AAC de chaque OPR » ci-dessous).

let t = Date.now()
await run(`
  CREATE TABLE export_raw AS
  SELECT * FROM read_csv('${EXPORT_CSV}', header=true, all_varchar=true)
`)
await run(`
  CREATE TABLE opr AS
  SELECT e.code_opr, e.statut_opr, NULLIF(trim(e.opr_rattach), '') AS opr_rattach, e.nom_sandre,
         e.code_ins, e.code_psv, e.code_bss, e.code_ptp_sandre, e.coord_x_wgs84, e.coord_y_wgs84,
         NULLIF(trim(e.code_aac), '') AS code_aac_propre,
         COALESCE(NULLIF(trim(e.code_aac), ''), NULLIF(trim(p.code_aac), '')) AS code_aac_export,
         CASE
           WHEN NULLIF(trim(e.code_aac), '') IS NOT NULL THEN 'export'
           WHEN NULLIF(trim(p.code_aac), '') IS NOT NULL THEN 'export_porteur'
         END AS code_aac_export_source,
         p.code_opr IS NOT NULL AS porteur_trouve
  FROM export_raw e
  LEFT JOIN export_raw p ON p.code_opr = NULLIF(trim(e.opr_rattach), '')
`)
const [{ n: nbOpr }] = await q(`SELECT COUNT(*) n FROM opr`)
console.log(`  ${nbOpr} OPR chargés depuis l'export (${Date.now() - t}ms)`)

// ─── Points de prélèvement (PTP) du Sandre ────────────────────────────────────
//
// `CdNationalPTE` donne le code BSS (presque toujours au nouveau format) du
// point d'eau d'un PTP. Un PTP peut avoir plusieurs lignes, une par OPR auquel
// il a été connecté (`DateDebConnOuvPoint`/`DateFinConnOuvPoint`) : elles sont
// toutes gardées, le code BSS ne dépendant que du PTP.

t = Date.now()
await run(`
  CREATE TABLE ptp_sandre AS
  SELECT DISTINCT CdPointPrelevement AS code_ptp, CdOuvragePrel AS code_opr,
         NULLIF(trim(CdNationalPTE), '') AS code_pte
  FROM read_csv('${PTP_CSV}', header=true, all_varchar=true)
`)
await run(`
  CREATE TABLE ptp_opr AS
  SELECT DISTINCT o.code_opr, trim(p.code_ptp) AS code_ptp
  FROM opr o, unnest(string_split(o.code_ptp_sandre, '|')) AS p(code_ptp)
  WHERE trim(p.code_ptp) <> ''
`)
const [ptpStats] = await q(`
  SELECT COUNT(DISTINCT p.code_ptp) AS ptp,
         COUNT(DISTINCT p.code_ptp) FILTER (WHERE s.code_ptp IS NOT NULL) AS trouves,
         COUNT(DISTINCT p.code_ptp) FILTER (WHERE s.code_pte IS NOT NULL) AS avec_bss
  FROM ptp_opr p
  LEFT JOIN ptp_sandre s USING (code_ptp)
`)
console.log(
  `  ${ptpStats.ptp} PTP dans l'export, ${ptpStats.trouves} trouvés dans la couche Sandre, ` +
    `${ptpStats.avec_bss} avec un code BSS (${Date.now() - t}ms)`
)

// ─── AAC de chaque OPR ────────────────────────────────────────────────────────
//
// Le référentiel AAC du Sandre (champ `PTP` d'AAC.gpkg) est la source de
// vérité principale, l'export ne fait que le compléter (question 10 de
// plan-captages.md). Pour chaque OPR, dans cet ordre :
//   sandre          AAC qui citent un PTP de l'OPR (une AAC gelée ne compte pas
//                   pour un PTP qu'une AAC validée cite aussi, cf. regles_aac.js)
//   sandre_porteur  pour un rattaché sans AAC du Sandre, celles de son porteur
//   export          code_aac de l'OPR dans l'export
//   export_porteur  pour un rattaché, code_aac de son porteur
// Le code de l'export est ignoré dès que le Sandre donne une AAC à l'OPR ; s'il
// en diffère, c'est signalé (`aac_differente_sandre`). Un code de l'export
// absent d'AAC.gpkg est gardé tel quel (signalé en `aac_inconnue`), mais ne
// donne aucun lien captage → AAC.

t = Date.now()
await run(aacSandreSql(AAC_GPKG))
await run(`
  CREATE TABLE opr_aac_sandre AS
  SELECT DISTINCT p.code_opr, a.cdaac
  FROM ptp_opr p
  JOIN aac_ptp a USING (code_ptp)
`)
await run(`
  CREATE TABLE opr_aac AS
  WITH sandre AS (
    SELECT code_opr, cdaac AS code_aac, 'sandre' AS code_aac_source FROM opr_aac_sandre
  ),
  sandre_porteur AS (
    SELECT o.code_opr, s.cdaac AS code_aac, 'sandre_porteur' AS code_aac_source
    FROM opr o
    JOIN opr_aac_sandre s ON s.code_opr = o.opr_rattach
    WHERE o.code_opr NOT IN (SELECT code_opr FROM sandre)
  )
  SELECT * FROM sandre
  UNION ALL
  SELECT * FROM sandre_porteur
  UNION ALL
  SELECT code_opr, code_aac_export, code_aac_export_source
  FROM opr
  WHERE code_aac_export IS NOT NULL
    AND code_opr NOT IN (SELECT code_opr FROM sandre UNION ALL SELECT code_opr FROM sandre_porteur)
`)
const aacStats = await q(`
  SELECT code_aac_source, COUNT(DISTINCT code_opr) AS opr
  FROM opr_aac GROUP BY code_aac_source ORDER BY code_aac_source
`)
console.log(
  `  ${(await q('SELECT COUNT(*) n FROM aac_ptp'))[0].n} couples (AAC, PTP) dans AAC.gpkg ; OPR par origine de leur AAC : ` +
    aacStats.map((r) => `${r.code_aac_source} ${r.opr}`).join(', ') +
    ` (${Date.now() - t}ms)`
)

// ─── Résolution des codes en captages ─────────────────────────────────────────
//
// `code_ins`, `code_psv`, `code_bss` et `code_ptp_sandre` sont des listes
// séparées par `|`, dont les longueurs ne concordent pas toujours : elles sont
// traitées comme des ensembles de codes par OPR, normalisés puis cherchés dans
// la table des identifiants. Les PTP y sont cherchés par le code BSS que leur
// donne la couche Sandre.
//
// Un OPR est rattaché aux captages trouvés par le type de code le plus sûr qui
// en trouve au moins un : INS, sinon PSV, sinon BSS de ses PTP, sinon BSS de
// l'OPR dans l'export (ancien ou nouveau). Les codes PTP, plus récents, passent
// avant les codes BSS de l'OPR, gardés en secours. Un code d'un type moins sûr
// qui désigne un autre captage n'ajoute pas de lien : il est signalé dans le
// rapport d'anomalies. Un code PSV ou BSS qui désigne encore plusieurs
// captages après la préférence BRGM ci-dessous les rattache tous, et est
// aussi signalé.

t = Date.now()
await run(`
  CREATE TABLE codes_opr AS
  WITH brut AS (
    SELECT code_opr, 'INS' AS type_brut, trim(unnest(string_split(code_ins, '|'))) AS code_brut, NULL AS code_ptp FROM opr
    UNION ALL
    SELECT code_opr, 'PSV', trim(unnest(string_split(code_psv, '|'))), NULL FROM opr
    UNION ALL
    SELECT p.code_opr, 'PTP', s.code_pte, p.code_ptp
    FROM ptp_opr p
    JOIN (SELECT DISTINCT code_ptp, code_pte FROM ptp_sandre WHERE code_pte IS NOT NULL) s USING (code_ptp)
    UNION ALL
    SELECT code_opr, 'BSS', trim(unnest(string_split(code_bss, '|'))), NULL FROM opr
  )
  SELECT DISTINCT code_opr, type_brut, code_brut, code_ptp,
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
         CASE type_brut WHEN 'INS' THEN 1 WHEN 'PSV' THEN 2 WHEN 'PTP' THEN 3 ELSE 4 END AS rang
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
  SELECT c.code_opr, c.type_code, c.code, c.code_brut, c.code_ptp, c.rang, i.code_installation,
         CASE WHEN c.code_ptp IS NOT NULL THEN 'PTP_' || c.type_code ELSE c.type_code END AS type_lien,
         c.type_code || ' ' || c.code_brut || COALESCE(' (PTP ' || c.code_ptp || ')', '') AS libelle
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
         list_sort(list_distinct(list(c.type_lien))) AS resolu_par
  FROM correspondances c
  JOIN rang_retenu r ON r.code_opr = c.code_opr AND r.rang = c.rang
  GROUP BY c.code_opr, c.code_installation, c.rang
`)
// Les OPR qu'aucun code ne résout en captage (signalés en `opr_sans_captage`)
// y figurent aussi, avec `code_installation` vide : aac/fiches en tire les AAC
// citées par l'export, pour leur flag `prioritaire`.
await run(`
  COPY (
    SELECT o.code_opr, o.statut_opr, o.opr_rattach, a.code_aac, a.code_aac_source, o.code_aac_export,
           l.code_installation, l.resolu_par
    FROM opr o
    LEFT JOIN liens l USING (code_opr)
    LEFT JOIN opr_aac a USING (code_opr)
    ORDER BY o.code_opr, a.code_aac, l.code_installation
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
//                       (PTP sans code BSS, coordonnées seules, codes inconnus)
//   captage_eloigne_aac captage à plus de DISTANCE_MAX_AAC_M de l'AAC retenue
//                       pour son OPR (lien gardé quand même, cf. regles_aac.js)
//   captage_dans_autre_aac captage hors de l'AAC retenue pour son OPR, mais
//                       dans une autre AAC (autresAacSql, regles_aac.js)
//   aac_differente_sandre code_aac de l'export absent des AAC que le Sandre donne
//                       à l'OPR (signalé sur l'OPR qui porte le code, pas sur
//                       ses rattachés) : l'AAC du Sandre est retenue
//   code_autre_captage  code PSV ou BSS de l'OPR ou de ses PTP qui désigne un
//                       captage autre que ceux retenus pour l'OPR (cf. résolution
//                       ci-dessus)
//   code_ambigu         code PSV ou BSS retenu pour l'OPR qui désigne plusieurs
//                       captages, tous rattachés à l'OPR
//   ptp_inconnu         PTP de l'OPR absent de la couche Sandre
//   ptp_autre_opr       PTP de l'OPR que la couche Sandre connecte à d'autres OPR
//                       seulement

t = Date.now()
await run(
  autresAacSql(
    'dans_autre_aac',
    `SELECT oa.code_aac AS cdaac, l.code_installation, ST_Point(c.t1_psv_x, c.t1_psv_y) AS point_l93
     FROM liens l
     JOIN opr_aac oa USING (code_opr)
     JOIN read_parquet('${CAPTAGES}') c ON c.t1_code_ins = l.code_installation
     WHERE c.t1_psv_x IS NOT NULL AND c.t1_psv_y IS NOT NULL AND NOT (c.t1_psv_x = 0 AND c.t1_psv_y = 0)`
  )
)
await run(`
  CREATE TABLE anomalies AS
  SELECT 'aac_inconnue' AS anomalie, o.code_opr, NULL::VARCHAR AS code_installation, NULL::INTEGER AS distance_m,
         'code_aac « ' || o.code_aac_propre || ' » absent d''AAC.gpkg' AS detail
  FROM opr o
  WHERE o.code_aac_propre IS NOT NULL AND o.code_aac_propre NOT IN (SELECT cdaac FROM aac_sandre)

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
  SELECT 'captage_eloigne_aac', l.code_opr, l.code_installation,
         CAST(round(ST_Distance(ST_Point(c.t1_psv_x, c.t1_psv_y), a.geom_l93)) AS INTEGER),
         'AAC ' || oa.code_aac || ' (' || oa.code_aac_source || ')'
  FROM liens l
  JOIN opr_aac oa USING (code_opr)
  JOIN aac_sandre a ON a.cdaac = oa.code_aac
  JOIN read_parquet('${CAPTAGES}') c ON c.t1_code_ins = l.code_installation
  WHERE c.t1_psv_x IS NOT NULL AND c.t1_psv_y IS NOT NULL
    AND ST_Distance(ST_Point(c.t1_psv_x, c.t1_psv_y), a.geom_l93) > ${DISTANCE_MAX_AAC_M}

  UNION ALL
  SELECT 'captage_dans_autre_aac', l.code_opr, l.code_installation, d.distance_m,
         'AAC ' || oa.code_aac || ' (' || oa.code_aac_source || ') ; captage dans : ' || d.autres_aac_libelle
  FROM liens l
  JOIN opr_aac oa USING (code_opr)
  JOIN dans_autre_aac d ON d.cdaac = oa.code_aac AND d.code_installation = l.code_installation

  UNION ALL
  SELECT 'aac_differente_sandre', o.code_opr, NULL, NULL,
         'code_aac « ' || o.code_aac_propre || ' » de l''export ('
           || COALESCE(lower(e.statut) || ', mise à jour le ' || e.date_maj, 'absent d''AAC.gpkg')
           || ') remplacé par l''AAC du Sandre : '
           || string_agg(s.cdaac || ' (' || lower(a.statut) || ', mise à jour le ' || a.date_maj || ')', ', ' ORDER BY s.cdaac)
  FROM opr o
  JOIN opr_aac_sandre s USING (code_opr)
  JOIN aac_sandre a ON a.cdaac = s.cdaac
  LEFT JOIN aac_sandre e ON e.cdaac = o.code_aac_propre
  WHERE o.code_aac_propre IS NOT NULL
  GROUP BY o.code_opr, o.code_aac_propre, e.statut, e.date_maj
  HAVING NOT bool_or(s.cdaac = o.code_aac_propre)

  UNION ALL
  SELECT 'code_autre_captage', c.code_opr, c.code_installation, NULL,
         c.libelle || ' désigne ' || c.code_installation
           || ', hors des captages retenus pour l''OPR (' || r.retenus || ')'
  FROM correspondances c
  JOIN (
    SELECT code_opr, string_agg(code_installation, ', ' ORDER BY code_installation) AS retenus
    FROM liens GROUP BY code_opr
  ) r USING (code_opr)
  WHERE NOT EXISTS (
    SELECT 1 FROM liens l WHERE l.code_opr = c.code_opr AND l.code_installation = c.code_installation
  )
  -- un code BSS donné à la fois par un PTP et par l'OPR n'est signalé qu'une fois
  QUALIFY row_number() OVER (
    PARTITION BY c.code_opr, c.code_installation, c.type_code, c.code ORDER BY c.rang, c.code_ptp
  ) = 1

  UNION ALL
  SELECT 'code_ambigu', c.code_opr, NULL, NULL,
         c.libelle || ' désigne plusieurs captages, tous retenus ('
           || string_agg(DISTINCT c.code_installation, ', ' ORDER BY c.code_installation) || ')'
  FROM correspondances c
  JOIN (SELECT DISTINCT code_opr, rang FROM liens) r USING (code_opr, rang)
  WHERE c.rang > 1
  GROUP BY c.code_opr, c.libelle
  HAVING COUNT(DISTINCT c.code_installation) > 1

  UNION ALL
  SELECT 'ptp_inconnu', p.code_opr, NULL, NULL,
         'PTP « ' || p.code_ptp || ' » absent de la couche Sandre'
  FROM ptp_opr p
  WHERE p.code_ptp NOT IN (SELECT code_ptp FROM ptp_sandre)

  UNION ALL
  SELECT 'ptp_autre_opr', p.code_opr, NULL, NULL,
         'PTP « ' || p.code_ptp || ' » connecté dans la couche Sandre à '
           || string_agg(DISTINCT s.code_opr, ', ' ORDER BY s.code_opr)
  FROM ptp_opr p
  JOIN ptp_sandre s USING (code_ptp)
  GROUP BY p.code_opr, p.code_ptp
  HAVING NOT bool_or(s.code_opr = p.code_opr)
`)
await run(`
  COPY (
    SELECT a.anomalie, a.code_opr, o.statut_opr, o.opr_rattach, o.nom_sandre,
           (SELECT string_agg(code_aac, '|' ORDER BY code_aac) FROM opr_aac oa WHERE oa.code_opr = a.code_opr) AS code_aac,
           o.code_aac_export, a.code_installation, a.distance_m, a.detail
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
           COUNT(*) FILTER (WHERE o.code_opr IN (SELECT code_opr FROM opr_aac)) AS avec_aac,
           COUNT(*) FILTER (WHERE o.code_opr IN (SELECT code_opr FROM opr_aac WHERE code_aac_source LIKE 'sandre%')) AS aac_sandre
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
