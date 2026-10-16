/**
 * Convertit le fichier AAC.gpkg partagé (data/aac/) en aac_hilbert.parquet trié par courbe
 * de Hilbert, et l'écrit dans le même dossier que ce script.
 *
 * Usage :
 *   node generate_aac_geometries_parquet.js [--input <chemin/AAC.gpkg>] [--output <chemin/aac_hilbert.parquet>]
 *
 * Valeurs par défaut :
 *   --input  data/aac/AAC.gpkg    (GPKG partagé, à la racine du dépôt)
 *   --output output/aac_hilbert.parquet
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { basename, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { dataPath } from "../../data-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Arguments CLI ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  return {
    input: resolve(
      __dirname,
      get("--input") ?? dataPath("aac", "AAC.gpkg")
    ),
    output: resolve(
      __dirname,
      get("--output") ?? "output/aac_hilbert.parquet"
    ),
  };
}

const { input, output } = parseArgs();

if (!existsSync(input)) {
  console.error(`Erreur : fichier introuvable : ${input}`);
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });

// ─── DuckDB ───────────────────────────────────────────────────────────────────

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();

async function run(sql) {
  await conn.run(sql);
}

async function query(sql) {
  const result = await conn.runAndReadAll(sql);
  return result.getRowObjects();
}

await run("INSTALL spatial; LOAD spatial;");
await run("INSTALL parquet; LOAD parquet;");

// ─── Conversion ───────────────────────────────────────────────────────────────

// Bbox France entière (métropole + DROM) pour normaliser ST_Hilbert
const BBOX = "{'min_x': -61.5, 'min_y': -12.9, 'max_x': 55.9, 'max_y': 51.5}::BOX_2D";

// Nettoyage des libellés du GPKG (lus de l'intérieur vers l'extérieur) :
//   - apostrophe typographique ’ → '
//   - apostrophes échappées plusieurs fois ('' ou '''') → '
//   - tiret long – et tiret collé d'un seul côté (« Brossac -puits ») → espacés des deux côtés
//   - espace manquant avant une parenthèse (« REYNIERES(LES) »)
//   - espaces multiples réduits, espaces de début/fin supprimés
const NOM = String.raw`
  trim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              replace(NomDeAACAdministratif, '’', ''''),
            '''{2,}', '''', 'g'),
          '\s*–\s*', ' – ', 'g'),
        ' -(\S)', ' - \1', 'g'),
      '(\S)- ', '\1 - ', 'g'),
    '([^\s(])\(', '\1 (', 'g'),
  '\s+', ' ', 'g'))`;

console.log(`Lecture : ${input}`);

const tmpOutput = output + ".tmp.parquet";

// Étape 1 : lire le GPKG, trier par Hilbert, écrire avec l'index de tri
await run(`
  COPY (
    WITH src AS (
      SELECT
        CAST(CdAAC AS VARCHAR)                       AS cdaac,
        ${NOM}                                       AS nom,
        CAST(DateCreationAAC AS VARCHAR)             AS datecreati,
        CAST(DateMajAAC AS VARCHAR)                  AS datemajaac,
        -- Le GPKG contient des Polygon ; on force MultiPolygon pour cohérence
        ST_Multi(geom)                               AS geom
      FROM ST_Read('${input.replace(/\\/g, "\\\\")}')
      WHERE geom IS NOT NULL
    )
    SELECT
      cdaac, nom, datecreati, datemajaac, geom,
      ST_Hilbert(geom, ${BBOX}) AS hilbert_idx
    FROM src
    ORDER BY hilbert_idx
  ) TO '${tmpOutput}' (FORMAT PARQUET, ROW_GROUP_SIZE 5000, COMPRESSION ZSTD)
`);

// Étape 2 : réécrire sans la colonne hilbert_idx (colonne de travail)
console.log("Tri Hilbert appliqué, écriture du fichier final…");
await run(`
  COPY (
    SELECT * EXCLUDE hilbert_idx
    FROM read_parquet('${tmpOutput}')
  ) TO '${output}' (FORMAT PARQUET, ROW_GROUP_SIZE 5000, COMPRESSION ZSTD)
`);

// Nettoyage du fichier intermédiaire
unlinkSync(tmpOutput);

// ─── Vérification ─────────────────────────────────────────────────────────────

const [{ n }] = await query(`SELECT COUNT(*) AS n FROM read_parquet('${output}')`);
const colRows = await query(`DESCRIBE SELECT * FROM read_parquet('${output}')`);
const cols = colRows.map((r) => r.column_name).join(", ");

console.log(`\n✓ ${output}`);
console.log(`  ${n} features`);
console.log(`  Colonnes : ${cols}`);

// Copie dans data/s3/, où fiches lit ses sources.
const dataCopy = dataPath("s3", basename(output));
if (dataCopy !== output) {
  mkdirSync(dirname(dataCopy), { recursive: true });
  copyFileSync(output, dataCopy);
  console.log(`✓ copie : ${dataCopy}`);
}
