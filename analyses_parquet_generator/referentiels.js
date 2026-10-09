/**
 * Logique d'enrichissement des paramètres d'analyse (libellé, fonction,
 * limite et référence de qualité), en fonctions pures pour pouvoir la tester.
 *
 * Tous ces enrichissements ne dépendent que du `code_parametre` : on les
 * calcule donc une seule fois par paramètre (~1 000 entrées), puis DuckDB
 * les joint aux millions de lignes d'analyses.
 */

/**
 * Normalise une chaîne : minuscules, trim, suppression des accents,
 * et réduction des espaces multiples.
 */
export function normalizeString(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * Cherche `value` dans un référentiel clé normalisée → valeur : d'abord par
 * égalité stricte, puis par inclusion de sous-chaîne dans un sens ou dans
 * l'autre (clés de 3 caractères minimum). En cas d'inclusion, c'est la
 * première clé du référentiel (ordre du fichier) qui gagne.
 *
 * @returns {{ value: string, key: string, exact: boolean } | null}
 */
export function findReferenceMatch(map, value) {
  const key = normalizeString(value)
  if (!key) return null

  const exact = map.get(key)
  if (exact) return { value: exact, key, exact: true }

  if (key.length < 3) return null

  for (const [refKey, refValue] of map) {
    if (refKey.length < 3) continue
    if (key.includes(refKey) || refKey.includes(key)) {
      return { value: refValue, key: refKey, exact: false }
    }
  }

  return null
}

/**
 * Uniformise un nombre de seuil (séparateurs `.`/`,` de milliers ou de
 * décimales) et le restitue avec une virgule décimale.
 */
export function normalizeThresholdNumber(value) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
  if (!cleaned) return ''

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')

  let normalized
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.')
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '')
  } else {
    normalized = cleaned
  }

  const num = Number.parseFloat(normalized)
  if (Number.isNaN(num)) return cleaned

  return String(num).replace('.', ',')
}

/** Harmonise les variantes typographiques d'unités. */
export function normalizeThresholdUnit(rawUnit) {
  return String(rawUnit ?? '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/°\s*C/gi, '°C')
    .replace(/Unité pH/g, 'unité pH')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Recompose une limite de qualité au format canonique `<=<nombre> <unité>`. */
export function formatLimiteQualite(value) {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return ''

  const withoutLeadingOperator = cleaned.replace(/^(<=?|>=?)\s*/, '').trim()
  const match = withoutLeadingOperator.match(/^([\d.,]+)\s*(.*)$/)
  if (!match) return ''

  const [, numericRaw, unitRaw] = match
  const numeric = normalizeThresholdNumber(numericRaw)
  const unit = normalizeThresholdUnit(unitRaw)
  return `<=${numeric}${unit ? ` ${unit}` : ''}`
}

/**
 * Recompose une référence de qualité au format canonique : intervalle
 * `>=a et <=b <unité>` ou seuil `<=a <unité>`, avec deux cas particuliers
 * connus dans `reference_qualite.csv`.
 */
export function formatReferenceQualite(value) {
  const cleaned = String(value ?? '').trim()
  if (!cleaned) return ''

  const normalized = cleaned.replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/\s+/g, ' ').trim()

  // Conductivité : la source donne deux intervalles (selon la température de
  // mesure, 20 °C ou 25 °C) ; on ne retient que celui à 25 °C.
  if (/^>=?\s*180\s*et\s*<=?\s*1\s*000\s*ou\s*>=?\s*200\s*et\s*<=?\s*1\s*100/i.test(normalized)) {
    return '>=200 et <=1100 µS/cm'
  }

  // COT : « 2 et aucun changement anormal » → seul le seuil chiffré est gardé.
  if (/^2\s+et\s+aucun\s+changement\s+anormal/i.test(normalized)) {
    return '<=2 mg(C)/L'
  }

  const formatRange = (lowRaw, highRaw, unitRaw) => {
    const low = normalizeThresholdNumber(lowRaw)
    const high = normalizeThresholdNumber(highRaw)
    const unit = normalizeThresholdUnit(unitRaw)
    return `>=${low} et <=${high}${unit ? ` ${unit}` : ''}`
  }

  const rangeWithBounds = normalized.match(/^>=?\s*([\d.,]+)\s*et\s*<=?\s*([\d.,]+)\s*(.*)$/i)
  if (rangeWithBounds) return formatRange(...rangeWithBounds.slice(1))

  const plainRange = normalized.match(/^([\d.,]+)\s*(?:-|a|à)\s*([\d.,]+)\s*(.*)$/i)
  if (plainRange) return formatRange(...plainRange.slice(1))

  const simpleThreshold = normalized.match(/^(?:<=?|>=?)?\s*([\d.,]+)\s*(.*)$/i)
  if (simpleThreshold) {
    const [, numericRaw, unitRaw] = simpleThreshold
    const numeric = normalizeThresholdNumber(numericRaw)
    const unit = normalizeThresholdUnit(unitRaw)
    return `<=${numeric}${unit ? ` ${unit}` : ''}`
  }

  return ''
}

/**
 * Construit un référentiel clé normalisée → valeur à partir de lignes
 * `[clé, valeur, ...]` (en-tête déjà retiré). En cas de doublon, la première
 * occurrence est conservée.
 */
export function buildKeyValueMap(rows) {
  const map = new Map()
  for (const [rawKey, rawValue] of rows) {
    const key = normalizeString(rawKey)
    const value = String(rawValue ?? '').trim()
    if (!key || !value || map.has(key)) continue
    map.set(key, value)
  }
  return map
}

// Mêmes motifs que `SQL_DEP_REGL` / `SQL_DEP_ALERTE` de Viz'eau
// (`app/services/aac_service.ts`), cherchés n'importe où dans la chaîne. Dans
// un intervalle `>=X et <=Y`, le premier `<=` est donc celui de `Y`.
const SEUIL_MAX = /<=([0-9][0-9,.]*)/
const SEUIL_MIN = />=([0-9][0-9,.]*) et/

/**
 * Convertit le nombre capturé (décimale `,` ou `.`) en nombre, ou `null`
 * s'il n'est pas lisible (comme le `TRY_CAST` de Viz'eau).
 */
function parseSeuil(match) {
  if (!match) return null
  const num = Number(match[1].replace(/,/g, '.'))
  return Number.isFinite(num) ? num : null
}

/**
 * Extrait les seuils numériques d'une limite et d'une référence de qualité
 * (voir « Format des seuils » dans `formats-parquet.md`) :
 *
 * - `seuil_regl` : `X` si `limite_qualite` est de la forme `<=X` ;
 * - `seuil_alerte_min` : `X` si `reference_qualite` est de la forme
 *   `>=X et <=Y` ;
 * - `seuil_alerte_max` : `X` si `<=X`, `Y` si `>=X et <=Y`.
 *
 * Tout autre format donne `null` : pas de seuil, donc pas de dépassement.
 */
export function extractSeuils(limiteQualite, referenceQualite) {
  const limite = String(limiteQualite ?? '')
  const reference = String(referenceQualite ?? '')
  return {
    seuil_regl: parseSeuil(limite.match(SEUIL_MAX)),
    seuil_alerte_min: parseSeuil(reference.match(SEUIL_MIN)),
    seuil_alerte_max: parseSeuil(reference.match(SEUIL_MAX)),
  }
}

/**
 * Calcule l'enrichissement de chaque paramètre de `parametres.json`.
 *
 * - `libelle_parametre` : libellé du paramètre, sans espaces de début et de
 *   fin (dernier gagnant si un code est présent plusieurs fois).
 * - `fonction` : première substance de `substances_par_fonction.csv` dont le
 *   nom est contenu dans le libellé.
 * - `limite_qualite` / `reference_qualite` : lues dans `seuilsParCode` (code
 *   paramètre → `{ limite_qualite, reference_qualite }`, chaîne vide si le
 *   paramètre n'a pas de seuil) quand le code y figure ; sinon recherchées
 *   par libellé, puis par fonction à défaut. Elles sont mises au format
 *   canonique.
 * - `seuil_regl`, `seuil_alerte_min`, `seuil_alerte_max` : seuils numériques
 *   extraits de ces deux chaînes canoniques (voir `extractSeuils`).
 *
 * Les correspondances non exactes (par sous-chaîne) sont renvoyées à part
 * dans `approximations` pour pouvoir être contrôlées, et les codes absents de
 * `seuilsParCode` dans `codesSansSeuilConnu`. Les codes de `seuilsParCode`
 * absents de `parametres` sont ajoutés, sans libellé.
 */
export function buildParametresEnrichis({
  parametres,
  substancesParFonction,
  limitesQualite,
  referencesQualite,
  seuilsParCode = new Map(),
}) {
  const fonctions = new Map()
  for (const { substance, fonction } of substancesParFonction) {
    const key = normalizeString(substance)
    if (key) fonctions.set(key, fonction ?? '')
  }

  const libelles = new Map()
  for (const p of parametres ?? []) {
    libelles.set(String(p.code_parametre), String(p.libelle ?? '').trim())
  }
  for (const code of seuilsParCode.keys()) {
    if (!libelles.has(code)) libelles.set(code, '')
  }

  const lignes = []
  const approximations = []
  const codesSansSeuilConnu = []

  const lookup = (champ, map, code, libelle, fonction) => {
    const match = findReferenceMatch(map, libelle) ?? findReferenceMatch(map, fonction)
    if (match && !match.exact) {
      approximations.push({ champ, code_parametre: code, libelle, fonction, cle_referentiel: match.key })
    }
    return match?.value ?? ''
  }

  for (const [code, libelle] of libelles) {
    const libelleNormalise = normalizeString(libelle)
    let fonction = ''
    for (const [substance, f] of fonctions) {
      if (libelleNormalise.includes(substance)) {
        fonction = f
        break
      }
    }

    const seuils = seuilsParCode.get(code)
    if (!seuils) codesSansSeuilConnu.push(code)
    const seuil = (champ, map) => seuils?.[champ] ?? lookup(champ, map, code, libelle, fonction)

    const limiteQualite = formatLimiteQualite(seuil('limite_qualite', limitesQualite)) || null
    const referenceQualite = formatReferenceQualite(seuil('reference_qualite', referencesQualite)) || null
    lignes.push({
      code_parametre: code,
      libelle_parametre: libelle || null,
      fonction: fonction || null,
      limite_qualite: limiteQualite,
      reference_qualite: referenceQualite,
      ...extractSeuils(limiteQualite, referenceQualite),
    })
  }

  return { lignes, approximations, codesSansSeuilConnu }
}
