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
prioritaires aux captages du référentiel et liste les lignes de l'export à
corriger. Le détail
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
`generate_aac_fiches_parquet.js` lit `captages_prioritaires.parquet`, produit
ici, pour poser le flag `prioritaire` des installations, et les codes BSS de
`captages_new.parquet`.

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
| `ppe_hilbert.parquet`                                                 | Géométries des périmètres de protection éloignée (PPE), avec leur `code_pp`.                          |
| `ppr_hilbert.parquet`                                                 | Géométries des périmètres de protection rapprochée (PPR), avec leur `code_pp`.                        |
| `ppi_hilbert.parquet`                                                 | Géométries des périmètres de protection immédiate (PPI), avec leur `code_pp`.                          |
| `20260901-export_source_list_ouvragespourVizeau.csv`                  | Export des captages prioritaires : une ligne par ouvrage de prélèvement (OPR), avec ses codes INS, PSV, BSS et son AAC. Lu par `generate_prioritaires.js`. |
| `data/aac/AAC.gpkg` (couche `AAC_FRA`)                                | Géométries des AAC, partagées avec `aac/`. Lu par `generate_prioritaires.js` pour vérifier les codes AAC de l'export et mesurer la distance captage → AAC. |

Les 3 fichiers `*_hilbert.parquet` sont utilisés pour reconstruire, par
intersection spatiale avec le point de chaque captage, les codes de périmètre
(`t2_code_ppe`/`t2_code_ppr`/`t2_code_ppi`) qu'aucun des CSV ne fournit
directement.

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

La table de correspondance code département → nom (`t1_dep_geo_lib`, absente
du CSV) est codée en dur dans le script (`DEPARTEMENTS`), pas besoin de
fichier externe.

## Usage

```bash
npm start              # generate_captages_parquet.js
npm run prioritaires   # generate_prioritaires.js, à lancer après
```

`generate_prioritaires.js` lit `captages_identifiants.parquet` et
`captages_new.parquet` : il faut relancer `npm start` avant lui quand les
référentiels changent.

Aucune variable d'environnement requise (contrairement à
`generate_aac_fiches_parquet.js`, qui a besoin des identifiants S3).

## Artefacts produits

```
generate_captages_parquet.js
DGS_ref_cap_06_05_2026/cap.csv ──┬──────────────────────────────────► captages_new.parquet ──► aac/fiches
DGS_ref_cap_06_05_2026/mca.csv ──┤  (t1_ins_cap_ref)                         ▲               (codes BSS)
pp*_hilbert.parquet ─────────────┼──(intersection spatiale) ─────────────────┤
                                 │                                           │ (codes BSS)
DGS_ref_cap_23_02_2024/cap.csv ──┴──(normalisation des codes) ──► captages_identifiants.parquet

generate_prioritaires.js
export OPR (CSV) ─────────┐
captages_identifiants ────┼──(résolution INS > PSV > BSS) ──► captages_prioritaires.parquet ──► aac/fiches
                          │                                        │                              (flag prioritaire)
captages_new (points) ────┤                                        ▼
data/aac/AAC.gpkg ────────┴──(codes AAC, distance) ───────► anomalies_prioritaires.csv
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
installations. C'est une étape intermédiaire, destinée à :
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
| `t2_code_ppe`         | Reconstruit par intersection spatiale avec `ppe_hilbert.parquet`                              |
| `t2_code_ppr`         | Reconstruit par intersection spatiale avec `ppr_hilbert.parquet`                               |
| `t2_code_ppi`         | Reconstruit par intersection spatiale avec `ppi_hilbert.parquet`                               |
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
captage → périmètre. On le reconstruit en projetant le point du captage
(`x_l93_installation`/`y_l93_installation`) en WGS84 et en cherchant la zone
`ppe`/`ppr`/`ppi` qui le contient (`ST_Intersects`). En cas de chevauchement
de zones (rare), un seul code est retenu par captage (le plus petit,
arbitrairement).

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

Produit par `generate_prioritaires.js`. Une ligne par couple (OPR de l'export
des captages prioritaires, captage du référentiel). Seuls les OPR rattachés à
au moins un captage y figurent.

| Colonne             | Contenu                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `code_opr`          | Code de l'ouvrage de prélèvement                                                                |
| `statut_opr`        | `seul`, `porteur` ou `rattaché`                                                                 |
| `opr_rattach`       | Pour un rattaché, code OPR de son porteur                                                       |
| `code_aac`          | AAC de l'OPR, ou celle de son porteur pour un rattaché (tel quel, même absent d'`AAC.gpkg`)     |
| `code_aac_source`   | `export` (porté par la ligne de l'OPR) ou `porteur` (hérité)                                    |
| `code_installation` | Code INS du captage (`t1_code_ins`)                                                             |
| `resolu_par`        | Types de code de l'OPR qui ont mené à ce captage (`INS`, `PSV`, `BSS_INDICE`, `BSS_ID`)         |

**Règle de résolution.**
- `code_ins`, `code_psv` et `code_bss` sont des listes séparées par `|`, de
  longueurs parfois différentes : elles sont traitées comme des ensembles de
  codes, normalisés puis cherchés dans `captages_identifiants.parquet`.
- Un OPR est rattaché aux captages trouvés par le type de code le plus sûr qui
  en trouve au moins un : INS, sinon PSV, sinon BSS (ancien ou nouveau). Un
  code moins sûr qui désigne un autre captage n'ajoute pas de lien, il est
  signalé dans le rapport d'anomalies.
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
- Un OPR rattaché hérite de l'AAC de son porteur (`opr_rattach`), seuls les
  OPR seuls ou porteurs ayant un `code_aac` dans l'export (hypothèse de la
  question 3 de `plan-captages.md`).

`aac/fiches` lit ce fichier pour poser le flag `prioritaire` : une
installation est prioritaire si l'un de ses captages (référence ou rattaché)
y figure. La comparaison se faisait auparavant sur le texte des codes BSS, qui
mélangent ancien et nouveau format selon les sources.

**Résultats observés (dernière exécution).** 1 494 liens : 1 333 OPR sur
1 539 rattachés à 1 464 captages (1 210 OPR par leurs codes INS, 123 par leurs
seuls codes BSS ; aucun par les seuls codes PSV). Dans `aac.parquet`
régénéré le 20 octobre 2026 (toujours avec l'ancien `captages.parquet`),
1 401 installations sur 7 378 sont flaguées prioritaires, dans 898 AAC,
contre 89 installations et 66 AAC avec l'ancienne comparaison des codes BSS.

### `anomalies_prioritaires.csv`

Produit par `generate_prioritaires.js`. Lignes de l'export des captages
prioritaires non résolues ou incohérentes, à renvoyer au producteur de
l'export. Une ligne par anomalie, avec les colonnes `anomalie`, `code_opr`,
`statut_opr`, `opr_rattach`, `nom_sandre`, `code_aac` (hérité du porteur le
cas échéant), `code_installation`, `distance_m` et `detail`.

| `anomalie`            | Signification                                                                                                  | Lignes |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| `aac_inconnue`        | `code_aac` absent d'`AAC.gpkg` (code d'une autre nomenclature, code BSS ou OPR saisi à la place). Signalé sur l'OPR qui le porte, pas sur ses rattachés | 22 |
| `porteur_absent`      | OPR rattaché dont le porteur n'est pas dans l'export                                                           | 1      |
| `opr_sans_captage`    | Aucun code de l'OPR ne mène à un captage du référentiel : code PTP seul, coordonnées seules, ou codes INS/PSV/BSS inconnus. `detail` liste les codes présents | 206 |
| `captage_eloigne_aac` | Captage à plus de 10 km (`DISTANCE_MAX_AAC_M`) de l'AAC de son OPR, mesuré depuis son point dans `captages_new.parquet` | 8 |
| `code_autre_captage`  | Code PSV ou BSS de l'OPR qui désigne un captage autre que ceux retenus pour l'OPR                              | 21     |
| `code_ambigu`         | Code PSV ou BSS retenu pour l'OPR qui désigne plusieurs captages, même après la préférence BRGM, tous rattachés | 0      |

Les 21 codes AAC inconnus comprennent des codes numériques absents de la
couche SANDRE (`55005`, `417`…) et des valeurs qui ne sont pas des codes AAC
(`FRH_AAC ONS EN BRAY 1`, `00883X0044`, `OPR0000082770`).

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
   contournable en l'état.
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
  un problème de données isolé mais un **écart systématique**, cohérent avec
  le fait que le périmètre éloigné (PPE) est, réglementairement, le moins
  strictement délimité des trois (souvent une zone plus approximative/
  généralisée que les PPR/PPI, parfois même juste une distance forfaitaire
  plutôt qu'un polygone précis) : la géométrie fournie dans
  `ppe_hilbert.parquet` ne colle probablement pas aussi finement au point
  réel de l'installation que pour PPR/PPI.
- Dans les 3 fichiers, une poignée de cas (~30 par périmètre) sont à plus de
  100 km de leur zone désignée — clairement des coordonnées de captage
  corrompues dans `captages.parquet` lui-même (ex. `035000148` :
  `t1_psv_y = 67804011.610`, une valeur avec un chiffre en trop, donnant un
  point totalement hors de France), pas un défaut de la méthode.

### Conclusion

Le déficit de couverture n'est pas un simple problème de seuil de tolérance
à ajuster : c'est la combinaison de deux limites réelles des données
disponibles (zones manquantes dans les fichiers hilbert, et généralisation
géométrique du PPE en particulier). Un buffer de quelques centaines de
mètres autour du point avant intersection récupérerait sans doute une bonne
partie des cas PPE à 100m-1km (à tester), mais ne comblera pas le manque de
zones absentes des fichiers (cause 1), qui reste la limite la plus dure.

## Prochaines étapes

1. ~~Comparer `captages_new.parquet` à `captages.parquet` champ par champ~~
   **Fait** — cf. section ci-dessus. Les résultats montrent que la
   reconstruction n'est pas encore assez fidèle pour remplacer le fichier de
   production tel quel, notamment sur `t1_cap_type_lib`, `t1_ins_cap_ref` et
   `t2_code_ppe/ppr/ppi`.
2. ~~Investiguer le déficit de couverture des périmètres PPE/PPR/PPI~~ **Fait**
   — cf. section "Investigation de la couverture PPE/PPR/PPI" ci-dessus. Deux
   causes distinctes identifiées (zones manquantes dans les fichiers hilbert ;
   généralisation géométrique du PPE). Prochaine sous-étape possible : tester
   un buffer de tolérance de quelques centaines de mètres autour du point
   pour le cas PPE, et évaluer si une source de zonage plus complète existe.
3. Construire une vraie table de correspondance pour `t1_cap_type_lib` à
   partir des désaccords observés, plutôt que le mapping direct actuel.
4. Étudier les 294 captages présents seulement dans l'ancien fichier et les
   777 captages actifs présents seulement dans le nouveau, pour comprendre
   ces écarts d'exhaustivité.
5. Une fois ces points levés, brancher la génération dans
   `generate_aac_fiches_parquet.js` (ou en amont, comme étape de préparation avant
   upload S3), en remplacement du téléchargement direct de la source privée.
