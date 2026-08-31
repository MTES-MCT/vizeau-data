# Instructions pour agents IA — gpkg_to_parquet

## Contexte

Ce dossier contient un **script de conversion one-shot** : `convert_gpkg_to_parquet.js`.

Il lit un fichier GeoPackage (`AAC.gpkg`) local, le convertit en GeoParquet trié par courbe de Hilbert via DuckDB, et écrit le résultat dans le même dossier. Aucune dépendance réseau ni credentials ne sont requis.

C'est le pendant local de `geojson_to_parquet/convert_to_parquet.js` (qui lui opère via S3).

## Commande

```bash
npm run convert
# ou
node convert_gpkg_to_parquet.js [--input AAC.gpkg] [--output aac_hilbert.parquet]
```

## Architecture de convert_gpkg_to_parquet.js

Le script est structuré en 4 sections dans cet ordre :

1. **Imports** — `@duckdb/node-api`, modules Node natifs (`fs`, `path`, `url`)
2. **Arguments CLI** — `parseArgs()` lit `--input` et `--output`, résout les chemins depuis `__dirname`
3. **DuckDB** — instance en mémoire, helpers `run()` et `query()`, chargement des extensions `spatial` et `parquet`
4. **Conversion** — deux passes COPY + vérification finale

## Conventions critiques

### API DuckDB
- Utilise `@duckdb/node-api` (pas l'ancien package `duckdb`)
- `run(sql)` → `conn.run(sql)` — pour DDL / COPY
- `query(sql)` → `conn.runAndReadAll(sql).then(r => r.getRowObjects())` — pour SELECT

### Tri Hilbert — deux passes obligatoires
La conversion écrit d'abord un fichier temporaire avec la colonne `hilbert_idx`, puis en recrée un second sans elle. Ne pas fusionner en une seule passe : DuckDB ne peut pas à la fois trier et exclure la colonne de tri dans un seul `COPY`.

### Géométries
- Le GPKG source contient des `Polygon` ; ils sont convertis en `MultiPolygon` via `ST_Multi()` pour cohérence avec le GeoJSON source utilisé par `geojson_to_parquet`
- CRS conservé : WGS84 (OGC:CRS84)
- La BBox de normalisation Hilbert couvre la France entière (métropole + DROM) : `min_x: -61.5, min_y: -12.9, max_x: 55.9, max_y: 51.5`

### Colonnes produites
Le GPKG a des noms de colonnes différents du GeoJSON source. La correspondance est :

| GPKG | Parquet produit |
|---|---|
| `CdAAC` (Integer64) | `cdaac` (VARCHAR) |
| `NomDeAACAdministratif` | `nom` |
| `DateCreationAAC` (Date) | `datecreati` (VARCHAR) |
| `DateMajAAC` (Date) | `datemajaac` (VARCHAR) |
| `geom` (Polygon) | `geom` (MultiPolygon) |

## Pièges connus

- **`INSTALL spatial` dans DuckDB** peut télécharger l'extension depuis internet au premier lancement — prévoir une connexion réseau.
- **Fichier temporaire** `aac_hilbert.parquet.tmp.parquet` créé à côté du fichier de sortie et supprimé automatiquement. En cas d'erreur, il peut rester sur le disque.
- **`DESCRIBE` dans DuckDB** retourne `column_name` et `column_type` (pas `data_type`). Utiliser `column_type`.
