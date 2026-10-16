# aac/zonage

Met à jour la couche **`aac`** du PMTiles de zonage de protection de l'eau (`water_protection` : couches `ppr`, `ppe`, `aac`, `sage`) à partir du **GeoPackage des Aires d'Alimentation de Captage**, en conservant à l'identique les tuiles des autres couches.

Les sources GeoJSON des couches `ppr`, `ppe` et `sage` n'étant pas disponibles, ces couches sont reprises telles quelles depuis un PMTiles existant (« PMTiles de base ») : seules les AAC sont rafraîchies.

## Prérequis

- Node.js ≥ 22 (aucune dépendance npm)
- Dans le `PATH` :
  - `ogr2ogr` (GDAL)
  - `tippecanoe` et `tile-join` (testé avec tippecanoe v2.79.0)

```bash
brew install gdal tippecanoe
```

## Usage

1. Placer le PMTiles de zonage existant dans ce dossier sous le nom `zonage.pmtiles`
2. Vérifier que `data/aac/AAC.gpkg` (à la racine du dépôt) est à jour
3. Lancer la génération :

```bash
# depuis aac/
npm run zonage
# ou directement :
node zonage/generate_zonage_pmtiles.js
```

Le fichier `output/zonage.pmtiles` est produit (environ 1 minute), et copié dans `data/s3/`.

### Options

```bash
node generate_zonage_pmtiles.js \
  --aac    /chemin/vers/AAC.gpkg \
  --layer  AAC_FRA \
  --base   /chemin/vers/zonage.pmtiles \
  --output /chemin/vers/zonage.pmtiles
```

| Option | Défaut | Description |
|---|---|---|
| `--aac` | `data/aac/AAC.gpkg` (racine du dépôt) | GeoPackage des AAC |
| `--layer` | `AAC_FRA` | Couche du GeoPackage |
| `--base` | `zonage.pmtiles` | PMTiles existant dont on reprend les couches autres que `aac` |
| `--output` | `output/zonage.pmtiles` | Fichier produit (peut être égal à `--base`) |

Les chemins relatifs sont résolus depuis ce dossier.

## Fonctionnement

```
AAC.gpkg (couche AAC_FRA)
   │
   │ [1] ogr2ogr ── typage des champs
   ▼
aac.geojsonl
   │
   │ [2] tippecanoe -z14 -Z0 --drop-densest-as-needed
   ▼
aac.pmtiles ─────────────────────────────┐
   (tilestats aac)                       │
                                         │
zonage.pmtiles (base)                    │
   │                                     │
   │ [3a] tile-join -L aac               │
   ▼                                     ▼
sans_aac.pmtiles ──────────► [3b] tile-join -pk
   (ppr, ppe, sage inchangées)           │
                                         ▼
                                  joined.pmtiles
                                         │
                                         │ [4] réécriture des métadonnées
                                         ▼
                              output/zonage.pmtiles
```

1. **Export GeoJSON** — la couche AAC du GPKG est exportée en GeoJSON (une entité par ligne). Les champs sont typés comme dans la couche `aac` d'origine : `CdAAC` et dates en texte, `ArreteDelimitationAAC` en entier, `NivQualite` en nombre. Les champs JSON (`AdminAAC`, `CommandAAC`, `PTP`, `CodesAlternatifs`, `DepArreteDelim`) sont sérialisés en chaîne par tippecanoe.
2. **Tuilage** — tippecanoe génère la couche `aac` avec les options du PMTiles d'origine (zooms 0 à 14, `--drop-densest-as-needed`).
3. **Fusion** — `tile-join -L aac` retire l'ancienne couche `aac` du PMTiles de base, puis un second `tile-join` fusionne le résultat avec la nouvelle couche. `-pk` empêche tile-join de supprimer des entités dans les tuiles de plus de 500 Ko.
4. **Métadonnées** — tile-join laisse des métadonnées incorrectes, corrigées en réécrivant le bloc de métadonnées du PMTiles (tuiles et index recopiés à l'identique) :
   - `generator_options` : sans chemins locaux, avec la commande tippecanoe d'origine suivie des étapes de régénération
   - `tilestats` : ceux calculés par tippecanoe pour `aac`, ceux du PMTiles de base pour les autres couches (tile-join compte les occurrences par tuile, pas les entités)
   - `strategies` : celles du PMTiles de base (tile-join les additionne, elles grossiraient à chaque régénération)

Les fichiers intermédiaires sont écrits dans un dossier temporaire supprimé en fin d'exécution.

Le script vérifie en fin d'exécution que la couche `aac` contient autant d'entités que le GeoPackage.

## Fichier produit

| Couche | Source | Contenu |
|---|---|---|
| `aac` | GeoPackage AAC | Aires d'Alimentation de Captage, tous statuts (`Validé`, `Gelé`) |
| `ppe` | PMTiles de base | Périmètres de protection éloignée |
| `ppr` | PMTiles de base | Périmètres de protection rapprochée |
| `sage` | PMTiles de base | Schémas d'aménagement et de gestion des eaux |

### Attributs de la couche `aac`

`CdAAC`, `NomDeAACAdministratif`, `NomDeAACUsage`, `NomDeAACAutre`, `DateCreationAAC`, `DateMajAAC`, `StAAC`, `ComAAC`, `NumCircAdminBassin`, `NomCircAdminBassin`, `NivQualite`, `ArreteDelimitationAAC`, `DateArreteDelim`, `DepArreteDelim`, `AdminAAC`, `CommandAAC`, `CodesAlternatifs`, `PTP`.

Par rapport au PMTiles d'origine (généré fin 2025), `CommandAAC` a été ajouté ; `ProducAAC`, `gid` et `id`, absents du GeoPackage, ont disparu. L'identifiant à utiliser est `CdAAC`.

## Limites

- Seule la couche `aac` est rafraîchie : `ppr`, `ppe` et `sage` ont l'ancienneté du PMTiles de base.
- La sélection des entités par tippecanoe (`--drop-densest-as-needed`) aux petits zooms est calculée sur la seule couche `aac`, et non sur l'ensemble des couches comme lors de la génération d'origine.
