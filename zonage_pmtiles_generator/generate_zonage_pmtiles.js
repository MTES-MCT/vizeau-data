/**
 * Régénère la couche `aac` d'un PMTiles de zonage (couches ppr, ppe, aac, sage)
 * à partir du GeoPackage des AAC, en conservant telles quelles les autres couches.
 *
 * Usage :
 *   node generate_zonage_pmtiles.js [--aac <AAC.gpkg>] [--base <zonage.pmtiles>] [--output <zonage.pmtiles>]
 *
 * Valeurs par défaut (relatives au dossier de ce script) :
 *   --aac     ../aac_geometries_parquet_generator/AAC.gpkg
 *   --layer   AAC_FRA                (couche du GPKG)
 *   --base    zonage.pmtiles         (PMTiles existant dont on reprend ppr, ppe, sage)
 *   --output  output/zonage.pmtiles
 *
 * Outils externes requis dans le PATH : ogr2ogr (GDAL), tippecanoe, tile-join.
 */

import { execFileSync, spawnSync } from "child_process";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, renameSync, rmSync, writeSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { gunzipSync, gzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Arguments CLI ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
  return {
    aac: resolve(__dirname, get("--aac") ?? "../aac_geometries_parquet_generator/AAC.gpkg"),
    layer: get("--layer") ?? "AAC_FRA",
    base: resolve(__dirname, get("--base") ?? "zonage.pmtiles"),
    output: resolve(__dirname, get("--output") ?? "output/zonage.pmtiles"),
  };
}

const { aac, layer, base, output } = parseArgs();

for (const f of [aac, base]) {
  if (!existsSync(f)) {
    console.error(`Erreur : fichier introuvable : ${f}`);
    process.exit(1);
  }
}

for (const cmd of ["ogr2ogr", "tippecanoe", "tile-join"]) {
  if (spawnSync("sh", ["-c", `command -v ${cmd}`]).status !== 0) {
    console.error(`Erreur : ${cmd} introuvable dans le PATH`);
    process.exit(1);
  }
}

// ─── PMTiles v3 : lecture / réécriture des métadonnées ────────────────────────
//
// Structure d'un fichier : header (127 octets) | root directory | metadata (JSON
// compressé) | leaf directories | tile data. Les offsets des leaf directories et
// des tuiles sont relatifs à leur section : on peut donc remplacer le bloc de
// métadonnées en recopiant les autres sections à l'identique et en ne mettant à
// jour que les offsets/longueurs du header.

const HEADER_LENGTH = 127;
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

function readHeader(fd) {
  const buf = Buffer.alloc(HEADER_LENGTH);
  readSync(fd, buf, 0, HEADER_LENGTH, 0);
  if (buf.toString("ascii", 0, 7) !== "PMTiles" || buf[7] !== 3) {
    throw new Error("Fichier PMTiles v3 attendu");
  }
  const u64 = (o) => Number(buf.readBigUInt64LE(o));
  return {
    buf,
    rootOffset: u64(8), rootLength: u64(16),
    metadataOffset: u64(24), metadataLength: u64(32),
    leafOffset: u64(40), leafLength: u64(48),
    tileDataOffset: u64(56), tileDataLength: u64(64),
    internalCompression: buf[97],
  };
}

function decompress(buf, compression) {
  if (compression === COMPRESSION_NONE) return buf;
  if (compression === COMPRESSION_GZIP) return gunzipSync(buf);
  throw new Error(`Compression interne non gérée : ${compression}`);
}

function compress(buf, compression) {
  if (compression === COMPRESSION_NONE) return buf;
  if (compression === COMPRESSION_GZIP) return gzipSync(buf);
  throw new Error(`Compression interne non gérée : ${compression}`);
}

function readMetadata(path) {
  const fd = openSync(path, "r");
  try {
    const h = readHeader(fd);
    const raw = Buffer.alloc(h.metadataLength);
    readSync(fd, raw, 0, h.metadataLength, h.metadataOffset);
    return JSON.parse(decompress(raw, h.internalCompression).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function copyRange(fdIn, fdOut, offset, length) {
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let done = 0;
  while (done < length) {
    const n = readSync(fdIn, chunk, 0, Math.min(chunk.length, length - done), offset + done);
    writeSync(fdOut, chunk, 0, n);
    done += n;
  }
}

function writeWithMetadata(src, dst, metadata) {
  const fdIn = openSync(src, "r");
  const fdOut = openSync(dst, "w");
  try {
    const h = readHeader(fdIn);
    const meta = compress(Buffer.from(JSON.stringify(metadata), "utf8"), h.internalCompression);

    const header = Buffer.from(h.buf);
    const metadataOffset = h.rootOffset + h.rootLength;
    const leafOffset = metadataOffset + meta.length;
    const tileDataOffset = leafOffset + h.leafLength;
    header.writeBigUInt64LE(BigInt(metadataOffset), 24);
    header.writeBigUInt64LE(BigInt(meta.length), 32);
    header.writeBigUInt64LE(BigInt(leafOffset), 40);
    header.writeBigUInt64LE(BigInt(tileDataOffset), 56);

    writeSync(fdOut, header);
    copyRange(fdIn, fdOut, h.rootOffset, h.rootLength);
    writeSync(fdOut, meta);
    copyRange(fdIn, fdOut, h.leafOffset, h.leafLength);
    copyRange(fdIn, fdOut, h.tileDataOffset, h.tileDataLength);
  } finally {
    closeSync(fdIn);
    closeSync(fdOut);
  }
}

// ─── Génération ───────────────────────────────────────────────────────────────

function sh(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

const baseMeta = readMetadata(base);
const name = baseMeta.name ?? "water_protection";
const description = baseMeta.description ?? "PPR, PPE, AAC, SAGE";

const tmp = mkdtempSync(join(tmpdir(), "zonage-pmtiles-"));
const aacGeojson = join(tmp, "aac.geojsonl");
const aacPmtiles = join(tmp, "aac.pmtiles");
const sansAacPmtiles = join(tmp, "sans_aac.pmtiles");
const joinedPmtiles = join(tmp, "joined.pmtiles");

try {
  // Étape 1 : export de la couche AAC en GeoJSON (une entité par ligne).
  // Les champs sont typés comme dans la couche `aac` d'origine : CdAAC et dates
  // en texte, ArreteDelimitationAAC en entier. Les champs JSON (AdminAAC, PTP…)
  // sont sérialisés en chaîne par tippecanoe.
  console.log(`\n[1/4] Export de ${aac} (couche ${layer})`);
  sh("ogr2ogr", [
    "-f", "GeoJSONSeq", aacGeojson, aac,
    "-t_srs", "EPSG:4326", "-lco", "RS=NO", "-nln", "aac",
    "-dialect", "SQLite", "-sql", `
      SELECT CAST(CdAAC AS TEXT) AS CdAAC, NomDeAACAdministratif, NomDeAACUsage, NomDeAACAutre,
             CAST(DateCreationAAC AS TEXT) AS DateCreationAAC, CAST(DateMajAAC AS TEXT) AS DateMajAAC,
             StAAC, ComAAC, NumCircAdminBassin, NomCircAdminBassin, NivQualite,
             CAST(ArreteDelimitationAAC AS INTEGER) AS ArreteDelimitationAAC,
             CAST(DateArreteDelim AS TEXT) AS DateArreteDelim, DepArreteDelim,
             AdminAAC, CommandAAC, CodesAlternatifs, PTP, geom
      FROM "${layer}"`,
  ]);
  const nbAac = readFileSync(aacGeojson, "utf8").split("\n").filter(Boolean).length;

  // Étape 2 : tuilage de la couche AAC, avec les options du PMTiles d'origine.
  console.log("\n[2/4] Tuilage de la couche aac");
  sh("tippecanoe", [
    `--output=${aacPmtiles}`, "--force", `--name=${name}`, `--description=${description}`,
    "-z14", "-Z0", "-L", `aac:${aacGeojson}`, "--drop-densest-as-needed", "--quiet",
  ]);

  // Étape 3 : retrait de l'ancienne couche aac, puis fusion. -pk évite que
  // tile-join ne supprime des entités dans les tuiles dépassant 500 Ko.
  console.log("\n[3/4] Fusion avec les autres couches du PMTiles de base");
  sh("tile-join", ["-f", "--quiet", "-o", sansAacPmtiles, "-L", "aac", base]);
  sh("tile-join", [
    "-f", "--quiet", "-pk", "-n", name, "-N", description,
    "-o", joinedPmtiles, sansAacPmtiles, aacPmtiles,
  ]);

  // Étape 4 : correction des métadonnées laissées par tile-join.
  //   - generator_options : tile-join y concatène les commandes avec les chemins
  //     locaux ; on garde la commande tippecanoe d'origine et on décrit les
  //     étapes de régénération avec des noms de fichiers génériques.
  //   - tilestats : tile-join compte les occurrences par tuile, pas les entités ;
  //     on reprend ceux de tippecanoe pour aac et ceux de la base pour le reste.
  //   - strategies : tile-join additionne celles de ses entrées, ce qui les
  //     ferait grossir à chaque régénération ; on garde celles de la base.
  console.log("\n[4/4] Correction des métadonnées");
  const meta = readMetadata(joinedPmtiles);
  const aacMeta = readMetadata(aacPmtiles);

  const origine = (baseMeta.generator_options ?? "").split("; ")[0];
  meta.generator_options = [
    origine,
    `tile-join -o sans_aac.pmtiles -L aac ${name}.pmtiles`,
    `tippecanoe '--output=aac.pmtiles' '--name=${name}' '--description=${description}' -z14 -Z0 -L aac:aac.geojsonl --drop-densest-as-needed`,
    `tile-join -pk -n ${name} -N '${description}' -o zonage.pmtiles sans_aac.pmtiles aac.pmtiles`,
  ].filter(Boolean).join("; ");

  const stats = Object.fromEntries((baseMeta.tilestats?.layers ?? []).map((l) => [l.layer, l]));
  stats.aac = aacMeta.tilestats.layers.find((l) => l.layer === "aac");
  const layers = meta.tilestats.layers.map((l) => stats[l.layer] ?? l);
  meta.tilestats = { layerCount: layers.length, layers };

  if (baseMeta.strategies) meta.strategies = baseMeta.strategies;

  mkdirSync(dirname(output), { recursive: true });
  // Écriture à côté de la sortie puis renommage : --output peut être égal à --base.
  const tmpOutput = output + ".tmp";
  writeWithMetadata(joinedPmtiles, tmpOutput, meta);
  renameSync(tmpOutput, output);

  // ─── Vérification ─────────────────────────────────────────────────────────

  const final = readMetadata(output);
  console.log(`\n✓ ${output}`);
  for (const l of final.tilestats.layers) {
    console.log(`  ${l.layer.padEnd(5)} ${String(l.count).padStart(6)} entités, ${l.attributeCount} attributs`);
  }
  const finalAac = final.tilestats.layers.find((l) => l.layer === "aac");
  if (finalAac?.count !== nbAac) {
    throw new Error(`Couche aac : ${finalAac?.count} entités tuilées pour ${nbAac} AAC dans le GPKG`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
