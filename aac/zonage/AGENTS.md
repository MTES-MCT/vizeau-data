# Instructions pour agents IA — aac/zonage

## Contexte

Ce dossier contient un **script one-shot** : `generate_zonage_pmtiles.js`.

Il remplace les couches `aac` et `sage` d'un PMTiles de zonage existant (`water_protection` : `ppr`, `ppe`, `aac`, `sage`) par des couches générées depuis `data/aac/AAC.gpkg` et `data/aac/sage.gpkg` (périmètres des SAGE de Gest'eau, voir le README pour le téléchargement), sans toucher aux tuiles des couches `ppr` et `ppe`. Le résultat est écrit dans `output/`, avec une copie dans `data/s3/` (racine du dépôt). Aucune dépendance réseau ni credentials ne sont requis.

## Commande

```bash
# depuis aac/
npm run zonage
# ou
node zonage/generate_zonage_pmtiles.js [--aac AAC.gpkg] [--layer AAC_FRA] [--sage sage.gpkg] [--sage-layer sage_shape] [--base zonage.pmtiles] [--output output/zonage.pmtiles]
```

## Architecture de generate_zonage_pmtiles.js

1. **Arguments CLI** — `parseArgs()`, chemins résolus depuis `__dirname` ; `SOURCES` liste les couches régénérées (nom, GPKG, requête SQL) ; vérification des fichiers d'entrée et des outils (`ogr2ogr`, `tippecanoe`, `tile-join`)
2. **PMTiles v3** — `readHeader()`, `readMetadata()`, `writeWithMetadata()` : lecture et réécriture du bloc de métadonnées, sans librairie
3. **Génération** — 4 étapes dans un dossier temporaire (`mkdtemp`) : export GeoJSON de chaque source, un seul tippecanoe pour toutes les couches de `SOURCES`, tile-join ×2, correction des métadonnées
4. **Vérification** — pour chaque couche de `SOURCES`, nombre d'entités dans les tilestats = nombre d'entités exportées

## Conventions critiques

### Aucune dépendance npm
Les outils de tuilage sont appelés via `execFileSync` (arguments en tableau, pas de shell). Le format PMTiles est manipulé directement avec `fs` et `zlib`.

### Réécriture des métadonnées PMTiles
Les offsets des leaf directories et des tuiles sont relatifs à leur section : `writeWithMetadata()` recopie root directory, leaf directories et tile data à l'identique et ne met à jour que `metadata_offset`, `metadata_length`, `leaf_directory_offset` et `tile_data_offset` dans le header. Les tuiles restent identiques octet pour octet.

### Métadonnées corrigées après tile-join
- `generator_options` : premier segment (séparateur `"; "`) du PMTiles de base + étapes de régénération avec des noms de fichiers génériques. Ne jamais y laisser de chemin local.
- `tilestats` : couches de `SOURCES` depuis le PMTiles produit par tippecanoe, les autres (`ppr`, `ppe`) depuis la base.
- `strategies` : reprises de la base, sinon tile-join les additionne à chaque exécution.

Grâce à ces corrections, le script est idempotent : relancé avec sa propre sortie comme `--base`, il produit un fichier identique octet pour octet.

### Typage des champs
Chaque export `ogr2ogr` utilise une requête SQLite (dans `SOURCES`) qui reproduit le schéma de la couche d'origine :
- `aac` : `CdAAC` et dates castés en texte, `ArreteDelimitationAAC` en entier ;
- `sage` : `cd_type_perimetre`/`lb_type_perimetre` renommés en `cd_type_pe`/`lb_type_pe` (noms tronqués de l'export shapefile Gest'eau d'origine).

Les listes de champs sont explicites : un nouveau champ d'un GPKG n'apparaîtra pas sans modification de la requête.

### Ajouter une couche régénérée
Ajouter une entrée à `SOURCES` (et l'option CLI du fichier source) suffit : export, tuilage, exclusion de la base, tilestats, `generator_options` et vérification en dérivent.

## Pièges connus

- **Fichier `<output>.tmp`** écrit à côté de la sortie puis renommé (une écriture directe échouerait si `--output` est égal à `--base`). En cas d'erreur à l'étape 4, il peut rester sur le disque.
- **`renameSync` entre volumes** : ne pas écrire la sortie finale dans le dossier temporaire système puis la renommer, cela échoue avec `EXDEV`.
