#!/usr/bin/env node
/**
 * Valide un aac.parquet régénéré avant de l'envoyer sur S3 (étape 7 de
 * plan-captages.md), en le comparant à la version publiée.
 *
 * Contrôles bloquants (code de sortie 1 s'ils échouent) :
 *   - structure : une ligne par AAC, champs des installations présents
 *     (source_rattachement, recroisement_geographique, a_part, motif_a_part,
 *     libelle_a_part), nb_installations égal au nombre d'installations ;
 *   - cohérence des champs de rattachement : source connue,
 *     recroisement_geographique conforme à la source, a_part et son motif
 *     conformes à l'état et à l'usage de l'installation (règle de motifAPart,
 *     generate_aac_fiches_parquet.js) ;
 *   - couverture : chaque couple (AAC, captage) de captages_aac.parquet et
 *     chaque captage prioritaire de captages_prioritaires.parquet, pour son
 *     AAC, se retrouve dans les installations (code de l'installation ou d'un
 *     captage rattaché).
 *
 * Informations, à relire (rien de bloquant) :
 *   - totaux avant et après : AAC, installations, prioritaires, à part,
 *     captages actifs, AAC sans installation ;
 *   - AAC dont le nombre de captages change le plus, AAC qui perdent ou
 *     gagnent leur seule installation, AAC qui perdent ou gagnent le flag
 *     prioritaire ;
 *   - AAC à revérifier à la main (AAC_A_VERIFIER) : installations après.
 *
 * Écrit aussi output/validation_aac.csv : par AAC, captages et installations
 * avant et après, installations à part, flag prioritaire avant et après.
 *
 * Usage : node --env-file=.env fiches/valider_aac_fiches.js [aac.parquet après] [aac.parquet avant]
 *   après  défaut : fiches/output/aac.parquet (sortie de npm run fiches)
 *   avant  défaut : version publiée, lue sur S3 (s3://<S3_BUCKET>/<S3_PREFIX>/aac.parquet,
 *          où npm run upload l'envoie ; variables S3 de .env). Pas data/s3/aac.parquet :
 *          npm run fiches y copie sa sortie, avant et après seraient identiques.
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { dataPath } from '../../data-dir.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const { S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env
const S3_REGION = process.env.S3_REGION || 'fr-par'
const S3_ENDPOINT = process.env.S3_ENDPOINT || 's3.fr-par.scw.cloud'
const S3_PREFIX = process.env.S3_PREFIX || ''

const APRES = process.argv[2] ?? join(__dirname, 'output', 'aac.parquet')
const AVANT = process.argv[3] ?? (S3_BUCKET ? `s3://${S3_BUCKET}/${S3_PREFIX ? `${S3_PREFIX}/` : ''}aac.parquet` : null)
if (!AVANT) {
  console.error('Version publiée introuvable : renseigner les variables S3 (.env) ou passer le fichier « avant » en argument.')
  process.exit(1)
}
const CAPTAGES_AAC = dataPath('captages', 'captages_aac.parquet')
const CAPTAGES_PRIORITAIRES = dataPath('captages', 'captages_prioritaires.parquet')
const SORTIE_CSV = join(__dirname, 'output', 'validation_aac.csv')

// AAC à revoir à la main après chaque changement de règle : sous-estimées
// autrefois (5186 La Maxe), prises d'eau de surface (1549, 1600, 48, 490),
// liens fragiles notés dans plan-captages.md (5116, 5117), même champ captant
// (1694 La Couyère), retours utilisateurs du répertoire des erreurs (61, 1569).
const AAC_A_VERIFIER = ['5186', '1549', '1600', '48', '490', '5116', '5117', '1694', '61', '1569']

const SOURCES = ['sandre', 'export', 'champ_captant', 'point', 'perimetre', 'proximite']
const SOURCES_SURES = ['sandre', 'export']
const USAGES_EAU_POTABLE = ['ADDUCTION COLLECTIVE PUBLIQUE', 'ADDUCTION COLLECTIVE PRIVEE', "Projet concernant l'AEP"]
const CHAMPS_INSTALLATION = ['source_rattachement', 'recroisement_geographique', 'a_part', 'motif_a_part', 'libelle_a_part']

for (const file of [APRES, AVANT, CAPTAGES_AAC, CAPTAGES_PRIORITAIRES].filter((f) => !f.startsWith('s3://'))) {
  if (!existsSync(file)) {
    console.error(`Fichier introuvable : ${file}`)
    process.exit(1)
  }
}

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()
const run = (sql) => conn.run(sql)
const q = async (sql) =>
  (await conn.runAndReadAll(sql)).getRowObjects().map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))
  )
const sqlEscape = (value) => value.replaceAll("'", "''")
if (AVANT.startsWith('s3://')) {
  if (!S3_ACCESS_KEY || !S3_SECRET_KEY) {
    console.error('Variables manquantes pour lire la version publiée : S3_ACCESS_KEY, S3_SECRET_KEY')
    process.exit(1)
  }
  for (const stmt of [
    'INSTALL httpfs',
    'LOAD httpfs',
    `SET s3_endpoint='${sqlEscape(S3_ENDPOINT)}'`,
    `SET s3_region='${sqlEscape(S3_REGION)}'`,
    `SET s3_access_key_id='${sqlEscape(S3_ACCESS_KEY)}'`,
    `SET s3_secret_access_key='${sqlEscape(S3_SECRET_KEY)}'`,
    "SET s3_url_style='vhost'",
  ])
    await run(stmt)
}
const sqlList = (values) => values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ')

let erreurs = 0
const controle = async (libelle, sql, exemples = 5) => {
  const lignes = await q(sql)
  if (lignes.length === 0) {
    console.log(`  ✓ ${libelle}`)
    return
  }
  erreurs++
  console.log(`  ✗ ${libelle} : ${lignes.length} cas`)
  console.table(lignes.slice(0, exemples))
}

console.log('═══ Validation de aac.parquet ═══\n')
console.log(`  après : ${APRES}`)
console.log(`  avant : ${AVANT}\n`)

await run(`CREATE TABLE apres AS SELECT * FROM read_parquet('${APRES}')`)
await run(`CREATE TABLE avant AS SELECT * FROM read_parquet('${AVANT}')`)

// ─── Structure ────────────────────────────────────────────────────────────────

console.log('Structure')
const [{ column_type: typeInstallations }] = await q(`
  SELECT column_type FROM (DESCRIBE SELECT installations FROM apres)
`)
const champsManquants = CHAMPS_INSTALLATION.filter((c) => !new RegExp(`\\b${c} `).test(typeInstallations))
if (champsManquants.length > 0) {
  console.log(`  ✗ champs absents des installations : ${champsManquants.join(', ')}`)
  console.log('    (aac.parquet produit avant les règles du 16 novembre 2026 ?)')
  process.exit(1)
}
console.log('  ✓ champs des installations présents')

await controle('une ligne par AAC', `SELECT code, COUNT(*) AS lignes FROM apres GROUP BY code HAVING COUNT(*) > 1`)
await controle(
  'mêmes AAC qu\'avant',
  `SELECT code, 'absente après' AS cas FROM avant WHERE code NOT IN (SELECT code FROM apres)
   UNION ALL
   SELECT code, 'nouvelle' FROM apres WHERE code NOT IN (SELECT code FROM avant)`
)
await controle(
  'nb_installations égal au nombre d\'installations',
  `SELECT code, nb_installations, len(installations) AS installations
   FROM apres WHERE nb_installations IS DISTINCT FROM COALESCE(len(installations), 0)`
)

// ─── Cohérence des champs de rattachement ─────────────────────────────────────

await run(`
  CREATE TABLE inst AS
  SELECT code AS cdaac, unnest(installations) AS i FROM apres
`)
await run(`
  CREATE TABLE inst_apres AS
  SELECT cdaac, i.code AS code, i.nom AS nom, i.etat AS etat, i.usage AS usage,
         i.prioritaire AS prioritaire, i.source_rattachement AS source,
         i.recroisement_geographique AS recroisement,
         COALESCE(i.a_part, false) AS a_part, i.motif_a_part AS motif, i.libelle_a_part AS libelle,
         CASE
           WHEN NOT i.recroisement_geographique THEN NULL
           WHEN i.usage IS NOT NULL AND i.usage <> 'Abandon de l''usage AEP'
                AND i.usage NOT IN (${sqlList(USAGES_EAU_POTABLE)}) THEN 'autre_usage'
           WHEN i.usage = 'Abandon de l''usage AEP' OR starts_with(upper(i.etat), 'ABANDONN') THEN 'abandon_aep'
         END AS motif_attendu,
         len(i.captages_rattaches) AS nb_rattaches
  FROM inst
`)

console.log('\nCohérence des champs de rattachement')
await controle(
  'source_rattachement connue',
  `SELECT cdaac, code, source FROM inst_apres WHERE source IS NULL OR source NOT IN (${sqlList(SOURCES)})`
)
await controle(
  'recroisement_geographique conforme à la source',
  `SELECT cdaac, code, source, recroisement FROM inst_apres
   WHERE recroisement IS DISTINCT FROM (source NOT IN (${sqlList(SOURCES_SURES)}))`
)
await controle(
  'a_part et motif conformes à l\'état et à l\'usage',
  `SELECT cdaac, code, etat, usage, source, a_part, motif, motif_attendu FROM inst_apres
   WHERE motif IS DISTINCT FROM motif_attendu OR a_part <> (motif_attendu IS NOT NULL)`
)
await controle(
  'libelle_a_part renseigné pour chaque installation à part, et seulement pour elles',
  `SELECT cdaac, code, a_part, libelle FROM inst_apres WHERE a_part <> (libelle IS NOT NULL)`
)

// ─── Couverture ───────────────────────────────────────────────────────────────

await run(`
  CREATE TABLE captages_apres AS
  SELECT cdaac, i.code AS code_installation FROM inst
  UNION
  SELECT cdaac, unnest(i.captages_rattaches).code FROM inst
`)

console.log('\nCouverture')
await controle(
  'chaque lien de captages_aac.parquet est dans les installations',
  `SELECT l.cdaac, l.code_installation, l.source FROM read_parquet('${CAPTAGES_AAC}') l
   WHERE (l.cdaac, l.code_installation) NOT IN (SELECT (cdaac, code_installation) FROM captages_apres)`
)
await controle(
  'chaque captage prioritaire est dans les installations de son AAC',
  `SELECT DISTINCT p.code_aac, p.code_installation, p.code_opr FROM read_parquet('${CAPTAGES_PRIORITAIRES}') p
   WHERE p.code_installation IS NOT NULL AND p.code_aac IN (SELECT code FROM apres)
     AND (p.code_aac, p.code_installation) NOT IN (SELECT (cdaac, code_installation) FROM captages_apres)`
)
await controle(
  'chaque AAC citée par l\'export est prioritaire',
  `SELECT DISTINCT a.code FROM apres a
   JOIN read_parquet('${CAPTAGES_PRIORITAIRES}') p ON p.code_aac = a.code
   WHERE NOT a.prioritaire`
)

// ─── Avant / après ────────────────────────────────────────────────────────────

await run(`
  CREATE TABLE captages_avant AS
  WITH inst_avant AS (SELECT code AS cdaac, unnest(installations) AS i FROM avant)
  SELECT cdaac, i.code AS code_installation FROM inst_avant
  UNION
  SELECT cdaac, unnest(i.captages_rattaches).code FROM inst_avant
`)
await run(`
  CREATE TABLE par_aac AS
  SELECT a.code AS cdaac, a.nom,
         COALESCE(len(v.installations), 0) AS installations_avant,
         COALESCE(len(a.installations), 0) AS installations_apres,
         (SELECT COUNT(*) FROM captages_avant c WHERE c.cdaac = a.code) AS captages_avant,
         (SELECT COUNT(*) FROM captages_apres c WHERE c.cdaac = a.code) AS captages_apres,
         (SELECT COUNT(*) FROM inst_apres i WHERE i.cdaac = a.code AND i.a_part) AS a_part_apres,
         v.nb_captages_actifs AS actifs_avant, a.nb_captages_actifs AS actifs_apres,
         v.prioritaire AS prioritaire_avant, a.prioritaire AS prioritaire_apres
  FROM apres a
  LEFT JOIN avant v USING (code)
`)

const totaux = async (table, aPart) =>
  (
    await q(`
      SELECT COUNT(*) AS aac,
             SUM(COALESCE(len(installations), 0)) AS installations,
             SUM(len(list_filter(installations, lambda x: x.prioritaire))) AS installations_prioritaires,
             ${aPart ? 'SUM(len(list_filter(installations, lambda x: x.a_part)))' : 'NULL'} AS installations_a_part,
             COUNT(*) FILTER (WHERE prioritaire) AS aac_prioritaires,
             COUNT(*) FILTER (WHERE COALESCE(len(installations), 0) = 0) AS aac_sans_installation,
             SUM(nb_captages_actifs) AS captages_actifs
      FROM ${table}
    `)
  )[0]
console.log('\nTotaux')
console.table({ avant: await totaux('avant', false), apres: await totaux('apres', true) })

const [toutAPart] = await q(`
  SELECT COUNT(*) AS n FROM par_aac WHERE installations_apres > 0 AND a_part_apres = installations_apres
`)
console.log(`  ${toutAPart.n} AAC n'ont que des installations à part (elles restent des AAC avec captages)`)

console.log('\nAAC dont le nombre de captages baisse le plus')
console.table(
  await q(`
    SELECT cdaac, nom, captages_avant, captages_apres, installations_avant, installations_apres, a_part_apres
    FROM par_aac WHERE captages_apres < captages_avant
    ORDER BY captages_apres - captages_avant, cdaac LIMIT 15
  `)
)
console.log('AAC dont le nombre de captages augmente le plus')
console.table(
  await q(`
    SELECT cdaac, nom, captages_avant, captages_apres, installations_avant, installations_apres, a_part_apres
    FROM par_aac WHERE captages_apres > captages_avant
    ORDER BY captages_avant - captages_apres, cdaac LIMIT 15
  `)
)
const [mouvements] = await q(`
  SELECT COUNT(*) FILTER (WHERE captages_apres < captages_avant) AS aac_en_baisse,
         COUNT(*) FILTER (WHERE captages_apres > captages_avant) AS aac_en_hausse,
         COUNT(*) FILTER (WHERE captages_apres = captages_avant) AS aac_inchangees,
         string_agg(cdaac, ', ' ORDER BY TRY_CAST(cdaac AS INTEGER)) FILTER (WHERE installations_avant > 0 AND installations_apres = 0) AS perdent_tout,
         string_agg(cdaac, ', ' ORDER BY TRY_CAST(cdaac AS INTEGER)) FILTER (WHERE installations_avant = 0 AND installations_apres > 0) AS gagnent_une_premiere,
         string_agg(cdaac, ', ' ORDER BY TRY_CAST(cdaac AS INTEGER)) FILTER (WHERE prioritaire_avant AND NOT prioritaire_apres) AS perdent_prioritaire,
         string_agg(cdaac, ', ' ORDER BY TRY_CAST(cdaac AS INTEGER)) FILTER (WHERE NOT prioritaire_avant AND prioritaire_apres) AS gagnent_prioritaire
  FROM par_aac
`)
console.log(
  `  ${mouvements.aac_en_baisse} AAC en baisse, ${mouvements.aac_en_hausse} en hausse, ${mouvements.aac_inchangees} inchangées\n` +
    `  Perdent toutes leurs installations : ${mouvements.perdent_tout ?? 'aucune'}\n` +
    `  Gagnent une première installation : ${mouvements.gagnent_une_premiere ?? 'aucune'}\n` +
    `  Perdent le flag prioritaire : ${mouvements.perdent_prioritaire ?? 'aucune'}\n` +
    `  Gagnent le flag prioritaire : ${mouvements.gagnent_prioritaire ?? 'aucune'}`
)

// ─── AAC à revérifier ─────────────────────────────────────────────────────────

console.log('\nAAC à revérifier')
for (const cdaac of AAC_A_VERIFIER) {
  const [aac] = await q(`SELECT * FROM par_aac WHERE cdaac = '${cdaac}'`)
  if (!aac) {
    console.log(`  ${cdaac} : absente de aac.parquet`)
    continue
  }
  console.log(
    `  ${cdaac} ${aac.nom} : ${aac.captages_avant} → ${aac.captages_apres} captages, ` +
      `${aac.installations_avant} → ${aac.installations_apres} installations`
  )
  console.table(
    await q(`
      SELECT code, nom, etat, source, nb_rattaches, prioritaire, libelle AS a_part
      FROM inst_apres WHERE cdaac = '${cdaac}' ORDER BY a_part, nom LIMIT 20
    `)
  )
}

await run(`COPY (SELECT * FROM par_aac ORDER BY TRY_CAST(cdaac AS INTEGER), cdaac) TO '${SORTIE_CSV}' (HEADER)`)
console.log(`\nDétail par AAC : ${SORTIE_CSV}`)

if (erreurs > 0) {
  console.log(`\n✗ ${erreurs} contrôle(s) bloquant(s) en échec : ne pas envoyer aac.parquet sur S3.`)
  process.exitCode = 1
} else {
  console.log('\n✓ Contrôles bloquants passés. Relire les informations ci-dessus avant npm run upload.')
}
