# aac

Outils de génération des données liées aux **Aires d'Alimentation de Captage (AAC)**. Les trois scripts partagent la même source, `data/AAC.gpkg`, et doivent être relancés ensemble quand elle change, pour que les géométries, les fiches et les tuiles restent alignées.

| Dossier | Produit | Description |
|---|---|---|
| [`geometries`](geometries/README.md) | `geometries/output/aac_hilbert.parquet` | GeoParquet des AAC (WGS84, ZSTD) trié par courbe de Hilbert |
| [`zonage`](zonage/README.md) | `zonage/output/zonage.pmtiles` | PMTiles de zonage (`ppr`, `ppe`, `aac`, `sage`) dont la couche `aac` est régénérée |
| [`fiches`](fiches/README.md) | `fiches/output/aac.parquet` | Une fiche descriptive par AAC (surface, communes, captages, cultures, bio…) |

## Source

`data/AAC.gpkg` — couche `AAC_FRA` du [SANDRE](https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/f6a60c29-77dc-4bc1-a8d2-bf0572bf58ab) (service WFS `https://sandre.eaufrance.fr/aac/mapserver/aac`, `OUTPUTFORMAT=GPKG`). Non versionné.

`data/` regroupe toutes les sources : `AAC.gpkg`, les fichiers téléchargés depuis S3 par `fiches` et son cache (`data/cache/`). Chaque script écrit ses fichiers produits dans son propre sous-dossier `output/` et en dépose une copie dans `data/`, où les autres scripts les lisent. Le S3 ne sert qu'au partage dans l'équipe : `fiches` n'y télécharge que les fichiers absents de `data/`.

## Enchaînement

```
data/AAC.gpkg
   │
   ├──► geometries ──► output/aac_hilbert.parquet ──(copie)──► data/aac_hilbert.parquet
   │                                                                  │
   │        data/captages.parquet, aac_pp_zones.parquet,              │
   │        communes, RPG (S3 si absents de data/) ───────────────────┤
   │                                                                  ▼
   │                                       fiches ──► output/aac.parquet ──(copie)──► data/aac.parquet
   │
   └──► zonage ◄── zonage/zonage.pmtiles (ppr, ppe, sage repris)
          │
          ▼
       output/zonage.pmtiles ──(copie)──► data/zonage.pmtiles

geometries/output/, zonage/output/, fiches/output/
   │
   └──► upload (à la demande) ──► s3://<S3_BUCKET>/<S3_PREFIX>/
```

`fiches` lit `data/aac_hilbert.parquet` déposé par `geometries`, sans passer par S3. Aucun script de génération n'écrit sur S3 : l'envoi se fait à part avec `npm run upload`, pour partager les fichiers avec l'équipe.

## Usage

```bash
cd aac
npm install
npm run all
```

`npm run all` lance `geometries`, `zonage` puis `fiches`.

Chaque étape peut aussi être lancée seule :

```bash
npm run geometries
npm run zonage
npm run fiches
```

Prérequis propres à chaque étape :

- `zonage` : `ogr2ogr`, `tippecanoe` et `tile-join` dans le `PATH`, et le PMTiles de zonage existant dans `zonage/zonage.pmtiles`
- `fiches` : fichier `aac/.env` avec les accès S3 (voir `aac/.env.sample`)

## Upload sur S3

```bash
npm run upload                       # tous les dossiers output/
npm run upload -- geometries fiches  # seulement ces dossiers
```

Pousse les fichiers des sous-dossiers `output/` vers `s3://<S3_BUCKET>/<S3_PREFIX>/<nom du fichier>`, là où `fiches` va chercher les sources absentes de `data/`. Utilise les accès S3 de `aac/.env`.

Si un fichier existe déjà sur S3, le script demande confirmation avant de l'écraser. Hors terminal interactif, les fichiers déjà présents sont ignorés, sauf avec `S3_OVERWRITE=1` qui écrase sans confirmation.
