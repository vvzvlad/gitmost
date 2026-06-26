#!/usr/bin/env node
// Validates the agent roles catalog.
// Fails (exit 1) on: duplicate slugs across the whole catalog, mismatches
// between a bundle's index roles[] and the slugs present in each language
// file, a missing declared language file, or a role missing required fields.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(__dirname, "..");

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
      const key = slug;
      if (slugSeen.has(key)) {
        const prev = slugSeen.get(key);
        const prevBundle = prev.split("/")[0];
        if (prevBundle !== bundleId) {
          errors.push(
            `Slug "${slug}" is duplicated across the catalog: ${prev} and ${where}`
          );
        }
      } else {
        slugSeen.set(key, where);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Catalog check FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("OK");
