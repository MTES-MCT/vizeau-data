---
name: update-aac
description: Met à jour les AAC depuis le Sandre — télécharge le dernier AAC.gpkg, le compare à la version en place, puis régénère géométries, captages prioritaires, liens captages-AAC, fiches et zonage, et donne les statistiques du diff. À utiliser quand de nouvelles AAC sont publiées ou qu'on demande de rafraîchir AAC.gpkg. N'envoie jamais rien sur S3.
---

# update-aac

Procédure complète de mise à jour des Aires d'Alimentation de Captage, de `data/aac/AAC.gpkg` jusqu'au PMTiles de zonage. Les commandes partent de la racine du dépôt (`vizeau-data/`). `SCRATCH` désigne le dossier scratchpad de la session.

## Règles

- **Jamais d'upload** : ne pas lancer `npm run upload`, ni `aws s3`, `rclone` ou autre écriture sur S3, ni poser `S3_OVERWRITE`. Donner la commande d'upload à l'utilisateur à la fin, sans la lancer.
- Pas de commit (règle globale) : tout reste dans le working tree, de toute façon non versionné (`data/`, `output/`).
- Sauvegarder avant d'écraser : l'ancien `AAC.gpkg` reste dans `data/aac/`, les anciens fichiers produits vont dans `$SCRATCH/backup/`.

## 1. Télécharger le nouveau fichier

Le WFS renvoie un **zip** (malgré `OUTPUTFORMAT=GPKG`) contenant un fichier nommé `%TYPENAME%.gpkg`. Le télécharger dans un dossier neuf (donnée non fiable) :

```bash
D=$SCRATCH/aac_dl_$(date +%Y%m%d-%H%M%S); mkdir -p $D/x
curl -sS -L -o $D/AAC.zip -w "%{http_code} %{content_type} %{size_download}\n" \
  "https://sandre.eaufrance.fr/aac/mapserver/aac?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=sa:AAC_FRA&OUTPUTFORMAT=GPKG"
unzip -l $D/AAC.zip && unzip -q $D/AAC.zip -d $D/x
cp "$D/x/%TYPENAME%.gpkg" $D/AAC_new.gpkg && file $D/AAC_new.gpkg   # attendu : OGC GeoPackage
```

Si la réponse n'est pas un zip contenant un GeoPackage (HTML d'erreur, fichier vide…), s'arrêter et le signaler. Si le serveur renvoie directement un `.gpkg` (pas de zip), l'utiliser tel quel.

## 2. Comparer avec la version en place

```bash
node .claude/skills/update-aac/scripts/diff_aac.mjs data/aac/AAC.gpkg $D/AAC_new.gpkg | tee $D/diff.txt
```

Le script affiche : schéma, totaux (AAC, AAC avec PTP, géométries invalides, dernière mise à jour), AAC ajoutées/supprimées, AAC modifiées par type (géométrie réelle, simples arrondis de coordonnées, PTP, nom, statut, date de MAJ), par bassin, changements de statut, détail par AAC avec surfaces avant/après. La dernière ligne est `CHANGEMENTS=<n>`.

Il ajoute quatre contrôles sur la **stabilité des codes**, car Vizeau utilise `CdAAC` comme identifiant :

| Section | Ce qu'elle repère |
|---|---|
| Codes dont l'aire désignée change | nom changé et surface ×2 ou plus sous le même code |
| Aires qui changent de code | une géométrie de l'ancienne version se retrouve, à l'identique, sous un autre code |
| Quasi-doublons (IoU ≥ 0,99) apparus / disparus | deux codes pour la même aire, qui apparaissent ou disparaissent (les doublons stables, souvent légitimes, ne sont que comptés) |
| PTP cités par plusieurs codes | un même point de prélèvement rattaché à des codes différents, avant / après |

- Code de sortie 2 (couche `AAC_FRA` ou champ `CdAAC` absent) : s'arrêter, le schéma a changé.
- `CHANGEMENTS=0` : rien à régénérer. Le dire et s'arrêter sans toucher à `data/aac/AAC.gpkg`.
- Schéma modifié, géométries invalides, AAC supprimées : les signaler, mais continuer (ce sont des faits de la source à remonter, pas des erreurs).

### Quand un code change d'aire

Un code dont l'aire change **ne prouve pas une réattribution** : ce peut être la correction d'une erreur de la version précédente. Ne pas conclure sur le seul critère nom + surface. Trancher avec les versions déjà disponibles en local, sans chercher plus loin :

- **Aires qui changent de code** : l'ancienne aire retrouvée sous un autre code, avec un doublon qui disparaît (1694 ≈ 5490 par exemple), indique que l'ancien contenu du code était une copie d'une autre AAC, désormais corrigée.
- **Export des captages prioritaires** (`data/captages/20260901-export_source_list_ouvragespourVizeau.csv`, colonnes `code_aac`, `nom_sandre`, `code_ptp_sandre`) : quel ouvrage le ministère associe à ce code.
- **PTP** du code avant et après, comparés à ceux de l'export.
- Les autres versions locales : `data/aac/AAC-*.gpkg`, `aac_hilbert.parquet` sur S3 ou dans `data/s3/`.

Cas de référence (novembre 2026) : 1694 et 5464 étaient, depuis la mise à jour du 9 juillet 2026, des copies de 5490 (La Couyère) et 5455 (Le Bernadais). La version de novembre leur a rendu leur aire d'origine, La Roche et Le Lié, celles de 2025 et de l'export. C'était une correction, pas une réattribution, et c'était la version publiée qui était fausse.

Dans le rapport, dire dans quel sens va l'erreur, et quelle version publiée (S3, appli) est concernée : les données Vizeau rattachées au code pendant la période erronée sont à vérifier avant publication.

## 3. Sauvegarder et installer

```bash
R=$(pwd); B=$SCRATCH/backup_$(date +%Y%m%d-%H%M%S); mkdir -p $B
cp -p data/captages/captages_aac.parquet data/captages/captages_prioritaires.parquet \
      data/captages/anomalies_prioritaires.csv aac/fiches/output/aac.parquet \
      aac/zonage/output/zonage.pmtiles data/s3/aac_hilbert.parquet $B/
cp -rp data/aac/cache $B/cache_rpg
OLD_DATE=$(stat -f %Sm -t %Y-%m-%d data/aac/AAC.gpkg)          # macOS
mv data/aac/AAC.gpkg data/aac/AAC-$OLD_DATE.gpkg                # si le nom existe déjà, ajouter un suffixe
cp $D/AAC_new.gpkg data/aac/AAC.gpkg
```

## 4. Régénérer, dans cet ordre

Chaque étape lit la sortie de la précédente : ne pas paralléliser.

1. **Géométries** — `cd aac && npm run geometries` → `aac_hilbert.parquet` (vérifier le nombre de features = nombre d'AAC du diff).
2. **Captages prioritaires** — `cd captages_parquet_generator && npm run prioritaires` (lit le champ `PTP` d'`AAC.gpkg`). `npm start` n'est pas nécessaire : il ne dépend pas d'`AAC.gpkg`.
3. **Liens captages → AAC** — `cd captages_parquet_generator && npm run aac` → `data/captages/captages_aac.parquet`.
4. **Fiches** — `cd aac && RPG_REFRESH=1 npm run fiches > ../data/aac/fiches_$(date +%d%b | tr A-Z a-z).log 2>&1`, **en arrière-plan** (environ 10 min).
   `RPG_REFRESH=1` est indispensable : le cache `data/aac/cache/rpg_evolution_YYYY.parquet` est agrégé par AAC sur les géométries du moment et n'est jamais invalidé quand elles changent ; sans lui, `cultures_evolution` serait faux pour les AAC nouvelles ou redessinées. Vérifier dans le log que la phase 4 affiche « agrégat calculé » pour chaque année, et non « agrégats en cache ».
5. **Zonage** — `cd aac && npm run zonage > ../data/aac/zonage_<date>.log 2>&1` (prérequis : `ogr2ogr`, `tippecanoe`). Vérifier que la couche `aac` du PMTiles a le nombre d'AAC attendu. `sage_shape.zip` n'est pas mis à jour par ce skill.

Si une étape échoue, s'arrêter, montrer la fin du log et ne pas lancer les suivantes.

## 5. Valider les fiches

Deux comparaisons, car la version publiée sur S3 peut être bien plus ancienne que la dernière génération locale :

```bash
cd aac
npm run valider > $B/valider_vs_s3.log 2>&1; cp fiches/output/validation_aac.csv $B/validation_vs_s3.csv
node --env-file=.env fiches/valider_aac_fiches.js fiches/output/aac.parquet $B/aac.parquet > $B/valider_vs_local.log 2>&1
cp fiches/output/validation_aac.csv $B/validation_vs_local.csv
cp $B/validation_vs_s3.csv fiches/output/validation_aac.csv   # le CSV de référence reste celui contre S3
```

- **Contre S3** : l'échec du contrôle « mêmes AAC qu'avant » est attendu s'il ne liste que les AAC ajoutées/supprimées du diff. Tout autre contrôle bloquant en échec est à signaler en premier.
- **Contre la génération locale précédente** : isole l'effet du nouveau `AAC.gpkg`. En extraire les totaux, « N AAC en baisse, N en hausse, N inchangées », les listes « Perdent / Gagnent » et le tableau des plus fortes hausses/baisses.

## 6. Rapport (texte, dans la réponse)

Répondre en français, avec des tableaux Markdown, dans cet ordre :

1. **Diff AAC.gpkg** (statistiques de `diff.txt`) :
   - nombre d'AAC avant → après, AAC avec PTP avant → après, dates de dernière MAJ ;
   - AAC ajoutées et supprimées (code, nom, bassin, date de création) ;
   - AAC modifiées : total, puis par type (géométrie réelle / arrondis seuls / PTP / nom / statut / date seule) et par bassin ;
   - changements de statut (ex. Validé → Gelé : n) ;
   - géométries réellement modifiées avec surface avant → après ;
   - stabilité des codes : codes dont l'aire change, aires qui changent de code, quasi-doublons apparus ou disparus, PTP partagés qui changent, avec le diagnostic (correction ou réattribution) et ses preuves ;
   - ⚠ géométries invalides, schéma modifié, s'il y en a.
2. **Effet sur les fiches** (contre la génération locale précédente) : totaux avant → après (installations, prioritaires, AAC sans installation, captages actifs), AAC en hausse/baisse, AAC qui gagnent ou perdent toutes leurs installations ou le flag prioritaire.
3. **Validation contre S3** : contrôles bloquants (attendus ou non) ; si les écarts sont massifs, préciser s'ils viennent de l'ancienneté de la version publiée plutôt que du nouveau fichier.
4. **Fichiers produits** : `aac_hilbert.parquet`, `captages_prioritaires.parquet`, `captages_aac.parquet`, `aac.parquet`, `zonage.pmtiles` (nombre d'entités par couche), logs, emplacement de l'ancien `AAC.gpkg` et du dossier de sauvegarde (chemin absolu complet).
5. **À faire par l'utilisateur** : la commande d'upload à lancer lui-même après relecture, sans l'exécuter :
   ```bash
   cd aac && npm run upload -- geometries zonage fiches
   ```
