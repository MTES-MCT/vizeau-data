# aac/zonage

Génère le PMTiles de zonage de protection de l'eau (`water_protection` : couches `ppr`, `ppe`, `aac`, `sage`) à partir de ses quatre fichiers sources. Le fichier est recréé de zéro à chaque exécution : aucune donnée n'est reprise d'un PMTiles existant.

## Sources

| Couche | Fichier (dans `data/`) | Couche du fichier | Origine |
|---|---|---|---|
| `ppr` | `captages/ppr_hilbert.parquet` | `ppr_hilbert` | Périmètres de protection rapprochée des captages (voir ci-dessous) |
| `ppe` | `captages/ppe_hilbert.parquet` | `ppe_hilbert` | Périmètres de protection éloignée des captages (voir ci-dessous) |
| `aac` | `aac/AAC.gpkg` | `AAC_FRA` | Aires d'Alimentation de Captage du [SANDRE](https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/f6a60c29-77dc-4bc1-a8d2-bf0572bf58ab) (voir [`../README.md`](../README.md#sources)) |
| `sage` | `aac/sage_shape.zip` (shapefile zippé) | `sage_shape` | Périmètres des SAGE de [Gest'eau](https://www.gesteau.fr/telecharger/sage) (OIEau) |

Les fichiers de `data/` ne sont pas versionnés (voir [`data-dir.mjs`](../../data-dir.mjs)).

### Périmètres de protection (`ppr_hilbert.parquet`, `ppe_hilbert.parquet`)

⚠️ Ces fichiers proviennent de **sources institutionnelles sensibles** : les périmètres de protection des captages d'eau potable ne sont pas diffusés en open data (risque de malveillance sur l'alimentation en eau). Ils ont été **modifiés par l'équipe Viz'eau pour masquer les PPI** (périmètres de protection immédiate).

Ils ne peuvent pas être téléchargés depuis une source publique. Ils servent aussi d'entrées à [`captages_parquet_generator`](../../captages_parquet_generator/README.md), d'où leur emplacement dans `data/captages/`.

Contenu : une entité par couple (périmètre, captage rattaché), identifiée par `code_pp` (`001_R_0012`, `001_E_0001`…). Un même périmètre apparaît donc plusieurs fois, une fois par captage (14 049 PPE pour 9 490 codes, 30 273 PPR pour 19 943 codes). Ces doublons sont conservés tels quels. Les fichiers portent aussi les attributs d'origine des couches Cart'eaux (`psv_code`, `ins_cap_ref`…, détail dans [`captages_parquet_generator`](../../captages_parquet_generator/README.md#attributs-dorigine-des-ppr-et-ppe)). Le PMTiles n'en reprend aucun : seul `code_pp` est exporté.

### Télécharger `sage_shape.zip`

La couche `sage_shape` est servie par le WFS de l'OIEau qui alimente Gest'eau, `https://maps.oieau.fr/ows/OIEau/gesteau`. Elle correspond à l'export shapefile proposé sur [gesteau.fr/telecharger/sage](https://www.gesteau.fr/telecharger/sage), avec les mêmes champs. Le WFS reste accessible quand gesteau.fr ne l'est pas.

Le serveur renvoie un zip (`sage_shape.shp`, `.shx`, `.dbf`, `.prj`), lu tel quel par le script via `/vsizip/` :

```bash
# depuis la racine du dépôt
curl -o data/aac/sage_shape.zip "https://maps.oieau.fr/ows/OIEau/gesteau?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=sa:sage_shape&OUTPUTFORMAT=application/shapefile&SRSNAME=EPSG:4326"
ogrinfo -so /vsizip/data/aac/sage_shape.zip/sage_shape.shp sage_shape   # vérification : ~200 entités, champs nid, code, nom, cd_etat…
```

**Ne pas utiliser l'export GeoPackage (`OUTPUTFORMAT=GPKG`) ni GeoJSON du même WFS** : le serveur y assemble mal les multipolygones. Toutes les parties d'un SAGE sont rangées dans un seul polygone, dont le contour extérieur est un petit îlot et le vrai contour un « trou » : géométries invalides, que tippecanoe fait disparaître (6 SAGE concernés, dont Authie, Serre et Gapeau). Le shapefile, dont les anneaux sont classés par orientation, n'a pas ce défaut.

Seul inconvénient du shapefile : le DBF est encodé en Latin-1, où « œ » devient « ? ». Le script rétablit « œuvre » dans `lb_etat` et `lb_ss_etat`, les seuls champs concernés.

Le WFS propose d'autres couches SAGE (`sa:sage`, `sa:sage_type_perimetre_etat`…) avec des champs plus récents (`necessaire_sdage_2015/2021/2022` au lieu de `necess2010/2016`). Le script attend les champs de `sage_shape`.

## Prérequis

- Node.js ≥ 22 (aucune dépendance npm)
- Dans le `PATH` :
  - `ogr2ogr` (GDAL, avec le pilote Parquet)
  - `tippecanoe` (testé avec v2.79.0)

```bash
brew install gdal tippecanoe
```

## Usage

1. Vérifier que les quatre sources sont présentes et à jour dans `data/` (à la racine du dépôt)
2. Lancer la génération :

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
  --sage       /chemin/vers/sage_shape.zip \
  --sage-layer sage_shape \
  --ppr        /chemin/vers/ppr_hilbert.parquet \
  --ppe        /chemin/vers/ppe_hilbert.parquet \
  --output     /chemin/vers/zonage.pmtiles
```

| Option | Défaut | Description |
|---|---|---|
| `--aac` | `data/aac/AAC.gpkg` | GeoPackage des AAC |
| `--layer` | `AAC_FRA` | Couche du GeoPackage des AAC |
| `--sage` | `data/aac/sage_shape.zip` | Shapefile des périmètres des SAGE, zippé (lu via `/vsizip/`) ou non |
| `--sage-layer` | `sage_shape` | Couche du shapefile des SAGE |
| `--ppr` | `data/captages/ppr_hilbert.parquet` | Périmètres de protection rapprochée |
| `--ppe` | `data/captages/ppe_hilbert.parquet` | Périmètres de protection éloignée |
| `--output` | `output/zonage.pmtiles` | Fichier produit |

Les chemins `data/` sont relatifs à la racine du dépôt ; les chemins passés en option sont résolus depuis ce dossier.

## Fonctionnement

```
ppr_hilbert.parquet   ppe_hilbert.parquet   AAC.gpkg (AAC_FRA)   sage_shape.zip (sage_shape)
       │                     │                     │                     │
       │ [1] ogr2ogr ── sélection et typage des champs                   │
       ▼                     ▼                     ▼                     ▼
  ppr.geojsonl          ppe.geojsonl          aac.geojsonl          sage.geojsonl
       │                     │                     │                     │
       └─────────────────────┴──────────┬──────────┴─────────────────────┘
                                        │
                                        │ [2] tippecanoe -z14 -Z0 --drop-densest-as-needed
                                        ▼
                              output/zonage.pmtiles ──(copie)──► data/s3/zonage.pmtiles
```

1. **Export GeoJSON** — chaque source est exportée en GeoJSON (une entité par ligne) par une requête SQLite qui fixe les champs et leurs types :
   - `ppr`, `ppe` : `code_pp` seul, les autres attributs des parquets sont écartés (`psv_code` ne doit pas être diffusé).
   - `aac` : `CdAAC` et dates en texte, `ArreteDelimitationAAC` en entier, `NivQualite` en nombre. Les champs JSON (`AdminAAC`, `CommandAAC`, `PTP`, `CodesAlternatifs`, `DepArreteDelim`) sont sérialisés en chaîne par tippecanoe. `NomDeAACAdministratif` est ensuite nettoyé comme dans [`aac/geometries`](../geometries/README.md), pour que la carte et les fiches affichent le même libellé : apostrophes typographiques (`’`) et échappées (`''`, `''''`) ramenées à `'`, tirets et parenthèses mal espacés corrigés, espaces multiples réduits, espaces de début et de fin supprimés.
   - `sage` : champs repris tels quels du shapefile (dont `cd_type_pe` et `lb_type_pe`, tronqués à 10 caractères), « ?uvre » remplacé par « œuvre » dans `lb_etat` et `lb_ss_etat`.
2. **Tuilage** — tippecanoe génère les quatre couches ensemble, avec les options de la génération d'origine (zooms 0 à 14, `--drop-densest-as-needed` calculé sur l'ensemble des couches). Il est lancé depuis le dossier temporaire avec des chemins relatifs : la commande enregistrée dans les métadonnées (`generator_options`) ne contient aucun chemin local.

Les fichiers intermédiaires sont écrits dans un dossier temporaire supprimé en fin d'exécution. Le script vérifie que chaque couche contient autant d'entités que sa source.

La génération est déterministe : à sources identiques, le fichier produit est identique octet pour octet.

## Fichier produit

| Couche | Entités | Contenu |
|---|---|---|
| `ppr` | 30 273 | Périmètres de protection rapprochée (une entité par captage rattaché) |
| `ppe` | 14 049 | Périmètres de protection éloignée (une entité par captage rattaché) |
| `aac` | 1 681 | Aires d'Alimentation de Captage, tous statuts (`Validé`, `Gelé`) |
| `sage` | 198 | Schémas d'aménagement et de gestion des eaux, outre-mer compris |

Nombres d'entités à la date de rédaction (octobre 2026).

### Attributs

- `ppr`, `ppe` : `code_pp`.
- `aac` : `CdAAC`, `NomDeAACAdministratif` (nettoyé), `NomDeAACUsage`, `NomDeAACAutre`, `DateCreationAAC`, `DateMajAAC`, `StAAC`, `ComAAC`, `NumCircAdminBassin`, `NomCircAdminBassin`, `NivQualite`, `ArreteDelimitationAAC`, `DateArreteDelim`, `DepArreteDelim`, `AdminAAC`, `CommandAAC`, `CodesAlternatifs`, `PTP`. L'identifiant est `CdAAC`.
- `sage` : `nid`, `code`, `nom`, `type`, `cd_etat`, `lb_etat`, `cd_ss_etat`, `lb_ss_etat`, `cd_comite`, `lb_comite`, `necess2010`, `necess2016`, `cd_type_pe`, `lb_type_pe`. L'identifiant est `code` (`SAGE03022`…) : `nid` est un identifiant interne de Gest'eau, qui peut changer.

### Différences avec le PMTiles d'origine (généré fin 2025)

- `ppr`, `ppe` : mêmes entités et mêmes géométries, mais seul `code_pp` est conservé. Les autres attributs d'origine (`psv_code`, `ins_cap_ref`, `nb_ppi_associes`, `code_ins`, `ins_pro_etat`, `siren_ars`…) sont dans les parquets sources (voir [`captages_parquet_generator`](../../captages_parquet_generator/README.md#attributs-dorigine-des-ppr-et-ppe)), et l'application Viz'eau n'en lit aucun. Ils **ne doivent pas revenir dans le PMTiles** : le lien entre un périmètre et son point de surveillance (`psv_code`) ne doit pas être diffusé (question 12 de [`plan-captages.md`](../../plan-captages.md)).
- `aac` : `CommandAAC` ajouté ; `ProducAAC`, `gid` et `id`, absents du GeoPackage, ont disparu.
- `sage` : `cd_type_pe`/`lb_type_pe` et les autres champs inchangés ; « Mis en œuvre » au lieu de « Mis en ?uvre ».
