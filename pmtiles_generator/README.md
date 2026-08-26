# RPG → PMTiles

Générateur multi-sources de pipelines [Tylt](https://github.com/tylt-org/tylt) pour produire un
fichier **PMTiles** multi-couches à partir du **Registre Parcellaire Graphique (RPG)**. Chaque
source de données a son propre pipeline dans `pipelines/<source>.yaml`, mais toutes partagent la
même fin (build PMTiles + upload S3) et un point d'entrée unique, `./run.sh <source> <MILLESIME>`.

Sources disponibles :

- `rpg1` — archives GeoPackage IGN/Géoportail, HTTP public (voir [Pipeline rpg1](#pipeline-rpg1))
- `rpg2` — shapefiles départementaux depuis S3 privé (voir [Pipeline rpg2](#pipeline-rpg2-s3))

## Prérequis

- [Tylt](https://github.com/tylt-org/tylt) installé et accessible dans le PATH (ou `npx @tylt/cli`)
- Docker (utilisé par Tylt pour les étapes conteneurisées)
- Accès S3 compatible (Scaleway, AWS…) pour l'upload _(optionnel)_

## Configuration

Copier `.env.example` en `.env` et renseigner les credentials S3 :

```bash
cp .env.example .env
```

| Variable               | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `S3_ENDPOINT`          | URL du endpoint S3 (ex. `https://s3.fr-par.scw.cloud`)               |
| `S3_REGION`            | Région S3 (ex. `fr-par`)                                             |
| `S3_BUCKET`            | Nom du bucket S3 (destination)                                       |
| `S3_ACCESS_KEY_ID`     | Clé d'accès S3                                                       |
| `S3_SECRET_ACCESS_KEY` | Secret S3                                                            |
| `S3_SOURCE_BUCKET`     | Bucket source des shapefiles (source `rpg2` uniquement, même compte) |

Les millésimes disponibles et leurs URLs sources sont définis dans `config.yaml`, sous
`sources.open_data.millesimes`.

## Utilisation

```bash
./run.sh <source> <MILLESIME>
```

### Pipeline complet (téléchargement + conversion + upload S3 + nettoyage)

```bash
./run.sh rpg1 2024
./run.sh rpg2 2024
```

Le workspace (`rpg-<source>-<MILLESIME>`) est automatiquement supprimé après un upload réussi.
En cas d'échec, il est conservé pour permettre le debug (`tylt show rpg-rpg1-2024`,
`tylt logs rpg-rpg1-2024 <étape>`).

### Sans upload S3 (pipeline complète, upload sauté)

```bash
./run.sh rpg1 2024 --no-upload
```

Fonctionne quelle que soit la pipeline (contrairement à `--target build-pmtiles`,
qui dépend du nom de l'étape de build). Le workspace Tylt étant vidé en fin de
pipeline, le PMTiles produit est automatiquement copié dans
`pmtiles_generator/output/<MILLESIME>/parcelles_france.pmtiles` avant nettoyage.

### Forcer le re-téléchargement

```bash
./run.sh rpg1 2024 --force download
```

## Couches PMTiles produites

| Source-layer   | Contenu                 |
| -------------- | ----------------------- |
| `parcelles`    | Parcelles agricoles PAC |
| `parcellesbio` | Parcelles bio (RPG BIO) |

Zoom min/max configurables dans `config.yaml` (`tippecanoe`, partagé par toutes les sources,
défaut : zoom 5–14).

## Structure du projet

```
.
├── run.sh                  # Point d'entrée unique : ./run.sh <source> <MILLESIME> [args tylt]
├── config.yaml              # tippecanoe (partagé) + sources.<source>.* (config par source)
├── .env.example              # Variables d'environnement (modèle)
├── kits/
│   ├── build-pmtiles.js       # Kit partagé : install tippecanoe + scripts/common/build.sh
│   └── upload.js                # Kit partagé : install awscli + scripts/common/upload.sh
├── pipelines/
│   ├── rpg1.yaml                 # Pipeline Tylt — GeoPackage/IGN, HTTP public
│   └── rpg2.yaml                  # Pipeline Tylt — shapefiles, S3 privé
└── scripts/
    ├── common/
    │   ├── build.sh                 # Assemblage PMTiles (tippecanoe)
    │   └── upload.sh                 # Upload S3
    ├── sources/                       # Scripts liés à la SOURCE (accès réseau)
    │   ├── open-data/
    │   │   ├── discover.sh               # Détection des parties d'archive (HTTP)
    │   │   ├── download.sh                # Téléchargement parallèle (curl)
    │   │   └── fetch-bio.sh                # Récupération RPG BIO (IGN ou data.gouv.fr)
    │   └── private-s3/
    │       ├── discover.sh               # Recherche du dossier daté sur S3
    │       └── download.sh                # aws s3 sync
    ├── formats/                       # Scripts liés au FORMAT (conversion géospatiale)
    │   ├── gpkg/
    │   │   └── convert.sh                # Conversion GeoPackage → FlatGeobuf
    │   └── shapefile/
    │       └── convert.sh                # Fusion + dérivation code_group + export fgb
    ├── rpg1/
    │   └── setup.sh                    # Résolution de la config millésime (via yq)
    └── rpg2/
        └── setup.sh                    # Validation MILLESIME/S3_SOURCE_BUCKET
```

## Pipeline `rpg1`

Télécharge une archive GeoPackage IGN/Géoportail (7z) depuis une URL publique, l'extrait, la
convertit en FlatGeobuf.

| #   | ID              | Description                                                          |
| --- | --------------- | -------------------------------------------------------------------- |
| 1   | `setup`         | Lit `config.yaml`, résout l'URL source pour le millésime demandé     |
| 2   | `discover`      | Sonde les URLs pour détecter archive unique (`.7z`) ou multi-parties |
| 3   | `download`      | Télécharge toutes les parties en parallèle                           |
| 4   | `extract`       | Extrait l'archive 7z (`.7z` ou `.7z.001`)                            |
| 5   | `fetch-bio`     | Récupère la couche RPG BIO (IGN ou fallback data.gouv.fr)            |
| 6   | `convert`       | Convertit chaque couche GeoPackage LAMB93 → FlatGeobuf WGS84         |
| 7   | `build-pmtiles` | Assemble les FlatGeobuf en un PMTiles multi-couches via tippecanoe   |
| 8   | `upload`        | Envoie le PMTiles vers le bucket S3                                  |

## Pipeline `rpg2` (S3)

Source alternative : shapefiles départementaux ("surfaces graphiques constatées"), lus depuis
un bucket S3 privé (`S3_SOURCE_BUCKET`, même compte que le bucket de destination) au lieu des
archives GeoPackage IGN. Les étapes `build-pmtiles` et `upload` sont les mêmes kits partagés que
le pipeline `rpg1`.

| #   | ID              | Description                                                                    |
| --- | --------------- | ------------------------------------------------------------------------------ |
| 1   | `setup`         | Valide `MILLESIME`/`S3_SOURCE_BUCKET`, lit les zooms tippecanoe                |
| 2   | `discover`      | Trouve le dossier daté du millésime sur S3                                     |
| 3   | `download`      | Synchronise les shapefiles départementaux depuis S3                            |
| 4   | `convert`       | Fusionne les départements, dérive `code_group`, exporte parcelles/parcellesbio |
| 5   | `build-pmtiles` | Assemble les FlatGeobuf en un PMTiles multi-couches via tippecanoe (partagé)   |
| 6   | `upload`        | Envoie le PMTiles vers le bucket S3 (partagé)                                  |

Détails et conventions : voir `AGENTS.md`.

## Ajouter une nouvelle source

Voir `AGENTS.md`, section "Adding a New Source" : créer `pipelines/<source>.yaml`, en composant
des scripts de `scripts/sources/<source>/*.sh` (accès réseau) et `scripts/formats/<format>/*.sh`
(conversion) — réutiliser des scripts existants si la source ou le format existe déjà, sinon en
ajouter de nouveaux. Réutiliser les kits `build-pmtiles`/`upload`. Aucune modification de
`run.sh` n'est nécessaire — il route automatiquement vers `pipelines/<source>.yaml`.
