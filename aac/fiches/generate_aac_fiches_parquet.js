#!/usr/bin/env node
/**
 * Pipeline complet AAC :
 *   1. Télécharge depuis S3 vers data/s3/ les fichiers source absents
 *      (aac_hilbert.parquet y est déjà si geometries a été lancé)
 *   2. Génère les fiches AAC (5 phases DuckDB + assemblage JS)
 *   3. Écrit le fichier aac.parquet dans fiches/output/ (copie dans data/s3/).
 *      L'envoi sur S3 se fait à part : npm run upload
 *
 * Usage : node --env-file=.env generate_aac_fiches_parquet.js
 *
 * Variables d'environnement :
 *   S3_BUCKET        Bucket source (fichiers input) — requis
 *   S3_ACCESS_KEY    Clé d'accès S3 — requis
 *   S3_SECRET_KEY    Clé secrète S3 — requis
 *   S3_REGION        Région S3 (défaut : fr-par)
 *   S3_ENDPOINT      Endpoint S3 (défaut : s3.fr-par.scw.cloud)
 *   S3_PREFIX        Préfixe des fichiers source dans le bucket (défaut : vide)
 *   S3_BIO_DIR       Répertoire S3 des fichiers RPG bio annuels (défaut : bio)
 *   S3_RPG_DIR       Répertoire S3 des fichiers RPG annuels (défaut : RPG)
 *   DUCKDB_THREADS   Threads DuckDB (défaut : nb de cœurs - 1)
 *   RPG_CONCURRENCY  Nb d'années RPG téléchargées en parallèle en phase 4 (défaut : 3)
 *   RPG_REFRESH      À 1, ignore le cache local des agrégats RPG annuels (phase 4)
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { copyFileSync, existsSync, mkdirSync, createWriteStream, unlinkSync, renameSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { once } from 'events'
import { cpus } from 'os'
import { dataPath } from '../../data-dir.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Copie locale du bucket S3 (sources et fichiers produits), et dossier de travail
// propre à fiches (cache, fichiers temporaires).
const S3_DATA = dataPath('s3')
const WORK = dataPath('aac')
mkdirSync(S3_DATA, { recursive: true })
mkdirSync(WORK, { recursive: true })

// ─── Config S3 ────────────────────────────────────────────────────────────────

const S3_BUCKET = process.env.S3_BUCKET
const S3_ACCESS = process.env.S3_ACCESS_KEY
const S3_SECRET = process.env.S3_SECRET_KEY
const S3_REGION = process.env.S3_REGION || 'fr-par'
const S3_ENDPOINT = process.env.S3_ENDPOINT || 's3.fr-par.scw.cloud'
const S3_PREFIX = process.env.S3_PREFIX || ''
const S3_BIO_DIR = process.env.S3_BIO_DIR || 'bio'
const S3_RPG_DIR = process.env.S3_RPG_DIR || 'RPG'
const DUCKDB_THREADS = Number(process.env.DUCKDB_THREADS) || Math.max(4, cpus().length - 1)
const RPG_CONCURRENCY = Number(process.env.RPG_CONCURRENCY) || 3
const RPG_REFRESH = process.env.RPG_REFRESH === '1'

if (!S3_BUCKET || !S3_ACCESS || !S3_SECRET) {
  console.error('Variables manquantes : S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY')
  process.exit(1)
}

const s3src = (name) => `s3://${S3_BUCKET}/${S3_PREFIX ? `${S3_PREFIX}/${name}` : name}`
const sqlEscape = (value) => value.replace(/'/g, "''")

// ─── DuckDB ───────────────────────────────────────────────────────────────────

const instance = await DuckDBInstance.create(':memory:', {
  temp_directory: join(WORK, '.tmp'),
  preserve_insertion_order: 'false',
  threads: String(DUCKDB_THREADS),
})

await (await instance.connect()).run('INSTALL httpfs; INSTALL spatial')

// Les réglages httpfs/spatial sont propres à chaque connexion : la phase 4 en ouvre
// plusieurs pour télécharger les RPG annuels en parallèle.
async function newConnection() {
  const c = await instance.connect()
  for (const stmt of [
    'LOAD httpfs',
    'LOAD spatial',
    `SET s3_endpoint='${sqlEscape(S3_ENDPOINT)}'`,
    `SET s3_region='${sqlEscape(S3_REGION)}'`,
    `SET s3_access_key_id='${sqlEscape(S3_ACCESS)}'`,
    `SET s3_secret_access_key='${sqlEscape(S3_SECRET)}'`,
    "SET s3_url_style='vhost'",
  ])
    await c.run(stmt)
  return c
}

const conn = await newConnection()
const q = (sql) => conn.runAndReadAll(sql).then((r) => r.getRowObjects())

// Exécute `fn` sur `items` avec au plus `limit` tâches simultanées.
async function runPool(items, limit, fn) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift())
    })
  )
}

// ─── Helpers chemins locaux ───────────────────────────────────────────────────

const localPath = (name) => join(S3_DATA, name)

const readTable = (name) => `read_parquet('${localPath(name)}')`

// ─── Étape 1 : téléchargement des fichiers source ────────────────────────────

console.log('═══ Étape 1 : téléchargement des fichiers source ═══\n')

const SOURCE_FILES = [
  'aac_hilbert.parquet',
  'aac_pp_zones.parquet',
  'communes_hilbert.parquet',
  'captages.parquet',
  'rpg_parcelles.parquet',
]

const BIO_YEARS = [2019, 2020, 2021, 2022, 2023, 2024]
const CULTURES_EVOLUTION_YEARS = [2020, 2021, 2022, 2023, 2024]

for (const name of SOURCE_FILES) {
  const dest = localPath(name)

  if (existsSync(dest)) {
    console.log(`  ✓ ${name} (déjà présent)`)
    continue
  }

  process.stdout.write(`  ↓ ${name}...`)
  const t = Date.now()

  await conn.run(
    `COPY (SELECT * FROM read_parquet('${s3src(name)}'))
     TO '${dest}' WITH (FORMAT PARQUET, CODEC 'ZSTD', ROW_GROUP_SIZE 5000)`
  )
  console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`)
}

for (const year of BIO_YEARS) {
  const name = `rpg_bio_${year}.parquet`
  const dest = localPath(name)

  if (existsSync(dest)) {
    console.log(`  ✓ ${name} (déjà présent)`)
    continue
  }

  process.stdout.write(`  ↓ ${name}...`)
  const t = Date.now()

  await conn.run(
    `COPY (SELECT * FROM read_parquet('s3://${S3_BUCKET}/${S3_BIO_DIR}/${name}'))
     TO '${dest}' WITH (FORMAT PARQUET, CODEC 'ZSTD', ROW_GROUP_SIZE 5000)`
  )
  console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`)
}

{
  const name = 'captages_prioritaires_2026.csv'
  const dest = localPath(name)
  if (existsSync(dest)) {
    console.log(`  ✓ ${name} (déjà présent)`)
  } else {
    process.stdout.write(`  ↓ ${name}...`)
    const t = Date.now()
    await conn.run(
      `COPY (SELECT * FROM read_csv('${s3src(name)}', header=true))
       TO '${dest}' (FORMAT CSV, HEADER true)`
    )
    console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`)
  }
}

// ─── Constantes RPG ───────────────────────────────────────────────────────────

const GROUPES_CULTURES_EVOLUTION = {
  1: 'Blé tendre',
  2: 'Maïs grain et ensilage',
  3: 'Orge',
  4: 'Autres céréales',
  5: 'Colza',
  6: 'Tournesol',
  7: 'Autres oléagineux',
  8: 'Protéagineux',
  9: 'Plantes à fibres',
  11: 'Gel (surfaces gelées sans production)',
  14: 'Riz',
  15: 'Légumineuses à grains',
  16: 'Fourrage',
  17: 'Estives et landes',
  18: 'Prairies permanentes',
  19: 'Prairies temporaires',
  20: 'Vergers',
  21: 'Vignes',
  22: 'Fruits à coque',
  23: 'Oliviers',
  24: 'Autres cultures industrielles',
  25: 'Autres cultures industrielles',
  26: 'Canne à sucre',
  28: 'Divers',
}

function buildInstallations(captages, bssPrioritaires) {
  const groups = new Map()
  for (const r of captages) {
    const ref = r.t1_ins_cap_ref || r.t1_code_ins
    const refLib = r.t1_ins_cap_ref_lib || r.t1_ins_nom
    if (!groups.has(ref)) groups.set(ref, { nom_ref: refLib, membres: new Map() })
    groups.get(ref).membres.set(r.t1_code_ins, r)
  }

  return [...groups.entries()]
    .map(([codeRef, { membres }]) => {
      const ref = membres.get(codeRef) ?? [...membres.values()][0]
      const entry = {
        code: codeRef,
        nom: ref.t1_ins_nom,
        ...(ref.t1_ins_code_bss ? { code_bss: ref.t1_ins_code_bss } : {}),
        commune: ref.t1_com_nom,
        departement: ref.t1_dep_geo_lib,
        type: ref.t1_cap_type_lib,
        nature: ref.t1_ins_nat_code,
        usage: ref.t1_ins_usage_lib,
        etat: ref.t1_ins_etat_lib,
        ...(ref.t2_code_ppe ? { code_ppe: ref.t2_code_ppe } : {}),
      }

      const allBss = [...membres.values()].map((m) => m.t1_ins_code_bss).filter(Boolean)
      if (allBss.some((bss) => bssPrioritaires.has(bss))) entry.prioritaire = true

      const rattaches = [...membres.values()]
        .filter((m) => m.t1_code_ins !== codeRef)
        .map((m) => ({
          code: m.t1_code_ins,
          nom: m.t1_ins_nom,
          ...(m.t1_ins_code_bss ? { code_bss: m.t1_ins_code_bss } : {}),
          etat: m.t1_ins_etat_lib,
        }))

      if (rattaches.length > 0) entry.captages_rattaches = rattaches
      return entry
    })
    .sort((a, b) => a.nom.localeCompare(b.nom))
}

function buildSauResult(rows, surfKey, nbKey, totalM2) {
  const result = {}
  for (const r of [...rows].sort((a, b) => (b[surfKey] || 0) - (a[surfKey] || 0))) {
    if (!r[nbKey] || !r[surfKey]) continue
    result[GROUPES_CULTURES_EVOLUTION[r.code_group] || `Groupe ${r.code_group}`] = {
      nb_parcelles: r[nbKey],
      surface: Math.round(r[surfKey] / 100) / 100,
      SAU: totalM2 > 0 ? Math.round((r[surfKey] / totalM2) * 1000) / 10 : 0,
    }
  }

  return result
}

// ─── Étape 2 : génération des fiches AAC ─────────────────────────────────────

console.log('\n═══ Étape 2 : génération des fiches AAC ═══\n')

// Phase 1 : données légères

console.log('Phase 1 — chargement des données légères...')
let t = Date.now()

const aacRows = await q(`
  SELECT cdaac, nom, datemajaac, datecreati,
         ST_AsGeoJSON(geom)                                                AS geom_wgs,
         ST_AsGeoJSON(ST_Transform(geom, 'EPSG:4326', 'EPSG:2154', true)) AS geom_l93,
         ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:2154', true))      AS area_m2,
         ST_XMin(geom) AS bbox_west,
         ST_YMin(geom) AS bbox_south,
         ST_XMax(geom) AS bbox_east,
         ST_YMax(geom) AS bbox_north
  FROM read_parquet('${localPath('aac_hilbert.parquet')}')`)

const aacMap = new Map(aacRows.map((r) => [r.cdaac, r]))
console.log(`  ${aacRows.length} AAC chargées (${Date.now() - t}ms)`)

t = Date.now()
const ppRows = await q(`SELECT * FROM read_parquet('${localPath('aac_pp_zones.parquet')}')`)
const ppMap = new Map(ppRows.map((r) => [r.cdaac, r]))
console.log(`  PP zones chargées (${Date.now() - t}ms)`)

t = Date.now()
const communesRows = await q(`
  SELECT a.cdaac, c.nom, c.code,
         ST_Area(ST_Transform(
           ST_MakeValid(ST_Intersection(ST_MakeValid(c.geom), ST_MakeValid(a.geom))),
           'EPSG:4326', 'EPSG:2154', true
         )) AS surf_m2
  FROM read_parquet('${localPath('aac_hilbert.parquet')}') a
  JOIN read_parquet('${localPath('communes_hilbert.parquet')}') c ON ST_Intersects(a.geom, c.geom)
  ORDER BY a.cdaac, surf_m2 DESC`)

const communesMap = new Map()
for (const r of communesRows) {
  if (!communesMap.has(r.cdaac)) communesMap.set(r.cdaac, [])
  communesMap.get(r.cdaac).push(r)
}
console.log(`  Communes chargées — ${communesRows.length} lignes (${Date.now() - t}ms)`)

// Géométries AAC en Lambert 93, projetées et validées une seule fois : elles
// servent au rattachement des captages ci-dessous ainsi qu'aux phases 2, 3 et 4,
// qui les rejoignaient chacune en recalculant ST_Transform/ST_MakeValid à chaque
// ligne appariée.
t = Date.now()
await conn.run(`
  CREATE OR REPLACE TABLE aac_l93 AS
  SELECT cdaac, geom_l93, ST_MakeValid(geom_l93) AS geom_l93_valid
  FROM (
    SELECT cdaac, ST_Transform(geom, 'EPSG:4326', 'EPSG:2154', true) AS geom_l93
    FROM read_parquet('${localPath('aac_hilbert.parquet')}')
  )`)
console.log(`  Géométries AAC préparées en Lambert 93 (${Date.now() - t}ms)`)

t = Date.now()
// ─── Règle métier de rattachement captage → AAC ──────────────────────────────
//
// Un point de captage est rattaché à une AAC si (et seulement si) :
//   (a) son point (t1_psv_x/y) est directement inclus dans la géométrie de
//       l'AAC (intersection géométrique directe), OU
//   (b) il appartient à un périmètre de protection (PPE, PPR ou PPI) qui est
//       lui-même majoritairement inclus dans l'AAC.
//
// Le cas (b) n'est pas calculé ici : il est précalculé en amont sous forme de
// listes de codes PPE/PPR/PPI par AAC dans aac_pp_zones.parquet (le seuil de
// "majoritairement inclus" est appliqué lors de la génération de ce fichier).
// Un captage est donc rattaché via (b) si le code de périmètre auquel il
// appartient (t2_code_ppe/ppr/ppi) figure dans la liste associée à l'AAC.
//
// ⚠️ Implémentation initiale (incomplète, à ne pas réintroduire) : seul le cas
// (b) était implémenté, via une jointure unique entre aac_pp_zones et
// captages sur les codes PPE/PPR/PPI. Cela ratait tous les captages dont le
// point tombe dans une AAC sans qu'un code de périmètre corresponde (ex. PPE/
// PPR/PPI non renseigné dans captages.parquet) — cf. l'AAC de LA MAXE (code
// 5186) ou PRISE DE MAQUENS - Carcassonne (code 1549), où le nombre
// d'installations rattachées était sous-estimé de 30 à 60 %. La requête
// ci-dessous calcule donc les deux cas séparément (CTE `matches`) et les
// combine par UNION (dédoublonnage automatique des couples cdaac/captage
// trouvés par les deux voies).
//
// Les coordonnées (0, 0) dans t1_psv_x/y (~430 lignes sur 53 775, valeur
// placeholder pour donnée manquante) sont explicitement exclues du cas (a) :
// sans ce garde-fou elles ne matcheraient de toute façon aucune AAC réelle
// (aucune géométrie AAC ne couvre l'origine du Lambert 93), mais on préfère
// le rendre explicite plutôt que de compter sur cette coïncidence.
const captagesRows = await q(`
  WITH captages_dedup AS (
    SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY t1_code_ins
             ORDER BY
               (t1_ins_cap_ref IS NOT NULL) DESC,
               (t1_ins_code_bss IS NOT NULL) DESC,
               (COALESCE(t2_code_ppe, '') <> '') DESC,
               (COALESCE(t2_code_ppr, '') <> '') DESC,
               (COALESCE(t2_code_ppi, '') <> '') DESC,
               t1_ins_nom ASC,
               t1_code_ins ASC
           ) AS rn
    FROM read_parquet('${localPath('captages.parquet')}')
  ),
  captages_uniq AS (
    SELECT *,
           CASE
             WHEN TRY_CAST(t1_psv_x AS DOUBLE) = 0 AND TRY_CAST(t1_psv_y AS DOUBLE) = 0 THEN NULL
             ELSE ST_Point(TRY_CAST(t1_psv_x AS DOUBLE), TRY_CAST(t1_psv_y AS DOUBLE))
           END AS point_l93
    FROM captages_dedup
    WHERE rn = 1
  ),
  matches AS (
    SELECT a.cdaac, cap.t1_code_ins
    FROM aac_l93 a
    JOIN captages_uniq cap
      ON cap.point_l93 IS NOT NULL AND ST_Intersects(cap.point_l93, a.geom_l93_valid)
    UNION
    SELECT pp.cdaac, cap.t1_code_ins
    FROM read_parquet('${localPath('aac_pp_zones.parquet')}') pp
    JOIN captages_uniq cap ON (
      (pp.ppe_codes IS NOT NULL AND list_contains(pp.ppe_codes, cap.t2_code_ppe)) OR
      (pp.ppr_codes IS NOT NULL AND list_contains(pp.ppr_codes, cap.t2_code_ppr)) OR
      (pp.ppi_codes IS NOT NULL AND list_contains(pp.ppi_codes, cap.t2_code_ppi))
    )
  )
  SELECT m.cdaac,
         cap.t1_code_ins, cap.t1_ins_nom, cap.t1_com_nom, cap.t1_com_insee,
         cap.t1_ins_etat_lib, cap.t1_uge_mo_nom,
         cap.t1_dep_geo_lib, cap.t1_cap_type_lib, cap.t1_ins_nat_code,
         cap.t1_ins_usage_lib, cap.t1_ins_etat,
         cap.t1_ins_cap_ref, cap.t1_ins_cap_ref_lib,
         cap.t1_ins_code_bss,
         COALESCE(cap.t2_code_ppe, '') AS t2_code_ppe,
         COALESCE(cap.t2_code_ppr, '') AS t2_code_ppr,
         COALESCE(cap.t2_code_ppi, '') AS t2_code_ppi
  FROM matches m
  JOIN captages_uniq cap ON cap.t1_code_ins = m.t1_code_ins`)

const captagesMap = new Map()
for (const r of captagesRows) {
  if (!captagesMap.has(r.cdaac)) captagesMap.set(r.cdaac, [])
  captagesMap.get(r.cdaac).push(r)
}
console.log(`  Captages chargés — ${captagesRows.length} lignes (${Date.now() - t}ms)`)

t = Date.now()
const bssRows = await q(
  `SELECT CodeBss FROM read_csv('${localPath('captages_prioritaires_2026.csv')}', header=true) WHERE CodeBss IS NOT NULL`
)
const bssPrioritaires = new Set(
  bssRows.flatMap((r) =>
    r.CodeBss.split('|')
      .map((s) => s.trim())
      .filter(Boolean)
  )
)
console.log(`  ${bssPrioritaires.size} BSS prioritaires chargés (${Date.now() - t}ms)`)

// Géométries des périmètres de protection en Lambert 93
// (aac_l93 est déjà créée plus haut, pour le rattachement des captages.)

t = Date.now()
await conn.run(`
  CREATE OR REPLACE TABLE aac_pp_l93 AS
  SELECT cdaac,
         CASE WHEN ppe_zone_l93 IS NOT NULL THEN ST_GeomFromGeoJSON(ppe_zone_l93) END AS ppe_geom,
         CASE WHEN ppr_zone_l93 IS NOT NULL THEN ST_GeomFromGeoJSON(ppr_zone_l93) END AS ppr_geom
  FROM read_parquet('${localPath('aac_pp_zones.parquet')}')`)
console.log(`  Géométries AAC préparées en Lambert 93 (${Date.now() - t}ms)`)

// Phase 2 : RPG bio

console.log('\nPhase 2 — RPG bio (scan par année)...')
t = Date.now()

const bioByYearMap = new Map() // cdaac -> [{year, nb, surf_m2}, ...]

for (const year of BIO_YEARS) {
  const fileName = `rpg_bio_${year}.parquet`
  process.stdout.write(`  ${year}...`)
  const t2 = Date.now()

  const rows = await q(`
    SELECT a.cdaac,
           CAST(COUNT(*) AS INTEGER)                                           AS nb,
           CAST(SUM(ST_Area(ST_Intersection(ST_MakeValid(r.geom_l93),
                 a.geom_l93_valid))) AS DOUBLE)                                AS surf_m2
    FROM (
      SELECT ST_Transform(geometry, 'EPSG:4326', 'EPSG:2154', true) AS geom_l93
      FROM ${readTable(fileName)}
    ) r
    JOIN aac_l93 a ON ST_Intersects(r.geom_l93, a.geom_l93)
    GROUP BY a.cdaac`)

  for (const r of rows) {
    if (!bioByYearMap.has(r.cdaac)) bioByYearMap.set(r.cdaac, [])
    bioByYearMap.get(r.cdaac).push({ year, nb: r.nb, surf_m2: r.surf_m2 })
  }
  console.log(` ${rows.length} AAC (${Date.now() - t2}ms)`)
}

console.log(`  Bio chargé — ${bioByYearMap.size} AAC avec parcelles bio (${Date.now() - t}ms)`)

// Phase 3 : RPG parcelles

console.log('\nPhase 3 — RPG parcelles (scan unique, peut prendre plusieurs minutes)...')
t = Date.now()

const rpgRows = await q(`
  SELECT cdaac, code_group,
         CAST(COUNT(*) AS INTEGER)                                     AS nb_aac,
         CAST(SUM(area_aac) AS DOUBLE)                                 AS surf_aac,
         CAST(COUNT(*) FILTER (WHERE area_ppe > 0) AS INTEGER)         AS nb_ppe,
         CAST(SUM(area_ppe) AS DOUBLE)                                 AS surf_ppe,
         CAST(COUNT(*) FILTER (WHERE area_ppr > 0) AS INTEGER)         AS nb_ppr,
         CAST(SUM(area_ppr) AS DOUBLE)                                 AS surf_ppr
  FROM (
    SELECT code_group, cdaac,
           ST_Area(ST_Intersection(parcelle, geom_l93_valid))                                AS area_aac,
           CASE WHEN ppe_geom IS NOT NULL THEN ST_Area(ST_Intersection(parcelle, ppe_geom))
                ELSE 0.0 END                                                                 AS area_ppe,
           CASE WHEN ppr_geom IS NOT NULL THEN ST_Area(ST_Intersection(parcelle, ppr_geom))
                ELSE 0.0 END                                                                 AS area_ppr
    FROM (
      -- ST_MakeValid n'est appliqué qu'aux parcelles retenues par la jointure
      -- spatiale, et une seule fois pour les trois intersections.
      SELECT t.code_group, a.cdaac, a.geom_l93_valid, pp.ppe_geom, pp.ppr_geom,
             ST_MakeValid(t.geom) AS parcelle
      FROM ${readTable('rpg_parcelles.parquet')} t
      JOIN aac_l93 a ON ST_Intersects(t.geom, a.geom_l93)
      LEFT JOIN aac_pp_l93 pp ON a.cdaac = pp.cdaac
    )
  ) inner_t
  GROUP BY cdaac, code_group`)

const rpgMap = new Map()
for (const r of rpgRows) {
  if (!rpgMap.has(r.cdaac)) rpgMap.set(r.cdaac, [])
  rpgMap.get(r.cdaac).push(r)
}
console.log(`  RPG chargé — ${rpgRows.length} lignes pour ${rpgMap.size} AAC (${Date.now() - t}ms)`)

// Phase 4 : RPG évolution annuelle depuis S3
//
// Chaque RPG_YYYY.parquet pèse 2 à 4 Go (colonne geom ≈ 98 % des octets, aucune
// statistique spatiale exploitable pour élaguer des row groups) : la phase est
// bornée par le débit S3, pas par le CPU. Deux leviers :
//   1. les années sont téléchargées en parallèle (le débit agrégé dépasse celui
//      d'un flux unique et une année lente ne bloque plus les suivantes) ;
//   2. l'agrégat par année (~18 000 lignes) est mis en cache dans data/aac/cache/ :
//      un RPG_YYYY publié ne bouge plus, une réexécution ne retélécharge rien.

console.log('\nPhase 4 — RPG évolution annuelle (S3 RPG/RPG_YYYY.parquet)...')
t = Date.now()

const CACHE = join(WORK, 'cache')
mkdirSync(CACHE, { recursive: true })
const evolutionCachePath = (year) => join(CACHE, `rpg_evolution_${year}.parquet`)

const yearsToCompute = CULTURES_EVOLUTION_YEARS.filter(
  (year) => RPG_REFRESH || !existsSync(evolutionCachePath(year))
)
const yearsCached = CULTURES_EVOLUTION_YEARS.filter((year) => !yearsToCompute.includes(year))

if (yearsCached.length > 0) console.log(`  ✓ agrégats en cache : ${yearsCached.join(', ')}`)

if (yearsToCompute.length > 0) {
  await runPool(yearsToCompute, RPG_CONCURRENCY, async (year) => {
    const t2 = Date.now()
    const rpgYearPath = `s3://${S3_BUCKET}/${S3_RPG_DIR}/RPG_${year}.parquet`
    const dest = evolutionCachePath(year)
    const tmp = `${dest}.tmp`
    const c = await newConnection()

    await c.run(`
      COPY (
        SELECT CAST(${year} AS INTEGER) AS annee,
               a.cdaac, t.code_group,
               CAST(COUNT(*) AS INTEGER)                                          AS nb_parcelles,
               CAST(SUM(ST_Area(ST_Intersection(ST_MakeValid(t.geom),
                     a.geom_l93_valid))) AS DOUBLE) / 10000.0                      AS surface_ha
        FROM read_parquet('${rpgYearPath}') t
        JOIN aac_l93 a ON ST_Intersects(t.geom, a.geom_l93)
        GROUP BY a.cdaac, t.code_group
      ) TO '${tmp}' (FORMAT PARQUET, CODEC 'ZSTD')`)

    renameSync(tmp, dest)
    console.log(`  ${year} — agrégat calculé (${Date.now() - t2}ms)`)
  })
}

const evolutionRows = await q(`
  SELECT annee, cdaac, code_group, nb_parcelles, surface_ha
  FROM read_parquet([${CULTURES_EVOLUTION_YEARS.map((y) => `'${evolutionCachePath(y)}'`).join(', ')}])
  ORDER BY annee, cdaac, surface_ha DESC`)

const culturesEvolutionMap = new Map()

for (const r of evolutionRows) {
  if (!r.nb_parcelles || !r.surface_ha) continue

  const libelle = isNaN(r.code_group)
    ? r.code_group
    : GROUPES_CULTURES_EVOLUTION[r.code_group] || `Groupe ${r.code_group}`

  let fiche = culturesEvolutionMap.get(r.cdaac)
  if (!fiche) culturesEvolutionMap.set(r.cdaac, (fiche = {}))
  ;(fiche[r.annee] ??= {})[libelle] = {
    surface_ha: Math.round(r.surface_ha * 10) / 10,
    nb_parcelles: r.nb_parcelles,
  }
}

console.log(`  Évolution cultures chargée — ${culturesEvolutionMap.size} AAC (${Date.now() - t}ms)`)

// Phase 5 : assemblage

console.log('\nPhase 5 — assemblage des fiches...')
t = Date.now()
let nbFiches = 0

const tmpNdjson = join(WORK, '_tmp_aac.ndjson')
const ndjsonStream = createWriteStream(tmpNdjson)

for (const [cdaac, aac] of aacMap) {
  const pp = ppMap.get(cdaac) ?? {}
  const communes = communesMap.get(cdaac) ?? []
  const captages = captagesMap.get(cdaac) ?? []
  const bioYears = bioByYearMap.get(cdaac) ?? []
  const bio = bioYears.at(-1)
  const rpg = rpgMap.get(cdaac) ?? []
  const culturesEvolution = culturesEvolutionMap.get(cdaac) ?? {}

  const ppeGeom = pp.ppe_zone_l93 ?? null
  const pprGeom = pp.ppr_zone_l93 ?? null

  const totalSauM2 = rpg.reduce((s, r) => s + (r.surf_aac || 0), 0)
  const totalPpeM2 = rpg.reduce((s, r) => s + (r.surf_ppe || 0), 0)
  const totalPprM2 = rpg.reduce((s, r) => s + (r.surf_ppr || 0), 0)
  const nbParcelles = rpg.reduce((s, r) => s + (r.nb_aac || 0), 0)
  const nbBio = bio?.nb ?? 0
  const totalBioM2 = bio?.surf_m2 ?? 0
  const nbCaptagesActifs = captages.filter(
    (c) => c.t1_ins_etat_lib?.toUpperCase() === 'ACTIF'
  ).length

  const installations = buildInstallations(captages, bssPrioritaires)
  const estPrioritaire = installations.some((i) => i.prioritaire === true)

  const line =
    JSON.stringify({
      nom: aac.nom,
      code: String(cdaac),
      prioritaire: estPrioritaire,
      date_creation: aac.datecreati ? new Date(aac.datecreati).toISOString().slice(0, 10) : null,
      date_maj: aac.datemajaac ? new Date(aac.datemajaac).toISOString().slice(0, 10) : null,
      bbox: [aac.bbox_west, aac.bbox_south, aac.bbox_east, aac.bbox_north],
      surface: Math.round(aac.area_m2 / 100) / 100,
      nb_captages_actifs: nbCaptagesActifs,
      nb_installations: installations.length,
      surface_agricole: Math.round(totalSauM2 / 100) / 100,
      nb_parcelles: nbParcelles,
      communes: {
        nb_communes: communes.length,
        communes: Object.fromEntries(
          communes.map((c) => [
            c.nom,
            {
              code_insee: c.code,
              surface: Math.round((c.surf_m2 / 10_000) * 100) / 100,
              repartition: Math.round((c.surf_m2 / aac.area_m2) * 1000) / 10,
            },
          ])
        ),
      },
      surface_agricole_utile: buildSauResult(rpg, 'surf_aac', 'nb_aac', totalSauM2),
      surface_agricole_ppe: ppeGeom ? buildSauResult(rpg, 'surf_ppe', 'nb_ppe', totalPpeM2) : null,
      surface_agricole_ppr: pprGeom ? buildSauResult(rpg, 'surf_ppr', 'nb_ppr', totalPprM2) : null,
      surface_agricole_bio: {
        nb_parcelles: nbBio,
        surface: Math.round(totalBioM2 / 100) / 100,
        part_bio: totalSauM2 > 0 ? Math.round((totalBioM2 / totalSauM2) * 1000) / 10 : 0,
        evolution: bioYears.map(({ year, nb, surf_m2 }) => ({
          annee: year,
          nb_parcelles: nb,
          surface: Math.round(surf_m2 / 100) / 100,
        })),
      },
      cultures_evolution: { repartition: culturesEvolution },
      installations,
    }) + '\n'
  if (!ndjsonStream.write(line)) {
    await once(ndjsonStream, 'drain')
  }
  nbFiches++
}

await new Promise((resolve, reject) => {
  ndjsonStream.end()
  ndjsonStream.on('finish', resolve)
  ndjsonStream.on('error', reject)
})

console.log(`  ${nbFiches} fiches assemblées en ${Date.now() - t}ms`)

// ─── Étape 3 : écriture Parquet locale ───────────────────────────────────────

console.log('\n═══ Étape 3 : écriture locale ═══\n')

const OUTPUT = join(__dirname, 'output')
mkdirSync(OUTPUT, { recursive: true })
const localOutput = join(OUTPUT, 'aac.parquet')
const tmpOutput = `${localOutput}.tmp`

// Tri par code pour getByCode et getInstallationCodesByAacCode. Pas de
// ROW_GROUP_SIZE : le fichier (~1 700 lignes) tient de toute façon en un seul
// row group, DuckDB découpant par paquets de 2 048 lignes.
t = Date.now()
process.stdout.write(`  → ${localOutput}...`)
await conn.run(`
  COPY (
    SELECT * FROM read_json_auto('${tmpNdjson}', maximum_object_size = 10485760)
    ORDER BY TRY_CAST(code AS INTEGER), code
  )
  TO '${tmpOutput}' (FORMAT PARQUET, CODEC 'ZSTD')
`)
renameSync(tmpOutput, localOutput)
unlinkSync(tmpNdjson)
console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`)

// Copie dans data/s3/, où sont les autres fichiers du bucket.
const dataCopy = join(S3_DATA, basename(localOutput))
copyFileSync(localOutput, dataCopy)
console.log(`  ✓ copie : ${dataCopy}`)

console.log(`\nTerminé → ${localOutput}`)
process.exit(0)
