# gpkg_to_parquet

Convertit un fichier **GeoPackage (GPKG) des Aires d'Alimentation de Captage** en fichier **GeoParquet trié par courbe de Hilbert**, optimisé pour des requêtes spatiales performantes via DuckDB.

## Prérequis

- Node.js ≥ 22

```bash
npm install
```

## Usage

1. Placer le fichier `AAC.gpkg` dans ce dossier
2. Lancer la conversion :

```bash
npm run convert
# ou directement :
node convert_gpkg_to_parquet.js
```

Le fichier `aac_hilbert.parquet` est produit dans ce même dossier.

### Chemins personnalisés

```bash
node convert_gpkg_to_parquet.js --input /chemin/vers/AAC.gpkg --output /chemin/vers/out.parquet
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

