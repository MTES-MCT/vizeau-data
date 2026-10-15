# Génération des fiches AAC

Pipeline Node.js qui génère des fiches descriptives pour chaque **Aire d'Alimentation de Captage (AAC)** à partir de données géospatiales stockées sur S3, et publie le résultat en Parquet sur S3.

## Fonctionnement

Le pipeline s'exécute en 3 étapes :

1. **Téléchargement** — récupère depuis S3 vers `aac/data/` les fichiers source absents (`aac_hilbert.parquet` y est déjà si `../geometries` a été lancé)
2. **Génération des fiches** — 5 phases de traitement via DuckDB :
   - Phase 1 : données légères (AAC, zones PP, communes, captages)
   - Phase 2 : parcelles bio RPG annuelles (scan spatial)
   - Phase 3 : parcelles RPG toutes cultures (scan spatial)
   - Phase 4 : évolution annuelle des cultures (`RPG_YYYY.parquet` depuis S3, mis en cache)
   - Phase 5 : assemblage des fiches JSON
3. **Écriture et push S3** — sérialise les fiches en Parquet dans `output/` (avec une copie dans `aac/data/`), puis pousse le fichier vers S3

Chaque fiche AAC contient : nom, code, surface, emprise (bbox), communes recouvertes, installations de captage, répartition des cultures (SAU globale, PPE, PPR), part de l'agriculture biologique et évolution annuelle des cultures.

## Prérequis

- Node.js ≥ 22
- Accès S3 (Scaleway par défaut, configurable)

## Installation

```bash
# depuis aac/
npm install
```

## Configuration

Créer un fichier `.env` dans `aac/` (voir `aac/.env.sample`) :

```env
S3_BUCKET=mon-bucket          # Bucket source (requis)
S3_ACCESS_KEY=AKIAXXXXXXXX    # Clé d'accès S3 (requis)
S3_SECRET_KEY=xxxxxxxx        # Clé secrète S3 (requis)
S3_REGION=fr-par              # Région (défaut : fr-par)
S3_ENDPOINT=s3.fr-par.scw.cloud  # Endpoint (défaut : s3.fr-par.scw.cloud)
S3_PREFIX=                    # Préfixe des fichiers source (optionnel)
S3_BIO_DIR=bio                # Répertoire S3 des fichiers rpg_bio_YYYY.parquet
S3_RPG_DIR=RPG                # Répertoire S3 des RPG annuels RPG_YYYY.parquet
S3_OUTPUT_BUCKET=             # Bucket de destination (défaut : S3_BUCKET)
S3_OUTPUT_KEY=aac.parquet     # Clé du fichier de sortie (défaut : aac.parquet)
DUCKDB_THREADS=               # Threads DuckDB (défaut : nb de cœurs - 1)
RPG_CONCURRENCY=3             # Années RPG téléchargées en parallèle (phase 4)
RPG_REFRESH=                  # À 1, recalcule les agrégats RPG annuels en cache
S3_OVERWRITE=                 # À 1, écrase la destination sans confirmation
```

## Utilisation

```bash
# depuis aac/
npm run fiches
# ou directement :
node --env-file=.env fiches/generate_aac_fiches_parquet.js
```

Si le fichier de destination existe déjà sur S3, le script demande confirmation avant de lancer le traitement (réponse `o` pour écraser). En cas de refus, ou hors terminal interactif (CI, cron…) sans `S3_OVERWRITE=1`, le traitement est mené jusqu'au bout mais le fichier n'est écrit qu'en local.

Dans tous les cas, le fichier final est écrit dans `output/` avant l'upload : il reste disponible même si l'upload est ignoré ou échoue.

## Fichiers source attendus sur S3

| Fichier                          | Description                                                      |
| -------------------------------- | ---------------------------------------------------------------- |
| `aac_hilbert.parquet`            | Géométries des AAC (WGS84)                                       |
| `aac_pp_zones.parquet`           | Zones de protection (PPE, PPR, PPI)                              |
| `communes_hilbert.parquet`       | Géométries des communes                                          |
| `captages.parquet`               | Installations de captage                                         |
| `captages_prioritaires_2026.csv` | Référentiel des captages prioritaires (BSS)                      |
| `rpg_bio_YYYY.parquet`           | Parcelles RPG bio annuelles (dans `S3_BIO_DIR`)                  |
| `rpg_parcelles.parquet`          | Parcelles RPG toutes cultures                                    |
| `RPG_YYYY.parquet`               | RPG annuel utilisé pour `cultures_evolution` (dans `S3_RPG_DIR`) |

Ces fichiers ne sont pas publiés tels quels par l'administration : ils sont produits à partir des sources ouvertes ci-dessous (téléchargement, conversion en Parquet, réindexation Hilbert le cas échéant) avant d'être déposés sur le bucket S3.

### Sources ouvertes

| Fichier                          | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aac_hilbert.parquet`            | [Aires d'Alimentation de Captages – France entière](https://www.sandre.eaufrance.fr/atlas/srv/fre/catalog.search#/metadata/f6a60c29-77dc-4bc1-a8d2-bf0572bf58ab) (SANDRE, couche WFS `sa:AAC_FRA`). Télécharger "AAC.gpkg" (service WFS `https://sandre.eaufrance.fr/aac/mapserver/aac`, `OUTPUTFORMAT=GPKG`), puis convertir en parquet via `../geometries` (tri Hilbert inclus).                                                                                                                                 |
| `communes_hilbert.parquet`       | Contours communaux [IGN ADMIN EXPRESS COG (simplifié)](https://www.data.gouv.fr/datasets/admin-express-cog-simplifiee-metropole-drom-saint-martin-saint-barthelemy) (data.gouv.fr), champs `code`/`nom`/`geom`, convertis en Parquet et réindexés en Hilbert.                                                                                                                                                                                                                                                                            |
| `captages_prioritaires_2026.csv` | Export du référentiel national des captages prioritaires ("Grenelle") du portail [aires-captages.fr](https://aires-captages.fr) (OFB/Ministère), qui agrège les listes par agence de l'eau (ex. AEAG pour Adour-Garonne, cf. [SDAGE 2022-2027 — Captages prioritaires](https://www.data.gouv.fr/datasets/aeag-sdage-2022-2027-captages-prioritaires) sur data.gouv.fr pour l'équivalent en accès ouvert bassin par bassin). L'export national complet passe généralement par une demande d'accès au portail plutôt que par data.gouv.fr. |

> ⚠️ Les captages et leurs périmètres de protection sont considérés comme des données sensibles en France (risque de malveillance sur l'AEP) : l'accès national homogène n'est pas toujours en open data direct et passe parfois par des portails régionaux (DREAL/ARS/bassins) ou des conventions avec le BRGM/l'OFB. Le RPG est en open data complet mais distribué par année et par région/département sous forme de shapefiles zippés, à pré-traiter pour obtenir le format Parquet attendu ici.

### Sources privées

| Fichier                                     | Source                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `captages.parquet` / `aac_pp_zones.parquet` | Les données liées aux captages et aux périmètres de protection sont privées pour des raisons de sécurité. |

## Notes de performance

Les phases 2, 3 et 4 sont des jointures spatiales entre ~1600 AAC et des millions de parcelles RPG. Trois principes y sont appliqués :

- les géométries AAC sont projetées en Lambert 93 et validées **une seule fois** dans la table `aac_l93`, au lieu d'un `ST_Transform`/`ST_MakeValid` réévalué à chaque ligne appariée ;
- les périmètres de protection sont désérialisés une seule fois dans `aac_pp_l93` : le GeoJSON était auparavant reparsé pour chacun des ~1,3 million de couples (parcelle, AAC) de la phase 3 ;
- `ST_MakeValid` sur les parcelles est appliqué après la jointure spatiale, et une seule fois pour les trois intersections (AAC, PPE, PPR).

## Cache local

`aac/data/` conserve les fichiers source : seuls les fichiers absents sont téléchargés depuis S3. `aac_hilbert.parquet` y est déposé par `../geometries`, qui l'écrase à chaque exécution.

La phase 4 dispose d'un cache dédié. Les `RPG_YYYY.parquet` pèsent 2 à 4 Go chacun et la colonne géométrique représente ~98 % des octets, sans statistique spatiale permettant d'élaguer des row groups : la phase est bornée par le débit S3 (~50 Mo/s en agrégé), pas par le CPU. Le script écrit donc l'agrégat de chaque année (≈ 18 000 lignes) dans `aac/data/cache/rpg_evolution_YYYY.parquet` et télécharge les années manquantes en parallèle (`RPG_CONCURRENCY`). Un millésime publié n'évoluant plus, une réexécution ne retélécharge que les nouvelles années — poser `RPG_REFRESH=1` force le recalcul de toutes.

Pour repartir de zéro : supprimer les sources de `aac/data/` et/ou `aac/data/cache/` (agrégats RPG annuels).

## Sortie

Fichier `aac.parquet` (configurable via `S3_OUTPUT_KEY`) écrit dans `output/` et poussé sur S3 (ZSTD), contenant une ligne par AAC, triée par `code` (ordre numérique, codes non numériques en fin), avec les champs suivants :

- `nom`, `code`, `prioritaire`, `date_creation`, `date_maj`, `bbox`, `surface`
- `nb_captages_actifs`, `nb_installations`
- `surface_agricole`, `nb_parcelles`
- `communes` — liste des communes avec surface et répartition
- `surface_agricole_utile` — SAU par groupe de culture (nb parcelles, surface, % SAU)
- `surface_agricole_ppe` / `surface_agricole_ppr` — idem dans les zones de protection
- `surface_agricole_bio` — nb parcelles, surface et part bio
- `installations` — captage de référence (dont le code PPE de sa zone de protection), captages rattachés, statut prioritaire. Les codes PPR et PPI servent à rattacher les captages aux AAC mais ne sont pas écrits dans la sortie
- `cultures_evolution` — objet `{ repartition }`, où `repartition` contient les années `2020..2024` et, pour chaque groupe, `{ surface_ha, nb_parcelles }`
