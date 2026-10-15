# Instructions pour agents IA — aac/zonage

## Contexte

Ce dossier contient un **script one-shot** : `generate_zonage_pmtiles.js`.

Il remplace la couche `aac` d'un PMTiles de zonage existant (`water_protection` : `ppr`, `ppe`, `aac`, `sage`) par une couche générée depuis `AAC.gpkg`, sans toucher aux tuiles des autres couches. Le résultat est écrit dans `output/`, avec une copie dans `../data/`. Aucune dépendance réseau ni credentials ne sont requis.

## Commande

```bash
# depuis aac/
npm run zonage
# ou
node zonage/generate_zonage_pmtiles.js [--aac AAC.gpkg] [--layer AAC_FRA] [--base zonage.pmtiles] [--output output/zonage.pmtiles]
```

## Architecture de generate_zonage_pmtiles.js

1. **Arguments CLI** — `parseArgs()`, chemins résolus depuis `__dirname` ; vérification des fichiers d'entrée et des outils (`ogr2ogr`, `tippecanoe`, `tile-join`)
2. **PMTiles v3** — `readHeader()`, `readMetadata()`, `writeWithMetadata()` : lecture et réécriture du bloc de métadonnées, sans librairie
3. **Génération** — 4 étapes dans un dossier temporaire (`mkdtemp`) : export GeoJSON, tippecanoe, tile-join ×2, correction des métadonnées
4. **Vérification** — nombre d'entités `aac` dans les tilestats = nombre d'AAC exportées

## Conventions critiques

### Aucune dépendance npm
Les outils de tuilage sont appelés via `execFileSync` (arguments en tableau, pas de shell). Le format PMTiles est manipulé directement avec `fs` et `zlib`.

### Réécriture des métadonnées PMTiles
Les offsets des leaf directories et des tuiles sont relatifs à leur section : `writeWithMetadata()` recopie root directory, leaf directories et tile data à l'identique et ne met à jour que `metadata_offset`, `metadata_length`, `leaf_directory_offset` et `tile_data_offset` dans le header. Les tuiles restent identiques octet pour octet.

### Métadonnées corrigées après tile-join
- `generator_options` : premier segment (séparateur `"; "`) du PMTiles de base + étapes de régénération avec des noms de fichiers génériques. Ne jamais y laisser de chemin local.
- `tilestats` : `aac` depuis le PMTiles produit par tippecanoe, les autres couches depuis la base.
- `strategies` : reprises de la base, sinon tile-join les additionne à chaque exécution.

Grâce à ces corrections, le script est idempotent : relancé avec sa propre sortie comme `--base`, il produit un fichier identique octet pour octet.

### Typage des champs AAC
L'export `ogr2ogr` utilise une requête SQLite qui caste `CdAAC` et les dates en texte et `ArreteDelimitationAAC` en entier, pour garder les types de la couche `aac` d'origine. La liste des champs est explicite : un nouveau champ du GPKG n'apparaîtra pas sans modification de la requête.

## Pièges connus

- **Fichier `<output>.tmp`** écrit à côté de la sortie puis renommé (une écriture directe échouerait si `--output` est égal à `--base`). En cas d'erreur à l'étape 4, il peut rester sur le disque.
- **`renameSync` entre volumes** : ne pas écrire la sortie finale dans le dossier temporaire système puis la renommer, cela échoue avec `EXDEV`.
