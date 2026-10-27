/**
 * Dossier des données locales (non versionné), partagé par tous les scripts du dépôt.
 * Par défaut `data/` à la racine du dépôt. La variable d'environnement DATA_DIR permet
 * d'en désigner un autre, par exemple celui du checkout principal depuis un worktree.
 *
 *   s3/        copie locale des fichiers du bucket S3 : téléchargés s'ils sont absents,
 *              ou produits par les scripts aac puis envoyés par `aac/upload.js`
 *   aac/       sources propres aux outils AAC (AAC.gpkg, sage_shape.zip), cache et fichiers temporaires de fiches
 *   analyses/  dossier de travail de analyses_parquet_generator (sources, référentiels, sorties)
 *   captages/  entrées et sorties de captages_parquet_generator ; ppr/ppe_hilbert.parquet
 *              (périmètres de protection, sensibles) sont aussi lus par aac/zonage,
 *              captages_prioritaires.parquet et captages_new.parquet (codes BSS) par aac/fiches
 */

import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const DATA_DIR = resolve(process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data"));

export const dataPath = (...parts) => join(DATA_DIR, ...parts);
