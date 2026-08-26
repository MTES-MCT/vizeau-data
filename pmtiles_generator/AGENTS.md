# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

A multi-source Tylt pipeline generator that produces a multi-layer PMTiles file (via
FlatGeobuf + tippecanoe) from RPG (Registre Parcellaire Graphique) open data. Each **pipeline**
(a way of obtaining RPG parcels) has its own definition in `pipelines/<pipeline>.yaml` and
composes:

- **source** (`scripts/sources/<source>/`) — how the raw data is fetched (HTTP public archive vs
  private S3 bucket). Covers `discover`/`download`/any source-specific fetch step (e.g.
  `fetch-bio`). Shared across pipelines when they fetch data the same way.
- **pipeline-specific scripts** (`scripts/<pipeline>/`) — `setup.sh` (resolves/validates the
  config specific to that pipeline, e.g. which millesime → which URL, or which env vars are
  required) and `convert.sh` (converts the raw data to FlatGeobuf). `convert.sh` lives next to
  `setup.sh` rather than being shared by raw-data format, because each pipeline's conversion
  logic (schema mapping, field normalization, code_group derivation, …) is pipeline-specific
  even when two pipelines happen to start from the same format.

All pipelines share the same `build-pmtiles`/`upload` tail via Tylt kits (`kits/`), and a single
`run.sh` dispatches to any pipeline.

Current pipelines:

- **`rpg1`** — downloads GeoPackage archives (7z) from IGN/Géoportail (`sources/open-data` +
  `rpg1/convert.sh`).
- **`rpg2`** — downloads department-split shapefiles from a private S3 bucket
  (dataset "surfaces graphiques constatées") (`sources/private-s3` + `rpg2/convert.sh`).

## Key Commands

```bash
# Run full pipeline (includes cleanup after successful upload)
./run.sh <source> 2024
./run.sh rpg1 2024
./run.sh rpg2 2024

# Run without S3 upload (works regardless of pipeline shape); run.sh then
# runs `tylt export <workspace> build-pmtiles ./output/` automatically
./run.sh rpg1 2024 --no-upload

# Run without S3 upload, stopping right after build (for local export below)
./run.sh rpg1 2024 --target build-pmtiles

# Force re-download (bypass cache)
./run.sh rpg1 2024 --force download

# Export produced PMTiles locally (after --target build-pmtiles)
tylt export rpg-rpg1-2024 build-pmtiles ./output/

# Inspect step logs (only if pipeline failed — workspace preserved)
tylt logs rpg-rpg1-2024 <step-id>

# Check workspace step status
tylt show rpg-rpg1-2024
```

Workspace naming: `rpg-<source>-<MILLESIME>` (e.g. `rpg-rpg1-2024`, `rpg-rpg2-2024`).

## Repository Structure

```
run.sh                # Single entrypoint: ./run.sh <source> <MILLESIME> [tylt args]
config.yaml            # tippecanoe options (shared) + sources.<source>.* (per-source config)
.env.example           # Environment variable template (copy to .env)
kits/
  build-pmtiles.js     # Shared kit: tippecanoe install + scripts/common/build.sh
  upload.js            # Shared kit: awscli install + scripts/common/upload.sh
pipelines/
  rpg1.yaml            # Tylt pipeline: GeoPackage/IGN, open data (HTTP public)
  rpg2.yaml             # Tylt pipeline: shapefiles, private S3
scripts/
  common/
    build.sh           # tippecanoe invocation to build PMTiles (used via build-pmtiles kit)
    upload.sh           # S3 upload with awscli (used via upload kit)
  sources/               # scripts specific to a DATA SOURCE (network fetch)
    open-data/
      discover.sh          # Detects single .7z vs multi-part .7z.001+ archive
      download.sh            # Parallel download with curl
      fetch-bio.sh             # Fetches RPG BIO GPKG (IGN extract or data.gouv.fr API fallback)
    private-s3/
      discover.sh          # Finds the dated S3 folder for the millesime
      download.sh            # aws s3 sync of department shapefiles
  rpg1/
    setup.sh              # Reads config.yaml (via yq), resolves download URL, writes config.env
    convert.sh            # ogr2ogr conversion LAMB93→WGS84; PAC GPKG (glob *_pac*.gpkg)
                           #   → parcelles.fgb, BIO GPKG (fixed path bio.gpkg) →
                           #   parcellesbio.fgb; handles IGN and data.gouv.fr BIO schemas;
                           #   field name normalization to lowercase
  rpg2/
    setup.sh              # Validates MILLESIME/S3_SOURCE_BUCKET, reads shared tippecanoe zoom
    convert.sh            # Merges department shapefiles, derives code_group, exports fgb
```

## Pipeline definition pattern (Tylt kits)

Every step in `pipelines/<source>.yaml` uses `uses: shell` (Tylt's built-in kit) instead of
manually writing `image` + `cmd: [sh, -c, 'apt-get install ... && ...']`:

- `with.image` — override the base image (defaults to `debian:bookworm-slim` if `packages` is
  set, `alpine:3.20` otherwise)
- `with.packages` — package list, installed via `apt-get` in a separate cached `setup` phase
  (works on any Debian/Ubuntu-based image, including the GDAL image). For Alpine-based steps
  (`apk`), packages aren't installed via `with.packages` (that's always apt) — install inline in
  `with.run` instead (e.g. `run: apk add --no-cache yq -q && sh /app/setup.sh`), and set
  `allowNetwork: true` on the step itself (not just the kit's setup phase).
  Reference: `@tylt/core`'s `kits/shell.js` — `with.packages` triggers an apt install with
  its own `allowNetwork: true` and an `apt-cache` cache mount; `with.image` overrides the
  default; `with.src` mounts a whole host directory to `/app` (we instead use per-step
  `mounts:` for a single script file, which merges with the kit's own mounts).
- Step-level `mounts:` for the script file(s), e.g.
  `mounts: [{ host: ../scripts/sources/open-data/discover.sh, container: /app/discover.sh }]` —
  paths are relative to the pipeline YAML file's own directory (`pipelines/`), so always start
  with `../`.
- The two shared tail steps use local kits instead: `uses: build-pmtiles` / `uses: upload`.
  Local kits are auto-discovered from `<cwd>/kits/<name>.js` (no `.tylt.yml` needed) — `cwd` is
  wherever `tylt run` is invoked from, i.e. `pmtiles_generator/` (see `run.sh`). A kit exports a
  default function returning `{ image, cmd, setup?, mounts?, allowNetwork?, ... }`; its own
  `mounts` paths are also relative to the *pipeline file's* directory, not the kit file's.

This pattern was validated end-to-end against a real `@tylt/cli` (`npx @tylt/cli`) + Docker
during development — both the `shell` kit's `packages`/`src`/`mounts` merging and local kit
auto-discovery work as described above.

## Pipeline Steps (`rpg1`)

| Step            | Tool/Image                     | Key Output                                     |
| --------------- | ------------------------------- | ----------------------------------------------- |
| `setup`         | alpine + yq                     | `/output/config.env`                            |
| `discover`      | alpine + curl                   | `/output/parts.txt`                             |
| `download`      | alpine + curl                   | `/output/download/*.7z*`                        |
| `extract`       | shell kit + p7zip-full          | `/output/*.gpkg`                                |
| `fetch-bio`     | osgeo/gdal + curl/unzip/file     | `/output/bio.gpkg` (or `.no-bio`)               |
| `convert`       | osgeo/gdal + jq                 | `/output/*.fgb`                                 |
| `build-pmtiles` | build-pmtiles kit (ubuntu+tippecanoe) | `/output/{MILLESIME}/parcelles_france.pmtiles` |
| `upload`        | upload kit (debian+awscli)      | S3 object                                       |

## Pipeline Steps (`rpg2`)

| Step            | Tool/Image                       | Key Output                                          |
| --------------- | ---------------------------------- | ----------------------------------------------------- |
| `setup`         | alpine + yq                        | `/output/config.env` (MILLESIME, MIN_ZOOM, MAX_ZOOM)  |
| `discover`      | debian + awscli                    | `/output/s3_prefix.txt`                               |
| `download`      | debian + awscli                    | `/output/*.shp` (+ .shx/.dbf/.prj/.cpg)               |
| `convert`       | osgeo/gdal + jq                    | `/output/parcelles.fgb`, `/output/parcellesbio.fgb`   |
| `build-pmtiles` | build-pmtiles kit (shared)          | `/output/{MILLESIME}/parcelles_france.pmtiles`        |
| `upload`        | upload kit (shared)                | S3 object                                             |

Conventions specific to `rpg2` (private-s3 source):

- Source layout on S3: `s3://$S3_SOURCE_BUCKET/$MILLESIME/couches_graphiques/<dated-folder>/`,
  one `.shp` per department (99 files). The dated folder name is not predictable across
  millesimes — `scripts/sources/private-s3/discover.sh` lists the prefix and selects the single
  directory matching `SURFACES-<MILLESIME>-PARCELLES-GRAPHIQUES-CONSTATEES_<date>` (the sibling
  `-DEPT_` variant is intentionally excluded — it's a different/duplicate export). Fails if 0
  or >1 matches.
- `scripts/rpg2/convert.sh` merges all department shapefiles into one GeoPackage via
  a loop of `ogr2ogr -f GPKG -update -append` (SQLite dialect, per-file schema transform), then
  does two single-pass FlatGeobuf exports from that merge: `parcelles.fgb` (all rows) and
  `parcellesbio.fgb` (`WHERE bio = 1`).
- `code_group` (1-28) has no ready-made source field in this SHP schema (unlike the IGN GPKG's
  PAC layer) — it's derived from `CODE_CULTU` via a SQL `CASE` generated at runtime with `jq` from
  `inertia/data/cultures.json` (mounted read-only into the `convert` step), which maps each RPG
  crop code to a stable `groupCode`. `scripts/rpg1/convert.sh` generates the same `CASE` fragment
  from the same file for its data.gouv.fr BIO branch (see below), so the two pipelines classify
  crops identically even though the logic is duplicated per pipeline-specific `convert.sh`.
- `id_parcel` is built as `PACAGE-NUM_ILOT-NUM_PARCEL` (the standard RPG parcel identifier) —
  there is no single ID field in the source schema. `PACAGE` is also kept as its own `pacage`
  column.
- The BIO layer is not fetched separately: it's the subset of the same source where the `BIO`
  field (integer 0/1) is `1`.

## Important Conventions

- Shell scripts use `set -e` — any failing command aborts the step
- Step inputs/outputs flow through `/input/<step-id>/` and `/output/` inside containers
- `config.env` written by `setup` is sourced by downstream steps via Tylt `inputs`
- `config.yaml` has one `tippecanoe` block shared by all pipelines, and one `sources.<source>`
  subsection per data source for anything source-specific (e.g. `sources.open_data.millesimes`).
  A source with nothing to configure (like `private_s3`) just has an empty `{}` entry.
- **(rpg1 / open-data source) RPG BIO fallback**: `fetch-bio` checks the IGN extract first; if
  absent, queries the data.gouv.fr API (`dataset 616d6531c2951bbe8bd97771`) to download the
  national GPKG (2021+) or SHP (2019-2020). If unavailable for the requested millesime,
  a `.no-bio` marker is written and `parcellesbio` is omitted from the PMTiles.
- **(rpg1 convert) GeoPackage layer mapping**: PAC GPKG (located by glob `*_pac*.gpkg`) →
  `parcelles`, BIO GPKG (fixed path `bio.gpkg`) → `parcellesbio`. The layer name within each GPKG
  is detected dynamically via `ogrinfo`. Field names vary across millesimes (UPPERCASE pre-2024,
  lowercase 2024+) — `convert.sh` normalizes all field names to lowercase via a dynamic SQL
  SELECT. Layers absent from a given millesime are silently omitted from the PMTiles (no error);
  a warning is printed if the critical `parcelles` layer is missing. The PAC layer already carries
  a native `code_group`/`id_parcel` (IGN standard fields), passed through as-is; only the BIO
  branch (data.gouv.fr schema) needs the `CODE_CULTU` → `code_group` `CASE` (generated from
  `inertia/data/cultures.json`, same logic as `rpg2`) and a derived `id_parcel` (`gid`/`rowid`
  fallback, since that schema has no parcel ID field either).

## Known Pitfalls

- (rpg1 / open-data source) The archive may be `.7z` (older years) or `.7z.001+` (recent years) —
  `discover.sh` handles both
- `tylt run` takes the pipeline file **positionally** (`tylt run pipelines/rpg1.yaml ...`) — there
  is no `--pipeline` flag. There is also no `--env` flag for a single variable — only
  `--env-file <path>`; `run.sh` builds a temp env file rather than passing `--env`.
- Tylt is required (no native Docker fallback) — verify with `tylt --version`, or use
  `npx @tylt/cli` if not installed globally
- On macOS with Colima, Docker bind mounts only work for host paths under Colima's shared mounts
  (typically `$HOME`) — paths under plain `/tmp` silently mount as empty directories instead of
  erroring. Keep working directories for any manual tylt testing under the repo (e.g.
  `$HOME/...`), not `/tmp`.

## Adding a New Source

1. Add `pipelines/<pipeline>.yaml`, following the pattern in `pipelines/rpg2.yaml` (uses the
   `shell` kit per step, `uses: build-pmtiles` / `uses: upload` for the shared tail — see
   "Pipeline definition pattern" above).
2. Reuse existing source scripts where possible: if the new pipeline fetches data the same way an
   existing pipeline does (same network access pattern), reuse `scripts/sources/<source>/*.sh`
   as-is. Only add a new `scripts/sources/<source>/*.sh` when none of the existing ones fit.
3. Add `scripts/<pipeline>/setup.sh` (config resolution/validation — which millesime → which URL,
   which env vars are required, etc.) and `scripts/<pipeline>/convert.sh` (own conversion logic,
   even if it starts from a raw format another pipeline already handles — see
   `scripts/rpg1/convert.sh` or `scripts/rpg2/convert.sh` for reference). The `convert` step must
   produce `/output/parcelles.fgb` (required) and optionally `/output/parcellesbio.fgb`, both
   EPSG:4326 with the unified schema (`id_parcel`, `code_group`, `surf_parc`, `code_cultu`, …).
4. If the pipeline needs per-millesime config, add a `sources.<source>` block to `config.yaml`
   (keyed by data source, not by pipeline name — reuse the existing block if the source already
   has one). Otherwise `sources.<source>: {}` is enough — `run.sh` only needs
   `pipelines/<pipeline>.yaml` to exist to route to it (`./run.sh <pipeline> <MILLESIME>`).
5. No changes needed to `run.sh`, `kits/`, or `scripts/common/` — those are source-agnostic.

## Adding a New Millesime (`rpg1` pipeline)

Edit `config.yaml` and add an entry under `sources.open_data.millesimes` with the `version` and
`base_url` fields. No code changes required.

## Required Environment Variables

| Variable               | Description                                                            |
| ----------------------- | ------------------------------------------------------------------------ |
| `MILLESIME`             | Year to process (e.g. `2024`) — injected by `run.sh`, not set manually   |
| `S3_ENDPOINT`           | S3-compatible endpoint URL                                              |
| `S3_REGION`             | S3 region                                                                |
| `S3_BUCKET`             | Destination bucket name                                                 |
| `S3_KEY`                | Object key path in bucket — computed by `run.sh` per source (see below) |
| `S3_ACCESS_KEY_ID`      | S3 access key                                                            |
| `S3_SECRET_ACCESS_KEY`  | S3 secret key                                                            |
| `S3_SOURCE_BUCKET`      | Source bucket for shapefiles (`rpg2` pipeline only, same account)   |

`S3_KEY` default computed by `run.sh`: `rpg1` keeps the historical
`<MILLESIME>/parcelles_france.pmtiles` (no breaking change for the pre-existing production key);
every other source gets `<MILLESIME>/parcelles_france_<source>.pmtiles`.
