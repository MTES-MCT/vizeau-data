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
set -e

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
        GRP_CULTU_FIELD="grp_culture"
    else
        # SHP converti (2019-2020) : champs tronqués à 10 caractères
        CODE_CULTU_FIELD="code_cultu"
        LBL_CULTU_FIELD="lbl_cultu"
        GRP_CULTU_FIELD="grp_cultu"
    fi

    # Pour SHP converti : pas de colonne gid → utiliser rowid (FID SQLite)
    if has_field "$GPKG" "$LAYER" "gid"; then
        ID_EXPR="CAST(gid AS TEXT)"
    else
        ID_EXPR="CAST(rowid AS TEXT)"
    fi

    echo "  → parcellesbio (schéma data.gouv.fr → schéma unifié PAC)"
    echo "    champs source : ${CODE_CULTU_FIELD}, ${GRP_CULTU_FIELD}"

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
              CASE ${GRP_CULTU_FIELD}
                WHEN 'Blé tendre'                     THEN 1
                WHEN 'Maïs grain et ensilage'         THEN 2
                WHEN 'Orge'                           THEN 3
                WHEN 'Autres céréales'                THEN 4
                WHEN 'Colza'                          THEN 5
                WHEN 'Tournesol'                      THEN 6
                WHEN 'Autre oléagineux'               THEN 7
                WHEN 'Protéagineux'                   THEN 8
                WHEN 'Plantes à fibres'               THEN 9
                WHEN 'Semences'                       THEN 10
                WHEN 'Gel'                            THEN 11
                WHEN 'Gel industriel'                 THEN 12
                WHEN 'Autres gels'                    THEN 13
                WHEN 'Riz'                            THEN 14
                WHEN 'Légumineux à grains'            THEN 15
                WHEN 'Fourrage'                       THEN 16
                WHEN 'Estives et landes'              THEN 17
                WHEN 'Prairies permanentes'           THEN 18
                WHEN 'Prairies temporaires'           THEN 19
                WHEN 'Vergers'                        THEN 20
                WHEN 'Vignes'                         THEN 21
                WHEN 'Fruits à coque'                 THEN 22
                WHEN 'Oliviers'                       THEN 23
                WHEN 'Autres cultures industrielles'  THEN 24
                WHEN 'Légumes ou fleurs'              THEN 25
                WHEN 'Canne à sucre'                  THEN 26
                WHEN 'Arboriculture'                  THEN 27
                ELSE 28
              END                     AS code_group
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

