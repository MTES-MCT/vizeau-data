#!/bin/bash
# Lance la pipeline RPG → PMTiles pour une source et un millésime donnés,
# puis nettoie le workspace Tylt après un upload réussi.
#
# Usage :
#   ./run.sh <source> <MILLESIME> [options tylt supplémentaires]
#   ./run.sh rpg1 2024
#   ./run.sh rpg2 2024 --no-upload                # pipeline complète, sans l'upload S3
#   ./run.sh rpg1 2022 --force download          # re-télécharger
#   S3_OVERWRITE=1 ./run.sh rpg1 2024            # écraser le PMTiles distant sans confirmation
#
# Sources disponibles : un fichier par source dans pipelines/<source>.yaml.
#
# --no-upload fait sauter l'étape d'upload quelle que soit la pipeline (via
# une variable d'env NO_UPLOAD lue par scripts/common/upload.sh), contrairement
# à --target build-pmtiles qui dépend du nom de l'étape dans la pipeline.
#
# Si le PMTiles existe déjà sur S3, une confirmation est demandée avant de
# lancer la pipeline (refus hors terminal interactif, sauf S3_OVERWRITE=1).

list_sources() {
    ls pipelines/*.yaml 2>/dev/null | sed -e 's#pipelines/##' -e 's#\.yaml$##' -e 's/^/  - /'
}

SOURCE="${1:?Usage: ./run.sh <source> <MILLESIME> [options tylt supplémentaires]}"
MILLESIME="${2:?Usage: ./run.sh <source> <MILLESIME> [options tylt supplémentaires]}"
shift 2

# --no-upload : fait sauter l'étape d'upload (voir scripts/common/upload.sh),
# quelle que soit la pipeline. On le retire des args avant de les passer à tylt.
NO_UPLOAD=0
TYLT_ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--no-upload" ]; then
        NO_UPLOAD=1
    else
        TYLT_ARGS+=("$arg")
    fi
done
set -- "${TYLT_ARGS[@]}"

PIPELINE_FILE="pipelines/${SOURCE}.yaml"
if [ ! -f "$PIPELINE_FILE" ]; then
    echo "Erreur : source '${SOURCE}' inconnue (${PIPELINE_FILE} introuvable)." >&2
    echo "Sources disponibles :" >&2
    list_sources >&2
    exit 1
fi

WORKSPACE="rpg-${SOURCE}-${MILLESIME}"
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Erreur : fichier $ENV_FILE introuvable." >&2
    echo "Copier .env.example → .env et renseigner les credentials S3." >&2
    exit 1
fi

# Clé S3 par défaut : rpg1 garde la clé historique (pas de casse en prod),
# les autres sources sont suffixées par leur nom.
if [ "$SOURCE" = "rpg1" ]; then
    DEFAULT_S3_KEY="${MILLESIME}/parcelles_france.pmtiles"
else
    DEFAULT_S3_KEY="${MILLESIME}/parcelles_france_${SOURCE}.pmtiles"
fi

# Vérifie avant la pipeline (qui dure longtemps) que l'upload n'écrasera pas
# un PMTiles existant sans confirmation. La question est posée ici car l'étape
# upload tourne dans un conteneur sans terminal ; upload.sh refait la
# vérification et refuse d'écraser si S3_OVERWRITE n'a pas été posé à 1.
S3_OVERWRITE="${S3_OVERWRITE:-$(grep "^S3_OVERWRITE=" "$ENV_FILE" | tail -1 | cut -d= -f2-)}"
if [ "$NO_UPLOAD" = "0" ] && [ "$S3_OVERWRITE" != "1" ]; then
    S3_DEST=$(
        set -a
        . "./$ENV_FILE"
        echo "s3://${S3_BUCKET}/${DEFAULT_S3_KEY}"
    )
    HEAD_ERR=$(
        set -a
        . "./$ENV_FILE"
        AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" \
            aws s3api head-object --bucket "$S3_BUCKET" --key "$DEFAULT_S3_KEY" \
            --endpoint-url "$S3_ENDPOINT" --region "${S3_REGION:-fr-par}" 2>&1 >/dev/null
    )
    HEAD_STATUS=$?

    if [ $HEAD_STATUS -eq 0 ]; then
        if [ ! -t 0 ]; then
            echo "Erreur : ${S3_DEST} existe déjà. Poser S3_OVERWRITE=1 pour l'écraser." >&2
            exit 1
        fi
        read -r -p "${S3_DEST} existe déjà. L'écraser ? (o/N) " ANSWER
        case "$ANSWER" in
            o|O|oui|OUI|y|Y|yes|YES) S3_OVERWRITE=1 ;;
            *)
                echo "Abandon : le fichier distant est conservé (--no-upload pour générer sans pousser)."
                exit 0
                ;;
        esac
        echo ""
    elif ! echo "$HEAD_ERR" | grep -q "Not Found\|404"; then
        echo "Erreur : impossible de vérifier l'existence de ${S3_DEST} :" >&2
        echo "$HEAD_ERR" >&2
        exit 1
    fi
fi

# Fichier env temporaire : credentials de base + MILLESIME/S3_KEY dynamiques
TMP_ENV=$(mktemp)
trap 'rm -f "$TMP_ENV"' EXIT

grep -v "^MILLESIME=\|^S3_KEY=\|^NO_UPLOAD=\|^S3_OVERWRITE=" "$ENV_FILE" > "$TMP_ENV"
echo "MILLESIME=${MILLESIME}" >> "$TMP_ENV"
echo "S3_KEY=${DEFAULT_S3_KEY}" >> "$TMP_ENV"
echo "NO_UPLOAD=${NO_UPLOAD}" >> "$TMP_ENV"
echo "S3_OVERWRITE=${S3_OVERWRITE:-0}" >> "$TMP_ENV"

echo "▶ Source : ${SOURCE}  |  Millésime : ${MILLESIME}  |  Workspace : ${WORKSPACE}"
echo ""

# Dossier persistant (hors workspace Tylt) où le PMTiles est extrait via
# `tylt export` quand --no-upload est actif (voir plus bas).
mkdir -p output

tylt run "$PIPELINE_FILE" --env-file "$TMP_ENV" --workspace "$WORKSPACE" "$@"
PIPELINE_STATUS=$?

if [ $PIPELINE_STATUS -ne 0 ]; then
    echo ""
    echo "✗ Pipeline échouée (code $PIPELINE_STATUS). Workspace conservé pour debug : ${WORKSPACE}"
    echo "  → tylt show ${WORKSPACE}"
    echo "  → tylt logs ${WORKSPACE} <étape>"
    exit $PIPELINE_STATUS
else
    echo ""
    if [ "$NO_UPLOAD" = "1" ]; then
        tylt export "$WORKSPACE" build-pmtiles output/
        echo "✓ Pipeline terminée. PMTiles extrait vers pmtiles_generator/output/${MILLESIME}/"
    else
        echo "✓ Pipeline terminée."
    fi
    echo "Pour nettoyer le workspace :"
    echo "  → tylt rm ${WORKSPACE}"
fi
