# vizeau-data

Recueil d'outils de transformation de données liés au projet Viz'eau.

## Outils

### [`pmtiles_generator`](pmtiles_generator/README.md)

Génère un fichier **PMTiles** multi-couches à partir du **Registre Parcellaire Graphique (RPG)**, via des pipelines [Tylt](https://github.com/tylt-org/tylt). Deux sources sont gérées : `rpg1` traite le RPG de niveau 1, public (archives GeoPackage IGN), et `rpg2` traite le RPG de niveau 2, privé (shapefiles départementaux sur S3). Point d'entrée unique : `./run.sh <source> <MILLESIME>`, avec upload S3 en fin de pipeline.

### [`gpkg_to_parquet`](gpkg_to_parquet/README.md)

Convertit le GeoPackage des **Aires d'Alimentation de Captage (AAC)** en **GeoParquet** (WGS84, compression ZSTD) trié par courbe de Hilbert, pour des requêtes spatiales performantes avec DuckDB.

### [`captages_parquet_generator`](captages_parquet_generator/README.md)

Génère `captages.parquet`, le fichier de recensement des captages d'eau publique sensibles, à partir de données internes au ministère de la Transition écologique. Les codes des périmètres de protection (PPI, PPR, PPE) de chaque captage sont reconstruits par intersection spatiale.

### [`aac_parquet_generator`](aac_parquet_generator/README.md)

Pipeline Node.js/DuckDB qui construit une **fiche descriptive par AAC** (surface, emprise, communes, installations de captage, répartition des cultures sur la SAU/PPE/PPR, part du bio, évolution annuelle des cultures) à partir des fichiers Parquet stockés sur S3, puis publie le résultat en `aac.parquet` sur S3.

## Enchaînement

```
gpkg_to_parquet ──────────────┐
                              ├──► aac_parquet_generator ──► aac.parquet (S3)
captages_parquet_generator ───┘

pmtiles_generator ──► RPG en PMTiles (S3)
```
