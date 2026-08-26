#!/bin/bash

# Étape convert (pipeline rpg2) : fusionne les shapefiles départementaux
# RPG ("surfaces graphiques constatées") en un schéma unifié, puis exporte
# deux FlatGeobuf (EPSG:4326) :
#   parcelles.fgb     — toutes les parcelles
#   parcellesbio.fgb  — sous-ensemble où le champ BIO du SHP source vaut 1
#
# Schéma cible (identique au pipeline GPKG) :
#   id_parcel  — PACAGE-NUM_ILOT-NUM_PARCEL (identifiant RPG standard)
#   code_group — code groupe cultural (1-28), dérivé de CODE_CULTU via
#                inertia/data/cultures.json (mapping code → groupCode)
#   surf_parc  — SURF_ADM (surface en hectares)
#   code_cultu — CODE_CULTU (code culture 4 lettres)
#
# Source : /input/download/*.shp (un fichier par département).
set -e

CULTURES_JSON=/app/cultures.json
MERGED_GPKG=/tmp/merged.gpkg

mkdir -p /output

# ── 1. Génération du CASE code_cultu → code_group depuis cultures.json ────────
# Un seul groupCode par code toutes années confondues (vérifié en amont).
CASE_FRAGMENT=$(jq -r '
    [.[] | select(.groupCode != null) | {code, groupCode}]
    | unique_by(.code)
    | map("WHEN '\''" + (.code | gsub("'\''"; "'\'''\''")) + "'\'' THEN \(.groupCode)")
    | join(" ")
' "$CULTURES_JSON")

if [ -z "$CASE_FRAGMENT" ]; then
    echo "Erreur : impossible de générer le mapping code_cultu → code_group depuis $CULTURES_JSON" >&2
    exit 1
fi

CODE_GROUP_SQL="CASE code_cultu ${CASE_FRAGMENT} ELSE 28 END"

# ── 2. Fusion des shapefiles départementaux dans un GeoPackage unique ─────────
SHAPEFILES=$(find /input/download/ -iname "*.shp" | sort)
COUNT=$(echo "$SHAPEFILES" | grep -c . || true)

if [ "$COUNT" -eq 0 ]; then
    echo "Erreur : aucun fichier .shp trouvé dans /input/download/" >&2
    exit 1
fi

echo "Fusion de ${COUNT} shapefile(s) départementaux..."
rm -f "$MERGED_GPKG"

N=0
while IFS= read -r SHP; do
    [ -z "$SHP" ] && continue
    LAYER=$(basename "$SHP" .shp)
    N=$((N + 1))
    echo "  [$N/$COUNT] $(basename "$SHP")"

    ogr2ogr \
        -f GPKG -update -append \
        -t_srs EPSG:4326 \
        -dialect SQLITE \
        -sql "SELECT
                geometry,
                (PACAGE || '-' || NUM_ILOT || '-' || NUM_PARCEL) AS id_parcel,
                CODE_CULTU                                       AS code_cultu,
                SURF_ADM                                         AS surf_parc,
                CULTURE_D1                                       AS culture_d1,
                CULTURE_D2                                       AS culture_d2,
                BIO                                               AS bio,
                (${CODE_GROUP_SQL})                              AS code_group
              FROM \"${LAYER}\"" \
        -nln parcelles_merged \
        -nlt PROMOTE_TO_MULTI \
        "$MERGED_GPKG" \
        "$SHP"
done <<< "$SHAPEFILES"

MERGED_COUNT=$(ogrinfo -al -so "$MERGED_GPKG" parcelles_merged 2>/dev/null | grep "Feature Count" | awk '{print $3}')
echo "Fusion terminée : ${MERGED_COUNT} parcelle(s) au total."

# ── 3. Exports finaux ──────────────────────────────────────────────────────────
# -nlt MULTIPOLYGON : certains départements source contiennent des géométries
# Multi Surface (polygones à courbes), rejetées par FlatGeobuf sans conversion.
echo ""
echo "Export parcelles → parcelles.fgb"
ogr2ogr \
    -f FlatGeobuf \
    -nln parcelles \
    -nlt MULTIPOLYGON \
    -progress \
    /output/parcelles.fgb \
    "$MERGED_GPKG" parcelles_merged

echo ""
echo "Export parcellesbio (bio = 1) → parcellesbio.fgb"
ogr2ogr \
    -f FlatGeobuf \
    -nln parcellesbio \
    -nlt MULTIPOLYGON \
    -where "bio = 1" \
    -progress \
    /output/parcellesbio.fgb \
    "$MERGED_GPKG" parcelles_merged

if [ ! -f /output/parcelles.fgb ]; then
    echo "⚠  ATTENTION : la couche 'parcelles' est absente." >&2
    exit 1
fi

echo ""
ls -lh /output/*.fgb
