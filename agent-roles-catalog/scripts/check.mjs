#!/usr/bin/env node
// Validates the agent roles catalog.
// Fails (exit 1) on: duplicate slugs across the whole catalog, mismatches
// between a bundle's index roles[] and the slugs present in each language
// file, a missing declared language file, or a role missing required fields.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(__dirname, "..");

// `--update-hashes` (alias `--fix`) recomputes the content-hash lockfile from
// the current catalog instead of just validating against it.
const updateHashes =
  process.argv.includes("--update-hashes") || process.argv.includes("--fix");

// The content-hash lockfile lives under scripts/ and is a CHECK ARTIFACT only:
// the server never fetches it, so it has zero impact on the served schema.
const lockPath = join(__dirname, "content-hashes.json");

const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`Cannot read/parse ${path}: ${err.message}`);
    return null;
  }
}

const indexPath = join(catalogDir, "index.json");
if (!existsSync(indexPath)) {
  console.error(`Missing index.json at ${indexPath}`);
  process.exit(1);
}

const index = readJson(indexPath);
if (!index) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

const bundles = Array.isArray(index.bundles) ? index.bundles : [];
if (bundles.length === 0) {
  errors.push("index.json has no bundles[]");
}

// Track every slug seen across the whole catalog to detect duplicates.
const slugSeen = new Map(); // slug -> "bundleId/lang"

for (const bundle of bundles) {
  const bundleId = bundle.id;
  if (!bundleId) {
    errors.push("A bundle in index.json is missing an id");
    continue;
  }

  const indexSlugs = (bundle.roles || []).map((r) => r.slug);
  // Duplicate slugs inside the bundle index roles[].
  const indexSlugSet = new Set(indexSlugs);
  if (indexSlugSet.size !== indexSlugs.length) {
    errors.push(`Bundle "${bundleId}" index.json roles[] contains duplicate slugs`);
  }

  // Each index role must carry a finite numeric "version". The server requires
  // this (see ai-agent-roles-catalog.provider.ts), and the content-hash guard
  // below relies on it for the bump comparison, so enforce it here too.
  for (const r of bundle.roles || []) {
    if (typeof r.version !== "number" || !Number.isFinite(r.version)) {
      errors.push(
        `Bundle "${bundleId}" index.json role "${r.slug}" is missing a numeric "version"`
      );
    }
  }

  const languages = Array.isArray(bundle.languages) ? bundle.languages : [];
  if (languages.length === 0) {
    errors.push(`Bundle "${bundleId}" declares no languages`);
  }

  for (const lang of languages) {
    const langPath = join(catalogDir, "bundles", bundleId, `${lang}.json`);
    if (!existsSync(langPath)) {
      errors.push(`Bundle "${bundleId}" declares language "${lang}" but ${langPath} is missing`);
      continue;
    }

    const langFile = readJson(langPath);
    if (!langFile) continue;

    const roles = Array.isArray(langFile.roles) ? langFile.roles : [];
    const fileSlugs = roles.map((r) => r && r.slug);

    // (d) Required fields per role.
    for (const role of roles) {
      for (const field of ["slug", "name", "instructions"]) {
        if (role == null || role[field] == null || role[field] === "") {
          errors.push(
            `Bundle "${bundleId}/${lang}" has a role missing required field "${field}" (slug=${role && role.slug})`
          );
        }
      }
    }

    // (b) index roles[] must match the slugs present in each language file.
    const fileSlugSet = new Set(fileSlugs);
    const missingInFile = indexSlugs.filter((s) => !fileSlugSet.has(s));
    const extraInFile = fileSlugs.filter((s) => !indexSlugSet.has(s));
    if (missingInFile.length > 0) {
      errors.push(
        `Bundle "${bundleId}/${lang}" is missing roles declared in index.json: ${missingInFile.join(", ")}`
      );
    }
    if (extraInFile.length > 0) {
      errors.push(
        `Bundle "${bundleId}/${lang}" has roles not declared in index.json: ${extraInFile.join(", ")}`
      );
    }

    // (a) Duplicate slugs across the whole catalog.
    for (const slug of fileSlugs) {
      if (!slug) continue;
      const where = `${bundleId}/${lang}`;
      // Only flag duplicates across DIFFERENT bundles or files; the same slug
      // is expected to appear once per language file of the same bundle.
      if (slugSeen.has(slug)) {
        const prev = slugSeen.get(slug);
        const prevBundle = prev.split("/")[0];
        if (prevBundle !== bundleId) {
          errors.push(
            `Slug "${slug}" is duplicated across the catalog: ${prev} and ${where}`
          );
        }
      } else {
        slugSeen.set(slug, where);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Content-hash guard: detect "content changed without a version bump".
//
// check.mjs cannot use git history, so we maintain a lockfile
// (scripts/content-hashes.json) mapping each role slug to its recorded
// { version, hash }. On every run we recompute each role's content hash and
// compare it against the lock; a content change is only allowed once the role's
// version in index.json has been bumped and the lock refreshed.
//
// Known, accepted limitation: a deliberate prune-then-readd of a slug (remove
// the role and run --update-hashes, then re-add it with changed content at the
// same version) is NOT caught, because a brand-new slug has no lock baseline to
// enforce a bump against. We document this rather than building tombstones.
// ---------------------------------------------------------------------------

// Content fields hashed for each role, in a fixed canonical order. `slug` is
// identity (not content) and `version` lives in index.json, so neither is here.
// `modelConfig` (an OPTIONAL role field the server also serves) is intentionally
// EXCLUDED: no shipped role uses it today, and being an object it would need a
// deterministic deep canonicalization (recursive key sort) before hashing —
// otherwise JSON.stringify key-order would make the hash non-deterministic. If a
// role ever gains a `modelConfig`, add it here WITH such canonicalization so a
// change to it is still caught by the bump guard.
const CONTENT_FIELDS = [
  "emoji",
  "autoStart",
  "name",
  "description",
  "instructions",
  "launchMessage",
];

// Build a map of slug -> { version, langRoles: { lang: roleObject } } from the
// current catalog so we can compute hashes and read index versions.
function collectCatalogRoles() {
  const out = new Map(); // slug -> { version, langRoles: Map<lang, role> }
  for (const bundle of bundles) {
    const bundleId = bundle.id;
    if (!bundleId) continue;
    const languages = Array.isArray(bundle.languages) ? bundle.languages : [];
    for (const r of bundle.roles || []) {
      if (!r || !r.slug) continue;
      if (!out.has(r.slug)) {
        out.set(r.slug, { version: r.version, langRoles: new Map() });
      } else {
        // Same slug declared twice in index.json roles[]; already flagged above.
        out.get(r.slug).version = r.version;
      }
    }
    for (const lang of languages) {
      const langPath = join(catalogDir, "bundles", bundleId, `${lang}.json`);
      if (!existsSync(langPath)) continue;
      const langFile = readJson(langPath);
      if (!langFile) continue;
      const roles = Array.isArray(langFile.roles) ? langFile.roles : [];
      for (const role of roles) {
        if (!role || !role.slug) continue;
        const entry = out.get(role.slug);
        if (!entry) continue; // role not declared in index.json; flagged above.
        entry.langRoles.set(lang, role);
      }
    }
  }
  return out;
}

// Deterministic content hash for a role: languages sorted ascending, each
// language's content fields taken in CONTENT_FIELDS order (null when absent).
function contentHash(langRoles) {
  const langs = [...langRoles.keys()].sort();
  const canonical = langs.map((lang) => {
    const role = langRoles.get(lang);
    const fields = {};
    for (const field of CONTENT_FIELDS) {
      fields[field] = role && role[field] != null ? role[field] : null;
    }
    return [lang, fields];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Compute current { version, hash } for every catalog role.
const catalogRoles = collectCatalogRoles();
const current = new Map(); // slug -> { version, hash }
for (const [slug, entry] of catalogRoles) {
  current.set(slug, {
    version: entry.version,
    hash: contentHash(entry.langRoles),
  });
}

// Load the existing lock (may be absent on first run).
let lock = {};
if (existsSync(lockPath)) {
  const parsed = readJson(lockPath);
  if (parsed && typeof parsed === "object") lock = parsed;
}

if (updateHashes) {
  // Refresh the lock from the current catalog, but refuse to write if any role's
  // content changed without its version being bumped above the existing lock.
  const blockers = [];
  for (const [slug, cur] of current) {
    const prev = lock[slug];
    if (!prev) continue; // new role; nothing to enforce a bump against.
    if (cur.hash === prev.hash) continue; // content unchanged.
    // Defense-in-depth: a non-numeric version must never pass the bump check via
    // `undefined <= N` (which is false). The standard checks already flag a
    // missing numeric version, but guard here too before comparing.
    if (typeof cur.version !== "number" || !Number.isFinite(cur.version)) {
      blockers.push(
        `role "${slug}" content changed but its index.json "version" is missing or not numeric; set a numeric "version" before refreshing the lock`
      );
    } else if (cur.version <= prev.version) {
      blockers.push(
        `role "${slug}" content changed but its version was not bumped (still ${prev.version}); bump "version" in index.json before refreshing the lock`
      );
    }
  }
  // Still honor the standard checks before allowing a write.
  if (errors.length > 0) {
    console.error("Catalog check FAILED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (blockers.length > 0) {
    console.error("Refusing to update content-hash lock:");
    for (const b of blockers) console.error(`  - ${b}`);
    process.exit(1);
  }

  // Compute the change summary relative to the old lock, pruning removed slugs.
  const newLock = {};
  const added = [];
  const changed = [];
  const removed = [];
  for (const [slug, cur] of [...current].sort((a, b) => a[0].localeCompare(b[0]))) {
    newLock[slug] = { version: cur.version, hash: cur.hash };
    const prev = lock[slug];
    if (!prev) added.push(slug);
    else if (prev.hash !== cur.hash || prev.version !== cur.version) changed.push(slug);
  }
  for (const slug of Object.keys(lock)) {
    if (!current.has(slug)) removed.push(slug);
  }
  writeFileSync(lockPath, JSON.stringify(newLock, null, 2) + "\n");
  console.log(`Wrote ${lockPath}`);
  if (added.length) console.log(`  added:   ${added.join(", ")}`);
  if (changed.length) console.log(`  updated: ${changed.join(", ")}`);
  if (removed.length) console.log(`  pruned:  ${removed.join(", ")}`);
  if (!added.length && !changed.length && !removed.length) {
    console.log("  (no changes; lock already up to date)");
  }
  console.log("OK");
  process.exit(0);
}

// Normal run: validate current content against the lock.
for (const [slug, cur] of current) {
  const prev = lock[slug];
  if (!prev) {
    errors.push(
      `role "${slug}" is not recorded in the content-hash lock; run: node scripts/check.mjs --update-hashes`
    );
    continue;
  }
  if (cur.hash === prev.hash) {
    // Content unchanged; the lock version must still agree with index.json.
    if (cur.version !== prev.version) {
      errors.push(
        `role "${slug}" content is unchanged but its index.json version (${cur.version}) differs from the lock (${prev.version}); run: node scripts/check.mjs --update-hashes`
      );
    }
    continue;
  }
  // Content changed.
  // Defense-in-depth: treat a non-numeric version as an error before the `<=`
  // comparison, so a missing version can never silently pass the bump check
  // (and we avoid a misleading "version bumped to undefined" message).
  if (typeof cur.version !== "number" || !Number.isFinite(cur.version)) {
    errors.push(
      `role "${slug}" content changed but its index.json "version" is missing or not numeric; set a numeric "version", then run: node scripts/check.mjs --update-hashes`
    );
  } else if (cur.version <= prev.version) {
    errors.push(
      `role "${slug}" content changed but its version was not bumped (still ${prev.version}); bump "version" in index.json, then run: node scripts/check.mjs --update-hashes`
    );
  } else {
    errors.push(
      `role "${slug}" content changed and version bumped to ${cur.version}; record it by running: node scripts/check.mjs --update-hashes`
    );
  }
}
// Lock entries for slugs that no longer exist in the catalog.
for (const slug of Object.keys(lock)) {
  if (!current.has(slug)) {
    errors.push(
      `content-hash lock has entry for unknown role "${slug}" (no longer in the catalog); run: node scripts/check.mjs --update-hashes`
    );
  }
}

if (errors.length > 0) {
  console.error("Catalog check FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("OK");
