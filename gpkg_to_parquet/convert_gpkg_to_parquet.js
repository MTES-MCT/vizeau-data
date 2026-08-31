/**
 * Convertit le fichier AAC.gpkg local en aac_hilbert.parquet trié par courbe
 * de Hilbert, et l'écrit dans le même dossier que ce script.
 *
 * Usage :
 *   node convert_gpkg_to_parquet.js [--input <chemin/AAC.gpkg>] [--output <chemin/aac_hilbert.parquet>]
 *
 * Valeurs par défaut :
 *   --input  AAC.gpkg             (dans le même dossier que ce script)
 *   --output aac_hilbert.parquet  (dans le même dossier que ce script)
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
      get("--input") ?? "AAC.gpkg"
    ),
    output: resolve(
      __dirname,
      get("--output") ?? "aac_hilbert.parquet"
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

console.log(`Lecture : ${input}`);

const tmpOutput = output + ".tmp.parquet";

// Étape 1 : lire le GPKG, trier par Hilbert, écrire avec l'index de tri
await run(`
  COPY (
    WITH src AS (
      SELECT
        CAST(CdAAC AS VARCHAR)                       AS cdaac,
        NomDeAACAdministratif                        AS nom,
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
