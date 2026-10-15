# aac/geometries

Convertit un fichier **GeoPackage (GPKG) des Aires d'Alimentation de Captage** en fichier **GeoParquet trié par courbe de Hilbert**, optimisé pour des requêtes spatiales performantes via DuckDB.

## Prérequis

- Node.js ≥ 22

```bash
# depuis aac/
npm install
```

## Usage

1. Placer le fichier `AAC.gpkg` dans `../data/` (partagé avec `../zonage`)
2. Lancer la conversion :

```bash
# depuis aac/
npm run geometries
# ou directement :
node geometries/generate_aac_geometries_parquet.js
```

Le fichier `output/aac_hilbert.parquet` est produit, et copié dans `../data/` où `../fiches` le lit. L'upload sur S3 n'est utile que pour le partager avec l'équipe.

### Chemins personnalisés

```bash
node generate_aac_geometries_parquet.js --input /chemin/vers/AAC.gpkg --output /chemin/vers/out.parquet
```

## Fichier produit

| Fichier | Description |
|---|---|
| `aac_hilbert.parquet` | GeoParquet WGS84, trié par courbe de Hilbert, compression ZSTD |

### Colonnes

| Colonne | Type | Description |
|---|---|---|
| `cdaac` | VARCHAR | Code de l'AAC |
| `nom` | VARCHAR | Nom administratif de l'AAC |
| `datecreati` | VARCHAR | Date de création |
| `datemajaac` | VARCHAR | Date de dernière mise à jour |
| `geom` | GEOMETRY | Géométrie MultiPolygon (WGS84 / OGC:CRS84) |

