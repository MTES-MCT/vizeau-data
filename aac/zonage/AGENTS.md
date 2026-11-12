# Instructions pour agents IA — aac/zonage

## Contexte

Ce dossier contient un **script one-shot** : `generate_zonage_pmtiles.js`.

Il génère de zéro le PMTiles de zonage (`water_protection` : `ppr`, `ppe`, `aac`, `sage`) à partir de quatre fichiers sources dans `data/` (racine du dépôt) :

- `data/captages/ppr_hilbert.parquet`, `data/captages/ppe_hilbert.parquet` : périmètres de protection, **données sensibles** d'origine institutionnelle, modifiées par l'équipe Viz'eau pour masquer les PPI ;
- `data/aac/AAC.gpkg` : AAC du SANDRE ;
- `data/aac/sage_shape.zip` : shapefile zippé des périmètres des SAGE de Gest'eau (voir le README pour le téléchargement).

Le résultat est écrit dans `output/`, avec une copie dans `data/s3/`. Aucune dépendance réseau ni credentials ne sont requis.

## Commande

```bash
# depuis aac/
npm run zonage
# ou
node zonage/generate_zonage_pmtiles.js [--aac AAC.gpkg] [--layer AAC_FRA] [--sage sage_shape.zip] [--sage-layer sage_shape] [--ppr ppr_hilbert.parquet] [--ppe ppe_hilbert.parquet] [--output output/zonage.pmtiles]
```

## Architecture de generate_zonage_pmtiles.js

1. **Arguments CLI** — `parseArgs()`, chemins résolus depuis `__dirname` ; `SOURCES` liste les couches (nom, fichier source, requête SQL) dans l'ordre de la génération d'origine ; vérification des fichiers d'entrée et des outils (`ogr2ogr`, `tippecanoe`)
2. **Génération** — 2 étapes dans un dossier temporaire (`mkdtemp`) : export GeoJSON de chaque source (suivi de `transform` sur les propriétés si la source en définit un), un seul tippecanoe pour toutes les couches
3. **Vérification** — pour chaque couche, nombre d'entités dans les tilestats = nombre d'entités exportées ; `readMetadata()` lit les métadonnées du PMTiles sans librairie

## Conventions critiques

### Génération de zéro, jamais incrémentale
Le script ne doit lire aucun PMTiles existant, et en particulier pas sa propre sortie : toutes les couches viennent de fichiers sources. Si une couche n'a pas de source, il faut en trouver une plutôt que de la reprendre d'un PMTiles.

### Aucune dépendance npm
Les outils sont appelés via `execFileSync` (arguments en tableau, pas de shell).

### Pas de chemin local dans les métadonnées
tippecanoe enregistre sa ligne de commande dans `generator_options`. Il est lancé avec `cwd` = dossier temporaire et des chemins relatifs (`zonage.pmtiles`, `<couche>.geojsonl`), puis le fichier est copié vers `--output`. La génération est ainsi déterministe (même sortie octet pour octet à sources identiques).

### Typage des champs
Chaque export `ogr2ogr` utilise une requête SQLite (dans `SOURCES`) qui reproduit le schéma de la couche d'origine :
- `ppr`, `ppe` : `code_pp` seul (le nom de la couche Parquet est le nom du fichier sans extension). Ne pas y ajouter `psv_code` ni les autres attributs d'origine, pourtant présents dans les parquets : le lien périmètre → point de surveillance ne doit pas être diffusé, et le PMTiles l'est ;
- `aac` : `CdAAC` et dates castés en texte, `ArreteDelimitationAAC` en entier ; `NomDeAACAdministratif` nettoyé après l'export par `nettoyerLibelle()` (le dialecte SQLite d'ogr2ogr n'a pas de `regexp_replace`) ;
- `sage` : champs du shapefile repris tels quels ; `REPLACE` rétablit « œuvre » dans `lb_etat`/`lb_ss_etat` (DBF en Latin-1, « œ » y devient « ? »). Lu via `/vsizip/` quand le chemin finit par `.zip`.

Les listes de champs sont explicites : un nouveau champ d'une source n'apparaîtra pas sans modification de la requête.

### Nettoyage des libellés aligné sur aac/geometries
`nettoyerLibelle()` transcrit en JavaScript l'expression DuckDB `NOM` de `aac/geometries/generate_aac_geometries_parquet.js`, dans le même ordre. Les classes d'espaces sont celles de RE2 (`[\t\n\f\r ]`), pas le `\s` de JavaScript. Toute modification de l'une doit être reportée dans l'autre, sinon la carte et les fiches n'afficheront plus le même nom.

### Données sensibles
Les périmètres de protection (`ppr`, `ppe`) sont des données sensibles. Ne pas en copier d'extraits dans la documentation, les logs ou des fichiers versionnés.

## Pièges connus

- **Source SAGE en shapefile, pas en GPKG** : l'export GPKG/GeoJSON du WFS OIEau assemble mal les multipolygones (îlot en contour extérieur, vrai contour en trou) ; tippecanoe fait alors disparaître 6 SAGE. Ne pas repasser au GPKG sans vérifier `ST_IsValid` sur toutes les entités.
- **Doublons de `code_pp`** : les parquets ont une entité par couple (périmètre, captage rattaché). Ne pas dédoublonner sans décision explicite : c'est la structure des couches d'origine.
- **`copyFileSync` et non `renameSync`** pour sortir du dossier temporaire : un renommage entre volumes échoue avec `EXDEV`.
