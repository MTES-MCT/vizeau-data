# Génération d'un `captages.parquet` candidat depuis le référentiel CSV

## Contexte

`captages.parquet` — utilisé par `../aac/fiches/generate_aac_fiches_parquet.js`
pour construire la liste des installations de captage de chaque fiche AAC —
est aujourd'hui téléchargé tel quel depuis S3, sans processus de génération
documenté dans ce dépôt : c'est un export brut d'une source privée
(probablement SISE-Eaux/ARS fourni par un partenaire).

Objectif à terme : remplacer cette source privée non documentée par un
`captages.parquet` regénéré à partir du référentiel CSV national
`ref_cap_avr25` (public, plus exhaustif — 57 720 captages contre 50 823
distincts dans le fichier actuel), **sans casser le pipeline existant**. La
bascule se fait par étapes : ce document couvre la première étape, la
génération d'un fichier candidat à comparer avant toute mise en production.

Le script correspondant est `generate_captages_parquet.js`. Le détail
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
bucket, `data/s3/captages.parquet` (cf. plus bas).

## Installation

```bash
cd captages_parquet_generator
npm install
```

## Fichiers nécessaires en entrée

Tous locaux, dans `data/captages/`, aucun accès réseau/S3 requis pour ce script :

| Fichier                                                              | Rôle                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ref_captages_25avril2025/ref_cap_avr25-Tableau 1.csv`                | Référentiel national des captages (SISE-Eaux, avril 2025). Source principale : une ligne par captage. |
| `ref_captages_25avril2025/ref_mca_avr25-Tableau 1.csv`                | Référentiel des "mélanges de captages" (regroupements). Sert à reconstruire `t1_ins_cap_ref`.          |
| `ppe_hilbert.parquet`                                                 | Géométries des périmètres de protection éloignée (PPE), avec leur `code_pp`.                          |
| `ppr_hilbert.parquet`                                                 | Géométries des périmètres de protection rapprochée (PPR), avec leur `code_pp`.                        |
| `ppi_hilbert.parquet`                                                 | Géométries des périmètres de protection immédiate (PPI), avec leur `code_pp`.                          |

Les 3 fichiers `*_hilbert.parquet` sont utilisés pour reconstruire, par
intersection spatiale avec le point de chaque captage, les codes de périmètre
(`t2_code_ppe`/`t2_code_ppr`/`t2_code_ppi`) qu'aucun des deux CSV ne fournit
directement.

La table de correspondance code département → nom (`t1_dep_geo_lib`, absente
du CSV) est codée en dur dans le script (`DEPARTEMENTS`), pas besoin de
fichier externe.

## Usage

```bash
node generate_captages_parquet.js
```

Aucune variable d'environnement requise (contrairement à
`generate_aac_fiches_parquet.js`, qui a besoin des identifiants S3).

## Artefact produit

**`data/captages/captages_new.parquet`** — fichier candidat (non versionné).
Pour comparer avec l'ancien `captages.parquet` (scripts `compare_captages.mjs`
et `investigate_pp_coverage.mjs`), utiliser sa copie locale
`data/s3/captages.parquet`, téléchargée depuis S3 par `aac/fiches`.

### À quoi il sert

Ce n'est **pas encore** branché sur `generate_aac_fiches_parquet.js`. C'est une étape
intermédiaire, destinée à :
1. Vérifier que le schéma produit est compatible avec les requêtes du
   pipeline (validé : la requête de rattachement captage→AAC de
   `generate_aac_fiches_parquet.js` tourne sans erreur dessus, cf. tests manuels).
2. Comparer son contenu avec `captages.parquet` (nombre de lignes, écarts de
   valeurs) avant toute décision de bascule.

### Ce qu'il contient

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
| `t1_ins_cap_ref`      | Reconstruit depuis `ref_mca` (voir ci-dessous), `NULL` si le captage n'est dans aucun mélange |
| `t1_ins_cap_ref_lib`  | Idem, nom de l'installation de référence du groupe                                            |
| `t1_ins_code_bss`     | `indice_bss_sise` (CSV)                                                                        |
| `t2_code_ppe`         | Reconstruit par intersection spatiale avec `ppe_hilbert.parquet`                              |
| `t2_code_ppr`         | Reconstruit par intersection spatiale avec `ppr_hilbert.parquet`                               |
| `t2_code_ppi`         | Reconstruit par intersection spatiale avec `ppi_hilbert.parquet`                               |
| `t1_psv_x`            | `x_l93_installation` (CSV), converti en `DOUBLE`                                              |
| `t1_psv_y`            | `y_l93_installation` (CSV), converti en `DOUBLE`                                              |

**Reconstruction de `t1_ins_cap_ref`** : `ref_mca` regroupe des captages
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

### Résultats observés (dernière exécution)

- 57 720 lignes / 57 720 `t1_code_ins` distincts (aucun doublon).
- 13 020 captages rattachés à un groupe via `ref_mca`.
- 7 252 captages rattachés à un PPE, 28 395 à un PPR, 22 216 à un PPI.

À comparer avec `data/s3/captages.parquet` : 53 775 lignes / 50 823
`t1_code_ins` distincts.

## Comparaison champ par champ avec `captages.parquet`

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
