// ─── Règles de rattachement captage → AAC partagées ───────────────────────────
//
// Utilisées par generate_prioritaires.js (choix de l'AAC de chaque ouvrage de
// l'export, rapport d'anomalies) et generate_captages_aac.js (table des liens
// captage → AAC), pour que les deux scripts suivent les mêmes règles.

// Distance maximale entre le point d'un captage et la géométrie d'une AAC, en
// kilomètres (question 4 de plan-captages.md). Au-delà :
//   - un lien géographique (point ou périmètre de protection dans l'AAC) n'est
//     pas créé ;
//   - un lien donné par une table (référentiel AAC du Sandre, export des
//     captages prioritaires) est gardé, mais signalé (`captage_eloigne_aac`).
// Modifier cette valeur, puis relancer `npm run prioritaires` et `npm run aac`.
//
// 2,5 km : le plus petit seuil au-delà duquel on ne trouve que des liens faux
// (mesuré en novembre 2026 ; détail dans le README, « Choix du seuil de
// distance ») :
//   - liens sûrs : les vrais liens hors de l'AAC vont jusqu'à 1,6 km (AAC 6048
//     Mont Olivier). Les 13 liens à plus de 2 km sont tous faux, le plus
//     souvent un captage situé dans une autre AAC qui porte son nom ;
//   - liens `perimetre` : les puits du champ captant de Hauconcourt (AAC 5186
//     La Maxe) vont jusqu'à 2,1 km de l'AAC. Entre 2,1 et 10 km, un seul lien,
//     faux (AAC 142 → F Rambouillet P8, à 3 km).
// Entre 1 et 2,5 km, vrais et faux liens se mêlent : la distance seule ne les
// sépare pas.
export const DISTANCE_MAX_AAC_KM = 2.5
export const DISTANCE_MAX_AAC_M = DISTANCE_MAX_AAC_KM * 1000

// Captage dans une autre AAC (alerte `captage_dans_autre_aac`, sur tout lien de
// captages_aac.parquet et dans le rapport d'anomalies). C'est le signe commun
// des liens faux que le seuil de distance ne sépare pas des vrais : AAC 297
// Mareuil-le-Port 1 → forages à 2,2 km, dans l'AAC 225 Mareuil-le-Port 2 ;
// 1703 → forages de Ligaine, dans 1891 « AAC de Ligaine ». Le lien est gardé.
// L'alerte est posée quand le point du captage est :
//   - à plus de DISTANCE_MIN_AUTRE_AAC_M de l'AAC du lien. En deçà, le captage
//     est au bord de son AAC, et souvent aussi dans l'AAC voisine (AAC qui se
//     touchent, sources quelques mètres en aval) : même tolérance que la
//     source `proximite` de generate_captages_aac.js ;
//   - dans une autre AAC, validée : une AAC gelée a été remplacée (AAC 4962
//     Blénod-lès-Pont-à-Mousson (5), gelée, qui chevauche les AAC (1) à (4)) ;
//   - et que cette autre AAC n'englobe pas l'AAC du lien : moins de
//     PART_MAX_AAC_DANS_AUTRE de la surface de l'AAC du lien dans l'autre. Une
//     AAC dessinée dans une plus grande contient normalement des captages de
//     celle-ci (AAC 5958 Maraye Bouteuille, entièrement dans l'AAC 5957
//     Champcharme, où est sa source).
export const DISTANCE_MIN_AUTRE_AAC_M = 100
export const PART_MAX_AAC_DANS_AUTRE = 0.5

// Crée la table `table` : une ligne par couple (AAC, captage) de la requête
// `couples` (colonnes cdaac, code_installation, point_l93) dont le captage est
// dans une autre AAC, au sens ci-dessus. Colonnes : cdaac, code_installation,
// distance_m (du captage à l'AAC du couple), autres_aac (liste des codes),
// autres_aac_libelle (« 1891 AAC de Ligaine, ... »). À appeler après
// aacSandreSql.
export const autresAacSql = (table, couples) => `
  CREATE TABLE ${table} AS
  WITH hors_aac AS (
    SELECT l.cdaac, l.code_installation, l.point_l93, a.geom_l93,
           CAST(round(ST_Distance(l.point_l93, a.geom_l93)) AS INTEGER) AS distance_m
    FROM (${couples}) l
    JOIN aac_sandre a USING (cdaac)
    WHERE NOT ST_DWithin(l.point_l93, a.geom_l93, ${DISTANCE_MIN_AUTRE_AAC_M})
    QUALIFY row_number() OVER (PARTITION BY l.cdaac, l.code_installation) = 1
  )
  SELECT h.cdaac, h.code_installation, h.distance_m,
         list(a.cdaac ORDER BY TRY_CAST(a.cdaac AS INTEGER), a.cdaac) AS autres_aac,
         string_agg(a.cdaac || ' ' || a.nom, ', ' ORDER BY TRY_CAST(a.cdaac AS INTEGER), a.cdaac) AS autres_aac_libelle
  FROM hors_aac h
  JOIN aac_sandre a ON a.cdaac <> h.cdaac AND a.statut <> 'Gelé'
                   AND ST_Intersects(h.point_l93, a.geom_l93)
  WHERE ST_Area(ST_Intersection(h.geom_l93, a.geom_l93)) < ${PART_MAX_AAC_DANS_AUTRE} * ST_Area(h.geom_l93)
  GROUP BY h.cdaac, h.code_installation, h.distance_m
`

// Crée deux tables à partir de la couche AAC_FRA d'AAC.gpkg :
//   aac_sandre  une ligne par AAC : cdaac, nom administratif, statut (`Validé`
//               ou `Gelé`), date de mise à jour, géométrie en Lambert 93
//               (validée)
//   aac_ptp     une ligne par couple (AAC, point de prélèvement) du champ `PTP`
//               (liste JSON de {CdPointPrelevement, NomPointPrelevement})
//
// Un même PTP peut être cité par une AAC gelée et par l'AAC validée qui l'a
// remplacée (6 PTP en novembre 2026, par exemple 5007 `AAC_ROUFFACH_1`, gelée,
// et 5991) : l'AAC gelée perd alors ce PTP. Une AAC gelée ne garde que les PTP
// qu'aucune AAC validée ne cite.
export const aacSandreSql = (gpkg) => `
  CREATE TABLE aac_sandre AS
  SELECT CAST(CdAAC AS VARCHAR) AS cdaac, NomDeAACAdministratif AS nom, StAAC AS statut, DateMajAAC AS date_maj, PTP AS ptp_json,
         ST_MakeValid(ST_Transform(geom, 'EPSG:4326', 'EPSG:2154', true)) AS geom_l93
  FROM ST_Read('${gpkg}', layer='AAC_FRA');

  CREATE TABLE aac_ptp AS
  SELECT DISTINCT a.cdaac, a.statut, json_extract_string(p.ptp, '$.CdPointPrelevement') AS code_ptp
  FROM aac_sandre a, unnest(from_json(a.ptp_json, '["json"]')) AS p(ptp)
  WHERE json_extract_string(p.ptp, '$.CdPointPrelevement') IS NOT NULL
  QUALIFY a.statut <> 'Gelé'
       OR NOT bool_or(a.statut <> 'Gelé') OVER (PARTITION BY json_extract_string(p.ptp, '$.CdPointPrelevement'));
`
