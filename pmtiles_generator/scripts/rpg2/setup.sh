#!/bin/sh
# Étape setup (pipeline rpg2) : valide MILLESIME et lit les options
# tippecanoe partagées depuis config.yaml. Produit /output/config.env.
set -e

CONFIG=/config.yaml

if [ -z "$MILLESIME" ]; then
    echo "Erreur : la variable MILLESIME n'est pas définie." >&2
    echo "Usage : tylt run --env MILLESIME=2024" >&2
    exit 1
fi

if [ -z "$S3_SOURCE_BUCKET" ]; then
    echo "Erreur : la variable S3_SOURCE_BUCKET n'est pas définie." >&2
    exit 1
fi

MIN_ZOOM=$(yq -r '.tippecanoe.min_zoom // 5' "$CONFIG")
MAX_ZOOM=$(yq -r '.tippecanoe.max_zoom // 14' "$CONFIG")

mkdir -p /output

cat > /output/config.env << EOF
MILLESIME=${MILLESIME}
MIN_ZOOM=${MIN_ZOOM}
MAX_ZOOM=${MAX_ZOOM}
EOF

echo "Millésime           : ${MILLESIME}"
echo "S3_SOURCE_BUCKET     : ${S3_SOURCE_BUCKET}"
echo "MIN_ZOOM / MAX_ZOOM   : ${MIN_ZOOM} / ${MAX_ZOOM}"
echo "config.env            : /output/config.env"
