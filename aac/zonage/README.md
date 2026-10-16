# aac/zonage

Met à jour les couches **`aac`** et **`sage`** du PMTiles de zonage de protection de l'eau (`water_protection` : couches `ppr`, `ppe`, `aac`, `sage`) à partir de leurs GeoPackages sources, en conservant à l'identique les tuiles des couches `ppr` et `ppe`.

Les sources des couches `ppr` et `ppe` (périmètres de protection rapprochée et éloignée des captages, données ARS) n'étant pas disponibles avec tous leurs attributs, ces couches sont reprises telles quelles depuis un PMTiles existant (« PMTiles de base ») : seules les couches `aac` et `sage` sont rafraîchies.

## Sources

| Couche | Fichier | Couche du GPKG | Origine |
|---|---|---|---|
| `aac` | `data/aac/AAC.gpkg` | `AAC_FRA` | Aires d'Alimentation de Captage du [SANDRE](https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/f6a60c29-77dc-4bc1-a8d2-bf0572bf58ab) (voir [`../README.md`](../README.md#source)) |
| `sage` | `data/aac/sage.gpkg` | `sage_shape` | Périmètres des SAGE de [Gest'eau](https://www.gesteau.fr/telecharger/sage) (OIEau) |
| `ppr`, `ppe` | `zonage.pmtiles` (PMTiles de base) | — | Reprises du PMTiles de zonage existant |

Les fichiers de `data/` ne sont pas versionnés (voir [`data-dir.mjs`](../../data-dir.mjs)).

### Télécharger `sage.gpkg`

La couche `sage_shape` est servie par le WFS de l'OIEau qui alimente Gest'eau, `https://maps.oieau.fr/ows/OIEau/gesteau`. Elle correspond à l'export shapefile proposé sur [gesteau.fr/telecharger/sage](https://www.gesteau.fr/telecharger/sage), dont provenait la couche `sage` d'origine, avec les mêmes champs. Le WFS reste accessible quand gesteau.fr ne l'est pas.

Le serveur renvoie le GeoPackage dans une archive zip contenant un seul fichier, `result.gpkg` :

```bash
# depuis la racine du dépôt
curl -o /tmp/sage.zip "https://maps.oieau.fr/ows/OIEau/gesteau?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=sa:sage_shape&OUTPUTFORMAT=GPKG&SRSNAME=EPSG:4326"
unzip -p /tmp/sage.zip result.gpkg > data/aac/sage.gpkg
ogrinfo -so data/aac/sage.gpkg sage_shape   # vérification : ~200 entités, champs nid, code, nom, cd_etat…
```

Le WFS propose d'autres couches SAGE (`sa:sage`, `sa:sage_type_perimetre_etat`…) avec des champs plus récents (`necessaire_sdage_2015/2021/2022` au lieu de `necess2010/2016`). Le script attend les champs de `sage_shape`.

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
2. Vérifier que `data/aac/AAC.gpkg` et `data/aac/sage.gpkg` (à la racine du dépôt) sont à jour
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
  --aac        /chemin/vers/AAC.gpkg \
  --layer      AAC_FRA \
  --sage       /chemin/vers/sage.gpkg \
  --sage-layer sage_shape \
  --base       /chemin/vers/zonage.pmtiles \
  --output     /chemin/vers/zonage.pmtiles
```

| Option | Défaut | Description |
|---|---|---|
| `--aac` | `data/aac/AAC.gpkg` (racine du dépôt) | GeoPackage des AAC |
| `--layer` | `AAC_FRA` | Couche du GeoPackage des AAC |
| `--sage` | `data/aac/sage.gpkg` (racine du dépôt) | GeoPackage des périmètres des SAGE |
| `--sage-layer` | `sage_shape` | Couche du GeoPackage des SAGE |
| `--base` | `zonage.pmtiles` | PMTiles existant dont on reprend les couches `ppr` et `ppe` |
| `--output` | `output/zonage.pmtiles` | Fichier produit (peut être égal à `--base`) |

Les chemins relatifs sont résolus depuis ce dossier.

## Fonctionnement

```
AAC.gpkg (AAC_FRA)        sage.gpkg (sage_shape)
   │                          │
   │ [1] ogr2ogr ── typage des champs
   ▼                          ▼
aac.geojsonl              sage.geojsonl
   │                          │
   └────────────┬─────────────┘
                │ [2] tippecanoe -z14 -Z0 --drop-densest-as-needed
                ▼
           regen.pmtiles ────────────────┐
   (tilestats aac, sage)                 │
                                         │
zonage.pmtiles (base)                    │
   │                                     │
   │ [3a] tile-join -L aac -L sage       │
   ▼                                     ▼
sans_regen.pmtiles ────────► [3b] tile-join -pk
   (ppr, ppe inchangées)                 │
                                         ▼
                                  joined.pmtiles
                                         │
                                         │ [4] réécriture des métadonnées
                                         ▼
                              output/zonage.pmtiles
```

1. **Export GeoJSON** — chaque couche source est exportée en GeoJSON (une entité par ligne). Les champs sont typés comme dans les couches d'origine du PMTiles :
   - `aac` : `CdAAC` et dates en texte, `ArreteDelimitationAAC` en entier, `NivQualite` en nombre. Les champs JSON (`AdminAAC`, `CommandAAC`, `PTP`, `CodesAlternatifs`, `DepArreteDelim`) sont sérialisés en chaîne par tippecanoe.
   - `sage` : `cd_type_perimetre` et `lb_type_perimetre` sont renommés en `cd_type_pe` et `lb_type_pe`, les noms tronqués de l'export shapefile utilisé à l'origine.
2. **Tuilage** — tippecanoe génère les couches `aac` et `sage` ensemble, avec les options du PMTiles d'origine (zooms 0 à 14, `--drop-densest-as-needed`).
3. **Fusion** — `tile-join -L aac -L sage` retire les anciennes couches du PMTiles de base, puis un second `tile-join` fusionne le résultat avec les nouvelles. `-pk` empêche tile-join de supprimer des entités dans les tuiles de plus de 500 Ko.
4. **Métadonnées** — tile-join laisse des métadonnées incorrectes, corrigées en réécrivant le bloc de métadonnées du PMTiles (tuiles et index recopiés à l'identique) :
   - `generator_options` : sans chemins locaux, avec la commande tippecanoe d'origine suivie des étapes de régénération
   - `tilestats` : ceux calculés par tippecanoe pour `aac` et `sage`, ceux du PMTiles de base pour `ppr` et `ppe` (tile-join compte les occurrences par tuile, pas les entités)
   - `strategies` : celles du PMTiles de base (tile-join les additionne, elles grossiraient à chaque régénération)

Les fichiers intermédiaires sont écrits dans un dossier temporaire supprimé en fin d'exécution.

Le script vérifie en fin d'exécution que les couches `aac` et `sage` contiennent autant d'entités que leurs GeoPackages.

## Fichier produit

| Couche | Source | Contenu |
|---|---|---|
| `aac` | `AAC.gpkg` | Aires d'Alimentation de Captage, tous statuts (`Validé`, `Gelé`) |
| `ppe` | PMTiles de base | Périmètres de protection éloignée |
| `ppr` | PMTiles de base | Périmètres de protection rapprochée |
| `sage` | `sage.gpkg` | Schémas d'aménagement et de gestion des eaux, outre-mer compris |

### Attributs de la couche `aac`

`CdAAC`, `NomDeAACAdministratif`, `NomDeAACUsage`, `NomDeAACAutre`, `DateCreationAAC`, `DateMajAAC`, `StAAC`, `ComAAC`, `NumCircAdminBassin`, `NomCircAdminBassin`, `NivQualite`, `ArreteDelimitationAAC`, `DateArreteDelim`, `DepArreteDelim`, `AdminAAC`, `CommandAAC`, `CodesAlternatifs`, `PTP`.

Par rapport au PMTiles d'origine (généré fin 2025), `CommandAAC` a été ajouté ; `ProducAAC`, `gid` et `id`, absents du GeoPackage, ont disparu. L'identifiant à utiliser est `CdAAC`.

### Attributs de la couche `sage`

`nid`, `code`, `nom`, `type`, `cd_etat`, `lb_etat`, `cd_ss_etat`, `lb_ss_etat`, `cd_comite`, `lb_comite`, `necess2010`, `necess2016`, `cd_type_pe`, `lb_type_pe`.

Mêmes champs et mêmes types que dans le PMTiles d'origine. L'identifiant à utiliser est `code` (`SAGE03022`…) : `nid` est un identifiant interne de Gest'eau qui a changé depuis la génération d'origine.

## Limites

- Les couches `ppr` et `ppe` ont l'ancienneté du PMTiles de base.
- La sélection des entités par tippecanoe (`--drop-densest-as-needed`) aux petits zooms est calculée sur les seules couches `aac` et `sage`, et non sur l'ensemble des couches comme lors de la génération d'origine.
