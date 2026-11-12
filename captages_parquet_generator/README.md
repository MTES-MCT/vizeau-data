# Génération d'un `captages.parquet` candidat depuis le référentiel DGS des captages

## Contexte

`captages.parquet` — utilisé par `../aac/fiches/generate_aac_fiches_parquet.js`
pour construire la liste des installations de captage de chaque fiche AAC —
est aujourd'hui téléchargé tel quel depuis S3, sans processus de génération
documenté dans ce dépôt : c'est un export brut d'une source privée
(probablement SISE-Eaux/ARS fourni par un partenaire).

Objectif à terme : remplacer cette source privée non documentée par un
`captages.parquet` regénéré à partir du référentiel national des captages
publié par la DGS (`DGS_ref_cap_06_05_2026`, plus exhaustif — 58 114 captages
contre 50 823 distincts dans le fichier actuel), **sans casser le pipeline existant**. La
bascule se fait par étapes : ce document couvre la première étape, la
génération d'un fichier candidat à comparer avant toute mise en production.

Le script correspondant est `generate_captages_parquet.js`. Un second script,
`generate_prioritaires.js`, rattache les ouvrages de l'export des captages
prioritaires aux captages du référentiel et à une AAC, et liste les lignes de
l'export à corriger. Un troisième, `generate_captages_aac.js`, rattache les
captages aux AAC (`captages_aac.parquet`) : c'est là que sont les règles de ce
rattachement, que `aac/fiches` ne calcule plus. Le détail
colonne par colonne du mapping (source → schéma cible, transformations,
approximations connues) est dans `csv-to-parquet-schema-mapping.md` — ce
document-ci résume le processus dans son ensemble : entrées, sorties,
contenu.

Ce dossier est **totalement indépendant** de `aac/fiches/` : il a ses
propres `package.json`/`node_modules`, et ses fichiers, rangés dans
`data/captages/` à la racine du dépôt (voir ci-dessous), ne dépendent d'aucun
fichier généré ou téléchargé par `generate_aac_fiches_parquet.js`. Seule la
comparaison avec l'ancien `captages.parquet` (scripts
`compare_captages.mjs`/`investigate_pp_coverage.mjs`) lit la copie locale du
bucket, `data/s3/captages.parquet` (cf. plus bas). En sens inverse,
`generate_aac_fiches_parquet.js` lit les fichiers produits ici :
`captages_aac.parquet` pour les installations de chaque AAC,
`captages_prioritaires.parquet` pour poser le flag `prioritaire` des
installations, et `captages_new.parquet` pour les codes BSS (et les attributs
des captages absents de l'ancien `captages.parquet`).

## Installation

```bash
cd captages_parquet_generator
npm install
```

## Fichiers nécessaires en entrée

Tous locaux, dans `data/captages/` sauf `AAC.gpkg`, aucun accès réseau/S3 requis :

| Fichier                                                              | Rôle                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DGS_ref_cap_06_05_2026/cap.csv`                                      | Référentiel national des captages (SISE-Eaux et BSS, mai 2026). Source principale : une ligne par captage. Les champs sont décrits dans `metadata.csv`, à côté. |
| `DGS_ref_cap_06_05_2026/mca.csv`                                      | Référentiel des "mélanges de captages" (regroupements). Sert à reconstruire `t1_ins_cap_ref` et complète les codes BSS des captages membres. |
| `DGS_ref_cap_23_02_2024/cap.csv`                                      | Référentiel de février 2024 : une ligne par point de surveillance (PSV), principal ou secondaire. Seule source du lien PSV secondaire → captage. |
| `ppe_hilbert.parquet`                                                 | Géométries des périmètres de protection éloignée (PPE), avec leur `code_pp` et leurs attributs d'origine, dont `psv_code` (voir ci-dessous). |
| `ppr_hilbert.parquet`                                                 | Géométries des périmètres de protection rapprochée (PPR), avec leur `code_pp` et leurs attributs d'origine, dont `psv_code` (voir ci-dessous). |
| `ppi_hilbert.parquet`                                                 | Géométries des périmètres de protection immédiate (PPI), avec leur `code_pp`.                          |
| `20260901-export_source_list_ouvragespourVizeau.csv`                  | Export des captages prioritaires : une ligne par ouvrage de prélèvement (OPR), avec ses codes INS, PSV, BSS, PTP et son AAC. Lu par `generate_prioritaires.js`. |
| `sandre_prl/PointPrelevement.csv`                                     | Couche WFS des points de prélèvement (PTP) du Sandre, en CSV : code BSS (`CdNationalPTE`) de chaque PTP et OPR auxquels il est connecté. Lu par `generate_prioritaires.js` et `generate_captages_aac.js`. À télécharger, voir ci-dessous. |
| `data/aac/AAC.gpkg` (couche `AAC_FRA`)                                | Géométries des AAC, partagées avec `aac/`, et référentiel AAC du Sandre : son champ `PTP` donne les points de prélèvement de chaque AAC (239 AAC sur 1 681 en novembre 2026). Lu par `generate_prioritaires.js` (AAC de chaque OPR, codes AAC de l'export, distance captage → AAC) et `generate_captages_aac.js`. |

Les 3 fichiers `*_hilbert.parquet` donnent les codes de périmètre
(`t2_code_ppe`/`t2_code_ppr`/`t2_code_ppi`) qu'aucun des CSV ne fournit : par
le `psv_code` des PPE et PPR, par intersection spatiale avec le point du
captage pour les PPI (voir `captages_new.parquet` ci-dessous). Leurs
géométries (PPR et PPI seulement) servent aussi à `generate_captages_aac.js`,
pour savoir quels périmètres sont dans une AAC à 40 % au moins.

La couche des PTP se télécharge depuis le WFS du Sandre (environ 35 Mo,
187 000 lignes en octobre 2026) :

```bash
mkdir -p data/captages/sandre_prl
curl -o data/captages/sandre_prl/PointPrelevement.csv \
  'https://services.sandre.eaufrance.fr/geo/prl?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=sa:PointPrelevement&OUTPUTFORMAT=text/csv'
```

Particularités des CSV, gérées par le script :
- `DGS_ref_cap_06_05_2026` écrit les coordonnées avec une virgule décimale
  (`922965,323`) ; le référentiel de 2025 utilisait un point.
- `DGS_ref_cap_23_02_2024/cap.csv` commence par 10 lignes de description de
  l'extraction et finit par une ligne de total (`Nombre:`) ; certains champs
  texte contiennent des `;` entre guillemets.
- Tous les CSV sont lus en texte (`all_varchar`) pour ne pas laisser DuckDB
  convertir des codes en nombres.

⚠️ Ces périmètres de protection proviennent de **sources institutionnelles
sensibles** et ne sont pas téléchargeables depuis une source publique.
`ppe_hilbert.parquet` et `ppr_hilbert.parquet` ont été **modifiés par l'équipe
Viz'eau pour masquer les PPI**. Ces deux fichiers servent aussi à générer les
couches `ppe` et `ppr` du PMTiles de zonage (voir
[`aac/zonage`](../aac/zonage/README.md#périmètres-de-protection-ppr_hilbertparquet-ppe_hilbertparquet)).

#### Attributs d'origine des PPR et PPE

`ppr_hilbert.parquet` et `ppe_hilbert.parquet` ont une ligne par couple
(périmètre, captage) : 30 273 PPR, 14 049 PPE. Outre `code_pp` et `geom`, ils
portent les attributs d'origine des couches Cart'eaux (AtlaSanté) :

| Fichier | Colonnes |
| ------- | -------- |
| `ppr_hilbert.parquet` | `code_pp`, `ins_cap_ref`, `nb_ppi_associes`, `psv_code`, `geom` |
| `ppe_hilbert.parquet` | `code_pp`, `_edit_datemaj`, `code_envir`, `code_ins`, `diffusion`, `ins_cap_ref`, `ins_pro_etat`, `ins_pro_etat_lib`, `precision`, `projet`, `psv_code`, `qualite`, `siren_ars`, `source`, `geom` |

`psv_code` est le point de surveillance du captage pour lequel le périmètre
a été établi. C'est le lien direct PP → PSV → INS, plus fiable que
l'intersection spatiale (étape 2 de [`plan-captages.md`](../plan-captages.md)).
Le PSV se résout en INS par `captages_identifiants.parquet`. `ins_cap_ref` ne
désigne pas le captage du périmètre, mais un captage de référence du groupe
qui partage le périmètre : ne pas l'utiliser pour ce lien.

⚠️ Ce lien ne doit figurer que dans des fichiers parquet, qui ne sont pas
diffusés. Il est volontairement exclu du PMTiles de zonage généré par
[`aac/zonage`](../aac/zonage/README.md) (question 12 du plan).

Ces attributs ont été remis dans les fichiers le 3 novembre 2026 (les
versions de septembre 2026 n'avaient plus que `code_pp`). Ils viennent de
l'ancien PMTiles de zonage (`data/aac/zonage-backup.pmtiles`, généré avant
octobre 2026), apparié ligne à ligne par la géométrie, faute d'identifiant
commun. Lignes, ordre, `code_pp` et géométries sont inchangés. Bilan :

- 30 191 PPR sur 30 273 et 14 039 PPE sur 14 049 ont un `psv_code`. Les autres
  (82 PPR, 10 PPE) n'ont aucun attribut d'origine : plusieurs variantes d'un
  même périmètre ne pouvaient pas être départagées.
- Les 29 423 couples (`code_pp`, `psv_code`) de l'ancienne couche PPR sont tous
  retrouvés, et 13 977 sur 13 979 pour les PPE ; aucun couple n'est inventé.
  Contrôle externe : `037_R_0581` → PSV `0370000002236`, comme dans Cart'eaux.
- Pour 1 174 lignes PPR, variantes quasi identiques d'un même périmètre, la
  répartition des attributs entre ces variantes est arbitraire. Le couple
  (`code_pp`, `psv_code`) reste juste, seule la géométrie associée peut être
  celle d'une variante voisine.

Les prochaines livraisons des périmètres arriveront sous forme de nouveaux
fichiers parquet, avec leurs attributs : ce rattrapage n'est pas à refaire.

La table de correspondance code département → nom (`t1_dep_geo_lib`, absente
du CSV) est codée en dur dans le script (`DEPARTEMENTS`), pas besoin de
fichier externe.

## Usage

```bash
npm start              # generate_captages_parquet.js
npm run prioritaires   # generate_prioritaires.js, à lancer après
npm run aac            # generate_captages_aac.js, à lancer en dernier
```

`generate_prioritaires.js` lit `captages_identifiants.parquet` et
`captages_new.parquet` : il faut relancer `npm start` avant lui quand les
référentiels changent. `generate_captages_aac.js` lit en plus
`captages_prioritaires.parquet` : il faut le relancer après chacun des deux
autres, et quand `AAC.gpkg` change.

Le seuil de distance entre un captage et une AAC (`DISTANCE_MAX_AAC_KM`,
2,5 km) est défini une seule fois, dans `regles_aac.js`, pour les deux derniers
scripts (voir [`captages_aac.parquet`](#captages_aacparquet)).

Aucune variable d'environnement requise (contrairement à
`generate_aac_fiches_parquet.js`, qui a besoin des identifiants S3).

## Artefacts produits

```
generate_captages_parquet.js
DGS_ref_cap_06_05_2026/cap.csv ──┬──────────────────────────────────► captages_new.parquet ──► aac/fiches
DGS_ref_cap_06_05_2026/mca.csv ──┤  (t1_ins_cap_ref)                    ▲    ▲               (codes BSS)
                                 │                                      │    │ (t2_code_pp*)
DGS_ref_cap_23_02_2024/cap.csv ──┴──(normalisation des codes) ──► captages_identifiants.parquet
                                                         (codes BSS) ───┘    │
                                                                             │ (PSV → captage)
pp*_hilbert.parquet ──(psv_code ; intersection pour les PPI) ────────────────┘

generate_prioritaires.js
export OPR (CSV) ─────────┐
sandre_prl (PTP → BSS) ───┤
captages_identifiants ────┼──(résolution INS > PSV > BSS des PTP > BSS de l'OPR) ──► captages_prioritaires.parquet ──► aac/fiches
                          │  (AAC de l'OPR : PTP cité par une AAC du Sandre > code_aac)   │                     (flag prioritaire)
captages_new (points) ────┤                                                              ▼
data/aac/AAC.gpkg ────────┴──(PTP des AAC, codes AAC, distance) ───────────────► anomalies_prioritaires.csv

generate_captages_aac.js
data/aac/AAC.gpkg (PTP) ──┐
sandre_prl (PTP → BSS) ───┼──► 1. sandre : PTP de l'AAC → BSS → captage ─────┐
captages_identifiants ────┘       et OPR auxquels le Sandre donne l'AAC       │ liens sûrs, sans
captages_prioritaires ─────────► 2. export : code_aac de l'OPR (ou porteur) ──┤ contrôle de distance
                                                                               │
                                  seulement pour les AAC sans lien sûr, ≤ 2,5 km :
captages_new (points) ─────────► 3. point : point du captage dans l'AAC ─────┤ recroisement
captages_new (t2_code_pp*) ──┬─► 4. perimetre : PPR/PPI du captage ≥ 40 % ───┤ géographique
ppr/ppi_hilbert (géométries) ┘      dans l'AAC                                 ▼
                                                     captages_aac.parquet ──► aac/fiches
                                                                               (installations de chaque AAC)
```

Les fichiers sont écrits dans `data/captages/` et ne sont pas versionnés.

### `captages_new.parquet`

**`data/captages/captages_new.parquet`** — fichier candidat (non versionné).
Pour comparer avec l'ancien `captages.parquet` (scripts `compare_captages.mjs`
et `investigate_pp_coverage.mjs`), utiliser sa copie locale
`data/s3/captages.parquet`, téléchargée depuis S3 par `aac/fiches`.

#### À quoi il sert

Ce n'est **pas encore** branché sur `generate_aac_fiches_parquet.js`, qui n'y
lit que les codes BSS (`t1_ins_code_bss`, `t1_ins_code_bss_nouveau`) de ses
installations, et les attributs des captages rattachés à une AAC mais absents
de l'ancien `captages.parquet`. Ses points et ses codes de périmètre servent en
revanche au rattachement des captages aux AAC
([`captages_aac.parquet`](#captages_aacparquet)). C'est une étape
intermédiaire, destinée à :
1. Vérifier que le schéma produit est compatible avec les requêtes du
   pipeline (validé : la requête de rattachement captage→AAC de
   `generate_aac_fiches_parquet.js` tourne sans erreur dessus, cf. tests manuels).
2. Comparer son contenu avec `captages.parquet` (nombre de lignes, écarts de
   valeurs) avant toute décision de bascule.

#### Ce qu'il contient

Une ligne par captage (`code_installation` du CSV), avec uniquement les
colonnes de `captages.parquet` réellement lues par `generate_aac_fiches_parquet.js`
(les ~70 autres colonnes du fichier actuel, non utilisées par le pipeline, ne
sont pas reproduites) :

| Colonne              | Origine                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `t1_code_ins`         | `code_installation` (CSV)                                                                     |
| `t1_ins_nom`          | `nom_installation` (CSV)                                                                       |
| `t1_com_nom`          | `nom_commune_actuelle`, ou `nom_commune_dans_sise` si absente (CSV)                           |
| `t1_com_insee`        | `code_insee_commune_sise` (CSV) — sélectionnée par le pipeline mais non utilisée en aval       |
| `t1_ins_etat_lib`     | `libel_etat` (CSV), mis en majuscules                                                          |
| `t1_uge_mo_nom`       | `NULL` — pas d'équivalent dans le CSV ; sélectionnée par le pipeline mais non utilisée en aval |
| `t1_dep_geo_lib`      | `dept_gestionnaire` (CSV) joint à la table `DEPARTEMENTS` codée en dur dans le script          |
| `t1_cap_type_lib`     | `nature_point_eau` (CSV), mis en majuscules — **approximation**, cf. limites ci-dessous       |
| `t1_ins_nat_code`     | `type_eau` (CSV)                                                                               |
| `t1_ins_usage_lib`    | `libel_usage` (CSV)                                                                            |
| `t1_ins_etat`         | `code_etat` (CSV) — sélectionnée par le pipeline mais non utilisée en aval                     |
| `t1_ins_cap_ref`      | Reconstruit depuis `mca.csv` (voir ci-dessous), `NULL` si le captage n'est dans aucun mélange |
| `t1_ins_cap_ref_lib`  | Idem, nom de l'installation de référence du groupe                                            |
| `t1_ins_code_bss`     | Ancien code BSS complet, indice et désignation (`06992X0035/P1`), voir ci-dessous            |
| `t1_ins_code_bss_nouveau` | Nouveau code BSS (`BSS001SEGK`), voir ci-dessous. Colonne absente de l'ancien fichier     |
| `t2_code_ppe`         | PPE du captage dans `ppe_hilbert.parquet`, par son `psv_code` (pas d'intersection spatiale), voir ci-dessous |
| `t2_code_ppr`         | PPR du captage dans `ppr_hilbert.parquet`, idem                                                |
| `t2_code_ppi`         | Reconstruit par intersection spatiale avec `ppi_hilbert.parquet` (pas de `psv_code`)          |
| `t2_code_ppe_source`, `t2_code_ppr_source`, `t2_code_ppi_source` | Origine du code : `psv` (lien direct) ou `intersection`, `NULL` sans code. Colonnes absentes de l'ancien fichier |
| `t1_psv_x`            | `x_l93_installation` (CSV), virgule décimale remplacée, converti en `DOUBLE`                 |
| `t1_psv_y`            | `y_l93_installation` (CSV), virgule décimale remplacée, converti en `DOUBLE`                 |

Les ~2 700 captages au statut « gelé » (`statut_captage = 'G'` : absents de la
dernière extraction SISE-Eaux transmise au BRGM) sont gardés, bien que
presque tous leurs champs soient vides.

**Reconstruction de `t1_ins_cap_ref`** : `mca.csv` regroupe des captages
"mélangés" sous un même `code_mca_national`. On prend, par groupe, le plus
petit `code_captage_principal_sise` comme référence — un choix arbitraire
mais déterministe, faute de documentation précise sur la sémantique exacte de
ce référentiel. Un même captage apparaissant dans plusieurs groupes (~189 cas
sur les données testées) ne garde qu'un seul rattachement (le plus petit),
pour rester cohérent 1:1 avec le schéma attendu par le pipeline.

**Reconstruction de `t2_code_ppe/ppr/ppi`** : le CSV ne donne aucun lien
captage → périmètre. Une méthode par type de périmètre :

1. **Lien direct (`psv`)**, pour les PPE et PPR : chaque périmètre porte le
   `psv_code` du point de surveillance du captage pour lequel il a été établi
   (voir « Attributs d'origine des PPR et PPE »). Ce PSV est résolu en captage
   par les PSV, principaux et secondaires, de `captages_identifiants.parquet`.
   `ins_cap_ref` n'est pas utilisé.
   Un captage qu'aucun `psv_code` ne désigne n'a pas de PPE ni de PPR : pas
   d'intersection spatiale en secours (voir ci-dessous pourquoi).
2. **Intersection spatiale (`intersection`)**, pour les PPI, qui n'ont pas de
   `psv_code` : le point du captage (`x_l93_installation`/`y_l93_installation`),
   projeté en WGS84, est dans la zone (`ST_Intersects`).

Un captage qui a plusieurs périmètres (26 par le `psv_code` pour les PPR, 5
pour les PPE ; chevauchements de zones par l'intersection) n'en garde qu'un, le
plus petit code, pour rester 1:1 avec le schéma attendu par le pipeline.

Résultat (novembre 2026), comparé à l'ancien `captages.parquet` (source ARS) :

| Périmètre | Source         | Captages | Même code que l'ancien | Autre code | Ancien sans code |
| --------- | -------------- | -------- | ---------------------- | ---------- | ---------------- |
| PPR       | `psv`          | 27 521   | 27 438                 | 15         | 2                |
| PPE       | `psv`          | 13 305   | 13 253                 | 5          | 2                |
| PPI       | `intersection` | 22 767   | 21 836                 | 314        | 588              |

Avec l'intersection seule, on avait 28 832 PPR (24 447 comme l'ancien) et
7 281 PPE (3 194 comme l'ancien).

**Pourquoi pas d'intersection en secours pour les PPR et PPE** (mesures de
novembre 2026) :

- *Effet de sélection.* En secours du lien direct, l'intersection donnait
  2 871 PPR et 3 251 PPE aux captages sans lien direct, dont 3 PPR et 1 PPE
  seulement comme l'ancien fichier. Ces
  captages sont justement ceux qu'aucun périmètre ne désigne : un périmètre
  qui les contient a été établi pour un autre captage (le `psv_code` le
  confirme dans 2 792 et 3 247 cas). Ce sont des puits voisins d'un même
  champ captant (pour les PPR, la moitié à moins de 200 m du captage du
  périmètre, et 570 dans le même mélange), d'anciens ouvrages abandonnés
  (plus de 40 %), ou des captages en projet. Quand l'ancien fichier leur
  donne un autre périmètre (830 PPR, 288 PPE), ce code est toujours absent
  des `pp*_hilbert.parquet` (cause 1 de l'investigation ci-dessous) : leur
  vrai périmètre manque. Limitée aux périmètres qu'aucun `psv_code` ne
  rattache à un captage (PSV absent du référentiel : 47 codes PPR, 21 codes
  PPE), elle ne donnait plus que 79 PPR et 5 PPE, dont 0 PPR et 1 PPE comme
  l'ancien fichier (qui n'avait pas de PPR pour 74 de ces captages).
- *Le PPE exclut le PPR.* Pour 9 665 des 13 148 captages qui ont un PPE et
  un PPR par le `psv_code`, le PPE ne recouvre pas 1 % de leur PPR : il est
  dessiné autour (anneau, 1 881 codes PPE ont un trou) ou à côté du PPR, pas
  par-dessus. Le captage, dans son PPR, n'est donc dans son propre PPE que
  dans 25 % des cas, mais dans son PPE ou son PPR dans 94 %. Une intersection
  avec un PPE doit tester le PPE réuni au PPR du même captage.
- Pour les PPR, l'intersection elle-même est fiable : 94 % des captages liés
  par le `psv_code` sont dans leur PPR. Pour les PPI, 96 % des liens
  concordent avec l'ancien fichier.

**Codes BSS (`t1_ins_code_bss`, `t1_ins_code_bss_nouveau`)** : un ouvrage BSS
a un ancien code, indice et désignation séparés par un `/` (`06992X0035/P1`),
et un nouveau code (`BSS001SEGK`), donné dans sa propre colonne. Les ouvrages
créés depuis le changement de format n'ont pas d'ancien code : le BRGM écrit
alors `BSS002PRUZ/F1`, qui n'est pas repris.

Il n'existe pas de table de conversion à part : les deux codes sont tirés de
[`captages_identifiants.parquet`](#captages_identifiantsparquet), qui réunit
les codes BSS du captage trouvés dans toutes les sources. Les captages dont
le BRGM donne les deux codes (`code_bss_en_bss`, `bss_id_en_bss`) servent de
pivot pour passer de l'un à l'autre : un indice n'y désigne qu'un ouvrage, et
un nouveau code qu'un ancien. Pour chaque captage :

| Origine | Règle | Captages | Ancien code | Nouveau code |
|---|---|---|---|---|
| BRGM | codes du BRGM du captage ; ses autres codes sont ignorés | 49 592 | 46 723 | 49 592 |
| Autres sources, avec pivot | meilleur ancien et meilleur nouveau code parmi les autres sources (ARS 2026, puis référentiel 2024, puis `mca.csv`) ; celui qui manque est retrouvé par le pivot | 345 | 345 | 345 |
| Autres sources | idem, sans que le pivot ne complète rien | 1 365 | 892 | 512 |
| aucune | pas de code BSS lisible (`XXX`, `789-6-`, indices bouche-trou) | 6 812 | | |

- Le code de l'ARS est ignoré quand le BRGM en donne un : ils désignent un
  ouvrage différent pour 1 124 captages (ancien code) et 298 (nouveau code),
  et ce sont les codes du BRGM qui servent à bancariser les analyses dans
  ADES. C'est la même préférence que pour les captages prioritaires.
- Combiner les sources complète des captages : pour `004004640`, l'ARS ne
  donne que le nouveau code (`BSS002AWSL`) et le référentiel 2024 l'ancien
  (`08717X0004/HY`).
- Quand l'indice figure parmi les pivots, la désignation du BRGM remplace
  celle des autres sources, qui diverge souvent (`L` pour `P`, `215` pour
  `SOURCE`). Faute de désignation connue, l'ancien code se réduit à l'indice
  (1 008 captages).
- Auparavant, `t1_ins_code_bss` reprenait `indice_bss_sise` brut : indice
  sans désignation, parfois déjà au nouveau format, avec des espaces et des
  valeurs fantaisistes.

#### Résultats observés (dernière exécution)

- 58 114 lignes / 58 114 `t1_code_ins` distincts (aucun doublon).
- 13 083 captages rattachés à un groupe via `mca.csv`.
- 7 281 captages rattachés à un PPE, 28 832 à un PPR, 22 767 à un PPI.

À comparer avec `data/s3/captages.parquet` : 53 775 lignes / 50 823
`t1_code_ins` distincts.

Par rapport au référentiel d'avril 2025, celui de mai 2026 contient les
57 720 mêmes captages plus 394 nouveaux. Sur les captages communs, les écarts
(coordonnées, état, nom, code BSS) viennent tous de mises à jour du
référentiel, pas de la lecture du fichier.

### `captages_identifiants.parquet`

Table de correspondance des identifiants de captage. Selon les sources, un
même captage est désigné par son code installation SISE-Eaux (INS), par le
code d'un de ses points de surveillance (PSV) ou par un code BSS, dans
l'ancien format (indice, `06992X0035`) ou le nouveau (`BSS001SEGK`). Ce
fichier donne tous les codes connus de chaque captage du référentiel 2026,
une ligne par code, pour retrouver le captage à partir de n'importe lequel
d'entre eux, et convertir un ancien code BSS en nouveau (et inversement).

| Colonne             | Contenu                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `code_installation` | Code INS du captage (`t1_code_ins` de `captages_new.parquet`)                                    |
| `type_code`         | `INS`, `PSV`, `BSS_INDICE` (ancien code BSS, sans la désignation) ou `BSS_ID` (nouveau code BSS) |
| `code`              | Le code, normalisé (voir ci-dessous)                                                            |
| `complement`        | PSV : catégorie `P` (principal) ou `S` (secondaire). BSS : désignation (`P1`, `F`…), celle du BRGM en priorité |
| `sources`           | Liste des sources où le code a été trouvé (voir ci-dessous)                                     |

Exemple pour le captage `001000106` :

| `type_code`  | `code`          | `complement` | `sources`                                     |
| ------------ | --------------- | ------------ | --------------------------------------------- |
| `BSS_ID`     | `BSS001SEGK`    |              | `cap_2026_brgm`                               |
| `BSS_INDICE` | `06775X0018`    | `HY`         | `cap_2024`, `cap_2026_brgm`, `cap_2026_sise`  |
| `INS`        | `001000106`     |              | `cap_2026`                                    |
| `PSV`        | `0010000000108` | `P`          | `cap_2024`, `cap_2026`                        |
| `PSV`        | `0010000000235` | `S`          | `cap_2024`                                    |

Valeurs de `sources` :

| Valeur          | Fichier et champs                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `cap_2026`      | `DGS_ref_cap_06_05_2026/cap.csv` : `code_installation`, `psv_code` (PSV principal seulement)  |
| `cap_2026_brgm` | `DGS_ref_cap_06_05_2026/cap.csv` : `code_bss_en_bss`, `bss_id_en_bss`, codes BSS saisis par le BRGM, sur lesquels les analyses sont bancarisées dans ADES |
| `cap_2026_sise` | `DGS_ref_cap_06_05_2026/cap.csv` : `indice_bss_sise`, code BSS saisi par l'ARS dans SISE-Eaux |
| `cap_2024`      | `DGS_ref_cap_23_02_2024/cap.csv` : PSV principaux et secondaires, code BSS saisi dans SISE-Eaux |
| `mca_2026`      | `DGS_ref_cap_06_05_2026/mca.csv` : codes BSS des captages membres d'un mélange                |

**Normalisation des codes.** Les fichiers passés par un tableur perdent les
zéros initiaux. `normalisation.js` définit des macros DuckDB (`norm_ins`, `norm_psv`,
`norm_bss_indice`, `norm_bss_id`) qui remettent chaque code dans son format de
référence. Elles servent aussi à `generate_prioritaires.js` pour les codes de
l'export des captages prioritaires :

| Macro             | Exemples                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| `norm_ins`        | `57002293` → `057002293`, `1000008` → `001000008`, `Sise021000257` → `021000257`, `2A004625` → `02A004625` |
| `norm_psv`        | `570000002805` → `0570000002805`, `2A0000000001` → `02A0000000001`            |
| `norm_bss_indice` | `06992X0035/P1` → `06992X0035`, `6952X0015` → `06952X0015`                    |
| `norm_bss_id`     | `bss002hyfb` → `BSS002HYFB`, `BSS002PRUZ/F1` → `BSS002PRUZ`                   |

Une valeur non reconnaissable donne `NULL` et n'est pas reprise dans la table.
Cela concerne des saisies fantaisistes côté ARS (`XXX`, `789-6-`) et des
indices bouche-trou partagés par des dizaines de captages (`9999X9999`,
`00000XCODE`, `00000X0000`).

**Choix de construction.**
- Le référentiel 2026 ne donne que le PSV principal de chaque captage ; celui
  de 2024 a une ligne par PSV, ce qui ajoute 4 656 PSV secondaires.
- Seuls les captages présents dans le référentiel 2026 sont gardés, pour que
  tout code résolu mène à une ligne de `captages_new.parquet` (2 PSV de 2024
  sont écartés pour cette raison).
- Un même code peut désigner plusieurs captages. La table garde toutes les
  correspondances et le résumé du script compte ces codes ambigus. Ils
  viennent presque tous des codes BSS saisis côté ARS : seuls 4 anciens et
  4 nouveaux codes BSS du BRGM sont partagés.

**Résultats observés (dernière exécution).**

| `type_code`  | Lignes | Captages | Codes ambigus |
| ------------ | ------ | -------- | ------------- |
| `BSS_ID`     | 50 524 | 50 149   | 204           |
| `BSS_INDICE` | 49 248 | 48 070   | 799           |
| `INS`        | 58 114 | 58 114   | 0             |
| `PSV`        | 60 229 | 55 559   | 0             |

Testée sur l'export des captages prioritaires
(`20260901-export_source_list_ouvragespourVizeau.csv`), la table retrouve,
après normalisation, 100 % des codes INS, 1 276 des 1 279 codes PSV et
1 496 des 1 541 codes BSS. 1 333 des 1 539 OPR peuvent ainsi être rattachés
à au moins un captage, contre 1 210 avec les seuls codes INS.

### `captages_prioritaires.parquet`

Produit par `generate_prioritaires.js`. Une ligne par OPR de l'export des
captages prioritaires, AAC retenue pour cet OPR et captage du référentiel.
Un OPR sans AAC a une ligne par captage, avec `code_aac` vide ; un OPR auquel
le Sandre donne plusieurs AAC aurait une ligne par AAC (aucun cas en
novembre 2026). Un OPR qu'aucun code ne résout en captage (`opr_sans_captage`
dans le rapport d'anomalies) a une ligne, avec `code_installation` et
`resolu_par` vides : `aac/fiches` en tire les AAC citées par l'export, qui ont
le flag `prioritaire` même sans captage identifié (prises d'eau de surface
surtout). En novembre 2026 : 1 700 lignes, dont 204 sans captage.

| Colonne             | Contenu                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `code_opr`          | Code de l'ouvrage de prélèvement                                                                |
| `statut_opr`        | `seul`, `porteur` ou `rattaché`                                                                 |
| `opr_rattach`       | Pour un rattaché, code OPR de son porteur                                                       |
| `code_aac`          | AAC retenue pour l'OPR (voir « AAC de l'OPR » ci-dessous). Un code de l'export absent d'`AAC.gpkg` est gardé tel quel |
| `code_aac_source`   | Origine de `code_aac` : `sandre` (AAC qui cite un PTP de l'OPR), `sandre_porteur` (idem, pour le porteur d'un rattaché), `export` (`code_aac` de la ligne de l'OPR) ou `export_porteur` (`code_aac` du porteur) |
| `code_aac_export`   | AAC de l'OPR dans l'export, ou celle de son porteur pour un rattaché, même quand le Sandre en donne une autre |
| `code_installation` | Code INS du captage (`t1_code_ins`)                                                             |
| `resolu_par`        | Types de code de l'OPR qui ont mené à ce captage (`INS`, `PSV`, `PTP_BSS_ID`, `PTP_BSS_INDICE` pour les codes BSS de ses PTP, `BSS_ID`, `BSS_INDICE` pour ceux de l'OPR) |

**Règle de résolution.**
- `code_ins`, `code_psv`, `code_bss` et `code_ptp_sandre` sont des listes
  séparées par `|`, de longueurs parfois différentes : elles sont traitées
  comme des ensembles de codes, normalisés puis cherchés dans
  `captages_identifiants.parquet`. Un PTP y est cherché par le code BSS que
  lui donne la couche Sandre (`CdNationalPTE`).
- Un OPR est rattaché aux captages trouvés par le type de code le plus sûr qui
  en trouve au moins un : INS, sinon PSV, sinon BSS de ses PTP, sinon BSS de
  l'OPR dans l'export (ancien ou nouveau). Les codes PTP, plus récents que
  les codes OPR, passent avant eux ; les codes BSS de l'OPR ne servent qu'en
  secours. Un code moins sûr qui désigne un autre captage n'ajoute pas de
  lien, il est signalé dans le rapport d'anomalies.
- Un code BSS partagé par plusieurs captages l'est presque toujours à cause
  d'une saisie côté ARS (captage recodé, voisin ou abandonné qui garde le
  code). Si l'un d'eux porte le code dans les champs du BRGM (source
  `cap_2026_brgm`), seul celui-là est retenu. Sur toute la table, cela fait
  passer les codes BSS ambigus de 1 003 à 49 ; sur l'export, les 8 cas
  ambigus sont tous levés : sur les 7 codes concernés, le captage retenu
  porte le nom de l'OPR dans 4 cas, un nom proche dans 2 (même lieu-dit), et
  ne permet pas de trancher dans 1 (`F0 EMMERIN`, abandonné). Un code encore
  ambigu rattache tous ses captages, et est signalé.
- La désignation de l'ancien code BSS (`06992X0035/P1`) ne départage pas :
  l'export ne la donne pour aucun code (ni l'ancienne liste
  `captages_prioritaires_2026.csv`), et les 4 indices partagés côté BRGM le
  restent avec leur désignation. La recherche se fait donc sur l'indice seul.

**AAC de l'OPR.** Le référentiel AAC du Sandre est la source de vérité
principale, l'export ne fait que le compléter (question 10 de
`plan-captages.md`). Pour chaque OPR, dans cet ordre :

1. `sandre` : les AAC dont le champ `PTP` d'`AAC.gpkg` cite un PTP de l'OPR
   (colonne `code_ptp_sandre` de l'export) ;
2. `sandre_porteur` : pour un rattaché qui n'en a pas, celles de son porteur ;
3. `export` : le `code_aac` de l'OPR dans l'export ;
4. `export_porteur` : pour un rattaché, le `code_aac` de son porteur. Seuls
   les OPR seuls ou porteurs ont un `code_aac` dans l'export (question 3).

Quand le Sandre donne une AAC à l'OPR, le `code_aac` de l'export est ignoré.
S'il en diffère, c'est signalé (`aac_differente_sandre`). Un PTP peut être cité
à la fois par une AAC gelée et par l'AAC validée qui l'a remplacée (6 PTP en
novembre 2026) : seule l'AAC validée compte pour ce PTP (`regles_aac.js`).

Résultat (novembre 2026) : 180 OPR ont une AAC du Sandre par leurs PTP et 36
rattachés par ceux de leur porteur ; 696 gardent le `code_aac` de l'export et
257 rattachés celui de leur porteur ; 370 n'ont pas d'AAC. Pour les 104 OPR
seuls ou porteurs qui ont à la fois une AAC du Sandre et un `code_aac`, les
deux concordent 93 fois. 58 OPR seuls ou porteurs sans `code_aac` en gagnent
une.

`aac/fiches` lit ce fichier pour poser le flag `prioritaire` : une
installation est prioritaire si l'un de ses captages (référence ou rattaché)
y figure. La comparaison se faisait auparavant sur le texte des codes BSS, qui
mélangent ancien et nouveau format selon les sources.

**Résultats observés (dernière exécution).** 1 496 liens : 1 335 OPR sur
1 539 rattachés à 1 466 captages (1 210 OPR par leurs codes INS, 79 par les
codes BSS de leurs PTP, 46 par les seuls codes BSS de l'OPR ; aucun par les
seuls codes PSV). Sur les 1 589 PTP de l'export, 1 540 sont dans la couche
Sandre et 1 380 y ont un code BSS. Les codes BSS des PTP et ceux de l'OPR sont
identiques pour 1 233 OPR, qui les ont tous les deux : passer par les PTP
retrouve les mêmes captages et n'ajoute que 2 OPR (un qui n'a que des codes
PTP, un dont le code BSS de l'export, `29445`, est invalide), sans retirer ni
modifier de lien. Dans `aac.parquet`
régénéré le 20 octobre 2026 (toujours avec l'ancien `captages.parquet`),
1 401 installations sur 7 378 sont flaguées prioritaires, dans 898 AAC,
contre 89 installations et 66 AAC avec l'ancienne comparaison des codes BSS.

### `anomalies_prioritaires.csv`

Produit par `generate_prioritaires.js`. Lignes de l'export des captages
prioritaires non résolues ou incohérentes, à renvoyer au producteur de
l'export. Une ligne par anomalie, avec les colonnes `anomalie`, `code_opr`,
`statut_opr`, `opr_rattach`, `nom_sandre`, `code_aac`, `code_aac_export`,
`code_installation`, `distance_m` et `detail`. `code_aac` est l'AAC retenue
pour l'OPR (plusieurs séparées par `|`), `code_aac_export` celle de l'export
(héritée du porteur le cas échéant).

| `anomalie`            | Signification                                                                                                  | Lignes |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| `aac_inconnue`        | `code_aac` absent d'`AAC.gpkg` (code d'une autre nomenclature, code BSS ou OPR saisi à la place). Signalé sur l'OPR qui le porte, pas sur ses rattachés | 22 |
| `porteur_absent`      | OPR rattaché dont le porteur n'est pas dans l'export                                                           | 1      |
| `opr_sans_captage`    | Aucun code de l'OPR ne mène à un captage du référentiel : PTP sans code BSS dans la couche Sandre, coordonnées seules, ou codes INS/PSV/BSS inconnus. `detail` liste les codes présents | 204 |
| `captage_eloigne_aac` | Captage à plus de 2,5 km (`DISTANCE_MAX_AAC_KM`, `regles_aac.js`) de l'AAC retenue pour son OPR, mesuré depuis son point dans `captages_new.parquet`. Le lien est gardé dans `captages_aac.parquet`, avec la même alerte | 11 |
| `captage_dans_autre_aac` | Captage à plus de 100 m de l'AAC retenue pour son OPR, mais dans une autre AAC validée qui n'englobe pas celle-ci (règle dans `regles_aac.js`, voir [`captages_aac.parquet`](#captages_aacparquet)). `detail` donne les autres AAC. Le lien est gardé dans `captages_aac.parquet`, avec la même alerte | 15 |
| `aac_differente_sandre` | `code_aac` de l'export absent des AAC que le Sandre donne à l'OPR par ses PTP : l'AAC du Sandre est retenue. `detail` donne le statut et la date de mise à jour des deux AAC. Signalé sur l'OPR qui porte le code, pas sur ses rattachés | 11 |
| `code_autre_captage`  | Code PSV ou BSS de l'OPR ou de ses PTP qui désigne un captage autre que ceux retenus pour l'OPR. Un code BSS donné à la fois par un PTP et par l'OPR n'est signalé qu'une fois | 21 |
| `code_ambigu`         | Code PSV ou BSS retenu pour l'OPR qui désigne plusieurs captages, même après la préférence BRGM, tous rattachés | 0      |
| `ptp_inconnu`         | PTP de l'OPR absent de la couche Sandre des points de prélèvement                                              | 49     |
| `ptp_autre_opr`       | PTP de l'OPR que la couche Sandre connecte à d'autres OPR seulement                                            | 0      |

Les 21 codes AAC inconnus comprennent des codes numériques absents de la
couche SANDRE (`55005`, `417`…) et des valeurs qui ne sont pas des codes AAC
(`FRH_AAC ONS EN BRAY 1`, `00883X0044`, `OPR0000082770`).

### `captages_aac.parquet`

Produit par `generate_captages_aac.js` (`npm run aac`). Une ligne par couple
(AAC, captage) : c'est la seule source des installations de chaque AAC dans
`aac/fiches` (étape 3 de `plan-captages.md`).

| Colonne             | Contenu                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `cdaac`             | Code de l'AAC dans `AAC.gpkg`                                                                   |
| `code_installation` | Code INS du captage (`t1_code_ins` de `captages_new.parquet`)                                   |
| `source`            | Source du lien, la plus sûre si plusieurs le donnent : `sandre`, `export`, `point`, `perimetre` ou `proximite` (voir ci-dessous) |
| `lien_sur`          | `true` pour un lien donné par une table (`sandre`, `export`), `false` pour un recroisement géographique (`point`, `perimetre`, `proximite`) |
| `distance_m`        | Distance entre le point du captage (`captages_new.parquet`) et l'AAC, en mètres : 0 dans l'AAC, vide sans point |
| `alerte`            | `captage_eloigne_aac` pour un lien sûr à plus de 2,5 km de l'AAC, `captage_dans_autre_aac` pour un lien dont le captage est dans une autre AAC (voir ci-dessous), les deux séparées par `, ` ; vide sinon. Le lien est gardé dans tous les cas |
| `autres_aac`        | Pour `captage_dans_autre_aac` : codes des autres AAC où est le captage (liste) ; vide sinon |
| `detail`            | Ce qui a donné le lien : PTP de l'AAC (`PTP PTP000000000170307`), OPR de l'export (`OPR OPR0000000709`), périmètre et part de sa surface dans l'AAC (`PPR 010_R_0067 (86 %)`), `seul captage à moins de 100 m` pour `proximite` |

```
                  ┌───────────── rattachement captage → AAC ─────────────┐
                  │ liens sûrs (tables), sans contrôle de distance :      │
AAC.gpkg (PTP) ──►│ 1. sandre    PTP de l'AAC → code BSS → captage, et    │
                  │              captages des OPR auxquels le Sandre      │
                  │              donne l'AAC                              │
export OPR ──────►│ 2. export    code_aac de l'OPR (ou de son porteur)    │
                  │              quand le Sandre ne donne pas d'AAC       │
                  │                                                       │
                  │ recroisement géographique, seulement pour les AAC     │
                  │ sans lien sûr, captages à 2,5 km au plus :            │
captages_new ────►│ 3. point     point du captage dans l'AAC              │
ppr/ppi_hilbert ─►│ 4. perimetre PPR ou PPI du captage dont 40 % au moins │
                  │              de la surface est dans l'AAC (90 % pour  │
                  │              un captage sans point) ; pas les PPE     │
                  │                                                       │
                  │ dernier recours, AAC encore sans aucun lien :         │
captages_new ────►│ 5. proximite seul captage à 100 m au plus du bord     │
                  │              de l'AAC                                 │
                  │                                                       │
                  │ alertes, sur des liens gardés :                       │
                  │   captage_eloigne_aac     lien sûr à plus de 2,5 km   │
                  │   captage_dans_autre_aac  captage à plus de 100 m de  │
                  │                           l'AAC, dans une autre AAC   │
                  └───────────────────────────┬───────────────────────────┘
                                              ▼
                                   captages_aac.parquet ──► aac/fiches
```

**Liens sûrs.** Quand une table donne les captages d'une AAC, on la respecte
sans regarder la géométrie (question 4 de `plan-captages.md`) :

- `sandre` : chaque PTP du champ `PTP` d'`AAC.gpkg` est résolu en captage par
  son code BSS (`CdNationalPTE` de la couche des PTP), cherché dans
  `captages_identifiants.parquet`, avec la même préférence BRGM que
  `generate_prioritaires.js` pour un code partagé. S'y ajoutent les captages
  des OPR de l'export auxquels le Sandre donne l'AAC (`code_aac_source`
  `sandre` ou `sandre_porteur` de `captages_prioritaires.parquet`), ce qui
  couvre les PTP sans code BSS (eaux de surface). Une AAC gelée ne garde que
  les PTP qu'aucune AAC validée ne cite (`regles_aac.js`).
- `export` : les captages des OPR auxquels le Sandre ne donne pas d'AAC, liés
  au `code_aac` de l'OPR ou de son porteur. Un code absent d'`AAC.gpkg`
  (`aac_inconnue`) ne donne aucun lien.
- Ces liens sont gardés quelle que soit la distance. Au-delà de 2,5 km, ils
  portent l'alerte `captage_eloigne_aac`, comme dans le rapport d'anomalies
  (alerte `captage_dans_autre_aac` : voir plus bas).
- Un OPR rattaché donne ses propres captages, qui forment une installation à
  part dans `aac.parquet` (question 3). Les `captages_rattaches` d'une
  installation restent les membres d'un même mélange.

**Recroisement géographique.** Il ne sert que pour les AAC qui n'ont aucun
lien sûr : une AAC qui en a un ne reçoit aucun lien géographique. Une AAC dont
les PTP ou les OPR ne se résolvent en aucun captage (PTP d'eaux de surface,
OPR sans captage) n'a pas de lien sûr : elle passe par la géographie.

- `point` : le point du captage (`t1_psv_x`/`t1_psv_y` de
  `captages_new.parquet`, référentiel DGS 2026) est dans l'AAC.
- `perimetre` : le PPR ou le PPI du captage (`t2_code_ppr`, `t2_code_ppi` de
  `captages_new.parquet`) a au moins 40 % de sa surface dans l'AAC
  (`PART_MIN_PP_DANS_AAC`, en tête du script). Les PPE ne servent pas
  (`TYPES_PP_DANS_AAC`) : grands, ils débordent sur les AAC voisines (voir
  ci-dessous). Les lignes d'un même `code_pp` des `*_hilbert.parquet` sont
  réunies avant le calcul.
- Un lien géographique n'est créé que si le captage est à 2,5 km au plus de
  l'AAC (choix du seuil : voir ci-dessous). Un captage sans point (coordonnées absentes du référentiel DGS) n'a
  de lien que par un périmètre dont 90 % au moins de la surface est dans
  l'AAC (`PART_MIN_PP_SANS_POINT`) : la distance ne peut pas être mesurée,
  mais le captage est forcément proche. Exemple : l'AAC 840
  (Villemaur-sur-Vanne), dont le PPR `010_R_0177`, entièrement dans l'AAC, est
  celui du captage `010000448`, sans point. `distance_m` est alors vide.
- `proximite` : dernier recours pour une AAC sans lien sûr que ni `point` ni
  `perimetre` ne rattachent. Si un seul captage a son point à 100 m au plus du
  bord de l'AAC (`DISTANCE_MAX_PROXIMITE_M`), il y est rattaché ; avec
  plusieurs captages à cette distance, l'AAC reste sans lien. Cas typique :
  une source dont le point tombe quelques mètres hors de l'AAC, dessinée en
  amont de l'émergence (lot d'AAC Rhin-Meuse du 26 mars 2020 surtout).
  L'état du captage n'est pas regardé, comme pour les autres sources : un
  captage abandonné ou suspendu peut être retenu (3 abandonnés et 1 suspendu
  sur 21 en novembre 2026).

**Alerte `captage_dans_autre_aac`.** Le seuil de distance ne sépare pas les
vrais liens des faux entre 1 et 2,5 km (voir « Choix du seuil de distance ») ;
le signe commun des liens faux est un captage situé dans une autre AAC, qui
porte souvent son nom. Sur tout lien, sûr ou géographique, l'alerte est posée
quand le point du captage est :

- à plus de 100 m de l'AAC du lien (`DISTANCE_MIN_AUTRE_AAC_M`). En deçà, le
  captage est au bord de son AAC et souvent aussi dans la voisine (AAC qui se
  touchent, sources en aval) : c'est la tolérance de `proximite`. Les liens
  `point` et `proximite` n'ont donc jamais l'alerte ;
- dans une autre AAC validée. Une AAC gelée a été remplacée : l'AAC 4962
  Blénod-lès-Pont-à-Mousson (5), gelée, chevauche les AAC (1) à (4) ;
- qui n'englobe pas l'AAC du lien : moins de la moitié de la surface de l'AAC
  du lien dans l'autre (`PART_MAX_AAC_DANS_AUTRE`). Une AAC dessinée dans une
  plus grande contient normalement des captages de celle-ci : l'AAC 5958
  Maraye Bouteuille, entièrement dans l'AAC 5957 Champcharme, a sa source
  dans Champcharme.

Le lien est gardé ; les autres AAC sont dans `autres_aac`. La règle est dans
`regles_aac.js` (`autresAacSql`), partagée avec le rapport d'anomalies.

Résultat en novembre 2026 : 28 liens. 14 liens sûrs (`export`), dont les
7 à plus de 2,5 km qui ont un point dans une autre AAC (1703 → 1891 « AAC de
Ligaine », 4421 → 4420 « AAC de Verneuil »…), et 7 que le seuil ne signale
pas : 297 → 225 Mareuil-le-Port 2 (2,2 km, deux forages), 1419 → 1424 Gastade
Ouest (1,8 km), 5122 → 5172 Vicherey (2) (1 km), 5589 → 31 et 37 La Ressègue
(940 m), 5147 → 5132 Vaux-en-Dieulet (2) (399 m), 82 Reims Couraux → 349
Reims Fléchambault (149 m). 82 et 5589 sont sans doute de vrais liens
(captage de Couraux au bord de l'AAC de Couraux ; AAC le faisan dont aucun des
5 captages n'est dans l'AAC). 14 liens `perimetre`, dont les forages de
Schweighouse (5129 Kingersheim → 5196 Schweighouse-Thann, 2,2 km), F17
Locquignol (5923 → 5936 Locquignol alluvions, 2,4 km) et Montmirail F4 et F6
(5712 Verdelot → 5669 Montmirail, 185 et 216 m).

Les seuils sont des constantes, faciles à faire varier :
`DISTANCE_MAX_AAC_KM`, `DISTANCE_MIN_AUTRE_AAC_M` et `PART_MAX_AAC_DANS_AUTRE`
dans `regles_aac.js` (partagées avec `generate_prioritaires.js`),
`PART_MIN_PP_DANS_AAC`, `TYPES_PP_DANS_AAC`,
`PART_MIN_PP_SANS_POINT` et `DISTANCE_MAX_PROXIMITE_M` en tête de
`generate_captages_aac.js`.

⚠️ L'ancien `aac_pp_zones.parquet`, dont `aac/fiches` lisait les listes de
codes PP, ne retenait pas les périmètres majoritairement dans l'AAC, comme le
disait le commentaire du script, mais tous ceux qui la touchaient : pour les
PPE de ses listes, 1 921 sur 2 940 ont plus de la moitié de leur surface dans
l'AAC, 268 moins de 1 %. Avec un seuil à 0, on retrouve ce comportement : 1 500
liens `perimetre` au lieu de 232.

**Choix du seuil et des types de périmètres (4 novembre 2026).** Pour juger
une règle, on l'applique aux 760 AAC qui ont des liens sûrs et on compte la
part des liens `perimetre` proposés (hors captages déjà rattachés par leur
point) qui figurent dans les tables. Ce n'est pas une vérité absolue : la
source `point` elle-même n'y fait que 30 % (1 144 liens sur 3 801), les tables
ne citant que le ou les captages pour lesquels l'AAC a été dessinée. Mais elle
permet de comparer les règles :

| Règle                                    | Liens (AAC à liens sûrs) | Dans les tables | Liens (AAC sans lien sûr) |
| ---------------------------------------- | ------------------------ | --------------- | ------------------------- |
| tout périmètre qui touche l'AAC (ancien) | 975                      | 51 (5 %)        | 1 507                     |
| PPE, PPR, PPI à 10 % au moins            | 428                      | 48 (11 %)       | 671                       |
| PPE, PPR, PPI à 50 % au moins            | 150                      | 43 (29 %)       | 239                       |
| part rapportée à min(PP, AAC), 50 %      | 233                      | 44 (19 %)       | 318                       |
| PPR, PPI à 0 % (touchent l'AAC)          | 471                      | 49 (10 %)       | 822                       |
| PPR, PPI à 30 % au moins                 | 140                      | 46 (33 %)       | 256                       |
| **PPR, PPI à 40 % au moins (retenue)**   | **108**                  | **45 (42 %)**   | **211**                   |
| PPR, PPI à 50 % au moins                 | 77                       | 40 (52 %)       | 177                       |

- Entre 0 et 50 %, 8 liens sur 825 sont dans les tables : les liens perdus par
  rapport à l'ancien comportement sont presque tous des débordements de PPE
  sur l'AAC voisine.
- Rapporter la part à la plus petite des deux surfaces (pour un PPE plus de
  deux fois plus grand que l'AAC, qui ne peut jamais atteindre 50 %) ajoute
  83 liens, dont 1 dans les tables.
- Les PPE à 50 % au moins ne donnent que 3 liens sur 73 dans les tables, les
  PPR et PPI 40 sur 77 : d'où l'exclusion des PPE.
- Seuil des PPR et PPI : chaque tranche de 10 points sous 50 % ajoute une
  trentaine de liens. Celle de 40 à 50 % en a encore 5 sur 31 dans les tables
  (16 %, la moitié de la source `point`), celle de 30 à 40 % 1 sur 32, et sous
  25 %, 3 sur 320 : d'où 40 %. L'échantillon de la tranche retenue est petit.
  Le seuil tombe aussi juste sous les PPR des AAC 4974 (41 %) et 5877 (43 %),
  que l'exclusion des PPE avait laissées sans captage : c'est le constat qui a
  fait chercher sous 50 %, pas ce qui a fixé la valeur.
- Effet par rapport aux règles précédentes (tous périmètres à 50 %) :
  51 liens retirés, 23 ajoutés (22 `perimetre` par un PPR ou PPI à 40-50 %,
  1 `proximite`, AAC 5123). Une seule AAC perd son captage : 5117
  (Noyers-Pont-Maugis, Rhin-Meuse), rattachée par un PPE à 69 %, son PPR
  n'étant dans l'AAC qu'à 0,2 % (captage à 300 m). Une AAC sans captage en
  gagne un : 5116 (Ranrupt/Urbeis, Rhin-Meuse), PPR à 43 %, captage à 319 m,
  mais deux autres PPR y sont à 31 %.

**Choix du seuil de distance (`DISTANCE_MAX_AAC_KM`, novembre 2026).** Le
premier seuil, 10 km, était arbitraire. 2,5 km est le plus petit seuil
au-delà duquel on ne trouve que des liens faux, mesuré sur la table produite
avec 10 km :

| Distance captage → AAC | Liens sûrs | Liens `perimetre` |
| ---------------------- | ---------- | ----------------- |
| dans l'AAC             | 1 146      | 3                 |
| 100 m au plus          | 40         | 105               |
| 100 m à 1 km           | 20         | 77                |
| 1 à 2 km               | 6          | 15                |
| 2 à 5 km               | 4          | 7                 |
| 5 à 10 km              | 3          | 0                 |
| plus de 10 km          | 6          | (écartés)         |

- Liens sûrs : les vrais liens hors de l'AAC vont jusqu'à 1,6 km (AAC 6048
  Mont Olivier, captage du même nom, PTP du Sandre ; Proville et Moeuvres
  vers 1,1 km). Les 13 liens à plus de 2 km sont tous faux : 7 ont leur
  captage dans une autre AAC qui porte son nom (1703 → forages de Ligaine à
  6 km, dans 1891 « AAC de Ligaine » ; 4421 → Verneuil puits 2, dans 4420
  « AAC de Verneuil » ; 1624 → La Foux Le Pradet, dans 1529 du même nom),
  2 viennent d'une AAC de Charente donnée à des captages de la Marne (AAC 1),
  2 d'une AAC gelée (4422), 1 d'un porteur dont l'AAC est à 40 km (1737 Caix
  → forage de Halloy-lès-Pernois), 1 d'une géométrie fausse (1397, à 48 km
  du captage du même nom).
- Liens `perimetre` : le champ captant de Hauconcourt (AAC 5186 La Maxe, PPI
  commun à 15 puits alignés le long de la Moselle) a des puits jusqu'à
  2,1 km de l'AAC ; un seuil de 2 km en couperait deux. Entre 2,1 et 10 km, il
  n'y a qu'un lien, faux : AAC 142 Bréviaires 1 → F Rambouillet P8, à 3 km,
  dans l'AAC 441 Rambouillet. Au-delà de 10 km, des périmètres dont le captage est
  ailleurs (jusqu'à 42 km).
- Entre 1 et 2,5 km, vrais et faux liens se mêlent et la distance ne les
  sépare pas : AAC 297 Mareuil-le-Port 1 → deux forages à 2,2 km, dans l'AAC
  225 Mareuil-le-Port 2 ; 1419 Les Piles → Gastade 1 Ouest à 1,8 km, dans
  1424 Gastade Ouest ; 5129 Kingersheim → forages de Schweighouse à 2,2 km
  (`perimetre`), dans 5196 Schweighouse-Thann. Le signe commun de ces erreurs
  est un captage dans une autre AAC, pas la distance : d'où l'alerte
  `captage_dans_autre_aac` (voir plus haut).
- Effet du passage de 10 à 2,5 km : 5 liens sûrs de plus portent l'alerte
  (11 au lieu de 6 ; 1459, 1624, 1703 deux fois, 4421), 1 lien `perimetre`
  est écarté (142 → `078000308`, l'AAC 142 garde ses 6 autres captages).

**Résultats observés (novembre 2026).**

| `source`    | Liens | AAC | Captages | `captage_eloigne_aac` | `captage_dans_autre_aac` |
| ----------- | ----- | --- | -------- | --------------------- | ------------------------ |
| `sandre`    | 274   | 201 | 273      | 1                     | 0                        |
| `export`    | 962   | 562 | 961      | 10                    | 14                       |
| `point`     | 4 060 | 810 | 3 759    |                       | 0                        |
| `perimetre` | 210   | 120 | 194      |                       | 14                       |
| `proximite` | 21    | 21  | 21       |                       | 0                        |

- 5 527 liens, 1 638 AAC sur 1 681 ; 43 AAC n'ont aucun captage (65 avant
  les liens sans point et `proximite`).
- Liens sûrs : 760 AAC. Sur les 274 liens `sandre`, 238 viennent du code BSS
  des PTP ; les autres viennent seulement des OPR de l'export.
- Les 1 148 couples (AAC, captage) que `captages_prioritaires.parquet` donne
  pour une AAC d'`AAC.gpkg` sont tous dans la table.
- Recroisement géographique : 921 AAC sans lien sûr ; 37 liens écartés à plus
  de 2,5 km, aucun faute de point. 4 liens `perimetre` vers un captage sans
  point sont gardés (PPR à 90 % au moins dans l'AAC), tous dans l'Aube ; un
  seul concerne une AAC qui n'avait aucun lien (840).
- `proximite` : 21 AAC rattachées, toutes à un captage à moins de 81 m.
  6 AAC ont plusieurs captages à moins de 100 m et restent sans lien.

**AAC sans captage.** Aucune des 43 n'a de PTP dans `AAC.gpkg` ni d'OPR dans
l'export : elles ne passent que par la géographie, qui échoue pour trois
raisons :

- DOM (8 AAC : les 5 de Mayotte et les 3 de Guadeloupe) : aucun captage de ces
  territoires n'a de point dans le référentiel DGS 2026.
- Plusieurs captages à moins de 100 m du bord (6 AAC) : le lien serait ambigu.
- Aucun captage à moins de 100 m (29 AAC, dont 27 en Rhin-Meuse) : le captage
  le plus proche est souvent un puits privé ou un captage abandonné ; le
  captage de l'AAC manque sans doute au référentiel ou n'y a pas de point.

## Comparaison champ par champ avec `captages.parquet`

⚠️ Comparaison établie avec le référentiel d'avril 2025 (57 720 captages), à
refaire avec celui de mai 2026.

Script : `compare_captages.mjs` (dédup identique à celle de
`generate_aac_fiches_parquet.js` des deux côtés, jointure sur `t1_code_ins`).

### Couverture

| | Valeur |
|---|---|
| `captages.parquet` dédupliqué | 50 823 |
| `captages_new.parquet` dédupliqué | 57 720 |
| Communs (`t1_code_ins`) | 50 529 |
| Présents seulement dans l'ancien | 294 |
| Présents seulement dans le nouveau | 7 191 (dont **777 actifs**) |

Les 294 captages présents seulement dans l'ancien fichier et les 777 captages
actifs présents seulement dans le nouveau restent à examiner individuellement
(pourquoi l'ancien fichier les a/n'a pas).

### Accord par champ (sur les 50 529 captages communs)

| Champ | Identiques | Différentes | Null seul. ancien | Null seul. nouveau |
|---|---|---|---|---|
| `t1_ins_nom` | 48 671 | 1 858 | 0 | 0 |
| `t1_com_nom` | 43 904 | 6 584 | 0 | 41 |
| `t1_com_insee` | 50 376 | 97 | 0 | 56 |
| `t1_ins_etat_lib` | 49 668 | 820 | 0 | 41 |
| `t1_dep_geo_lib` | 49 669 | 819 | 0 | 41 |
| `t1_cap_type_lib` | 28 444 | **17 410** | 0 | 4 675 |
| `t1_ins_nat_code` | 50 522 | 7 | 0 | 0 |
| `t1_ins_usage_lib` | 50 402 | 86 | 0 | 41 |
| `t1_ins_etat` | 49 668 | 820 | 0 | 41 |
| `t1_ins_cap_ref` | 6 043 | 6 556 | 0 | 37 930 |
| `t1_ins_cap_ref_lib` | 5 868 | 6 731 | 0 | 37 930 |
| `t1_ins_code_bss` | 45 244 | 814 | 0 | 4 471 |
| `t2_code_ppe` | 3 175 | 3 640 | 0 | 43 714 |
| `t2_code_ppr` | 24 077 | 4 061 | 0 | 22 391 |
| `t2_code_ppi` | 21 300 | 881 | 0 | 28 348 |

### Constats

- **Bon accord** (>99 %) sur `t1_ins_nat_code`, `t1_com_insee`,
  `t1_ins_usage_lib` : ces champs sont fiables tels quels.
- **`t1_cap_type_lib` diverge massivement** (34 % de désaccord) : confirme la
  limite déjà documentée. Exemples observés : `RESURGENCE`→`SOURCE`,
  `CAPTAGE SUR RETENUE`→`FORAGE`/`AFFLEUREMENT D'EAU SOUT`,
  `CHAMP CAPTANT COMPLEXE`→`PUITS`. La typologie ARS d'origine (`t1_cap_type_lib`)
  a des catégories plus fines/différentes que `nature_point_eau` (donnée
  BSS) — ce n'est pas un simple mapping direct, il faudrait une vraie table
  de correspondance construite à partir des cas observés, ou accepter la
  perte de granularité.
- **`t1_ins_etat_lib`/`t1_ins_etat`** divergent sur 820 captages (~1,6 %) —
  cohérent avec l'écart d'exhaustivité déjà identifié (l'ancien fichier est
  daté) : plusieurs cas observés sont `ABANDONNÉ` dans l'ancien mais `ACTIF`
  dans le nouveau (le CSV est plus à jour), mais aussi l'inverse dans
  quelques cas (`065001213` : `ACTIF`→`ABANDONNÉ`) — à ne pas tenir pour
  acquis que le nouveau a toujours raison, chaque écart mériterait un
  contrôle.
- **`t1_dep_geo_lib`** diverge sur 819 captages. Une partie semble être des
  erreurs plausibles du côté nouveau (ex. `974000161` : `REUNION` vs
  `LA REUNION`, un simple problème de libellé dans la table `DEPARTEMENTS` à
  corriger). Mais d'autres cas (`080000453` : `SEINE-MARITIME` vs `SOMME`,
  `088004258` : `HAUTE-MARNE` vs `VOSGES`) suggèrent que **`t1_dep_geo` (ARS)
  et `dept_gestionnaire` (CSV) ne mesurent pas forcément la même chose** :
  le premier serait le département géographique du point, le second le
  département de l'entité gestionnaire (ARS) — qui peut différer pour un
  captage proche d'une frontière départementale. À vérifier avant de faire
  confiance à ce mapping.
- **`t1_ins_code_bss`** : comparaison faite quand le champ reprenait
  `indice_bss_sise` brut. Il donne désormais l'ancien code complet
  (`06992X0035/P1`) : une comparaison texte avec l'ancien fichier, qui ne
  donne que l'indice et parfois le nouveau code, n'a plus de sens.
- **`t1_ins_cap_ref`/`t1_ins_cap_ref_lib`** divergent massivement (37 930
  `NULL` côté nouveau alors que l'ancien a une valeur) : l'approximation via
  `ref_mca` (cf. limites) ne couvre qu'une petite partie des regroupements
  que l'ARS fait réellement. Confirme que ce champ reste à retravailler.
- **`t2_code_ppe/ppr/ppi`** ont un taux de `NULL` côté nouveau bien plus élevé
  que côté ancien (ex. PPE : 43 714 `NULL` nouveau contre un accord de
  seulement 3 175) : la reconstruction par intersection spatiale est
  nettement moins couvrante que les codes d'origine ARS. À creuser : soit les
  géométries `*_hilbert.parquet` sont elles-mêmes incomplètes, soit la
  méthode d'intersection point-dans-polygone est trop stricte comparée à la
  méthode ARS d'origine (rayon de tolérance, association manuelle, etc.).

## Limites connues (à lever avant toute bascule)

1. **`t1_cap_type_lib`** reconstruit depuis `nature_point_eau` est une
   approximation de la typologie ARS d'origine (`t1_cap_type_lib` venait
   d'un code interne du type `001PUI`→`PUITS`) — **confirmé problématique**
   par la comparaison ci-dessus (34 % de désaccord). Nécessite une vraie
   table de correspondance ou l'acceptation d'une perte de granularité.
2. **`t1_ins_cap_ref`** repose sur une hypothèse non vérifiée (le plus petit
   code du groupe `ref_mca` comme "référence") — **confirmé insuffisant**
   par la comparaison (75 % de désaccord/valeurs manquantes). `ref_mca` ne
   couvre visiblement pas tous les regroupements faits côté ARS.
3. **`t2_code_ppe/ppr/ppi`** reconstruits par intersection spatiale sont
   **beaucoup moins couvrants** que les codes ARS d'origine — **causes
   identifiées**, cf. section "Investigation de la couverture PPE/PPR/PPI"
   ci-dessous. Deux causes indépendantes, ni l'une ni l'autre facilement
   contournable en l'état. **Levée en partie (novembre 2026)** pour les PPE
   et PPR par le lien direct `psv_code` (voir « Reconstruction de
   `t2_code_ppe/ppr/ppi` ») ; reste l'intersection pour les PPI. Les
   captages sans lien direct n'ont pas de PPE ni de PPR.
4. **`t1_dep_geo_lib`** : le mapping `dept_gestionnaire` → nom peut ne pas
   correspondre exactement au `t1_dep_geo` d'origine (possible différence
   géographique vs administratif) — à vérifier.

## Investigation de la couverture PPE/PPR/PPI

Script : `investigate_pp_coverage.mjs`. Objectif : comprendre pourquoi la
reconstruction par intersection spatiale (`t2_code_ppe/ppr/ppi`) couvre
tellement moins de captages que les codes fournis nativement par l'ARS dans
`captages.parquet`, en prenant justement ces codes ARS comme référence connue
et en vérifiant si/où la méthode les retrouve.

### Cause 1 — codes ARS absents des fichiers `*_hilbert.parquet`

Une partie des codes de périmètre que l'ARS assigne à ses captages
n'existent tout simplement pas dans les fichiers de zonage fournis :

| Périmètre | Codes ARS distincts référencés | Présents dans `*_hilbert.parquet` |
|---|---|---|
| PPE | 13 935 | 9 453 (**67,8 %**) |
| PPR | 25 066 | 19 875 (**79,3 %**) |
| PPI | 26 398 | 22 073 (**83,6 %**) |

→ Pour 16 à 32 % des captages selon le périmètre, la géométrie recherchée
n'existe simplement pas dans les fichiers fournis : aucune méthode
d'intersection spatiale ne peut les retrouver. Ces fichiers sont donc
eux-mêmes incomplets par rapport au référentiel de zonage utilisé par l'ARS.

### Cause 2 — même quand la zone existe, le point n'y tombe pas toujours (surtout pour PPE)

Pour les captages dont le code ARS existe bien dans le fichier hilbert
correspondant, on a vérifié si le point du captage (`t1_psv_x/y`, projeté en
WGS84) tombe géométriquement dans SA zone désignée :

| Périmètre | Dans la zone | Hors zone <100m | Hors zone 100m–1km | Hors zone 1–10km | Hors zone 10–100km | Hors zone >100km (donnée suspecte) |
|---|---|---|---|---|---|---|
| **PPE** | 3 340 (**25 %**) | 3 118 | **6 344** | 262 | 166 | 34 |
| PPR | 25 833 (94 %) | 1 153 | 193 | 137 | 117 | 27 |
| PPI | 21 979 (87 %) | 2 671 | 449 | 70 | 64 | 29 |

Constats :
- **PPR et PPI se comportent bien** (87-94 % de containment géométrique
  direct) : l'essentiel des écarts restants est à moins de 100 m, cohérent
  avec de simples effets de bord/précision de géométrie ou d'arrondi de
  coordonnées.
- **PPE se comporte très différemment** : seulement 25 % des points tombent
  dans leur zone, et l'essentiel des écarts se situe entre 100 m et 1 km (pas
  au hasard : 6 344 cas, largement la majorité des désaccords). Ce n'est pas
  un problème de données isolé mais un **écart systématique**. ~~Hypothèse
  initiale : PPE plus généralisé que les PPR/PPI.~~ **Explication vérifiée en
  novembre 2026** : le PPE est dessiné hors du PPR (anneau autour, ou zone
  voisine), pas par-dessus. Le captage, dans son PPR, est donc à l'extérieur
  de son PPE, à une distance de l'ordre de la taille du PPR (100 m à 1 km).
  Avec le lien `psv_code`, 25 % des captages sont dans leur PPE, mais 94 %
  dans leur PPE ou leur PPR (voir « Reconstruction de `t2_code_ppe/ppr/ppi` »).
- Dans les 3 fichiers, une poignée de cas (~30 par périmètre) sont à plus de
  100 km de leur zone désignée — clairement des coordonnées de captage
  corrompues dans `captages.parquet` lui-même (ex. `035000148` :
  `t1_psv_y = 67804011.610`, une valeur avec un chiffre en trop, donnant un
  point totalement hors de France), pas un défaut de la méthode.

### Conclusion

Le déficit de couverture n'est pas un simple problème de seuil de tolérance
à ajuster : c'est la combinaison de deux limites réelles des données
disponibles (zones manquantes dans les fichiers hilbert, et PPE dessiné
hors du PPR). Pour les PPE, il ne faut pas un buffer autour du point, mais
tester le PPE réuni au PPR du même captage. Le lien `psv_code` contourne
désormais les deux causes pour les PPE et PPR présents dans les fichiers ; il
ne comblera pas le manque de zones absentes des fichiers (cause 1), qui reste
la limite la plus dure.

## Prochaines étapes

1. ~~Comparer `captages_new.parquet` à `captages.parquet` champ par champ~~
   **Fait** — cf. section ci-dessus. Les résultats montrent que la
   reconstruction n'est pas encore assez fidèle pour remplacer le fichier de
   production tel quel, notamment sur `t1_cap_type_lib`, `t1_ins_cap_ref` et
   `t2_code_ppe/ppr/ppi`.
2. ~~Investiguer le déficit de couverture des périmètres PPE/PPR/PPI~~ **Fait**
   — cf. section "Investigation de la couverture PPE/PPR/PPI" ci-dessus. Deux
   causes distinctes identifiées (zones manquantes dans les fichiers hilbert ;
   PPE dessiné hors du PPR, et non généralisé comme supposé d'abord).
   **Fait (novembre 2026)** pour les PPE et PPR : le lien direct PP → PSV
   (`psv_code` des `pp*_hilbert.parquet`) remplace l'intersection. Il rattache
   13 305 captages à un PPE et 27 521 à un PPR. Reste à évaluer si
   une source de zonage plus complète existe (cause 1).
3. Construire une vraie table de correspondance pour `t1_cap_type_lib` à
   partir des désaccords observés, plutôt que le mapping direct actuel.
4. Étudier les 294 captages présents seulement dans l'ancien fichier et les
   777 captages actifs présents seulement dans le nouveau, pour comprendre
   ces écarts d'exhaustivité.
5. Une fois ces points levés, brancher la génération dans
   `generate_aac_fiches_parquet.js` (ou en amont, comme étape de préparation avant
   upload S3), en remplacement du téléchargement direct de la source privée.
