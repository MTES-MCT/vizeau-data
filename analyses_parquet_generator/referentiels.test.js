import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildKeyValueMap,
  buildParametresEnrichis,
  extractSeuils,
  findReferenceMatch,
  formatLimiteQualite,
  formatReferenceQualite,
  normalizeString,
  normalizeThresholdNumber,
  normalizeThresholdUnit,
} from './referentiels.js'

describe('normalizeString', () => {
  it('passe en minuscules, retire accents et espaces superflus', () => {
    assert.equal(normalizeString('  Activité   Béta '), 'activite beta')
    assert.equal(normalizeString(null), '')
  })
})

describe('findReferenceMatch', () => {
  const map = buildKeyValueMap([
    ['Arsenic', '10 µg/L'],
    ['Pesticides (par substance individuelle).', '0,10 µg/L'],
    ['Atrazine', '0,05 µg/L'],
    ['pH', '6,5'],
  ])

  it('trouve une correspondance exacte après normalisation', () => {
    assert.deepEqual(findReferenceMatch(map, 'ARSENIC'), { value: '10 µg/L', key: 'arsenic', exact: true })
  })

  it('trouve une correspondance par inclusion, dans les deux sens', () => {
    assert.equal(findReferenceMatch(map, 'Arsenic total').exact, false)
    assert.equal(findReferenceMatch(map, 'Pesticides').value, '0,10 µg/L')
  })

  it('retient la première clé du référentiel en cas de correspondances multiples', () => {
    // « atrazine déséthyl » contient « atrazine », mais aucune clé plus haut
    // dans le fichier ne correspond : c'est donc la limite de l'atrazine.
    assert.equal(findReferenceMatch(map, 'Atrazine déséthyl').key, 'atrazine')
  })

  it("n'applique pas l'inclusion aux libellés de moins de 3 caractères", () => {
    assert.equal(findReferenceMatch(map, 'ph').exact, true)
    assert.equal(findReferenceMatch(map, 'as'), null)
    assert.equal(findReferenceMatch(map, ''), null)
  })
})

describe('buildKeyValueMap', () => {
  it('garde la première occurrence et ignore les lignes vides', () => {
    const map = buildKeyValueMap([
      ['Nitrates', '50 mg/L'],
      ['NITRATES', '25 mg/L'],
      ['', 'x'],
      ['Nitrites', ''],
    ])
    assert.deepEqual([...map], [['nitrates', '50 mg/L']])
  })
})

describe('normalizeThresholdNumber', () => {
  it('uniformise les séparateurs et restitue une virgule décimale', () => {
    assert.equal(normalizeThresholdNumber('3.14'), '3,14')
    assert.equal(normalizeThresholdNumber('3,14'), '3,14')
    assert.equal(normalizeThresholdNumber('1 000'), '1000')
    assert.equal(normalizeThresholdNumber('1.000,5'), '1000,5')
    assert.equal(normalizeThresholdNumber('0,10'), '0,1')
  })
})

describe('normalizeThresholdUnit', () => {
  it('harmonise les variantes typographiques', () => {
    assert.equal(normalizeThresholdUnit('µS / cm'), 'µS/cm')
    assert.equal(normalizeThresholdUnit('°  C'), '°C')
    assert.equal(normalizeThresholdUnit('Unité pH'), 'unité pH')
  })
})

describe('formatLimiteQualite', () => {
  it('produit un seuil canonique', () => {
    assert.equal(formatLimiteQualite('0,10 µg/L'), '<=0,1 µg/L')
    assert.equal(formatLimiteQualite('< 100'), '<=100')
    assert.equal(formatLimiteQualite('<=100 µS / cm'), '<=100 µS/cm')
  })

  it('renvoie une chaîne vide si aucun nombre en tête', () => {
    assert.equal(formatLimiteQualite('Absence'), '')
    assert.equal(formatLimiteQualite(''), '')
  })
})

describe('formatReferenceQualite', () => {
  it('traite les cas particuliers de la conductivité et du COT', () => {
    assert.equal(
      formatReferenceQualite('≥ 180 et ≤ 1 000 ou ≥ 200 et ≤ 1 100 µS/ cmà 20° C, µS/ cmà 25° C'),
      '>=200 et <=1100 µS/cm'
    )
    assert.equal(formatReferenceQualite('2 et aucun changement anormal mg/ L'), '<=2 mg(C)/L')
  })

  it('reconnaît les intervalles bornés et simples', () => {
    assert.equal(formatReferenceQualite('≥ 6,5 et ≤ 9 unité pH'), '>=6,5 et <=9 unité pH')
    assert.equal(formatReferenceQualite('100-500 ppm'), '>=100 et <=500 ppm')
    assert.equal(formatReferenceQualite('6,5 à 9'), '>=6,5 et <=9')
  })

  it('reconnaît un seuil simple', () => {
    assert.equal(formatReferenceQualite('200 µg/ L'), '<=200 µg/L')
    assert.equal(formatReferenceQualite('Acceptable'), '')
  })
})

describe('extractSeuils', () => {
  const vide = { seuil_regl: null, seuil_alerte_min: null, seuil_alerte_max: null }

  it('lit le seuil réglementaire `<=X`', () => {
    assert.deepEqual(extractSeuils('<=0,1 µg/L', null), { ...vide, seuil_regl: 0.1 })
    assert.equal(extractSeuils('<=50 mg/L', null).seuil_regl, 50)
  })

  it("lit le seuil d'alerte simple `<=X`", () => {
    assert.deepEqual(extractSeuils(null, '<=2 NFU'), { ...vide, seuil_alerte_max: 2 })
  })

  it("lit l'intervalle d'alerte `>=X et <=Y`", () => {
    assert.deepEqual(extractSeuils(null, '>=6,5 et <=9 unité pH'), { ...vide, seuil_alerte_min: 6.5, seuil_alerte_max: 9 })
    assert.deepEqual(extractSeuils(null, '>=200 et <=1100 µS/cm'), { ...vide, seuil_alerte_min: 200, seuil_alerte_max: 1100 })
  })

  it('accepte la décimale `.` comme `,`', () => {
    assert.equal(extractSeuils('<=0.1 µg/L', null).seuil_regl, 0.1)
    assert.deepEqual(extractSeuils(null, '>=6.5 et <=9.5'), { ...vide, seuil_alerte_min: 6.5, seuil_alerte_max: 9.5 })
  })

  it('renvoie null pour tout autre format', () => {
    assert.deepEqual(extractSeuils(null, null), vide)
    assert.deepEqual(extractSeuils('', ''), vide)
    assert.deepEqual(extractSeuils('0,1 µg/L', 'aucun changement anormal'), vide)
    assert.deepEqual(extractSeuils('>=5 mg/L', '<5 NFU'), vide)
    assert.equal(extractSeuils('<=1.000.5', null).seuil_regl, null)
  })
})

describe('buildParametresEnrichis', () => {
  const { lignes, approximations } = buildParametresEnrichis({
    parametres: [
      { code_parametre: 1340, libelle: 'Nitrates (en NO3)' },
      { code_parametre: 1107, libelle: 'Atrazine' },
      { code_parametre: 1369, libelle: 'Arsenic' },
      { code_parametre: 9999, libelle: '' },
      { code_parametre: 1369, libelle: 'Arsenic total' },
    ],
    substancesParFonction: [{ substance: 'atrazine', fonction: 'Herbicide' }],
    limitesQualite: buildKeyValueMap([
      ['Nitrates', '50 mg/L'],
      ['Herbicide', '0,1 µg/L'],
      ['Arsenic', '10 µg/L'],
    ]),
    referencesQualite: buildKeyValueMap([]),
  })
  const parCode = Object.fromEntries(lignes.map((l) => [l.code_parametre, l]))

  it('calcule fonction et limite, par libellé puis par fonction', () => {
    assert.deepEqual(parCode['1107'], {
      code_parametre: '1107',
      libelle_parametre: 'Atrazine',
      fonction: 'Herbicide',
      limite_qualite: '<=0,1 µg/L',
      reference_qualite: null,
      seuil_regl: 0.1,
      seuil_alerte_min: null,
      seuil_alerte_max: null,
    })
    assert.equal(parCode['1340'].limite_qualite, '<=50 mg/L')
  })

  it('retire les espaces de début et de fin du libellé', () => {
    const { lignes } = buildParametresEnrichis({
      parametres: [{ code_parametre: 1107, libelle: '  Atrazine ' }],
      substancesParFonction: [],
      limitesQualite: new Map(),
      referencesQualite: new Map(),
    })
    assert.equal(lignes[0].libelle_parametre, 'Atrazine')
  })

  it('garde le dernier libellé pour un code en double', () => {
    assert.equal(lignes.length, 4)
    assert.equal(parCode['1369'].libelle_parametre, 'Arsenic total')
  })

  it('renvoie NULL plutôt que des chaînes vides', () => {
    assert.deepEqual(parCode['9999'], {
      code_parametre: '9999',
      libelle_parametre: null,
      fonction: null,
      limite_qualite: null,
      reference_qualite: null,
      seuil_regl: null,
      seuil_alerte_min: null,
      seuil_alerte_max: null,
    })
  })

  it('signale les correspondances approchées', () => {
    assert.deepEqual(
      approximations.map((a) => [a.code_parametre, a.cle_referentiel]),
      [
        ['1340', 'nitrates'],
        ['1369', 'arsenic'],
      ]
    )
  })
})

describe('buildParametresEnrichis avec seuilsParCode', () => {
  const { lignes, approximations, codesSansSeuilConnu } = buildParametresEnrichis({
    parametres: [
      { code_parametre: 1107, libelle: 'Atrazine' },
      { code_parametre: 1537, libelle: 'Pyrène' },
      { code_parametre: 1295, libelle: 'Turbidité néphélométrique NFU' },
      { code_parametre: 1340, libelle: 'Nitrates (en NO3)' },
    ],
    substancesParFonction: [],
    limitesQualite: buildKeyValueMap([
      ['Nitrates', '50 mg/L'],
      ['Benzo(a)pyrène', '0,01 µg/L'],
    ]),
    referencesQualite: buildKeyValueMap([
      ['Turbidité', '0,5 NFU'],
      ['Nitrates', '25 mg/L'],
    ]),
    seuilsParCode: new Map([
      ['1107', { limite_qualite: '<=0.1 µg/L', reference_qualite: '' }],
      ['1537', { limite_qualite: '', reference_qualite: '' }],
      ['1295', { limite_qualite: '<=1 NFU', reference_qualite: '<=2 NFU' }],
      ['6276', { limite_qualite: '<=0,5 µg/L', reference_qualite: '' }],
    ]),
  })
  const parCode = Object.fromEntries(lignes.map((l) => [l.code_parametre, l]))

  it('prend les seuils du code, au format canonique', () => {
    assert.equal(parCode['1107'].limite_qualite, '<=0,1 µg/L')
    assert.equal(parCode['1295'].limite_qualite, '<=1 NFU')
    assert.equal(parCode['1295'].reference_qualite, '<=2 NFU')
  })

  it('en extrait les seuils numériques', () => {
    assert.equal(parCode['1107'].seuil_regl, 0.1)
    assert.equal(parCode['1107'].seuil_alerte_max, null)
    assert.equal(parCode['1295'].seuil_regl, 1)
    assert.equal(parCode['1295'].seuil_alerte_max, 2)
    assert.equal(parCode['1537'].seuil_regl, null)
  })

  it("n'applique pas les correspondances floues à un code connu sans seuil", () => {
    assert.equal(parCode['1537'].limite_qualite, null)
    assert.equal(parCode['1107'].reference_qualite, null)
  })

  it('se rabat sur le libellé pour un code inconnu et le signale', () => {
    assert.equal(parCode['1340'].limite_qualite, '<=50 mg/L')
    assert.equal(parCode['1340'].reference_qualite, '<=25 mg/L')
    assert.deepEqual(codesSansSeuilConnu, ['1340'])
    assert.deepEqual(
      approximations.map((a) => [a.champ, a.code_parametre]),
      [
        ['limite_qualite', '1340'],
        ['reference_qualite', '1340'],
      ]
    )
  })

  it('ajoute, sans libellé, les codes absents de parametres', () => {
    assert.equal(parCode['6276'].libelle_parametre, null)
    assert.equal(parCode['6276'].limite_qualite, '<=0,5 µg/L')
  })
})
