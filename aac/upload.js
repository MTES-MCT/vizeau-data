/**
 * Pousse sur S3 les fichiers produits dans les sous-dossiers output/
 * (geometries, zonage, fiches), pour les partager avec l'équipe.
 *
 * Usage :
 *   npm run upload                       # tous les dossiers output/
 *   npm run upload -- geometries fiches  # seulement ces dossiers
 *
 * Destination : s3://<S3_BUCKET>/<S3_PREFIX>/<nom du fichier>, là où fiches
 * va chercher ses sources absentes de data/.
 *
 * Variables d'environnement (aac/.env) :
 *   S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY  requis
 *   S3_REGION    (défaut : fr-par)
 *   S3_ENDPOINT  (défaut : s3.fr-par.scw.cloud)
 *   S3_PREFIX    (défaut : vide)
 *   S3_OVERWRITE À 1, écrase les fichiers distants existants sans confirmation.
 *                Sinon, la confirmation est demandée pour chacun ; hors terminal
 *                interactif, les fichiers déjà présents sont ignorés.
 */

import { createHash, createHmac } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIRS = ["geometries", "zonage", "fiches"];

// ─── Config S3 ────────────────────────────────────────────────────────────────

const S3_BUCKET = process.env.S3_BUCKET;
const S3_ACCESS = process.env.S3_ACCESS_KEY;
const S3_SECRET = process.env.S3_SECRET_KEY;
const S3_REGION = process.env.S3_REGION || "fr-par";
const S3_ENDPOINT = process.env.S3_ENDPOINT || "s3.fr-par.scw.cloud";
const S3_PREFIX = process.env.S3_PREFIX || "";
const S3_OVERWRITE = process.env.S3_OVERWRITE === "1";

if (!S3_BUCKET || !S3_ACCESS || !S3_SECRET) {
  console.error("Variables manquantes : S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY");
  process.exit(1);
}

// ─── Requêtes S3 signées (SigV4) ──────────────────────────────────────────────

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// encodeURIComponent laisse passer !'()* que SigV4 exige encodés.
const encodeKey = (key) =>
  key
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

// Style vhost (bucket dans le nom d'hôte), comme la config DuckDB de fiches.
// Le contenu n'est pas haché (UNSIGNED-PAYLOAD) : la requête reste signée.
function s3Request(method, key, body) {
  const host = `${S3_BUCKET}.${S3_ENDPOINT}`;
  const path = `/${encodeKey(key)}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${S3_REGION}/s3/aws4_request`;

  const headers = { host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amzDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = [
    method,
    path,
    "",
    Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = ["s3", "aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(`AWS4${S3_SECRET}`, date), S3_REGION)
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  delete headers.host; // fixé par fetch à partir de l'URL
  return fetch(`https://${host}${path}`, {
    method,
    body,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${S3_ACCESS}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

async function exists(key) {
  const res = await s3Request("HEAD", key);
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`HEAD ${key} : HTTP ${res.status}`);
}

async function put(key, file) {
  const res = await s3Request("PUT", key, readFileSync(file));
  if (!res.ok) throw new Error(`PUT ${key} : HTTP ${res.status} ${await res.text()}`);
}

// ─── Fichiers à pousser ───────────────────────────────────────────────────────

const requested = process.argv.slice(2);
const unknown = requested.filter((d) => !DIRS.includes(d));
if (unknown.length) {
  console.error(`Dossier inconnu : ${unknown.join(", ")} (attendu : ${DIRS.join(", ")})`);
  process.exit(1);
}

const files = (requested.length ? requested : DIRS).flatMap((dir) => {
  const output = join(__dirname, dir, "output");
  if (!existsSync(output)) return [];
  return readdirSync(output)
    .filter((name) => !name.startsWith(".") && !name.includes(".tmp"))
    .map((name) => ({ name, file: join(output, name) }))
    .filter(({ file }) => statSync(file).isFile());
});

if (!files.length) {
  console.log("Aucun fichier à pousser dans les dossiers output/.");
  process.exit(0);
}

// ─── Upload ───────────────────────────────────────────────────────────────────

const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
let failed = false;

for (const { name, file } of files) {
  const key = S3_PREFIX ? `${S3_PREFIX}/${name}` : name;
  const dest = `s3://${S3_BUCKET}/${key}`;
  const size = `${(statSync(file).size / 1e6).toFixed(1)} Mo`;

  try {
    if (!S3_OVERWRITE && (await exists(key))) {
      const answer = rl ? await rl.question(`${dest} existe déjà. L'écraser ? (o/N) `) : "";
      if (!/^(o|oui|y|yes)$/i.test(answer.trim())) {
        console.log(`  – ${dest} conservé`);
        continue;
      }
    }

    process.stdout.write(`  ↑ ${file} → ${dest} (${size})...`);
    const t = Date.now();
    await put(key, file);
    console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.log();
    console.error(`Échec pour ${dest} : ${err.message}`);
    failed = true;
  }
}

rl?.close();
process.exit(failed ? 1 : 0);
