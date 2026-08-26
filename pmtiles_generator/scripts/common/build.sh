#!/bin/bash

# Étape build-pmtiles : assemble tous les FlatGeobuf en un PMTiles multi-layers
# via tippecanoe. Chaque fichier .fgb devient un source-layer nommé d'après
# le nom de fichier (sans extension).
#
# Les layers absents (millésimes anciens) sont simplement omis — pas d'erreur.
# Seule la couche 'parcelles' déclenche un avertissement si elle est manquante.
set -e

. /input/setup/config.env

OUTPUT="/output/${MILLESIME}/parcelles_france.pmtiles"
mkdir -p "$(dirname "$OUTPUT")"

# Construire les arguments -L layername:file pour chaque .fgb disponible
LAYER_ARGS=""
FOUND_LAYERS=""
for FGB in /input/convert/*.fgb; do
    [ -f "$FGB" ] || continue
    LAYER=$(basename "$FGB" .fgb)
    LAYER_ARGS="$LAYER_ARGS -L ${LAYER}:${FGB}"
    FOUND_LAYERS="$FOUND_LAYERS $LAYER"
done

if [ -z "$LAYER_ARGS" ]; then
    echo "Erreur : aucun fichier .fgb trouvé dans /input/convert/" >&2
    exit 1
fi

echo "Couches incluses  :$(echo "$FOUND_LAYERS" | tr ' ' '\n' | sort | tr '\n' ' ')"
if ! echo "$FOUND_LAYERS" | grep -qw "parcelles"; then
    echo "  ⚠  La couche 'parcelles' est absente de ce millésime."
fi

echo "Sortie  : $OUTPUT"

# shellcheck disable=SC2086
tippecanoe \
    --output "$OUTPUT" \
    $LAYER_ARGS \
    --minimum-zoom="${MIN_ZOOM}" \
    --maximum-zoom="${MAX_ZOOM}" \
    --drop-densest-as-needed \
    --temporary-directory=/tmp \
    --force

echo ""
echo "PMTiles généré :"
ls -lh "$OUTPUT"
