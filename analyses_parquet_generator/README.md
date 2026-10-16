# Génération de `analyses_robinet.parquet` et `analyses_robinet_par_date.parquet`

Script Node.js/DuckDB qui produit **une ligne par résultat d'analyse réalisée sur un captage**, à partir des fichiers _« Résultats du contrôle sanitaire de l'eau du robinet »_ publiés sur data.gouv.fr, enrichie avec les référentiels métier : libellé du paramètre, limite et référence de qualité (texte et seuils numériques), indicateurs de dépassement, captage prioritaire. Il produit aussi `analyses_robinet_par_date.parquet`, **une ligne par installation et par date de prélèvement**, qui dit si la date est en dépassement.

## Fonctionnement

```
S3 aac-workfiles/Fichiers_pour_analyses ──► référentiels absents téléchargés dans data/analyses/

sources/CAP_PLV_<période> ───────┐
  (prélèvements)                  ├─ jointure referenceprel ───┐
sources/CAP_RES_<période> ───────┘   (par période)             │
  (résultats)                                                  │
                                                               │
seuils_qualite_par_parametre.csv ──┐ (versionné)               │
parametres.json ───────────────────┤                           │
substances_par_fonction.csv ───────┼─► enrichissement par ─────┼──► analyses_robinet.parquet
limite_qualite.csv ────────────────┤   code_parametre (JS)     │      (via la table
reference_qualite.csv ─────────────┘   + seuils numériques     │       temporaire `analyses`,
                                                               │       avec dep_regl / dep_alerte)
captages_prioritaires.csv ──┬─► captage_prioritaire ───────────┤
ref_cap_25avril2025.xlsx ───┘   (installation → code BSS)      │
                                                               └──► analyses_robinet_par_date.parquet
                                                                      (1 ligne / installation × date,
                                                                       BOOL_OR des indicateurs)
```

1. **Téléchargement** : les référentiels absents du dossier de travail (`data/analyses/`) sont téléchargés depuis S3, à l'identique. Ceux déjà présents sont réutilisés ; il suffit de les supprimer pour forcer leur mise à jour.
2. **Chargement** : chaque fichier `CAP_PLV_*` / `CAP_RES_*` est lu par DuckDB (colonnes utiles uniquement, en texte). Les lignes mal formées sont ignorées et comptées dans un avertissement.
3. **Dédoublonnage** : les fichiers mensuels republient à l'identique des prélèvements déjà parus. Un prélèvement n'est donc gardé que dans sa période la plus récente.
4. **Enrichissement des paramètres** : libellé, limite et référence de qualité ne dépendent que du code paramètre. Ils sont calculés une fois par paramètre en JS (`referentiels.js`), avec les seuils numériques extraits de la limite et de la référence, puis joints aux analyses.
5. **Assemblage** : PLV et RES sont joints sur `referenceprel` au sein d'une même période, les indicateurs de dépassement sont calculés, et le résultat est matérialisé dans une table `analyses` de la base temporaire. Cette table est ensuite écrite en Parquet (ZSTD), trié par installation puis par date de prélèvement, en row groups d'un million de lignes. Ce tri permet aux lecteurs d'écarter, grâce aux min/max de chaque row group, les données des autres installations : une installation tient dans un ou deux row groups.
6. **Agrégats par date** : la même table `analyses` est regroupée par installation et date de prélèvement pour écrire `analyses_robinet_par_date.parquet`, à côté du fichier brut.
7. **Contrôles** : les valeurs présentes dans la source mais non convertibles (date, nombre) sont signalées avec des exemples, puis un résumé des taux de remplissage est affiché, ainsi que le découpage du fichier : nombre de row groups et nombre moyen de row groups couverts par une installation (proche de 1 si le tri est respecté). Enfin, les indicateurs de dépassement sont recalculés avec les expressions de Viz'eau (`SQL_DEP_REGL` / `SQL_DEP_ALERTE`) et comparés aux colonnes `dep_regl` / `dep_alerte` : un avertissement est affiché en cas d'écart. Les agrégats d'`analyses_robinet_par_date.parquet` sont de même comparés à la CTE `date_flags` de Viz'eau, recalculée sur le fichier brut.

DuckDB travaille dans une base temporaire sur disque et peut déborder sur disque : la taille des fichiers sources n'est pas limitée par la mémoire disponible.

## Prérequis

- Node.js ≥ 22.9
- Accès S3 (Scaleway par défaut), seulement si des référentiels sont absents de `data/analyses/`

## Installation

```bash
npm install
```

## Configuration

Copier `.env.sample` en `.env` dans ce dossier et renseigner les clés S3 :

```env
S3_BUCKET=aac-workfiles               # Bucket des référentiels (défaut : aac-workfiles)
S3_PREFIX=Fichiers_pour_analyses      # Préfixe des référentiels (défaut : Fichiers_pour_analyses)
S3_REGION=fr-par                      # Région (défaut : fr-par)
S3_ENDPOINT=s3.fr-par.scw.cloud       # Endpoint (défaut : s3.fr-par.scw.cloud)
S3_ACCESS_KEY=                        # Clé d'accès S3
S3_SECRET_KEY=                        # Clé secrète S3
```

Ce `.env` est propre à ce script. Il n'est pas versionné.

## Utilisation

Le script travaille dans le dossier `data/analyses/`, à la racine du dépôt (non versionné, voir `data-dir.mjs` ; la variable d'environnement `DATA_DIR` permet de déplacer le dossier `data/`) :

```
data/analyses/
├── sources/                            CAP_PLV_* / CAP_RES_*, à déposer (voir Sources)
├── parametres.json, *.csv, ...         référentiels, téléchargés depuis S3 s'ils manquent
├── analyses_robinet.parquet            fichier produit
└── analyses_robinet_par_date.parquet   agrégats par installation et par date
```

Une fois les fichiers `CAP_*` déposés dans `data/analyses/sources/`, il suffit de lancer :

```bash
npm start
```

Tous les fichiers `CAP_PLV_*` / `CAP_RES_*` de `data/analyses/sources/` sont traités, quelle que soit la période qu'ils couvrent.

Pour travailler sur un autre jeu de données (tests, par exemple), on peut passer un autre dossier de travail, organisé de la même façon (sources dans son sous-dossier `sources/`), et éventuellement un autre fichier de sortie :

```bash
node --env-file-if-exists=.env generate_analyses_parquet.js <dossier_travail> [sortie.parquet]
```

La sortie par défaut est `<dossier_travail>/analyses_robinet.parquet`. `analyses_robinet_par_date.parquet` est toujours écrit dans le même dossier que la sortie.

### Génération du fichier complet

Le fichier publié couvre tout l'historique : archives annuelles `eaurob-2017.zip` à `eaurob-2025.zip`, puis archives mensuelles de l'année en cours (`eaurob-202601.zip`…).

1. Télécharger les archives depuis data.gouv.fr (voir Sources) et en extraire uniquement les fichiers `CAP_*` dans `data/analyses/sources/` :
   ```bash
   unzip -o -j eaurob-2017.zip 'CAP_*' -d ../data/analyses/sources
   ```
2. Lancer `npm start`. Les référentiels absents de `data/analyses/` sont téléchargés depuis S3, ce qui demande le `.env`.

Ordre de grandeur (2017 à août 2026) : 9,4 Go de sources, 35 secondes, 50,2 millions de lignes, 27 728 installations, 51 row groups, 48 Mo. Un prélèvement republié dans une archive annuelle et dans une archive mensuelle n'est gardé qu'une fois (13 556 prélèvements dans ce cas).

```bash
npm test   # tests unitaires des règles d'enrichissement (referentiels.js)
```

## Fichiers d'entrée

| Fichier                             | Provenance | Rôle                                                                      |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `CAP_PLV_<période>.txt` (ou `.csv`) | à déposer  | Prélèvements sur captages : 1 ligne par prélèvement                       |
| `CAP_RES_<période>.txt` (ou `.csv`) | à déposer  | Résultats d'analyses : N lignes par prélèvement                           |
| `parametres.json`                   | S3         | `code_parametre` → `libelle`                                              |
| `substances_par_fonction.csv`       | S3         | Substance → fonction (`Fonction retenue`, `substance`), clé de repli des seuils |
| `limite_qualite.csv`                | S3         | Paramètre → limite de qualité (2ᵉ colonne, eau distribuée)                |
| `reference_qualite.csv`             | S3         | Paramètre → référence de qualité                                          |
| `captages_prioritaires.csv`         | S3         | Captages prioritaires (colonnes `CodeBss` et `INS`)                       |
| `ref_cap_25avril2025.xlsx`          | S3         | Référentiel des captages : `code_installation` → `bss_id_en_bss` (code BSS) |
| `seuils_qualite_par_parametre.csv`  | ce dépôt   | `code_parametre` → `limite_qualite`, `reference_qualite` (voir ci-dessous) |

Les fichiers `CAP_*` sont lus dans `data/analyses/sources/`, les référentiels dans `data/analyses/`. Chaque période de `CAP_PLV_*` doit avoir son `CAP_RES_*`, et inversement. Si un `.csv` et un `.txt` existent pour la même période, le `.csv` est utilisé.

### Sources

- **`CAP_PLV_*` / `CAP_RES_*`** : archives `eaurob-<AAAA>.zip` (annuelles) ou `eaurob-<AAAAMM>.zip` (mensuelles) du jeu [Résultats du contrôle sanitaire de l'eau du robinet](https://www.data.gouv.fr/datasets/resultats-du-controle-sanitaire-de-leau-du-robinet) (data.gouv.fr). Seuls les fichiers `CAP_*` (captages) sont utilisés, pas `UDI_*` ni `TTP_*`.
- **Référentiels** : bucket S3 `aac-workfiles`, préfixe `Fichiers_pour_analyses/`.
- **`seuils_qualite_par_parametre.csv`** : versionné à côté du script. Il a été extrait du fichier `analyses_robinet.parquet` de production (analyses 2017 à 2025, produit par l'ancienne chaîne de traitement), où chaque code paramètre a une seule limite et une seule référence de qualité, ou aucune : 1 445 codes, dont 807 avec une limite et 26 avec une référence. Trois codes absents de la prod y ont été ajoutés à la main, sur le modèle de paramètres comparables : `3319` (C10-C40 hydrocarbures, sans seuil), `8783` (métabolite de la pendiméthaline, `<=0,1 µg/L` comme les pesticides) et `9305` (Limnococcus, comptage de cyanobactéries, sans seuil). Une valeur vide signifie que le paramètre n'a pas ce seuil. La colonne `libelle_parametre` n'est là que pour la lecture.

## Fichiers produits

Les deux fichiers viennent de la même exécution et doivent être publiés ensemble. Viz'eau doit ensuite être redémarré : ses caches de métadonnées ne détectent pas le remplacement d'un fichier.

### `analyses_robinet.parquet`

Seules les colonnes lues par Viz'eau sont produites (voir `formats-parquet.md` à la racine du dépôt).

| Colonne               | Type    | Origine                                                                    |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| `code_insee`          | VARCHAR | PLV `inseecommune`                                                         |
| `nom_commune`         | VARCHAR | PLV `nomcommune`                                                           |
| `code_installation`   | VARCHAR | PLV `cdreseau` (code de l'installation de captage)                         |
| `nom_installation`    | VARCHAR | PLV `nomreseau`                                                            |
| `date_prelevement`    | DATE    | PLV `dateprel`                                                             |
| `heure_prelevement`   | VARCHAR | PLV `heureprel` (ex. `08h42`)                                              |
| `code_brgm`           | VARCHAR | PLV `codebrgm` (ancien code BSS)                                           |
| `code_parametre`      | DOUBLE  | RES `cdparametre`                                                          |
| `resultat`            | VARCHAR | RES `rqana` (résultat brut, ex. `<0,005`)                                  |
| `resultat_traduction` | DOUBLE  | RES `rsana` (valeur numérique)                                             |
| `code_unite`          | VARCHAR | RES `cdunitereferencesiseeaux`                                             |
| `libelle_parametre`   | VARCHAR | `parametres.json`                                                          |
| `limite_qualite`      | VARCHAR | `seuils_qualite_par_parametre.csv`, au format `<=0,1 µg/L`                 |
| `reference_qualite`   | VARCHAR | `seuils_qualite_par_parametre.csv`, au format `<=2 NFU` ou `>=6,5 et <=9 unité pH` |
| `captage_prioritaire` | BOOLEAN | Voir ci-dessous                                                            |
| `seuil_regl`          | DOUBLE  | `X` si `limite_qualite` vaut `<=X`, sinon `NULL`                           |
| `seuil_alerte_min`    | DOUBLE  | `X` si `reference_qualite` vaut `>=X et <=Y`, sinon `NULL`                 |
| `seuil_alerte_max`    | DOUBLE  | `X` si `reference_qualite` vaut `<=X`, `Y` si `>=X et <=Y`, sinon `NULL`   |
| `dep_regl`            | BOOLEAN | `resultat_traduction > seuil_regl`, `false` sans seuil ou sans valeur      |
| `dep_alerte`          | BOOLEAN | `resultat_traduction` hors de `[seuil_alerte_min, seuil_alerte_max]`, `false` sans seuil ou sans valeur |

Les textes sont débarrassés de leurs espaces de début et de fin, et une valeur vide devient `NULL`.

### `analyses_robinet_par_date.parquet`

Une ligne par installation et par date de prélèvement (une « analyse » au sens de Viz'eau), triée par `code_installation` puis `date_prelevement`. Les lignes sans installation ou sans date sont écartées (aucune dans l'historique actuel).

| Colonne             | Type    | Origine                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `code_installation` | VARCHAR | clé                                                                       |
| `date_prelevement`  | DATE    | clé                                                                       |
| `dep_regl`          | BOOLEAN | `BOOL_OR(dep_regl)` : au moins une mesure de la date en dépassement réglementaire |
| `dep_alerte`        | BOOLEAN | `BOOL_OR(dep_alerte)` : au moins une mesure de la date en dépassement d'alerte |

Les deux indicateurs ne valent jamais `NULL`. Ils sont indépendants : une date peut être en dépassement réglementaire et d'alerte. La règle « une telle date compte en réglementaire » est appliquée par Viz'eau à la lecture (`dep_alerte AND NOT dep_regl` pour l'alerte seule).

## Règles d'enrichissement

- **Fonction du paramètre** (non écrite dans la sortie) : première substance de `substances_par_fonction.csv` (dans l'ordre du fichier) dont le nom normalisé (minuscules, sans accents) est contenu dans le libellé du paramètre. Elle sert de clé de repli pour les seuils.
- **`limite_qualite` / `reference_qualite`** : lues par code paramètre dans `seuils_qualite_par_parametre.csv`, qui fait foi pour tous les codes qu'il contient, y compris quand il n'indique aucun seuil. Les paramètres mesurés absents de ce fichier sont signalés à chaque exécution : vérifier leurs seuils, puis les ajouter au fichier.
- **Seuils des codes absents de `seuils_qualite_par_parametre.csv`** : recherchés dans `limite_qualite.csv` / `reference_qualite.csv`, d'abord par libellé, puis par fonction à défaut. La recherche se fait par égalité stricte, puis par inclusion de sous-chaîne dans un sens ou dans l'autre (3 caractères minimum). En cas d'inclusion, c'est la **première clé du fichier** qui gagne : l'ordre des lignes des référentiels a donc une importance. Le nombre de correspondances approchées est affiché à chaque exécution.
- **Seuils numériques et indicateurs de dépassement** : mêmes règles que `SQL_DEP_REGL` / `SQL_DEP_ALERTE` dans Viz'eau (`app/services/aac_service.ts`), décrites dans « Format des seuils » de `formats-parquet.md`. Les seuils sont extraits par `extractSeuils` (`referentiels.js`) à partir des chaînes canoniques écrites dans `limite_qualite` / `reference_qualite` ; tout autre format donne `NULL`, donc aucun dépassement. `dep_regl` et `dep_alerte` ne valent jamais `NULL` : `false` quand il n'y a pas de seuil ou pas de `resultat_traduction`.
- **`captage_prioritaire`** : `true` sur toutes les lignes d'une installation si son code figure dans `INS`, ou si le captage correspondant figure dans `CodeBss`. Sinon, `false`. Le statut est déterminé par installation, et non par prélèvement : le code BRGM d'une même installation peut changer d'un prélèvement à l'autre (ancien puis nouveau format BSS), et il suffit qu'un de ses prélèvements corresponde.
  - `CodeBss` utilise les nouveaux identifiants BSS (`BSS000HXVV`), alors que les prélèvements ne donnent que l'ancien code BRGM (`01193X0172`). Le lien passe donc par `ref_cap_25avril2025.xlsx`, qui associe à chaque installation son identifiant BSS (`bss_id_en_bss`). Le code BRGM est aussi comparé directement à `CodeBss`, pour les quelques captages listés sous l'ancien format.
  - Les codes `INS` ont souvent perdu leurs zéros initiaux (`18000096` pour `018000096`) ou portent un préfixe (`Sise021000257`) : ils sont ramenés à 9 chiffres avant comparaison.
  - `CodeBss` et `INS` peuvent lister plusieurs codes séparés par `|`, `;` ou `,`.

## Limites connues

- Les correspondances approchées (par sous-chaîne) peuvent attribuer à un paramètre la valeur d'un paramètre voisin, par exemple un métabolite qui hérite de celle de sa molécule mère, ou le pyrène qui prendrait la limite du benzo(a)pyrène. Elles ne servent plus que pour les codes absents de `seuils_qualite_par_parametre.csv`.
- `seuils_qualite_par_parametre.csv` est figé : un nouveau paramètre n'y figure pas tant qu'on ne l'ajoute pas à la main.
- Pour les codes inconnus, `limite_qualite` utilise la limite **eau distribuée** (2ᵉ colonne de `limite_qualite.csv`). Ce fichier contient aussi une colonne `eau_brute`, plus pertinente pour des captages, qui n'est pas exploitée.
- Les règles de dépassement existent en deux exemplaires : dans Viz'eau et dans ce générateur (`extractSeuils`, plus les expressions recopiées pour le contrôle de cohérence dans `generate_analyses_parquet.js`). Une modification d'un côté doit être reportée de l'autre ; le contrôle signale tout écart.
- `code_parametre` est un code SANDRE entier, mais reste typé `DOUBLE` pour rester compatible avec les fichiers déjà produits.
- Deux paramètres mesurés sont absents de `seuils_qualite_par_parametre.csv` et restent sans seuil : `7363` (Goniochloris) et `8794` (coliphages somatiques). Ils sont signalés à chaque exécution.
- `captage_prioritaire` dépend des codes publiés dans les sources : quand data.gouv change le code BRGM d'un prélèvement, une installation peut perdre son rattachement. C'est le cas de `061001562` et `061001563` (Saint-Hilaire), autrefois rattachées par `02522X0003`, dont les nouveaux codes `BSS000TTHA` et `BSS000TTJD` ne figurent pas dans `captages_prioritaires.csv`.
