// ─── Normalisation des codes ──────────────────────────────────────────────────
//
// Les fichiers passés par un tableur perdent les zéros initiaux des codes
// (INS `57002293` pour `057002293`, PSV `570000002805` pour `0570000002805`,
// indice BSS `6952X0015` pour `06952X0015`). Ces macros remettent un code dans
// son format de référence, ou renvoient NULL s'il n'est pas reconnaissable :
//
//   norm_ins        code installation SISE-Eaux, 9 caractères (`057002293`, `02A004625`) ;
//                   le préfixe `Sise` parfois présent dans les exports est retiré
//   norm_psv        code point de surveillance, 13 caractères (`0570000002805`)
//   norm_bss_indice ancien code BSS, indice seul sans la désignation
//                   (`06992X0035/P1` → `06992X0035`)
//   norm_bss_id     nouveau code BSS (`BSS002HYFB`)
//   bss_designation partie après le `/` d'un code BSS complet (`P1`)
//   coord           coordonnée écrite avec une virgule ou un point décimal
//
// Les codes BSS « BRGM » (`code_bss_en_bss`) sont toujours complets
// (`indice/désignation`) ; ceux saisis côté ARS (`indice_bss_sise`) contiennent
// des espaces, des valeurs fantaisistes (`XXX`, `789-6-`) et parfois déjà le
// nouveau format : c'est pourquoi les deux formats sont reconnus partout. Les
// indices bouche-trou (`9999X9999`, `00000XCODE`, `00000X0000`), partagés par
// des dizaines de captages, sont écartés.
//
// Partagées par generate_captages_parquet.js et generate_prioritaires.js.
export const NORMALISATION_MACROS = `
  CREATE MACRO code_brut(x) AS regexp_replace(upper(trim(x)), '^SISE', '');
  CREATE MACRO norm_ins(x) AS CASE
    WHEN regexp_matches(code_brut(x), '^([0-9]{7,9}|2[AB][0-9]{6})$') THEN lpad(code_brut(x), 9, '0')
    WHEN regexp_matches(code_brut(x), '^02[AB][0-9]{6}$') THEN code_brut(x)
  END;
  CREATE MACRO norm_psv(x) AS CASE
    WHEN regexp_matches(code_brut(x), '^([0-9]{11,13}|2[AB][0-9]{10})$') THEN lpad(code_brut(x), 13, '0')
    WHEN regexp_matches(code_brut(x), '^02[AB][0-9]{10}$') THEN code_brut(x)
  END;
  CREATE MACRO bss_partie(x) AS upper(trim(split_part(x, '/', 1)));
  CREATE MACRO bss_indice_complet(x) AS CASE
    WHEN regexp_matches(bss_partie(x), '^[0-9]{4}[A-Z][0-9A-Z]{4}$') THEN '0' || bss_partie(x)
    WHEN regexp_matches(bss_partie(x), '^[0-9]{4}[0-9A-Z]{6}$') THEN bss_partie(x)
  END;
  CREATE MACRO norm_bss_indice(x) AS CASE
    WHEN left(bss_indice_complet(x), 5) NOT IN ('00000', '09999', '99999') THEN bss_indice_complet(x)
  END;
  CREATE MACRO norm_bss_id(x) AS CASE
    WHEN regexp_matches(bss_partie(x), '^BSS[0-9A-Z]{7}$') THEN bss_partie(x)
  END;
  CREATE MACRO bss_designation(x) AS NULLIF(upper(trim(split_part(x, '/', 2))), '');
  CREATE MACRO coord(x) AS TRY_CAST(replace(x, ',', '.') AS DOUBLE);
`
