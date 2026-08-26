#!/bin/sh
# Étape setup : lit config.yaml et produit /output/config.env
# avec BASE_URL, MILLESIME, BIO_FALLBACK_DATASET, MIN_ZOOM et MAX_ZOOM.
set -e

CONFIG=/config.yaml

if [ -z "$MILLESIME" ]; then
    echo "Erreur : la variable MILLESIME n'est pas définie." >&2
    echo "Usage : tylt run --env MILLESIME=2024" >&2
    exit 1
fi

BASE_URL=$(yq -r ".sources.open_data.millesimes[\"${MILLESIME}\"].base_url // \"\"" "$CONFIG")
if [ -z "$BASE_URL" ] || [ "$BASE_URL" = "null" ]; then
    AVAILABLE=$(yq -r '.sources.open_data.millesimes | keys | join(", ")' "$CONFIG")
    echo "Erreur : millésime '${MILLESIME}' absent de config.yaml" >&2
    echo "Millésimes disponibles : ${AVAILABLE}" >&2
    exit 1
fi

BIO_FALLBACK_DATASET=$(yq -r '.sources.open_data.bio_fallback_dataset // ""' "$CONFIG")
MIN_ZOOM=$(yq -r '.tippecanoe.min_zoom // 5' "$CONFIG")
MAX_ZOOM=$(yq -r '.tippecanoe.max_zoom // 14' "$CONFIG")

mkdir -p /output

cat > /output/config.env << EOF
BASE_URL=${BASE_URL}
MILLESIME=${MILLESIME}
BIO_FALLBACK_DATASET=${BIO_FALLBACK_DATASET}
MIN_ZOOM=${MIN_ZOOM}
MAX_ZOOM=${MAX_ZOOM}
EOF

echo "Millésime            : ${MILLESIME}"
echo "BASE_URL             : ${BASE_URL}"
echo "BIO_FALLBACK_DATASET : ${BIO_FALLBACK_DATASET}"
echo "MIN_ZOOM / MAX_ZOOM   : ${MIN_ZOOM} / ${MAX_ZOOM}"
echo "config.env            : /output/config.env"
