/**
 * Génère le PMTiles de zonage de protection de l'eau (couches ppr, ppe, aac, sage)
 * à partir de ses fichiers sources.
 *
 * Usage :
 *   node generate_zonage_pmtiles.js [--aac <AAC.gpkg>] [--sage <sage_shape.zip>] [--ppr <ppr_hilbert.parquet>] [--ppe <ppe_hilbert.parquet>] [--output <zonage.pmtiles>]
 *
 * Valeurs par défaut (relatives au dossier de ce script) :
 *   --aac         data/aac/AAC.gpkg                  (à la racine du dépôt)
 *   --layer       AAC_FRA                            (couche du GPKG des AAC)
 *   --sage        data/aac/sage_shape.zip            (shapefile zippé des SAGE)
 *   --sage-layer  sage_shape                         (couche du shapefile des SAGE)
 *   --ppr         data/captages/ppr_hilbert.parquet  (périmètres de protection rapprochée)
 *   --ppe         data/captages/ppe_hilbert.parquet  (périmètres de protection éloignée)
 *   --output      output/zonage.pmtiles
 *
 * Outils externes requis dans le PATH : ogr2ogr (GDAL), tippecanoe.
 */

import { execFileSync, spawnSync } from "child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import { dataPath } from "../../data-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NAME = "water_protection";
const DESCRIPTION = "PPR, PPE, AAC, SAGE";

// ─── Arguments CLI ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  return {
    aac: resolve(__dirname, get("--aac") ?? dataPath("aac", "AAC.gpkg")),
    layer: get("--layer") ?? "AAC_FRA",
    sage: resolve(__dirname, get("--sage") ?? dataPath("aac", "sage_shape.zip")),
    sageLayer: get("--sage-layer") ?? "sage_shape",
    ppr: resolve(__dirname, get("--ppr") ?? dataPath("captages", "ppr_hilbert.parquet")),
    ppe: resolve(__dirname, get("--ppe") ?? dataPath("captages", "ppe_hilbert.parquet")),
    output: resolve(__dirname, get("--output") ?? "output/zonage.pmtiles"),
  };
}

const { aac, layer, sage, sageLayer, ppr, ppe, output } = parseArgs();

// Nettoyage des libellés, identique à l'expression NOM de
// aac/geometries/generate_aac_geometries_parquet.js (appliquée dans le même ordre) :
//   - apostrophe typographique ’ → '
//   - apostrophes échappées plusieurs fois ('' ou '''') → '
//   - tiret long – et tiret collé d'un seul côté (« Brossac -puits ») → espacés des deux côtés
//   - espace manquant avant une parenthèse (« REYNIERES(LES) »)
//   - espaces multiples réduits, espaces de début/fin supprimés
// Les classes d'espaces sont celles de RE2 (moteur de DuckDB), pas le \s de JavaScript,
// qui inclut aussi les espaces insécables et Unicode.
function nettoyerLibelle(s) {
  if (s == null) return s;
  return s
    .replaceAll("’", "'")
    .replace(/'{2,}/g, "'")
    .replace(/[\t\n\f\r ]*–[\t\n\f\r ]*/g, " – ")
    .replace(/ -([^\t\n\f\r ])/g, " - $1")
    .replace(/([^\t\n\f\r ])- /g, "$1 - ")
    .replace(/([^\t\n\f\r (])\(/g, "$1 (")
    .replace(/[\t\n\f\r ]+/g, " ")
    .replace(/^ +| +$/g, "");
}

// Couches du PMTiles, dans l'ordre de la génération d'origine. Chaque source est
// exportée en GeoJSON par une requête SQLite qui fixe les champs et leurs types.
const SOURCES = [
  {
    // Seuls code_pp et la géométrie sont disponibles dans les parquets.
    layer: "ppr",
    file: ppr,
    sql: `SELECT code_pp, geom FROM "${basename(ppr, ".parquet")}"`,
  },
  {
    layer: "ppe",
    file: ppe,
    sql: `SELECT code_pp, geom FROM "${basename(ppe, ".parquet")}"`,
  },
  {
    // CdAAC et dates en texte, ArreteDelimitationAAC en entier. Les champs JSON
    // (AdminAAC, PTP…) sont sérialisés en chaîne par tippecanoe. Le nom
    // administratif est nettoyé comme dans aac/geometries, pour que la carte et
    // les fiches affichent le même libellé.
    layer: "aac",
    file: aac,
    transform: (p) => ({ ...p, NomDeAACAdministratif: nettoyerLibelle(p.NomDeAACAdministratif) }),
    sql: `
      SELECT CAST(CdAAC AS TEXT) AS CdAAC, NomDeAACAdministratif, NomDeAACUsage, NomDeAACAutre,
             CAST(DateCreationAAC AS TEXT) AS DateCreationAAC, CAST(DateMajAAC AS TEXT) AS DateMajAAC,
             StAAC, ComAAC, NumCircAdminBassin, NomCircAdminBassin, NivQualite,
             CAST(ArreteDelimitationAAC AS INTEGER) AS ArreteDelimitationAAC,
             CAST(DateArreteDelim AS TEXT) AS DateArreteDelim, DepArreteDelim,
             AdminAAC, CommandAAC, CodesAlternatifs, PTP, geom
      FROM "${layer}"`,
  },
  {
    // Shapefile Gest'eau : l'export GPKG du même WFS assemble mal les
    // multipolygones (îlots pris pour le contour extérieur). Le DBF est en
    // Latin-1, où « œ » devient « ? » : on le rétablit dans les libellés d'état.
    layer: "sage",
    file: sage.endsWith(".zip") ? `/vsizip/${sage}` : sage,
    sql: `
      SELECT nid, nom, type, code, cd_etat,
             REPLACE(lb_etat, '?uvre', 'œuvre') AS lb_etat, cd_ss_etat,
             REPLACE(lb_ss_etat, '?uvre', 'œuvre') AS lb_ss_etat,
             cd_comite, lb_comite, necess2010, necess2016, cd_type_pe, lb_type_pe, geometry
      FROM "${sageLayer}"`,
  },
];

for (const f of [aac, sage, ppr, ppe]) {
  if (!existsSync(f)) {
    console.error(`Erreur : fichier introuvable : ${f}`);
    process.exit(1);
  }
}

for (const cmd of ["ogr2ogr", "tippecanoe"]) {
  if (spawnSync("sh", ["-c", `command -v ${cmd}`]).status !== 0) {
    console.error(`Erreur : ${cmd} introuvable dans le PATH`);
    process.exit(1);
  }
}

// ─── PMTiles v3 : lecture des métadonnées (pour la vérification) ──────────────

function readMetadata(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(127);
    readSync(fd, header, 0, 127, 0);
    const offset = Number(header.readBigUInt64LE(24));
    const length = Number(header.readBigUInt64LE(32));
    const raw = Buffer.alloc(length);
    readSync(fd, raw, 0, length, offset);
    // Compression interne : 1 = aucune, 2 = gzip
    return JSON.parse((header[97] === 2 ? gunzipSync(raw) : raw).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// ─── Génération ───────────────────────────────────────────────────────────────

function sh(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

const tmp = mkdtempSync(join(tmpdir(), "zonage-pmtiles-"));

try {
  // Étape 1 : export de chaque source en GeoJSON (une entité par ligne).
  console.log("\n[1/2] Export des sources");
  const counts = {};
  for (const s of SOURCES) {
    const geojson = join(tmp, `${s.layer}.geojsonl`);
    sh("ogr2ogr", [
      "-f", "GeoJSONSeq", geojson, s.file,
      "-t_srs", "EPSG:4326", "-lco", "RS=NO", "-nln", s.layer,
      "-dialect", "SQLite", "-sql", s.sql,
    ]);
    let lignes = readFileSync(geojson, "utf8").split("\n").filter(Boolean);
    if (s.transform) {
      lignes = lignes.map((l) => {
        const f = JSON.parse(l);
        return JSON.stringify({ ...f, properties: s.transform(f.properties) });
      });
      writeFileSync(geojson, lignes.join("\n") + "\n");
    }
    counts[s.layer] = lignes.length;
  }

  // Étape 2 : tuilage de toutes les couches ensemble. tippecanoe est lancé depuis
  // le dossier temporaire avec des chemins relatifs, pour que generator_options
  // (enregistré dans les métadonnées) ne contienne aucun chemin local.
  console.log("\n[2/2] Tuilage");
  sh("tippecanoe", [
    "--output=zonage.pmtiles", "--force", `--name=${NAME}`, `--description=${DESCRIPTION}`,
    "-z14", "-Z0", ...SOURCES.flatMap((s) => ["-L", `${s.layer}:${s.layer}.geojsonl`]),
    "--drop-densest-as-needed", "--quiet",
  ], { cwd: tmp });

  // Copie (et non renommage : le dossier temporaire peut être sur un autre volume).
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(join(tmp, "zonage.pmtiles"), output);

  // ─── Vérification ─────────────────────────────────────────────────────────

  const meta = readMetadata(output);
  console.log(`\n✓ ${output}`);
  for (const l of meta.tilestats.layers) {
    console.log(`  ${l.layer.padEnd(5)} ${String(l.count).padStart(6)} entités, ${l.attributeCount} attributs`);
  }
  for (const s of SOURCES) {
    const tuilees = meta.tilestats.layers.find((l) => l.layer === s.layer)?.count;
    if (tuilees !== counts[s.layer]) {
      throw new Error(`Couche ${s.layer} : ${tuilees} entités tuilées pour ${counts[s.layer]} dans la source`);
    }
  }

  // Copie dans data/s3/, avec les autres fichiers du bucket.
  const dataCopy = dataPath("s3", basename(output));
  if (dataCopy !== output) {
    mkdirSync(dirname(dataCopy), { recursive: true });
    copyFileSync(output, dataCopy);
    console.log(`✓ copie : ${dataCopy}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
