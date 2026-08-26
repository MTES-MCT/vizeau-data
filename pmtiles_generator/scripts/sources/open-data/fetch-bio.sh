#!/bin/bash

# Étape fetch-bio : récupère le GeoPackage RPG BIO.
# Priorité :
#   1. Archive IGN (si BIO déjà présent dans l'extraction)
#   2. data.gouv.fr API (fallback — disponible pour les millésimes 2019–2023)
# Sortie : /output/bio.gpkg ou /output/.no-bio (si indisponible pour ce millésime).
set -e

source /input/setup/config.env
echo "Millésime : $MILLESIME"

DATASET_ID="${BIO_FALLBACK_DATASET:-}"

# ── 1. BIO déjà dans l'extraction IGN ? ─────────────────────────────────────
BIO_GPKG=$(find /input/extract/ -iname "*bio*.gpkg" 2>/dev/null | head -1)
if [ -n "$BIO_GPKG" ]; then
    echo "RPG BIO trouvé dans l'extraction IGN : $(basename "$BIO_GPKG")"
    cp "$BIO_GPKG" /output/bio.gpkg
    ls -lh /output/bio.gpkg
    exit 0
fi

echo "RPG BIO absent de l'extraction IGN → recherche sur data.gouv.fr..."

# ── 2. Requête API data.gouv.fr ──────────────────────────────────────────────
if [ -z "$DATASET_ID" ]; then
    echo "Erreur : BIO_FALLBACK_DATASET est vide ou non défini dans config.env." >&2
    echo "Vérifiez que bio_fallback_dataset est renseigné dans config.yaml et que l'étape setup s'est exécutée correctement." >&2
    exit 1
fi

API_RESPONSE=$(curl -sfL "https://www.data.gouv.fr/api/1/datasets/${DATASET_ID}/" || true)
if [ -z "$API_RESPONSE" ]; then
    echo "⚠  Impossible de contacter l'API data.gouv.fr" >&2
    touch /output/.no-bio
    exit 0
fi

# Sélection : ressources dont l'URL contient "rpg-bio-<MILLESIME>", triées par
# format préféré (gpkg > zip/shp.zip > autre), on garde la première.
BIO_URL=$(echo "$API_RESPONSE" | jq -r --arg year "$MILLESIME" '
    [.resources[]? | select(.url // "" | contains("rpg-bio-\($year)"))]
    | sort_by(
        if (.format // "" | contains("gpkg")) then 0
        elif ((.format // "") == "zip" or (.format // "") == "shp.zip") then 1
        else 2 end
      )
    | .[0].url // empty
' || true)

if [ -z "$BIO_URL" ]; then
    echo "⚠  Aucun fichier RPG BIO disponible pour le millésime $MILLESIME sur data.gouv.fr" >&2
    echo "⚠  La couche parcellesbio sera absente du PMTiles." >&2
    touch /output/.no-bio
    exit 0
fi

echo "URL : $BIO_URL"

# ── 3. Téléchargement ────────────────────────────────────────────────────────
mkdir -p /tmp/bio
cd /tmp/bio
curl -L --progress-bar -o bio.download "$BIO_URL"

# Décompression seulement si nécessaire (l'URL peut pointer directement vers un GPKG)
if file bio.download | grep -qi "zip"; then
    echo "Archive ZIP détectée — extraction..."
    unzip -o bio.download
else
    echo "Fichier non-ZIP détecté — utilisation directe."
    cp bio.download bio.gpkg
fi

# ── 4. Récupération du fichier géographique ──────────────────────────────────
GPKG_FILE=$(find . -iname "*.gpkg" | head -1)
if [ -n "$GPKG_FILE" ]; then
    echo "GPKG trouvé : $GPKG_FILE"
    cp "$GPKG_FILE" /output/bio.gpkg
else
    SHP_FILE=$(find . -iname "*.shp" | head -1)
    if [ -n "$SHP_FILE" ]; then
        echo "Conversion SHP → GPKG : $SHP_FILE"
        ogr2ogr -f GPKG /output/bio.gpkg "$SHP_FILE"
    else
        echo "⚠  Aucun fichier géographique trouvé dans l'archive" >&2
        ls -la .
        touch /output/.no-bio
        exit 0
    fi
fi

ls -lh /output/bio.gpkg
echo "RPG BIO prêt."
