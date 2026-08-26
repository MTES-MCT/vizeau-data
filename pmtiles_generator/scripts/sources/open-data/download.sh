#!/bin/sh

# Étape download : télécharge toutes les parties listées dans parts.txt
# en parallèle via curl. Les fichiers sont nommés d'après leur URL (basename).
set -e

PARTS_FILE="/input/discover/parts.txt"

if [ ! -f "$PARTS_FILE" ]; then
    echo "Erreur : $PARTS_FILE introuvable" >&2
    exit 1
fi

COUNT=$(grep -c . "$PARTS_FILE")
echo "Téléchargement de $COUNT fichier(s)…"

PIDS=""
while IFS= read -r URL; do
    [ -z "$URL" ] && continue
    BASENAME=$(basename "$URL")
    echo "  → $URL"
    curl -L --http1.1 --retry 10 --retry-delay 5 --retry-connrefused --retry-all-errors \
        -C - \
        --progress-bar \
        -o "/output/$BASENAME" \
        "$URL" &
    PIDS="$PIDS $!"
done < "$PARTS_FILE"

FAILED=0
for PID in $PIDS; do
    wait "$PID" || FAILED=$((FAILED + 1))
done

if [ "$FAILED" -gt 0 ]; then
    echo "Erreur : $FAILED téléchargement(s) ont échoué." >&2
    exit 1
fi

echo "Téléchargements terminés :"
ls -lh /output/
