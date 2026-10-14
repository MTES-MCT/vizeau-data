#!/bin/bash
# Étape upload : envoie le fichier PMTiles vers un bucket S3 (compatible Scaleway).
# Variables requises (injectées via --env-file .env) :
#   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_KEY,
#   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
# Optionnelle :
#   S3_OVERWRITE  À 1, autorise l'écrasement d'un fichier existant (posé par
#                 run.sh après confirmation). Sinon l'upload échoue si la
#                 destination existe déjà.
set -e

if [ "${NO_UPLOAD:-}" = "1" ]; then
    PMTILES_FILE=$(find /input/build-pmtiles/ -name "parcelles_france.pmtiles" | head -1)
    if [ -z "$PMTILES_FILE" ]; then
        echo "Erreur : parcelles_france.pmtiles introuvable dans /input/build-pmtiles/" >&2
        exit 1
    fi

    # Tylt bind-mounts (`mounts:`) are always read-only, so this step can't write
    # to a host directory directly. run.sh extracts the file locally afterwards
    # via `tylt export <workspace> build-pmtiles ./output/`.
    echo "⏭ Upload ignoré (--no-upload) — récupérer le fichier via 'tylt export <workspace> build-pmtiles ./output/'"
    exit 0
fi

. /input/setup/config.env

# Configurer awscli avec les credentials S3
mkdir -p ~/.aws
cat > ~/.aws/credentials << CREDS
[default]
aws_access_key_id = ${S3_ACCESS_KEY_ID}
aws_secret_access_key = ${S3_SECRET_ACCESS_KEY}
CREDS

PMTILES_FILE=$(find /input/build-pmtiles/ -name "parcelles_france.pmtiles" | head -1)
if [ -z "$PMTILES_FILE" ]; then
    echo "Erreur : parcelles_france.pmtiles introuvable dans /input/build-pmtiles/" >&2
    find /input/build-pmtiles/ -type f >&2
    exit 1
fi

: "${S3_KEY:="${MILLESIME}/parcelles_france.pmtiles"}"

echo "Fichier    : $PMTILES_FILE ($(du -h "$PMTILES_FILE" | cut -f1))"
echo "Destination: s3://${S3_BUCKET}/${S3_KEY}"
echo "Endpoint   : $S3_ENDPOINT"

# Garde-fou : run.sh demande confirmation avant la pipeline, mais un appel
# direct à `tylt run` passe par ici sans question possible (pas de terminal).
if [ "${S3_OVERWRITE:-}" != "1" ] && aws s3api head-object \
    --bucket "${S3_BUCKET}" --key "${S3_KEY}" \
    --endpoint-url "${S3_ENDPOINT}" --region "${S3_REGION:-fr-par}" > /dev/null 2>&1; then
    echo "Erreur : s3://${S3_BUCKET}/${S3_KEY} existe déjà. Poser S3_OVERWRITE=1 pour l'écraser." >&2
    exit 1
fi

aws configure set default.s3.multipart_chunksize 256MB
aws configure set default.s3.multipart_threshold 256MB

aws s3 cp "$PMTILES_FILE" "s3://${S3_BUCKET}/${S3_KEY}" \
    --endpoint-url "${S3_ENDPOINT}" \
    --region "${S3_REGION:-fr-par}" \
    --content-type "application/vnd.pmtiles"

echo ""
echo "✓ Upload terminé : s3://${S3_BUCKET}/${S3_KEY}"
