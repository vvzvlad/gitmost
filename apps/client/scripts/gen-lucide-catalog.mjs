#!/usr/bin/env node
// Generates `src/components/ui/lucide/lucide-catalog.generated.ts` — the single
// committed catalog artifact the icon picker loads (see issue #696).
//
// HAND-RUN ONLY, never in CI/Docker/build: the committed artifact is what ships;
// this script only regenerates it when `lucide-react` is bumped. cwd = apps/client.
//
// Metadata source has three modes (the single network step must close offline):
//   (default)          teams via the codeload tarball for the installed version
//   --tarball=<path>   tags/categories from a locally-downloaded tarball
//   --offline          tags/categories carried over from the committed artifact;
//                      new icons land in "other" and are listed in `degraded`
//
// Geometry (__iconNode) and the alias map ALWAYS come from node_modules, so they
// are complete in every mode. Fatal on any partial result (atomic write only).

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { loadIconModel, scriptDir } from "./lucide-imports.mjs";

const require = createRequire(import.meta.url);

const OUT_PATH = join(
  scriptDir,
  "../src/components/ui/lucide/lucide-catalog.generated.ts",
);

function fatal(msg) {
  console.error(`[gen-lucide-catalog] FATAL: ${msg}`);
  process.exit(1);
}

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const tarballArg = args.find((a) => a.startsWith("--tarball="));
const tarballPath = tarballArg ? tarballArg.slice("--tarball=".length) : null;
if (offline && tarballPath) fatal("--offline and --tarball are mutually exclusive.");

// ---- 1. version -----------------------------------------------------------
// version = INSTALLED lucide-react (a bare `require` is undefined in an ES
// module — createRequire is mandatory here, unlike the vitest guard test where
// CJS interop supplies one). Cross-check the declared spec; a mismatch or an
// imprecise ("^"/"~"/range) spec is fatal — the artifact must pin an exact build.
const version = require("lucide-react/package.json").version;
const clientPkg = require("../package.json");
const declared = clientPkg.dependencies?.["lucide-react"];
if (!declared) fatal("lucide-react is not a dependency of apps/client.");
if (!/^\d+\.\d+\.\d+$/.test(declared)) {
  fatal(`lucide-react spec "${declared}" is not an exact version — pin it.`);
}
if (declared !== version) {
  fatal(
    `installed lucide-react ${version} ≠ declared ${declared} — run pnpm install.`,
  );
}

// ---- 2/3. canonical + aliases (from node_modules) -------------------------
const { canonical, aliases } = loadIconModel(import.meta.url);
console.log(
  `[gen-lucide-catalog] lucide-react ${version}: ${canonical.length} canonical, ` +
    `${Object.keys(aliases).length} aliases`,
);

// ---- 4. geometry (__iconNode) ---------------------------------------------
const iconsDir = join(
  dirname(require.resolve("lucide-react/package.json")),
  "dist/esm/icons",
);
const icons = {};
{
  const CONCURRENCY = 32;
  const queue = [...canonical];
  const missing = [];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      const url = pathToFileURL(join(iconsDir, `${name}.mjs`));
      let mod;
      try {
        mod = await import(url.href);
      } catch (err) {
        missing.push(`${name} (import failed: ${err.message})`);
        continue;
      }
      const node = mod.__iconNode;
      if (!Array.isArray(node) || node.length === 0) {
        missing.push(`${name} (__iconNode missing/empty)`);
        continue;
      }
      icons[name] = node;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (missing.length) {
    fatal(`__iconNode missing for ${missing.length} icons:\n  ${missing.join("\n  ")}`);
  }
}

// ---- 5/6. tags + categories -----------------------------------------------
// Fills `tags` (name → string[]) and `primary` (name → category slug).
const tags = {};
const primary = {};
const degraded = [];

function applyFromRepoIcons(iconsJsonDir) {
  // repo tarball layout: <root>/icons/<name>.json with { tags, categories }
  const missing = [];
  for (const name of canonical) {
    const p = join(iconsJsonDir, `${name}.json`);
    if (!existsSync(p)) {
      missing.push(name);
      continue;
    }
    const meta = JSON.parse(readFileSync(p, "utf8"));
    tags[name] = Array.isArray(meta.tags) ? [...meta.tags].sort() : [];
    primary[name] =
      Array.isArray(meta.categories) && meta.categories.length
        ? meta.categories[0]
        : "other";
  }
  if (missing.length) {
    fatal(
      `no icon json in the tarball for ${missing.length} canonical name(s):\n  ` +
        missing.join("\n  "),
    );
  }
}

function extractTarball(tarPath) {
  const dest = mkdtempSync(join(tmpdir(), "lucide-cat-"));
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", dest]);
  } catch (err) {
    fatal(`tar extract of ${tarPath} failed: ${err.message}`);
  }
  // The tarball unpacks to a single top-level dir (e.g. lucide-<version>/).
  const entries = readdirSync(dest, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  if (entries.length !== 1) {
    fatal(`unexpected tarball layout: ${entries.length} top-level dirs in ${dest}`);
  }
  const root = join(dest, entries[0].name);
  const iconsJsonDir = join(root, "icons");
  if (!existsSync(iconsJsonDir)) {
    fatal(`no icons/ dir in the tarball root ${root}`);
  }
  return { dest, iconsJsonDir };
}

if (offline) {
  // Carry tags + primary from the committed artifact for every name it knows.
  if (!existsSync(OUT_PATH)) {
    fatal("--offline needs an existing committed artifact to carry metadata from.");
  }
  const prev = readCommittedCatalog(OUT_PATH);
  for (const name of canonical) {
    if (prev.tags[name] !== undefined && prev.primary[name] !== undefined) {
      tags[name] = prev.tags[name];
      primary[name] = prev.primary[name];
    } else {
      tags[name] = [];
      primary[name] = "other";
      degraded.push(name);
    }
  }
  if (degraded.length) {
    console.warn(
      `[gen-lucide-catalog] OFFLINE: ${degraded.length} icon(s) have NO tags/` +
        `category and were placed in "other" (field \`degraded\`). The guard ` +
        `test will FAIL until these are added to ` +
        `lucide-catalog.degraded-allowlist.json:\n  ${degraded.sort().join("\n  ")}`,
    );
  }
} else {
  let tarPath = tarballPath;
  let downloadedTmp = null;
  if (!tarPath) {
    // default mode: download the codeload tarball for the installed version.
    const url = `https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/tags/${version}`;
    downloadedTmp = join(mkdtempSync(join(tmpdir(), "lucide-tar-")), "lucide.tar.gz");
    console.log(`[gen-lucide-catalog] downloading ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) fatal(`tarball GET ${url} → HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(downloadedTmp, buf);
      console.log(`[gen-lucide-catalog] downloaded ${buf.length} bytes`);
    } catch (err) {
      fatal(`tarball GET ${url} failed: ${err.message}`);
    }
    tarPath = downloadedTmp;
  } else if (!existsSync(tarPath)) {
    fatal(`--tarball path does not exist: ${tarPath}`);
  }
  const { dest, iconsJsonDir } = extractTarball(tarPath);
  applyFromRepoIcons(iconsJsonDir);
  rmSync(dest, { recursive: true, force: true });
  if (downloadedTmp) rmSync(dirname(downloadedTmp), { recursive: true, force: true });
}

// ---- 7. atomic write ------------------------------------------------------
const catalog = {
  v: version,
  icons: sortKeys(icons),
  primary: sortKeys(primary),
  aliases: sortKeys(aliases),
  tags: sortKeys(tags),
  degraded: degraded.sort(),
};

const dataJson = JSON.stringify(catalog);
const file =
  `// GENERATED by scripts/gen-lucide-catalog.mjs — do not edit by hand.\n` +
  `// Regenerate on a lucide-react bump: \`node scripts/gen-lucide-catalog.mjs\`.\n` +
  `import type { IconNode } from "lucide-react";\n` +
  `export interface LucideCatalog {\n` +
  `  v: string;\n` +
  `  icons: Record<string, IconNode>;\n` +
  `  primary: Record<string, string>;\n` +
  `  aliases: Record<string, string>;\n` +
  `  tags: Record<string, string[]>;\n` +
  `  degraded: string[];\n` +
  `}\n` +
  `export default JSON.parse(${JSON.stringify(dataJson)}) as unknown as LucideCatalog;\n`;

const tmp = `${OUT_PATH}.tmp`;
writeFileSync(tmp, file);
renameSync(tmp, OUT_PATH);
console.log(
  `[gen-lucide-catalog] wrote ${OUT_PATH} (${file.length} bytes, ` +
    `degraded=${degraded.length})`,
);

// ---- helpers --------------------------------------------------------------
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Read the committed .ts artifact WITHOUT importing it (it imports a type from
// lucide-react and is a .ts file node can't load): pull the JSON.parse string
// literal out of the source and parse it.
function readCommittedCatalog(path) {
  const src = readFileSync(path, "utf8");
  const m = src.match(/JSON\.parse\((".*")\)\s*as\s+unknown/s);
  if (!m) fatal(`cannot find the JSON.parse literal in ${path}`);
  const inner = JSON.parse(m[1]); // the escaped JSON string
  return JSON.parse(inner);
}
