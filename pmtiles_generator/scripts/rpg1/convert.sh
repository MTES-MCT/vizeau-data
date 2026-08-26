#!/bin/bash

# Étape convert : convertit RPG_PAC et RPG_BIO en FlatGeobuf (EPSG:4326).
# Sources :
#   - PAC  : /input/extract/ (extraction IGN, fichier *_pac*.gpkg)
#   - BIO  : /input/fetch-bio/bio.gpkg (préparé par l'étape fetch-bio)
#
# Schéma unifié en sortie (les deux layers) :
#   id_parcel  — identifiant parcelle
#   code_group — code groupe cultural (1-28, pour colorisation vizeau)
#   surf_parc  — surface en hectares
#   code_cultu — code culture 4 lettres (optionnel)
#
# Fix géométrie : -nlt PROMOTE_TO_MULTI pour accepter Polygon et MultiPolygon.
# Fix champs majuscules (pre-2024) : -dialect SQLITE avec SELECT renommant les champs.
#
# La couche PAC porte déjà nativement id_parcel/code_group (champs standard IGN), transmis
# tels quels. La couche BIO (schéma data.gouv.fr) n'a ni l'un ni l'autre : code_group y est
# dérivé de code_cultu via le même CASE (généré depuis cultures.json) que le
# pipeline rpg2, pour classer les cultures de façon identique entre les deux pipelines.
set -e

CULTURES_JSON=/app/cultures.json

# Génère le CASE code_cultu → code_group depuis cultures.json (même logique que rpg2).
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

get_geom_col() {
    ogrinfo -al -so "$1" "$2" 2>/dev/null \
        | grep "^Geometry Column" \
        | sed 's/Geometry Column = //' \
        | tr -d ' '
}

get_fields() {
    ogrinfo -al -so "$1" "$2" 2>/dev/null \
        | grep -E "^[A-Za-z_][A-Za-z0-9_]*: (String|Real|Integer|Integer64|Date|DateTime)" \
        | awk -F: '{print $1}'
}

has_field() {
    ogrinfo -al -so "$1" "$2" 2>/dev/null | grep -qiE "^${3}:"
}

build_rename_sql() {
    local geom_col="$1"
    local layer="$2"
    shift 2
    local fields="$*"

    local select_parts="\"${geom_col}\""
    for field in $fields; do
        local lower
        lower=$(echo "$field" | tr '[:upper:]' '[:lower:]')
        if [ "$field" != "$lower" ]; then
            select_parts="${select_parts}, \"${field}\" AS ${lower}"
        else
            select_parts="${select_parts}, \"${field}\""
        fi
    done
    echo "SELECT ${select_parts} FROM \"${layer}\""
}

mkdir -p /output/

# ── Résolution des sources ────────────────────────────────────────────────────
PAC_GPKG=$(find /input/extract/ \( -iname "*_pac*.gpkg" -o -iname "parcelles_graphiques.gpkg" \) 2>/dev/null | head -1)
if [ -z "$PAC_GPKG" ]; then
    echo "Erreur : aucun fichier RPG PAC trouvé dans /input/extract/" >&2
    echo "Fichiers GPKG disponibles :" >&2
    find /input/extract/ -iname "*.gpkg" | head -20 >&2
    exit 1
fi
echo "RPG PAC : $(basename "$PAC_GPKG")"

BIO_GPKG=""
if [ -f /input/fetch-bio/.no-bio ]; then
    echo "⚠  Couche RPG BIO indisponible pour ce millésime (marqueur .no-bio)."
elif [ -f /input/fetch-bio/bio.gpkg ]; then
    BIO_GPKG="/input/fetch-bio/bio.gpkg"
    echo "RPG BIO : bio.gpkg"
else
    echo "⚠  Aucun fichier BIO trouvé dans /input/fetch-bio/, couche ignorée." >&2
fi

# ── Conversion ────────────────────────────────────────────────────────────────

convert_gpkg() {
    local GPKG="$1"
    local PMTILES_LAYER="$2"

    LAYER=$(ogrinfo "$GPKG" 2>/dev/null | grep '^1:' | sed 's/^1: //' | sed 's/ (.*//')
    if [ -z "$LAYER" ]; then
        echo "  ⚠  Impossible de lire la couche de $(basename "$GPKG"), ignoré." >&2
        return
    fi

    GEOM_COL=$(get_geom_col "$GPKG" "$LAYER")
    FIELDS=$(get_fields "$GPKG" "$LAYER")
    UPPERCASE_FIELDS=$(echo "$FIELDS" | grep -E "^[A-Z]" || true)

    if [ -n "$UPPERCASE_FIELDS" ]; then
        echo "  → $PMTILES_LAYER (champs normalisés en minuscules)"
        NORMALIZE_SQL=$(build_rename_sql "$GEOM_COL" "$LAYER" $FIELDS)
        ogr2ogr \
            -f FlatGeobuf \
            -t_srs EPSG:4326 \
            -dialect SQLITE \
            -sql "$NORMALIZE_SQL" \
            -nln "$PMTILES_LAYER" \
            -nlt PROMOTE_TO_MULTI \
            -progress \
            "/output/${PMTILES_LAYER}.fgb" \
            "$GPKG"
    else
        echo "  → $PMTILES_LAYER (conversion directe, colonne géom : '$GEOM_COL')"
        ogr2ogr \
            -f FlatGeobuf \
            -t_srs EPSG:4326 \
            -nln "$PMTILES_LAYER" \
            -nlt PROMOTE_TO_MULTI \
            -progress \
            "/output/${PMTILES_LAYER}.fgb" \
            "$GPKG" \
            "$LAYER"
    fi
}

convert_bio_gpkg() {
    local GPKG="$1"

    LAYER=$(ogrinfo "$GPKG" 2>/dev/null | grep '^1:' | sed 's/^1: //' | sed 's/ (.*//')
    if [ -z "$LAYER" ]; then
        echo "  ⚠  Impossible de lire la couche de $(basename "$GPKG"), ignoré." >&2
        return
    fi

    GEOM_COL=$(get_geom_col "$GPKG" "$LAYER")

    # Détection schéma data.gouv.fr par la présence de surface_ha (absent du format IGN)
    if ! has_field "$GPKG" "$LAYER" "surface_ha"; then
        # Schéma IGN (même format que PAC) : normalisation minuscules si nécessaire
        echo "  → parcellesbio (schéma IGN, même structure que PAC)"
        convert_gpkg "$GPKG" "parcellesbio"
        return
    fi

    # Schéma data.gouv.fr — champs tronqués (SHP, ≤10 chars) ou complets (GPKG natif)
    if has_field "$GPKG" "$LAYER" "code_culture"; then
        # GPKG natif data.gouv.fr (2021+) : champs complets
        CODE_CULTU_FIELD="code_culture"
        LBL_CULTU_FIELD="lbl_culture"
    else
        # SHP converti (2019-2020) : champs tronqués à 10 caractères
        CODE_CULTU_FIELD="code_cultu"
        LBL_CULTU_FIELD="lbl_cultu"
    fi

    # Pour SHP converti : pas de colonne gid → utiliser rowid (FID SQLite)
    if has_field "$GPKG" "$LAYER" "gid"; then
        ID_EXPR="CAST(gid AS TEXT)"
    else
        ID_EXPR="CAST(rowid AS TEXT)"
    fi

    echo "  → parcellesbio (schéma data.gouv.fr → schéma unifié PAC)"
    echo "    champs source : ${CODE_CULTU_FIELD}"

    ogr2ogr \
        -f FlatGeobuf \
        -t_srs EPSG:4326 \
        -dialect SQLITE \
        -sql "SELECT
              \"${GEOM_COL}\",
              ${ID_EXPR}              AS id_parcel,
              surface_ha              AS surf_parc,
              ${CODE_CULTU_FIELD}     AS code_cultu,
              ${LBL_CULTU_FIELD}      AS culture_d1,
              NULL                    AS culture_d2,
              (${CODE_GROUP_SQL})     AS code_group
            FROM \"${LAYER}\"" \
        -nln "parcellesbio" \
        -nlt PROMOTE_TO_MULTI \
        -progress \
        "/output/parcellesbio.fgb" \
        "$GPKG"
}

CONVERTED=0

echo ""
echo "Conversion RPG PAC → parcelles"
convert_gpkg "$PAC_GPKG" "parcelles"
CONVERTED=$((CONVERTED + 1))

if [ -n "$BIO_GPKG" ]; then
    echo ""
    echo "Conversion RPG BIO → parcellesbio"
    convert_bio_gpkg "$BIO_GPKG"
    CONVERTED=$((CONVERTED + 1))
fi

echo ""
echo "Bilan : $CONVERTED couche(s) convertie(s)"

if [ ! -f /output/parcelles.fgb ]; then
    echo "⚠  ATTENTION : la couche 'parcelles' (RPG_PAC.gpkg) est absente." >&2
    exit 1
fi

echo ""
ls -lh /output/*.fgb 2>/dev/null

