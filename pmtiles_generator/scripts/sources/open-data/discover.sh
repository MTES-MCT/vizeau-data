#!/bin/sh

# Étape discover : détermine si l'archive est un fichier unique (.7z)
# ou multi-parties (.7z.001, .7z.002, …) et écrit la liste des URLs
# dans /output/parts.txt.
set -e

. /input/setup/config.env

echo "Découverte de l'archive pour le millésime $MILLESIME"
echo "BASE_URL : $BASE_URL"

# 1. Essai multi-parties : sonde .7z.001, .7z.002… jusqu'au premier 404
N=1
PART_COUNT=0
MAX_PARTS=99
> /output/parts.txt
while true; do
    if [ $N -gt $MAX_PARTS ]; then
        echo "Erreur : nombre de parties dépasse $MAX_PARTS (boucle infinie ?)" >&2
        exit 1
    fi
    SUFFIX=$(printf '%03d' $N)
    URL="${BASE_URL}.7z.${SUFFIX}"
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' --head --max-time 30 "$URL")
    if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ] || [ "$STATUS" = "301" ]; then
        echo "  Partie trouvée : $URL"
        printf '%s\n' "$URL" >> /output/parts.txt
        PART_COUNT=$((PART_COUNT + 1))
        N=$((N + 1))
    else
        break
    fi
done

if [ $PART_COUNT -gt 0 ]; then
    echo "Archive multi-parties : $PART_COUNT partie(s)"
    echo "multipart" > /output/archive_type.txt
    exit 0
fi

# 2. Essai fichier unique : .7z
URL="${BASE_URL}.7z"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' --head --max-time 30 "$URL")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ] || [ "$STATUS" = "301" ]; then
    echo "$URL" > /output/parts.txt
    echo "Archive unique : $URL"
    echo "single" > /output/archive_type.txt
    exit 0
fi

echo "Erreur : aucune archive trouvée à $BASE_URL (.7z ou .7z.001)" >&2
exit 1
