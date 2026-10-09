#!/usr/bin/env node
/**
 * Génère `analyses_robinet.parquet` : une ligne par résultat d'analyse réalisée sur
 * un captage, à partir des fichiers « Résultats du contrôle sanitaire de
 * l'eau du robinet » (data.gouv.fr), enrichie avec les référentiels métier.
 * Produit aussi, à côté, `analyses_robinet_par_date.parquet` : une ligne par installation
 * et par date de prélèvement, avec ses indicateurs de dépassement.
 *
 * Sources (dans le sous-dossier `sources/` du dossier de travail) :
 *   - CAP_PLV_<période>.txt|csv   prélèvements sur captages (1 ligne / prélèvement)
 *   - CAP_RES_<période>.txt|csv   résultats d'analyses (N lignes / prélèvement)
 * Référentiels (dans le dossier de travail, téléchargés depuis S3 s'ils sont absents) :
 *   - parametres.json              code_parametre → libellé
 *   - substances_par_fonction.csv  substance → fonction (herbicide, …)
 *   - limite_qualite.csv           paramètre → limite de qualité
 *   - reference_qualite.csv        paramètre → référence de qualité
 *   - captages_prioritaires.csv    captages prioritaires (codes BSS et installations)
 *   - ref_cap_25avril2025.xlsx     référentiel des captages : code installation → code BSS
 * Référentiel versionné avec le script :
 *   - seuils_qualite_par_parametre.csv  code paramètre → limite et référence de qualité
 *
 * PLV et RES sont joints sur `referenceprel` au sein d'une même période. Les
 * enrichissements par paramètre sont calculés en JS (`referentiels.js`) puis
 * joints par DuckDB, qui gère seul les fichiers plus gros que la mémoire.
 *
 * Usage : node --env-file-if-exists=.env generate_analyses_parquet.js [dossier_travail] [sortie.parquet]
 *         (par défaut : data/ et <dossier_travail>/analyses_robinet.parquet ;
 *         analyses_robinet_par_date.parquet est écrit dans le même dossier que la sortie ;
 *         les sources sont toujours lues dans <dossier_travail>/sources/)
 *
 * Variables d'environnement (requises seulement si un référentiel manque) :
 *   S3_BUCKET      Bucket des référentiels
 *   S3_PREFIX      Préfixe des référentiels dans le bucket
 *   S3_ACCESS_KEY  Clé d'accès S3
 *   S3_SECRET_KEY  Clé secrète S3
 *   S3_REGION      Région S3 (défaut : fr-par)
 *   S3_ENDPOINT    Endpoint S3 (défaut : s3.fr-par.scw.cloud)
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'fs'
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { buildKeyValueMap, buildParametresEnrichis } from './referentiels.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORK_DIR = resolve(process.argv[2] ?? join(__dirname, 'data'))
const OUTPUT = resolve(process.argv[3] ?? join(WORK_DIR, 'analyses_robinet.parquet'))
const OUTPUT_PAR_DATE = join(dirname(OUTPUT), 'analyses_robinet_par_date.parquet')
const SOURCES_DIR = join(WORK_DIR, 'sources')
const input = (name) => join(WORK_DIR, name)
const SEUILS_PAR_PARAMETRE = join(__dirname, 'seuils_qualite_par_parametre.csv')

// Lignes par row group du fichier produit (voir « Assemblage final »).
const ROW_GROUP_SIZE = 1_000_000

const SOURCE_PATTERN = /^CAP_(PLV|RES)_(\d+)\.(csv|txt)$/i

// Règles de dépassement de Viz'eau, recopiées de `app/services/aac_service.ts`
// (`SQL_DEP_REGL`, `SQL_DEP_ALERTE`) : elles servent seulement à contrôler les
// colonnes `dep_regl` / `dep_alerte`. À garder synchronisées avec l'application.
const seuilSql = (colonne, motif) =>
  `TRY_CAST(replace(regexp_extract(${colonne}, '${motif}', 1), ',', '.') AS DOUBLE)`
const REGL = seuilSql('limite_qualite', '<=([0-9][0-9,.]*)')
const ALERTE_MAX = seuilSql('reference_qualite', '<=([0-9][0-9,.]*)')
const ALERTE_RANGE_MIN = seuilSql('reference_qualite', '>=([0-9][0-9,.]*) et')
const ALERTE_RANGE_MAX = seuilSql('reference_qualite', 'et <=([0-9][0-9,.]*)')
const SQL_DEP_REGL = `${REGL} IS NOT NULL AND resultat_traduction IS NOT NULL AND resultat_traduction > ${REGL}`
const SQL_DEP_ALERTE =
  `(${ALERTE_MAX} IS NOT NULL AND resultat_traduction IS NOT NULL AND resultat_traduction > ${ALERTE_MAX})` +
  ` OR (${ALERTE_RANGE_MIN} IS NOT NULL AND resultat_traduction IS NOT NULL` +
  ` AND (resultat_traduction < ${ALERTE_RANGE_MIN} OR resultat_traduction > ${ALERTE_RANGE_MAX}))`

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`

// ─── Découverte des fichiers ─────────────────────────────────────────────────

if (!existsSync(SOURCES_DIR)) throw new Error(`Dossier des sources introuvable : ${SOURCES_DIR}`)

// Regroupe les fichiers par période ; si un CSV et un TXT existent pour la
// même période, le CSV est prioritaire.
const sources = new Map()
for (const file of (await readdir(SOURCES_DIR)).sort()) {
  const match = file.match(SOURCE_PATTERN)
  if (!match) continue
  const [, type, periode, ext] = match
  const entry = sources.get(periode) ?? {}
  const key = type.toUpperCase()
  if (!entry[key] || ext.toLowerCase() === 'csv') entry[key] = join(SOURCES_DIR, file)
  sources.set(periode, entry)
}

const periodes = [...sources.keys()].sort()
if (periodes.length === 0) throw new Error(`Aucun fichier CAP_PLV_* / CAP_RES_* (csv/txt) dans ${SOURCES_DIR}`)
for (const periode of periodes) {
  const { PLV, RES } = sources.get(periode)
  if (!PLV || !RES) throw new Error(`Fichier CAP_${PLV ? 'RES' : 'PLV'}_${periode} manquant (période ${periode})`)
}
const plvFiles = periodes.map((p) => sources.get(p).PLV)
const resFiles = periodes.map((p) => sources.get(p).RES)

// ─── Référentiels (S3) ───────────────────────────────────────────────────────
//
// Les référentiels absents du dossier de travail sont téléchargés depuis S3,
// octet pour octet (certains CSV sont mal formés et ne survivraient pas à une
// relecture/réécriture). Ceux déjà présents sont réutilisés tels quels.

const REF_CAP = 'ref_cap_25avril2025.xlsx'
const REFERENTIELS = [
  'parametres.json',
  'substances_par_fonction.csv',
  'limite_qualite.csv',
  'reference_qualite.csv',
  'captages_prioritaires.csv',
  REF_CAP,
]

const S3_BUCKET = process.env.S3_BUCKET
const S3_PREFIX = process.env.S3_PREFIX
const S3_ACCESS = process.env.S3_ACCESS_KEY
const S3_SECRET = process.env.S3_SECRET_KEY
const S3_REGION = process.env.S3_REGION || 'fr-par'
const S3_ENDPOINT = process.env.S3_ENDPOINT || 's3.fr-par.scw.cloud'
const s3src = (name) => `s3://${S3_BUCKET}/${S3_PREFIX ? `${S3_PREFIX}/${name}` : name}`

console.log('═══ Génération de analyses_robinet.parquet et analyses_robinet_par_date.parquet ═══\n')

const aTelecharger = REFERENTIELS.filter((name) => !existsSync(input(name)))
for (const name of REFERENTIELS.filter((n) => !aTelecharger.includes(n))) {
  console.log(`  ✓ ${name} (déjà présent)`)
}
if (aTelecharger.length > 0) {
  if (!S3_ACCESS || !S3_SECRET) {
    throw new Error(
      `Référentiel(s) absent(s) de ${WORK_DIR} : ${aTelecharger.join(', ')}. ` +
        'Renseigner S3_ACCESS_KEY et S3_SECRET_KEY dans .env pour les télécharger.'
    )
  }
  const s3 = await (await DuckDBInstance.create(':memory:')).connect()
  for (const stmt of [
    'INSTALL httpfs',
    'LOAD httpfs',
    `SET s3_endpoint = ${sqlString(S3_ENDPOINT)}`,
    `SET s3_region = ${sqlString(S3_REGION)}`,
    `SET s3_access_key_id = ${sqlString(S3_ACCESS)}`,
    `SET s3_secret_access_key = ${sqlString(S3_SECRET)}`,
    "SET s3_url_style = 'vhost'",
  ]) {
    await s3.run(stmt)
  }
  for (const name of aTelecharger) {
    process.stdout.write(`  ↓ ${s3src(name)}...`)
    const t = Date.now()
    const [[blob]] = (await s3.runAndReadAll(`SELECT content FROM read_blob(${sqlString(s3src(name))})`)).getRows()
    await writeFile(input(name), blob.bytes)
    console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`)
  }
  s3.closeSync()
}
console.log()

// Le détecteur de DuckDB se trompe sur certains référentiels (ex. il choisit
// `|` pour limite_qualite.csv) : on impose le séparateur, déduit de la
// première ligne.
async function detectDelimiter(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]
    const count = (char) => firstLine.split(char).length - 1
    return count(';') > count(',') ? ';' : ','
  } finally {
    await handle.close()
  }
}

// Les référentiels sont lus de façon tolérante (lignes plus courtes ou plus
// longues acceptées) : limite_qualite.csv contient par exemple des `\;` dans
// ses notes. Seules leurs premières colonnes sont exploitées.
const REF_OPTIONS = ', strict_mode=false, null_padding=true, parallel=false'

const readCsv = async (file, options = REF_OPTIONS) => {
  const delim = await detectDelimiter(file)
  return `read_csv(${sqlString(file)}, header=true, all_varchar=true, delim=${sqlString(delim)}, quote='"'${options})`
}

// ─── DuckDB ──────────────────────────────────────────────────────────────────

// Base temporaire sur disque : les tables intermédiaires (notamment RES, qui
// peut dépasser plusieurs Go) ne sont pas limitées par la mémoire disponible.
const workDir = await mkdtemp(join(tmpdir(), 'analyses-parquet-'))
const instance = await DuckDBInstance.create(join(workDir, 'work.duckdb'))
const conn = await instance.connect()
const run = (sql) => conn.run(sql)
const q = (sql) => conn.runAndReadAll(sql).then((r) => r.getRowObjectsJson())
const rows = (sql) => conn.runAndReadAll(sql).then((r) => r.getRowsJson())

console.log(`  ${periodes.length} période(s) : ${periodes.join(', ')}`)

try {
  await run(`SET temp_directory = ${sqlString(join(workDir, 'spill'))}`)

  // Valeur texte nettoyée (NULL si vide) et conversion numérique tolérante
  // aux espaces et à la virgule décimale.
  await run(`CREATE MACRO txt(v) AS NULLIF(trim(v), '')`)
  await run(`CREATE MACRO num(v) AS TRY_CAST(replace(regexp_replace(v, '\\s', '', 'g'), ',', '.') AS DOUBLE)`)

  // ─── Prélèvements (PLV) et résultats d'analyses (RES) ─────────────────────
  //
  // Chargés fichier par fichier (DuckDB ne sait pas relever les lignes
  // rejetées en lisant plusieurs fichiers à la fois). Seules les colonnes
  // utiles sont gardées, en texte : les conversions de type se font à
  // l'assemblage, pour pouvoir compter les valeurs non convertibles.

  const PLV_COLUMNS = {
    referenceprel: 'referenceprel',
    code_insee: 'inseecommune',
    nom_commune: 'nomcommune',
    code_installation: 'cdreseau',
    nom_installation: 'nomreseau',
    dateprel: 'dateprel',
    heure_prelevement: 'heureprel',
    code_brgm: 'codebrgm',
  }

  const RES_COLUMNS = {
    referenceprel: 'referenceprel',
    cdparametre: 'cdparametre',
    resultat: 'rqana',
    rsana: 'rsana',
    code_unite: 'cdunitereferencesiseeaux',
  }

  async function loadSource(table, columns, files) {
    const t = Date.now()
    await run(`CREATE TABLE ${table} (periode VARCHAR, ${Object.keys(columns).map((c) => `${c} VARCHAR`).join(', ')})`)
    for (const [i, file] of files.entries()) {
      const source = await readCsv(file, ', store_rejects=true')
      const present = new Set((await q(`DESCRIBE SELECT * FROM ${source}`)).map((c) => c.column_name))
      const missing = Object.values(columns).filter((c) => !present.has(c))
      if (missing.includes('referenceprel')) throw new Error(`Colonne referenceprel absente de ${file}`)
      if (missing.length > 0) console.warn(`  ⚠️ Colonne(s) absente(s) de ${file} : ${missing.join(', ')}`)

      const select = Object.entries(columns).map(([alias, col]) => (present.has(col) ? `txt("${col}")` : 'NULL') + ` AS ${alias}`)
      await run(`INSERT INTO ${table} SELECT ${sqlString(periodes[i])}, ${select.join(', ')} FROM ${source}`)

      // `reject_errors` cumule les lectures successives et compte une entrée
      // par colonne en erreur : on compte les lignes distinctes du dernier scan.
      const [{ n: rejets }] = await q(`
        SELECT COUNT(DISTINCT line) n FROM reject_errors
        WHERE scan_id = (SELECT max(scan_id) FROM reject_scans)
      `)
      if (Number(rejets) > 0) console.warn(`  ⚠️ ${rejets} ligne(s) mal formée(s) ignorée(s) dans ${file}`)
    }
    const [{ n }] = await q(`SELECT COUNT(*) n FROM ${table}`)
    console.log(`  ${n} lignes ${table.toUpperCase()} chargées (${Date.now() - t}ms)`)
  }

  await loadSource('plv', PLV_COLUMNS, plvFiles)
  await loadSource('res', RES_COLUMNS, resFiles)

  // Les fichiers mensuels republient des prélèvements déjà parus (à
  // l'identique, résultats compris) : un prélèvement n'est gardé que dans sa
  // période la plus récente, pour ne pas dupliquer ses analyses.
  await run(`
    CREATE TABLE doublons AS
    SELECT referenceprel, periode FROM plv
    QUALIFY periode < max(periode) OVER (PARTITION BY referenceprel)
  `)
  const [{ n: nbDoublons }] = await q(`SELECT COUNT(DISTINCT referenceprel) n FROM doublons`)
  if (Number(nbDoublons) > 0) {
    for (const table of ['plv', 'res']) {
      await run(`
        DELETE FROM ${table} USING doublons d
        WHERE ${table}.referenceprel = d.referenceprel AND ${table}.periode = d.periode
      `)
    }
    console.log(`  ${nbDoublons} prélèvement(s) présent(s) dans plusieurs périodes : seule la plus récente est gardée`)
  }

  // ─── Enrichissement par paramètre ──────────────────────────────────────────
  //
  // Libellé, limite et référence de qualité ne dépendent que du code
  // paramètre : calculés une fois par paramètre en JS (correspondances
  // floues), puis joints aux analyses. Il en va de même des seuils
  // numériques, extraits de la limite et de la référence de qualité. La fonction du paramètre n'est pas
  // écrite dans la sortie : elle sert seulement de clé de repli pour trouver
  // les limites et références de qualité.
  //
  // Limite et référence de qualité sont d'abord lues par code paramètre dans
  // `seuils_qualite_par_parametre.csv`, qui fait foi pour les codes qu'il
  // contient (y compris quand il n'indique aucun seuil). Les correspondances
  // floues ne servent que pour les paramètres qui n'y figurent pas.

  let t = Date.now()
  const keyValueRows = async (file) => rows(`SELECT * FROM ${await readCsv(file)}`)
  const substancesParFonction = (
    await q(`SELECT * FROM ${await readCsv(input('substances_par_fonction.csv'))}`)
  ).map((s) => ({
    substance: s.substance || s.Substance,
    fonction: s['Fonction retenue'] || s.fonction,
  }))

  const seuilsParCode = new Map(
    (
      await q(`
        SELECT code_parametre, limite_qualite, reference_qualite
        FROM read_csv(${sqlString(SEUILS_PAR_PARAMETRE)}, header=true, all_varchar=true)
      `)
    ).map((l) => [
      String(Number(l.code_parametre)),
      { limite_qualite: l.limite_qualite ?? '', reference_qualite: l.reference_qualite ?? '' },
    ])
  )

  const { lignes, approximations, codesSansSeuilConnu } = buildParametresEnrichis({
    parametres: JSON.parse(await readFile(input('parametres.json'), 'utf8')),
    substancesParFonction,
    limitesQualite: buildKeyValueMap(await keyValueRows(input('limite_qualite.csv'))),
    referencesQualite: buildKeyValueMap(await keyValueRows(input('reference_qualite.csv'))),
    seuilsParCode,
  })

  await run(`
    CREATE TABLE parametres (
      code_parametre DOUBLE, libelle_parametre VARCHAR,
      limite_qualite VARCHAR, reference_qualite VARCHAR,
      seuil_regl DOUBLE, seuil_alerte_min DOUBLE, seuil_alerte_max DOUBLE
    )
  `)
  const appender = await conn.createAppender('parametres')
  for (const l of lignes) {
    const code = Number(l.code_parametre)
    if (Number.isNaN(code)) continue
    appender.appendDouble(code)
    for (const col of ['libelle_parametre', 'limite_qualite', 'reference_qualite']) {
      if (l[col] === null) appender.appendNull()
      else appender.appendVarchar(l[col])
    }
    for (const col of ['seuil_regl', 'seuil_alerte_min', 'seuil_alerte_max']) {
      if (l[col] === null) appender.appendNull()
      else appender.appendDouble(l[col])
    }
    appender.endRow()
  }
  appender.closeSync()

  // Un même code peut apparaître plusieurs fois dans parametres.json : seul
  // le dernier est conservé (comme `buildParametresEnrichis`, qui écrase).
  await run(`
    CREATE TABLE parametres_uniques AS
    SELECT * FROM parametres QUALIFY ROW_NUMBER() OVER (PARTITION BY code_parametre ORDER BY rowid DESC) = 1
  `)
  console.log(`  ${lignes.length} paramètres enrichis (${Date.now() - t}ms)`)
  const approxParChamp = Object.groupBy(approximations, (a) => a.champ)
  for (const [champ, liste] of Object.entries(approxParChamp)) {
    console.log(`    dont ${liste.length} ${champ} trouvée(s) par correspondance approchée (non exacte)`)
  }

  // Paramètres mesurés absents du référentiel des seuils : leurs seuils
  // viennent des correspondances floues et méritent d'être vérifiés, puis
  // ajoutés au référentiel.
  const sansSeuilConnu = new Set(codesSansSeuilConnu)
  const mesuresSansSeuilConnu = (
    await rows(`SELECT DISTINCT num(cdparametre) FROM res WHERE num(cdparametre) IS NOT NULL ORDER BY 1`)
  )
    .map(([code]) => String(code))
    .filter((code) => sansSeuilConnu.has(code))
  if (mesuresSansSeuilConnu.length > 0) {
    console.warn(
      `  ⚠️ ${mesuresSansSeuilConnu.length} paramètre(s) mesuré(s) absent(s) de seuils_qualite_par_parametre.csv ` +
        `(seuils déduits du libellé) : ${mesuresSansSeuilConnu.slice(0, 20).join(', ')}` +
        (mesuresSansSeuilConnu.length > 20 ? ', …' : '')
    )
  }

  // ─── Captages prioritaires ─────────────────────────────────────────────────
  //
  // Une installation est prioritaire si son code figure dans `INS`, ou si
  // le captage correspondant figure dans `CodeBss`. Le statut vaut pour
  // toutes les lignes de l'installation, même si son code BRGM change d'un
  // prélèvement à l'autre (ancien puis nouveau format BSS). Les deux
  // colonnes peuvent lister plusieurs codes séparés par `|`, `;` ou `,`.
  // Les codes `INS` ont souvent perdu leurs zéros initiaux (`18000096` pour
  // `018000096`) et sont parfois préfixés (`Sise021000257`) : ils sont
  // ramenés aux 9 chiffres des codes installation.
  //
  // `CodeBss` utilise les nouveaux identifiants BSS (`BSS000HXVV`), alors
  // que PLV ne donne que l'ancien code BRGM (`01193X0172`) : le lien passe
  // donc par `ref_cap`, qui associe à chaque installation son identifiant BSS
  // (`bss_id_en_bss`). Le code BRGM des prélèvements est aussi comparé
  // directement, pour les quelques captages encore listés sous l'ancien
  // format : il suffit qu'un prélèvement corresponde.

  t = Date.now()
  await run('INSTALL excel')
  await run('LOAD excel')
  await run(`
    CREATE TABLE ref_cap AS
    SELECT DISTINCT trim(code_installation) AS code_installation, upper(trim(bss_id_en_bss)) AS bss_id
    FROM read_xlsx(${sqlString(input(REF_CAP))}, all_varchar=true)
    WHERE trim(code_installation) <> '' AND trim(bss_id_en_bss) <> ''
  `)
  await run(`
    CREATE TABLE captages_prioritaires AS
    SELECT DISTINCT 'bss' AS type, upper(trim(code)) AS code
    FROM (SELECT unnest(string_split_regex(CodeBss, '[|;,]')) AS code
          FROM ${await readCsv(input('captages_prioritaires.csv'))})
    WHERE trim(code) <> ''
    UNION
    SELECT DISTINCT 'ins' AS type, CASE WHEN length(code) < 9 THEN lpad(code, 9, '0') ELSE code END AS code
    FROM (SELECT regexp_replace(trim(unnest(string_split_regex(INS, '[|;,]'))), '^[^0-9]+', '') AS code
          FROM ${await readCsv(input('captages_prioritaires.csv'))})
    WHERE trim(code) <> ''
  `)
  await run(`
    INSERT INTO captages_prioritaires
    SELECT DISTINCT 'ins', code_installation FROM ref_cap
    WHERE bss_id IN (SELECT code FROM captages_prioritaires WHERE type = 'bss')
      AND code_installation NOT IN (SELECT code FROM captages_prioritaires WHERE type = 'ins')
  `)

  await run(`
    CREATE TABLE installations_prioritaires AS
    SELECT DISTINCT p.code_installation
    FROM plv p
    WHERE p.code_installation IN (SELECT code FROM captages_prioritaires WHERE type = 'ins')
       OR EXISTS (
         SELECT 1 FROM unnest(string_split_regex(upper(p.code_brgm), '[|;,]')) AS t(code)
         WHERE trim(t.code) IN (SELECT code FROM captages_prioritaires WHERE type = 'bss')
       )
  `)
  const [{ n: nbInsPrio }] = await q(`SELECT COUNT(*) n FROM installations_prioritaires`)
  console.log(`  ${nbInsPrio} installations prélevées rattachées à un captage prioritaire (${Date.now() - t}ms)`)

  // ─── Assemblage final ──────────────────────────────────────────────────────
  //
  // Trié par installation puis par date : les lecteurs (DuckDB sur S3) peuvent
  // alors écarter, grâce aux min/max de chaque row group, tout ce qui ne
  // concerne pas les installations ou les dates demandées. Une installation
  // (quelques milliers de lignes) tient ainsi dans un ou deux row groups.
  // Trié et compressé en ZSTD, un row group d'un million de lignes ne pèse
  // qu'un Mo environ : des row groups plus petits ne réduisent pas ce qu'une
  // requête sur une installation lit, mais multiplient les requêtes HTTP des
  // lectures complètes (environ dix fois plus avec 100 000 lignes).
  //
  // Les indicateurs de dépassement valent `false` (et non NULL) quand il n'y a
  // pas de seuil ou pas de valeur. Le résultat est d'abord matérialisé dans la
  // table `analyses`, puis écrit dans l'ordre de la table (insertion order
  // préservé par DuckDB) : le tri n'est fait qu'une fois, et la table peut
  // servir à d'autres fichiers sans relire le Parquet.

  t = Date.now()
  await run(`
    CREATE TABLE analyses AS
    WITH lignes AS (
      SELECT
        p.code_insee,
        p.nom_commune,
        p.code_installation,
        p.nom_installation,
        TRY_CAST(p.dateprel AS DATE)                   AS date_prelevement,
        p.heure_prelevement,
        p.code_brgm,
        num(r.cdparametre)                             AS code_parametre,
        r.resultat,
        num(r.rsana)                                   AS resultat_traduction,
        r.code_unite,
        pa.libelle_parametre,
        pa.limite_qualite,
        pa.reference_qualite,
        ip.code_installation IS NOT NULL               AS captage_prioritaire,
        pa.seuil_regl,
        pa.seuil_alerte_min,
        pa.seuil_alerte_max
      FROM plv p
      JOIN res r USING (periode, referenceprel)
      LEFT JOIN parametres_uniques pa ON pa.code_parametre = num(r.cdparametre)
      LEFT JOIN installations_prioritaires ip ON ip.code_installation = p.code_installation
    )
    SELECT
      *,
      COALESCE(resultat_traduction > seuil_regl, false) AS dep_regl,
      COALESCE(resultat_traduction > seuil_alerte_max OR resultat_traduction < seuil_alerte_min, false) AS dep_alerte
    FROM lignes
    ORDER BY code_installation, date_prelevement, heure_prelevement, code_parametre
  `)
  console.log(`\n  Table analyses construite (${Date.now() - t}ms)`)

  t = Date.now()
  await run(`
    COPY analyses TO ${sqlString(OUTPUT)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})
  `)
  console.log(`  Fichier écrit : ${OUTPUT} (${Date.now() - t}ms)`)

  // ─── Agrégats par installation et par date ─────────────────────────────────
  //
  // Une « analyse » pour Viz'eau est une date de prélèvement d'une
  // installation : ce fichier lui évite de relire le fichier brut en entier
  // pour savoir quelles dates sont en dépassement. Les deux indicateurs sont
  // gardés tels quels : la règle « une date en dépassement réglementaire et
  // d'alerte compte en réglementaire » reste appliquée par l'application.
  // `dep_regl` / `dep_alerte` ne valant jamais NULL, leurs agrégats non plus.
  // À publier en même temps que `analyses_robinet.parquet`.

  t = Date.now()
  await run(`
    COPY (
      SELECT
        code_installation,
        date_prelevement,
        BOOL_OR(dep_regl)   AS dep_regl,
        BOOL_OR(dep_alerte) AS dep_alerte
      FROM analyses
      WHERE code_installation IS NOT NULL AND date_prelevement IS NOT NULL
      GROUP BY ALL
      ORDER BY code_installation, date_prelevement
    ) TO ${sqlString(OUTPUT_PAR_DATE)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})
  `)
  console.log(`  Fichier écrit : ${OUTPUT_PAR_DATE} (${Date.now() - t}ms)`)

  // ─── Contrôles ─────────────────────────────────────────────────────────────

  // Valeurs présentes dans la source mais non convertibles : signalées plutôt
  // que silencieusement remplacées par NULL.
  const CONVERSIONS = [
    ['date_prelevement', 'plv', 'dateprel', 'TRY_CAST(dateprel AS DATE)'],
    ['code_parametre', 'res', 'cdparametre', 'num(cdparametre)'],
    ['resultat_traduction', 'res', 'rsana', 'num(rsana)'],
  ]
  for (const [colonne, table, source, conversion] of CONVERSIONS) {
    const [{ n, exemples }] = await q(`
      SELECT COUNT(*) n, list(DISTINCT ${source})[1:3] exemples
      FROM ${table} WHERE ${source} IS NOT NULL AND ${conversion} IS NULL
    `)
    if (Number(n) > 0) {
      console.warn(`  ⚠️ ${n} valeur(s) non convertible(s) pour ${colonne}, mises à NULL (ex. : ${exemples.join(', ')})`)
    }
  }

  const [stats] = await q(`
    SELECT
      COUNT(*)                             AS lignes,
      COUNT(DISTINCT code_installation)    AS installations,
      COUNT(libelle_parametre)             AS avec_libelle,
      COUNT(limite_qualite)                AS avec_limite_qualite,
      COUNT(reference_qualite)             AS avec_reference_qualite,
      COUNT(seuil_regl)                    AS avec_seuil_regl,
      COUNT(seuil_alerte_max)              AS avec_seuil_alerte,
      COUNT_IF(dep_regl)                   AS dep_regl,
      COUNT_IF(dep_alerte)                 AS dep_alerte,
      COUNT_IF(captage_prioritaire)        AS captage_prioritaire
    FROM read_parquet(${sqlString(OUTPUT)})
  `)
  console.log('\n═══ Résumé ═══')
  console.log(stats)

  // Les règles de dépassement existent aussi dans Viz'eau, qui les applique
  // aux colonnes texte : on les recalcule ici avec ses expressions
  // (`SQL_DEP_REGL` / `SQL_DEP_ALERTE`), aucune différence n'est attendue.
  const [ecarts] = await q(`
    SELECT
      COUNT_IF(dep_regl <> COALESCE(${SQL_DEP_REGL}, false))     AS ecarts_dep_regl,
      COUNT_IF(dep_alerte <> COALESCE(${SQL_DEP_ALERTE}, false)) AS ecarts_dep_alerte
    FROM read_parquet(${sqlString(OUTPUT)})
  `)
  if (Number(ecarts.ecarts_dep_regl) > 0 || Number(ecarts.ecarts_dep_alerte) > 0) {
    console.warn(`  ⚠️ Indicateurs de dépassement différents des règles de Viz'eau :`, ecarts)
  } else {
    console.log(`  ✓ dep_regl / dep_alerte identiques aux règles de Viz'eau`)
  }

  // Découpage du fichier : un tri cassé se voit au nombre de row groups dont
  // la plage min/max de code_installation couvre chaque installation.
  const [decoupage] = await q(`
    WITH rg AS (
      SELECT row_group_id, row_group_num_rows, stats_min_value AS mini, stats_max_value AS maxi
      FROM parquet_metadata(${sqlString(OUTPUT)})
      WHERE path_in_schema = 'code_installation'
    ),
    par_installation AS (
      SELECT i.code_installation, COUNT(rg.row_group_id) AS n
      FROM (SELECT DISTINCT code_installation FROM read_parquet(${sqlString(OUTPUT)})
            WHERE code_installation IS NOT NULL) i
      LEFT JOIN rg ON i.code_installation BETWEEN rg.mini AND rg.maxi
      GROUP BY ALL
    )
    SELECT
      (SELECT COUNT(*) FROM rg)                              AS row_groups,
      (SELECT round(AVG(row_group_num_rows)) FROM rg)        AS lignes_par_row_group,
      round(AVG(n), 2)                                       AS row_groups_par_installation_moyen,
      MAX(n)                                                 AS row_groups_par_installation_max
    FROM par_installation
  `)
  console.log(decoupage)

  const [statsDates] = await q(`
    SELECT
      COUNT(*)                                  AS dates,
      COUNT(DISTINCT code_installation)         AS installations,
      COUNT_IF(dep_regl)                        AS dates_dep_regl,
      COUNT_IF(dep_alerte)                      AS dates_dep_alerte,
      COUNT_IF(dep_alerte AND NOT dep_regl)     AS dates_dep_alerte_seule
    FROM read_parquet(${sqlString(OUTPUT_PAR_DATE)})
  `)
  console.log('\n═══ analyses_robinet_par_date.parquet ═══')
  console.log(statsDates)

  // Agrégats recalculés comme la CTE `date_flags` de Viz'eau, sur le fichier
  // brut et avec ses expressions : chaque couple installation × date doit s'y
  // retrouver avec les mêmes indicateurs.
  const [ecartsDates] = await q(`
    WITH attendu AS (
      SELECT
        code_installation,
        date_prelevement,
        BOOL_OR(COALESCE(${SQL_DEP_REGL}, false))   AS dep_regl,
        BOOL_OR(COALESCE(${SQL_DEP_ALERTE}, false)) AS dep_alerte
      FROM read_parquet(${sqlString(OUTPUT)})
      GROUP BY code_installation, date_prelevement
    )
    SELECT COUNT(*) AS ecarts
    FROM attendu a
    FULL JOIN read_parquet(${sqlString(OUTPUT_PAR_DATE)}) d
      ON a.code_installation = d.code_installation AND a.date_prelevement = d.date_prelevement
    WHERE a.code_installation IS NULL OR d.code_installation IS NULL
       OR a.dep_regl <> d.dep_regl OR a.dep_alerte <> d.dep_alerte
  `)
  if (Number(ecartsDates.ecarts) > 0) {
    console.warn(`  ⚠️ ${ecartsDates.ecarts} couple(s) installation × date différent(s) du calcul de Viz'eau sur le fichier brut`)
  } else {
    console.log(`  ✓ Agrégats identiques au calcul de Viz'eau sur le fichier brut`)
  }
} finally {
  conn.closeSync()
  instance.closeSync()
  await rm(workDir, { recursive: true, force: true })
}
