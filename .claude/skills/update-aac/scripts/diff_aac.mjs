/**
 * Compare deux versions d'AAC.gpkg (couche AAC_FRA) et affiche les statistiques du diff.
 *
 * Usage :
 *   node .claude/skills/update-aac/scripts/diff_aac.mjs <ancien AAC.gpkg> <nouvel AAC.gpkg>
 *
 * Code de sortie : 0 si le diff est calculé (même vide), 2 si le nouveau fichier n'a pas
 * le schéma attendu (couche AAC_FRA, champ CdAAC), 1 en cas d'erreur.
 * La dernière ligne est `CHANGEMENTS=<n>` : nombre d'AAC ajoutées, supprimées ou modifiées.
 */

import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(join(REPO, "aac", "package.json"));
const { DuckDBInstance } = require("@duckdb/node-api");

const [OLD, NEW] = process.argv.slice(2);
if (!OLD || !NEW) {
  console.error("Usage : node diff_aac.mjs <ancien AAC.gpkg> <nouvel AAC.gpkg>");
  process.exit(1);
}

const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
const q = async (sql) => (await c.runAndReadAll(sql)).getRowObjectsJson();
const lit = (s) => `'${s.replaceAll("'", "''")}'`;

await c.run("INSTALL spatial; LOAD spatial;");

const layers = (await q(`SELECT unnest(layers).name AS name FROM st_read_meta(${lit(NEW)})`)).map((r) => r.name);
if (!layers.includes("AAC_FRA")) {
  console.error(`Couche AAC_FRA absente du nouveau fichier (couches : ${layers.join(", ") || "aucune"})`);
  process.exit(2);
}

await c.run(`CREATE TABLE o AS SELECT * FROM ST_Read(${lit(OLD)}, layer='AAC_FRA')`);
await c.run(`CREATE TABLE n AS SELECT * FROM ST_Read(${lit(NEW)}, layer='AAC_FRA')`);

const cols = async (t) => (await q(`SELECT column_name FROM (DESCRIBE ${t})`)).map((r) => r.column_name);
const [colsO, colsN] = [await cols("o"), await cols("n")];
if (!colsN.includes("CdAAC")) {
  console.error("Champ CdAAC absent du nouveau fichier");
  process.exit(2);
}
const ajoutees = colsN.filter((x) => !colsO.includes(x));
const retirees = colsO.filter((x) => !colsN.includes(x));
console.log("\nSchéma");
console.log(
  ajoutees.length || retirees.length
    ? `  ⚠ champs ajoutés : ${ajoutees.join(", ") || "aucun"} ; retirés : ${retirees.join(", ") || "aucun"}`
    : "  ✓ identique",
);

console.log("\nTotaux");
console.table(
  await q(`
    SELECT 'avant' AS version, count(*) AS aac, count(*) FILTER (WHERE COALESCE(PTP, '[]') NOT IN ('', '[]')) AS avec_ptp,
           count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS geom_invalides, max(DateMajAAC)::VARCHAR AS derniere_maj
    FROM o
    UNION ALL
    SELECT 'apres', count(*), count(*) FILTER (WHERE COALESCE(PTP, '[]') NOT IN ('', '[]')),
           count(*) FILTER (WHERE NOT ST_IsValid(geom)), max(DateMajAAC)::VARCHAR
    FROM n`),
);

const doublons = await q(`SELECT CdAAC, count(*) n FROM n GROUP BY CdAAC HAVING count(*) > 1`);
if (doublons.length) console.log(`  ⚠ codes en double dans le nouveau fichier : ${doublons.map((d) => d.CdAAC).join(", ")}`);

const entrees = await q(`
  SELECT 'ajoutée' AS cas, CdAAC, NomDeAACAdministratif AS nom, DateCreationAAC::VARCHAR AS creation,
         DateMajAAC::VARCHAR AS maj, NomCircAdminBassin AS bassin
  FROM n WHERE CdAAC NOT IN (SELECT CdAAC FROM o)
  UNION ALL
  SELECT 'supprimée', CdAAC, NomDeAACAdministratif, DateCreationAAC::VARCHAR, DateMajAAC::VARCHAR, NomCircAdminBassin
  FROM o WHERE CdAAC NOT IN (SELECT CdAAC FROM n)
  ORDER BY cas, CdAAC`);
console.log("\nAAC ajoutées ou supprimées");
if (entrees.length) console.table(entrees);
else console.log("  aucune");

// Surface en km² calculée sur l'ellipsoïde (coordonnées en WGS84, ordre lon/lat).
const surface = (g) => `ST_Area_Spheroid(ST_FlipCoordinates(${g})) / 1e6`;
// Une géométrie est modifiée quand la différence symétrique dépasse 1e-6 de sa surface :
// en deçà, seuls les arrondis des coordonnées ont changé (écarts de l'ordre de 1e-10).
const SEUIL_GEOM = 1e-6;
await c.run(`
  CREATE TABLE m AS
  WITH j AS (
    SELECT CdAAC, o.geom AS g_o, n.geom AS g_n, NOT ST_Equals(o.geom, n.geom) AS geom_diff
    FROM o JOIN n USING (CdAAC)
  ), ecart AS (
    SELECT CdAAC,
           CASE WHEN geom_diff THEN
             ST_Area(ST_Difference(ST_Union(g_o, g_n), ST_Intersection(g_o, g_n))) / NULLIF(ST_Area(g_n), 0)
           ELSE 0 END AS ecart_rel
    FROM j
  )
  SELECT CdAAC, o.NomDeAACAdministratif AS nom_avant, n.NomDeAACAdministratif AS nom_apres,
         n.NomCircAdminBassin AS bassin,
         o.DateMajAAC::VARCHAR AS maj_avant, n.DateMajAAC::VARCHAR AS maj_apres,
         COALESCE(ecart_rel, 1) > ${SEUIL_GEOM} AS geom,
         ecart_rel > 0 AND ecart_rel <= ${SEUIL_GEOM} AS geom_arrondi,
         o.PTP IS DISTINCT FROM n.PTP AS ptp,
         o.NomDeAACAdministratif IS DISTINCT FROM n.NomDeAACAdministratif AS nom_modif,
         o.StAAC IS DISTINCT FROM n.StAAC AS statut,
         o.DateMajAAC IS DISTINCT FROM n.DateMajAAC AS date_maj,
         round(${surface("o.geom")}, 2) AS km2_avant, round(${surface("n.geom")}, 2) AS km2_apres
  FROM o JOIN n USING (CdAAC) JOIN ecart USING (CdAAC)`);
await c.run(`DELETE FROM m WHERE NOT (geom OR geom_arrondi OR ptp OR nom_modif OR statut OR date_maj)`);

console.log("\nAAC modifiées, par type de changement");
console.table(
  await q(`
    SELECT count(*) AS modifiees, count(*) FILTER (WHERE geom) AS geometrie,
           count(*) FILTER (WHERE geom_arrondi) AS geometrie_arrondi, count(*) FILTER (WHERE ptp) AS ptp,
           count(*) FILTER (WHERE nom_modif) AS nom, count(*) FILTER (WHERE statut) AS statut,
           count(*) FILTER (WHERE date_maj) AS date_maj
    FROM m`),
);

const parBassin = await q(`
  SELECT bassin, count(*) AS modifiees FROM m GROUP BY bassin ORDER BY modifiees DESC, bassin`);
if (parBassin.length) {
  console.log("\nAAC modifiées par bassin");
  console.table(parBassin);
}

const statuts = await q(`
  SELECT o.StAAC AS avant, n.StAAC AS apres, count(*) AS aac
  FROM o JOIN n USING (CdAAC) WHERE o.StAAC IS DISTINCT FROM n.StAAC GROUP BY ALL ORDER BY aac DESC`);
if (statuts.length) {
  console.log("\nChangements de statut (StAAC)");
  console.table(statuts);
}

const detail = await q(`
  SELECT CdAAC, nom_apres AS nom, CASE WHEN nom_modif THEN nom_avant END AS ancien_nom, maj_avant, maj_apres,
         COALESCE(NULLIF(concat_ws(', ', CASE WHEN geom THEN 'géométrie' END, CASE WHEN geom_arrondi THEN 'arrondis géom.' END,
                   CASE WHEN ptp THEN 'PTP' END, CASE WHEN nom_modif THEN 'nom' END,
                   CASE WHEN statut THEN 'statut' END), ''), 'date de MAJ seule') AS changements,
         CASE WHEN geom THEN km2_avant END AS km2_avant, CASE WHEN geom THEN km2_apres END AS km2_apres
  FROM m ORDER BY CdAAC::BIGINT`);
if (detail.length) {
  console.log("\nDétail des AAC modifiées");
  console.table(detail);
}

// ─── Codes dont l'aire désignée change ────────────────────────────────────────
// Vizeau utilise CdAAC comme identifiant : un code qui désigne une autre aire est à
// vérifier avant publication. Le diff seul ne dit pas dans quel sens va l'erreur :
// réattribution d'un code, ou correction d'un code erroné dans la version précédente
// (cas de novembre 2026 : 1694 et 5464 étaient des doublons de 5490 et 5455 depuis le
// 9 juillet, et ont retrouvé leur aire d'origine). Les sections suivantes aident à trancher.
const aireChange = await q(`
  SELECT CdAAC, nom_avant, nom_apres, km2_avant, km2_apres
  FROM m
  WHERE nom_modif AND geom AND km2_avant > 0 AND km2_apres > 0
    AND greatest(km2_avant / km2_apres, km2_apres / km2_avant) >= 2
  ORDER BY CdAAC::BIGINT`);
if (aireChange.length) {
  console.log("\n⚠ Codes dont l'aire désignée change (nom changé et surface ×2 ou plus) : réattribution ou correction, à vérifier");
  console.table(aireChange);
}

// Deux géométries sont « la même aire » quand leur différence symétrique est sous SEUIL_GEOM.
const memeAire = (a, b) => `
  ST_Equals(${a}, ${b}) OR (
    abs(ST_Area(${a}) - ST_Area(${b})) <= ${SEUIL_GEOM} * ST_Area(${b})
    AND ST_Area(ST_Difference(ST_Union(${a}, ${b}), ST_Intersection(${a}, ${b}))) <= ${SEUIL_GEOM} * ST_Area(${b}))`;

// Une aire qui passe d'un code à un autre : signe d'une correction (l'aire retrouve
// son code) ou d'un changement de code de la même AAC.
const deplacees = await q(`
  SELECT o.CdAAC AS code_avant, n.CdAAC AS code_apres, o.NomDeAACAdministratif AS nom_avant,
         n.NomDeAACAdministratif AS nom_apres,
         round(${surface("n.geom")}, 2) AS km2,
         EXISTS (SELECT 1 FROM n n2 WHERE n2.CdAAC = o.CdAAC) AS code_avant_existe_encore
  FROM o JOIN n ON o.CdAAC <> n.CdAAC AND ST_Intersects(o.geom, n.geom) AND (${memeAire("o.geom", "n.geom")})
  -- l'aire était déjà sous code_apres avant : ce n'est pas un déplacement, mais un doublon (voir plus bas)
  WHERE NOT EXISTS (SELECT 1 FROM o o2 WHERE o2.CdAAC = n.CdAAC AND (${memeAire("o2.geom", "n.geom")}))
  ORDER BY code_avant::BIGINT`);
if (deplacees.length) {
  console.log("\n⚠ Aires qui changent de code (même géométrie, à la précision près, sous un autre code)");
  console.table(deplacees);
}

// Quasi-doublons : deux codes dont les aires se recouvrent à SEUIL_DOUBLON (IoU) ou plus.
// Il en existe de légitimes (plusieurs captages d'un même bassin, AAC remplacée par un
// nouveau code) : seuls ceux qui apparaissent ou disparaissent entre les deux versions
// sont listés. En novembre 2026, 1694 ≈ 5490 (IoU 0,9999) avait disparu.
const SEUIL_DOUBLON = 0.99;
const doublonsDe = async (t) =>
  q(`SELECT a.CdAAC::VARCHAR || ' ≈ ' || b.CdAAC::VARCHAR AS paire,
            a.NomDeAACAdministratif AS nom_a, b.NomDeAACAdministratif AS nom_b,
            round(ST_Area(ST_Intersection(a.geom, b.geom)) / ST_Area(ST_Union(a.geom, b.geom)), 4) AS iou
     FROM ${t} a JOIN ${t} b ON a.CdAAC < b.CdAAC AND ST_Intersects(a.geom, b.geom)
     WHERE ST_Area(ST_Intersection(a.geom, b.geom)) >= ${SEUIL_DOUBLON} * ST_Area(ST_Union(a.geom, b.geom))`);
const [dO, dN] = [await doublonsDe("o"), await doublonsDe("n")];
const pairesO = new Set(dO.map((d) => d.paire));
const pairesN = new Set(dN.map((d) => d.paire));
const doublonsAire = [
  ...dN.filter((d) => !pairesO.has(d.paire)).map((d) => ({ etat: "⚠ apparu", ...d })),
  ...dO.filter((d) => !pairesN.has(d.paire)).map((d) => ({ etat: "disparu", ...d })),
];
console.log(
  `\nQuasi-doublons (IoU ≥ ${SEUIL_DOUBLON}) : ${dO.length} avant, ${dN.length} après` +
    (doublonsAire.length ? " ; changements :" : " ; aucun changement"),
);
if (doublonsAire.length) console.table(doublonsAire);

// PTP cités par plusieurs codes : un même point de prélèvement rattaché à deux AAC est
// normal pour des aires emboîtées, mais signale aussi un doublon ou un code erroné.
const ptpMulti = async (t) =>
  q(`WITH p AS (
       SELECT CdAAC, NomDeAACAdministratif AS nom, unnest(from_json(PTP, '["json"]')) ->> 'CdPointPrelevement' AS ptp
       FROM ${t} WHERE COALESCE(PTP, '[]') NOT IN ('', '[]'))
     SELECT ptp, string_agg(CdAAC::VARCHAR || ' ' || nom, ' | ' ORDER BY CdAAC) AS aac
     FROM p GROUP BY ptp HAVING count(DISTINCT CdAAC) > 1`);
const [pO, pN] = [await ptpMulti("o"), await ptpMulti("n")];
const ptps = [...new Set([...pO, ...pN].map((p) => p.ptp))].sort().map((ptp) => ({
  ptp,
  avant: pO.find((x) => x.ptp === ptp)?.aac ?? "",
  apres: pN.find((x) => x.ptp === ptp)?.aac ?? "",
}));
const ptpChanges = ptps.filter((p) => p.avant !== p.apres);
console.log(
  `\nPTP cités par plusieurs codes : ${pO.length} avant, ${pN.length} après` +
    (ptpChanges.length ? ` ; ${ptpChanges.length} cas qui changent :` : " ; aucun changement"),
);
if (ptpChanges.length) console.table(ptpChanges);

const nb = entrees.length + detail.length;
console.log(`\nCHANGEMENTS=${nb}`);
