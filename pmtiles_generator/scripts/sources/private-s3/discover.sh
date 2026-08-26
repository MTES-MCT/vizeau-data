#!/bin/bash
# Étape discover (pipeline rpg2) : liste le préfixe S3
#   s3://$S3_SOURCE_BUCKET/$MILLESIME/couches_graphiques/
# et sélectionne le seul "dossier" qui correspond au pattern attendu
#   SURFACES-<MILLESIME>-PARCELLES-GRAPHIQUES-CONSTATEES_<AAAAMMJJ>/
# (la variante "-DEPT_" est explicitement exclue — voir AGENTS.md).
# Écrit le préfixe complet (sans bucket, avec / final) dans /output/s3_prefix.txt.
set -e

. /input/setup/config.env

mkdir -p ~/.aws
cat > ~/.aws/credentials << CREDS
[default]
aws_access_key_id = ${S3_ACCESS_KEY_ID}
aws_secret_access_key = ${S3_SECRET_ACCESS_KEY}
CREDS

PREFIX_ROOT="${MILLESIME}/couches_graphiques/"
echo "Recherche dans : s3://${S3_SOURCE_BUCKET}/${PREFIX_ROOT}"

LISTING=$(aws s3 ls "s3://${S3_SOURCE_BUCKET}/${PREFIX_ROOT}" \
    --endpoint-url "${S3_ENDPOINT}" \
    --region "${S3_REGION:-fr-par}")

PATTERN="^SURFACES-${MILLESIME}-PARCELLES-GRAPHIQUES-CONSTATEES_[0-9]+\$"

MATCHES=$(echo "$LISTING" \
    | awk '/PRE / {print $2}' \
    | sed 's#/$##' \
    | grep -E "$PATTERN" || true)

COUNT=$(echo "$MATCHES" | grep -c . || true)

if [ "$COUNT" -eq 0 ]; then
    echo "Erreur : aucun dossier ne correspond à ${PATTERN} sous ${PREFIX_ROOT}" >&2
    echo "Dossiers disponibles :" >&2
    echo "$LISTING" >&2
    exit 1
fi

if [ "$COUNT" -gt 1 ]; then
    echo "Erreur : plusieurs dossiers correspondent à ${PATTERN}, sélection ambiguë :" >&2
    echo "$MATCHES" >&2
    exit 1
fi

FOUND_DIR="$MATCHES"
FULL_PREFIX="${PREFIX_ROOT}${FOUND_DIR}/"

echo "Dossier trouvé : ${FULL_PREFIX}"
mkdir -p /output
printf '%s' "$FULL_PREFIX" > /output/s3_prefix.txt
