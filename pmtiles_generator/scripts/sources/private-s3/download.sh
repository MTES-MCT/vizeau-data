#!/bin/bash
# Étape download (pipeline rpg2) : synchronise le dossier trouvé par
# l'étape discover depuis S3 vers /output/ (fichiers .shp/.shx/.dbf/.prj/.cpg
# uniquement).
set -e

PREFIX_FILE="/input/discover/s3_prefix.txt"
if [ ! -f "$PREFIX_FILE" ]; then
    echo "Erreur : $PREFIX_FILE introuvable" >&2
    exit 1
fi
S3_PREFIX=$(cat "$PREFIX_FILE")

mkdir -p ~/.aws
cat > ~/.aws/credentials << CREDS
[default]
aws_access_key_id = ${S3_ACCESS_KEY_ID}
aws_secret_access_key = ${S3_SECRET_ACCESS_KEY}
CREDS

echo "Téléchargement depuis : s3://${S3_SOURCE_BUCKET}/${S3_PREFIX}"

mkdir -p /output
aws s3 sync "s3://${S3_SOURCE_BUCKET}/${S3_PREFIX}" /output/ \
    --endpoint-url "${S3_ENDPOINT}" \
    --region "${S3_REGION:-fr-par}" \
    --exclude "*" \
    --include "*.shp" \
    --include "*.shx" \
    --include "*.dbf" \
    --include "*.prj" \
    --include "*.cpg"

COUNT=$(find /output -name "*.shp" | wc -l | tr -d ' ')
echo "Téléchargement terminé : ${COUNT} shapefile(s)."
