/**
 * Régénère les couches `aac` et `sage` d'un PMTiles de zonage (couches ppr, ppe,
 * aac, sage) à partir de leurs GeoPackages sources, en conservant telles quelles
 * les couches ppr et ppe.
 *
 * Usage :
 *   node generate_zonage_pmtiles.js [--aac <AAC.gpkg>] [--sage <sage.gpkg>] [--base <zonage.pmtiles>] [--output <zonage.pmtiles>]
 *
 * Valeurs par défaut (relatives au dossier de ce script) :
 *   --aac         data/aac/AAC.gpkg      (à la racine du dépôt)
 *   --layer       AAC_FRA                (couche du GPKG des AAC)
 *   --sage        data/aac/sage.gpkg     (à la racine du dépôt)
 *   --sage-layer  sage_shape             (couche du GPKG des SAGE)
 *   --base        zonage.pmtiles         (PMTiles existant dont on reprend ppr, ppe)
 *   --output      output/zonage.pmtiles
 *
 * Outils externes requis dans le PATH : ogr2ogr (GDAL), tippecanoe, tile-join.
 */

import { execFileSync, spawnSync } from "child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, renameSync, rmSync, writeSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { gunzipSync, gzipSync } from "zlib";
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
    aac: resolve(__dirname, get("--aac") ?? dataPath("aac", "AAC.gpkg")),
    layer: get("--layer") ?? "AAC_FRA",
    sage: resolve(__dirname, get("--sage") ?? dataPath("aac", "sage.gpkg")),
    sageLayer: get("--sage-layer") ?? "sage_shape",
    base: resolve(__dirname, get("--base") ?? "zonage.pmtiles"),
    output: resolve(__dirname, get("--output") ?? "output/zonage.pmtiles"),
  };
}

const { aac, layer, sage, sageLayer, base, output } = parseArgs();

// Couches régénérées depuis leur GeoPackage. Les champs sont typés comme dans
// les couches d'origine du PMTiles ; les autres couches (ppr, ppe) sont reprises
// telles quelles depuis le PMTiles de base.
const SOURCES = [
  {
    // CdAAC et dates en texte, ArreteDelimitationAAC en entier. Les champs JSON
    // (AdminAAC, PTP…) sont sérialisés en chaîne par tippecanoe.
    layer: "aac",
    file: aac,
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
    // cd_type_pe et lb_type_pe : noms tronqués à 10 caractères de l'export
    // shapefile Gest'eau dont provenait la couche sage d'origine.
    layer: "sage",
    file: sage,
    sql: `
      SELECT nid, nom, type, code, cd_etat, lb_etat, cd_ss_etat, lb_ss_etat,
             cd_comite, lb_comite, necess2010, necess2016,
             cd_type_perimetre AS cd_type_pe, lb_type_perimetre AS lb_type_pe, geom
      FROM "${sageLayer}"`,
  },
];

for (const f of [aac, sage, base]) {
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
const regenPmtiles = join(tmp, "regen.pmtiles");
const sansRegenPmtiles = join(tmp, "sans_regen.pmtiles");
const joinedPmtiles = join(tmp, "joined.pmtiles");

try {
  // Étape 1 : export de chaque couche source en GeoJSON (une entité par ligne),
  // avec le typage défini dans SOURCES.
  console.log("\n[1/4] Export des couches sources");
  const counts = {};
  for (const s of SOURCES) {
    s.geojson = join(tmp, `${s.layer}.geojsonl`);
    sh("ogr2ogr", [
      "-f", "GeoJSONSeq", s.geojson, s.file,
      "-t_srs", "EPSG:4326", "-lco", "RS=NO", "-nln", s.layer,
      "-dialect", "SQLite", "-sql", s.sql,
    ]);
    counts[s.layer] = readFileSync(s.geojson, "utf8").split("\n").filter(Boolean).length;
  }

  // Étape 2 : tuilage des couches régénérées ensemble, avec les options du
  // PMTiles d'origine : --drop-densest-as-needed opère sur l'ensemble de ces couches.
  console.log("\n[2/4] Tuilage des couches régénérées");
  sh("tippecanoe", [
    `--output=${regenPmtiles}`, "--force", `--name=${name}`, `--description=${description}`,
    "-z14", "-Z0", ...SOURCES.flatMap((s) => ["-L", `${s.layer}:${s.geojson}`]),
    "--drop-densest-as-needed", "--quiet",
  ]);

  // Étape 3 : retrait des anciennes versions des couches régénérées, puis fusion.
  // -pk évite que tile-join ne supprime des entités dans les tuiles dépassant 500 Ko.
  console.log("\n[3/4] Fusion avec les couches reprises du PMTiles de base");
  const exclusions = SOURCES.flatMap((s) => ["-L", s.layer]);
  sh("tile-join", ["-f", "--quiet", "-o", sansRegenPmtiles, ...exclusions, base]);
  sh("tile-join", [
    "-f", "--quiet", "-pk", "-n", name, "-N", description,
    "-o", joinedPmtiles, sansRegenPmtiles, regenPmtiles,
  ]);

  // Étape 4 : correction des métadonnées laissées par tile-join.
  //   - generator_options : tile-join y concatène les commandes avec les chemins
  //     locaux ; on garde la commande tippecanoe d'origine et on décrit les
  //     étapes de régénération avec des noms de fichiers génériques.
  //   - tilestats : tile-join compte les occurrences par tuile, pas les entités ;
  //     on reprend ceux de tippecanoe pour les couches régénérées et ceux de la
  //     base pour le reste.
  //   - strategies : tile-join additionne celles de ses entrées, ce qui les
  //     ferait grossir à chaque régénération ; on garde celles de la base.
  console.log("\n[4/4] Correction des métadonnées");
  const meta = readMetadata(joinedPmtiles);
  const regenMeta = readMetadata(regenPmtiles);

  const origine = (baseMeta.generator_options ?? "").split("; ")[0];
  const exclusionsGeneriques = SOURCES.map((s) => `-L ${s.layer}`).join(" ");
  const couchesGeneriques = SOURCES.map((s) => `-L ${s.layer}:${s.layer}.geojsonl`).join(" ");
  meta.generator_options = [
    origine,
    `tile-join -o sans_regen.pmtiles ${exclusionsGeneriques} ${name}.pmtiles`,
    `tippecanoe '--output=regen.pmtiles' '--name=${name}' '--description=${description}' -z14 -Z0 ${couchesGeneriques} --drop-densest-as-needed`,
    `tile-join -pk -n ${name} -N '${description}' -o zonage.pmtiles sans_regen.pmtiles regen.pmtiles`,
  ].filter(Boolean).join("; ");

  const stats = Object.fromEntries((baseMeta.tilestats?.layers ?? []).map((l) => [l.layer, l]));
  for (const l of regenMeta.tilestats.layers) stats[l.layer] = l;
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
  for (const s of SOURCES) {
    const tuilees = final.tilestats.layers.find((l) => l.layer === s.layer)?.count;
    if (tuilees !== counts[s.layer]) {
      throw new Error(`Couche ${s.layer} : ${tuilees} entités tuilées pour ${counts[s.layer]} dans le GPKG`);
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
