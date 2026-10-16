/**
 * Dossier des données locales (non versionné), partagé par tous les scripts du dépôt.
 * Par défaut `data/` à la racine du dépôt. La variable d'environnement DATA_DIR permet
 * d'en désigner un autre, par exemple celui du checkout principal depuis un worktree.
 *
 *   s3/        copie locale des fichiers du bucket S3 : téléchargés s'ils sont absents,
 *              ou produits par les scripts aac puis envoyés par `aac/upload.js`
 *   aac/       sources propres aux outils AAC (AAC.gpkg, sage.gpkg), cache et fichiers temporaires de fiches
 *   analyses/  dossier de travail de analyses_parquet_generator (sources, référentiels, sorties)
 *   captages/  entrées et sortie de captages_parquet_generator
 */

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const DATA_DIR = resolve(process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data"));

export const dataPath = (...parts) => join(DATA_DIR, ...parts);
