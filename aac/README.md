# aac

Outils de génération des données liées aux **Aires d'Alimentation de Captage (AAC)**. Les trois scripts partagent la même source, `data/aac/AAC.gpkg`, et doivent être relancés ensemble quand elle change, pour que les géométries, les fiches et les tuiles restent alignées. `zonage` lit en plus `data/aac/sage_shape.zip` (couche `sage`) et `data/captages/ppr_hilbert.parquet`, `ppe_hilbert.parquet` (couches `ppr`, `ppe`).

| Dossier | Produit | Description |
|---|---|---|
| [`geometries`](geometries/README.md) | `geometries/output/aac_hilbert.parquet` | GeoParquet des AAC (WGS84, ZSTD) trié par courbe de Hilbert |
| [`zonage`](zonage/README.md) | `zonage/output/zonage.pmtiles` | PMTiles de zonage (`ppr`, `ppe`, `aac`, `sage`), généré de zéro à partir des sources |
| [`fiches`](fiches/README.md) | `fiches/output/aac.parquet` | Une fiche descriptive par AAC (surface, communes, captages, cultures, bio…) |

## Sources

`data/aac/AAC.gpkg` — couche `AAC_FRA` du [SANDRE](https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/f6a60c29-77dc-4bc1-a8d2-bf0572bf58ab) (service WFS `https://sandre.eaufrance.fr/aac/mapserver/aac`, `OUTPUTFORMAT=GPKG`). Non versionné.

`data/aac/sage_shape.zip` — shapefile zippé (couche `sage_shape`) des périmètres des SAGE de [Gest'eau](https://www.gesteau.fr/telecharger/sage) (OIEau), utilisé seulement par `zonage`. Téléchargé depuis le WFS `https://maps.oieau.fr/ows/OIEau/gesteau` (`OUTPUTFORMAT=application/shapefile` ; l'export GPKG a des géométries invalides) : voir [`zonage/README.md`](zonage/README.md#télécharger-sage_shapezip). Non versionné.

`data/captages/ppr_hilbert.parquet`, `data/captages/ppe_hilbert.parquet` — périmètres de protection rapprochée et éloignée des captages (`code_pp` et géométrie), utilisés par `zonage` (et par `captages_parquet_generator`). ⚠️ Issus de **sources institutionnelles sensibles**, et **modifiés par l'équipe Viz'eau pour masquer les PPI** ; non téléchargeables depuis une source publique : voir [`zonage/README.md`](zonage/README.md#périmètres-de-protection-ppr_hilbertparquet-ppe_hilbertparquet). Non versionnés.

Les données locales sont rangées dans le dossier `data/` à la racine du dépôt (voir [`data-dir.mjs`](../data-dir.mjs)) :

- `data/aac/` : `AAC.gpkg`, `sage_shape.zip`, le cache de `fiches` (`data/aac/cache/`) et ses fichiers temporaires ;
- `data/s3/` : copie locale du bucket S3, avec les fichiers téléchargés par `fiches` et les copies des fichiers produits.

Chaque script écrit ses fichiers produits dans son propre sous-dossier `output/` et en dépose une copie dans `data/s3/`, où les autres scripts les lisent. Le S3 ne sert qu'au partage dans l'équipe : `fiches` n'y télécharge que les fichiers absents de `data/s3/`.

## Enchaînement

```
data/aac/AAC.gpkg
   │
   ├──► geometries ──► output/aac_hilbert.parquet ──(copie)──► data/s3/aac_hilbert.parquet
   │                                                                  │
   │        data/s3/captages.parquet, aac_pp_zones.parquet,           │
   │        communes, RPG (S3 si absents de data/s3/) ────────────────┤
   │        data/captages/captages_prioritaires.parquet,              │
   │        captages_new.parquet (captages_parquet_generator) ────────┤
   │                                                                  ▼
   │                                       fiches ──► output/aac.parquet ──(copie)──► data/s3/aac.parquet
   │
   └──► zonage ◄── data/aac/sage_shape.zip (couche sage)
          ▲
          └───── data/captages/ppr_hilbert.parquet, ppe_hilbert.parquet (couches ppr, ppe)
          │
          ▼
       output/zonage.pmtiles ──(copie)──► data/s3/zonage.pmtiles

geometries/output/, zonage/output/, fiches/output/
   │
   └──► upload (à la demande) ──► s3://<S3_BUCKET>/<S3_PREFIX>/
```

`fiches` lit `data/s3/aac_hilbert.parquet` déposé par `geometries`, sans passer par S3. Aucun script de génération n'écrit sur S3 : l'envoi se fait à part avec `npm run upload`, pour partager les fichiers avec l'équipe.

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

- `zonage` : `ogr2ogr` (avec le pilote Parquet) et `tippecanoe` dans le `PATH`, `data/aac/sage_shape.zip` et les périmètres `data/captages/ppr_hilbert.parquet`, `ppe_hilbert.parquet`
- `fiches` : fichier `aac/.env` avec les accès S3 (voir `aac/.env.sample`), et `data/captages/captages_prioritaires.parquet` (flag `prioritaire` des installations) et `captages_new.parquet` (codes BSS des installations) produits par [`captages_parquet_generator`](../captages_parquet_generator/README.md#captages_prioritairesparquet)

## Upload sur S3

```bash
npm run upload                       # tous les dossiers output/
npm run upload -- geometries fiches  # seulement ces dossiers
```

Pousse les fichiers des sous-dossiers `output/` vers `s3://<S3_BUCKET>/<S3_PREFIX>/<nom du fichier>`, là où `fiches` va chercher les sources absentes de `data/s3/`. Utilise les accès S3 de `aac/.env`.

Si un fichier existe déjà sur S3, le script demande confirmation avant de l'écraser. Hors terminal interactif, les fichiers déjà présents sont ignorés, sauf avec `S3_OVERWRITE=1` qui écrase sans confirmation.
