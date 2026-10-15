/**
 * Régénère toutes les données AAC à partir de data/AAC.gpkg, dans l'ordre :
 *   1. geometries → geometries/output/aac_hilbert.parquet (copie dans data/)
 *   2. zonage     → zonage/output/zonage.pmtiles (copie dans data/)
 *   3. fiches     → fiches/output/aac.parquet (copie dans data/) + S3
 *                   (lit data/aac_hilbert.parquet produit à l'étape 1)
 *
 * Usage :
 *   npm run all
 *
 * L'upload de data/aac_hilbert.parquet sur S3, pour le partager avec l'équipe,
 * reste manuel.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const gpkg = join(__dirname, "data", "AAC.gpkg");
if (!existsSync(gpkg)) {
  console.error(`Erreur : fichier introuvable : ${gpkg}`);
  process.exit(1);
}

function step(title, script) {
  console.log(`\n━━━ ${title} (${script}/) ━━━\n`);
  execFileSync("npm", ["run", script], { cwd: __dirname, stdio: "inherit" });
}

step("1/3 Géométries AAC", "geometries");
step("2/3 PMTiles de zonage", "zonage");
step("3/3 Fiches AAC", "fiches");
