# vizeau-data

Recueil d'outils de transformation de données liés au projet Viz'eau.

## Outils

### [`pmtiles_generator`](pmtiles_generator/README.md)

Génère un fichier **PMTiles** multi-couches à partir du **Registre Parcellaire Graphique (RPG)**, via des pipelines [Tylt](https://github.com/tylt-org/tylt). Deux sources sont gérées : `rpg1` traite le RPG de niveau 1, public (archives GeoPackage IGN), et `rpg2` traite le RPG de niveau 2, privé (shapefiles départementaux sur S3). Point d'entrée unique : `./run.sh <source> <MILLESIME>`, avec upload S3 en fin de pipeline.

### [`aac`](aac/README.md)

Outils des **Aires d'Alimentation de Captage (AAC)**, alimentés par une source commune (`data/aac/AAC.gpkg`) et lancés ensemble via `npm run all` :

- [`aac/geometries`](aac/geometries/README.md) — convertit le GeoPackage des AAC en **GeoParquet** (WGS84, ZSTD) trié par courbe de Hilbert, pour des requêtes spatiales performantes avec DuckDB.
- [`aac/fiches`](aac/fiches/README.md) — pipeline Node.js/DuckDB qui construit une **fiche descriptive par AAC** (surface, emprise, communes, installations de captage, répartition des cultures sur la SAU/PPE/PPR, part du bio, évolution annuelle des cultures) à partir des fichiers Parquet stockés sur S3, puis publie le résultat en `aac.parquet` sur S3.
- [`aac/zonage`](aac/zonage/README.md) — met à jour la couche **`aac`** du PMTiles de zonage de protection de l'eau (`ppr`, `ppe`, `aac`, `sage`) via tippecanoe et tile-join, en reprenant telles quelles les autres couches.

### [`captages_parquet_generator`](captages_parquet_generator/README.md)

Génère `captages.parquet`, le fichier de recensement des captages d'eau publique sensibles, à partir de données internes au ministère de la Transition écologique. Les codes des périmètres de protection (PPI, PPR, PPE) de chaque captage sont reconstruits par intersection spatiale.

### [`analyses_parquet_generator`](analyses_parquet_generator/README.md)

Script Node.js/DuckDB qui génère `analyses_robinet.parquet` : une ligne par **résultat d'analyse réalisée sur un captage**, à partir des fichiers du contrôle sanitaire de l'eau (data.gouv.fr), enrichie avec le libellé du paramètre, les limites et références de qualité et le statut de captage prioritaire.

## Enchaînement

```
                 ┌──► aac/geometries ──► aac_hilbert.parquet ──(upload S3 manuel)──┐
                 │                                                                 ▼
data/aac/AAC.gpkg┤                                captages_parquet_generator ──► aac/fiches ──► aac.parquet (S3)
                 │
                 └──► aac/zonage ──► zonage.pmtiles (couche aac mise à jour)

pmtiles_generator ──► RPG en PMTiles (S3)

analyses_parquet_generator ──► analyses_robinet.parquet
```

## Données locales

Les scripts lisent et écrivent leurs données dans `data/`, à la racine du dépôt (non versionné). Le chemin est défini dans [`data-dir.mjs`](data-dir.mjs) ; la variable d'environnement `DATA_DIR` permet d'en utiliser un autre, par exemple pour qu'un worktree travaille sur les données du checkout principal.

```
data/
├── s3/         copie locale du bucket S3 : sources téléchargées par aac/fiches si absentes,
│               et copies des fichiers produits par aac (aac_hilbert, aac, zonage)
├── aac/        AAC.gpkg, cache des agrégats RPG (cache/), fichiers temporaires de fiches
├── analyses/   dossier de travail de analyses_parquet_generator : sources/ (CAP_*),
│               référentiels (téléchargés depuis S3 s'ils manquent), fichiers produits
└── captages/   entrées (référentiels, périmètres pp*_hilbert) et sortie (captages_new.parquet)
                de captages_parquet_generator
```
