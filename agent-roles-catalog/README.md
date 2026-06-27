# Agent roles catalog

This directory is **data, not application code**. It holds the content of an
"agent roles catalog": reusable agent role definitions (system prompts plus a
little metadata), grouped into bundles and translated into one or more
languages. A separate server reads these files and serves them; nothing here is
executable application logic except the validation script.

## File layout

```
agent-roles-catalog/
  index.json                  # the catalog manifest: bundles, languages, role versions
  bundles/
    <bundle-id>/
      <lang>.json             # one file per declared language (e.g. ru.json, en.json)
  scripts/
    check.mjs                 # validates the catalog (no dependencies)
  package.json                # defines the `check` script
  README.md
```

Currently shipped bundles:

- `editorial` — the editorial suite (structural-editor, line-editor,
  fact-checker, proofreader, narrator), languages `ru`, `en`.
- `research` — a single `researcher` role, languages `ru`, `en`.

## How it's served

The server does not bundle this data; it reads it at request time from a single
configured location, the `AI_AGENT_ROLES_CATALOG_URL` env var
(`EnvironmentService.getAiAgentRolesCatalogSource()`), an `http(s)://` base URL
to the catalog's raw files. The server fetches `<base>/index.json` for the
manifest and `<base>/bundles/<bundle-id>/<lang>.json` for each opened bundle
file (REMOTE only).

That base URL is provided as a per-branch default in the Docker image (set in
CI: a `develop` build points at the `develop` raw URL, a release build at the
`main` raw URL) and can be overridden at runtime via the
`AI_AGENT_ROLES_CATALOG_URL` env var. Local-filesystem sources are no longer
supported; if the value is unset the catalog is unavailable.

The fetched JSON is re-validated server-side (the catalog is treated as
untrusted input). See `.env.example` for the variable and the CHANGELOG for the
rollout.

## `index.json` schema

```jsonc
{
  "schemaVersion": 1,
  "bundles": [
    {
      "id": "editorial",                       // unique bundle id; matches bundles/<id>/
      "name": { "ru": "...", "en": "..." },    // localized display name
      "description": { "ru": "...", "en": "..." },
      "languages": ["ru", "en"],               // which <lang>.json files must exist
      "roles": [
        { "slug": "structural-editor", "version": 1 }
        // ...
      ]
    }
  ]
}
```

`version` lives **here, in index.json**, per role. Bump it whenever a role's
content (instructions, name, description, etc.) changes, so consumers can detect
updates.

## Bundle (`<lang>.json`) schema

```jsonc
{
  "schemaVersion": 1,
  "language": "ru",
  "roles": [
    {
      "slug": "structural-editor",   // REQUIRED, unique across the whole catalog
      "emoji": "🧱",
      "name": "...",                 // REQUIRED, localized
      "description": "...",          // localized
      "instructions": "...",         // REQUIRED, the system prompt, localized
      "autoStart": true,             // whether the role starts working immediately
      "launchMessage": "..."         // first message sent on launch (or null)
    }
  ]
}
```

Notes:

- `modelConfig` is intentionally absent; the server treats an absent
  `modelConfig` as `null`.
- A role's `slug`, `emoji`, and `autoStart` are identical across all language
  files of the same bundle. Only `name`, `description`, `instructions`, and
  `launchMessage` are translated.

## Slug uniqueness

**Every `slug` must be UNIQUE ACROSS THE WHOLE CATALOG**, not just within a
bundle. A slug appears once per language file of its bundle (same slug in
`ru.json` and `en.json`), but no two different bundles may share a slug.
`scripts/check.mjs` enforces this.

## How to add things

### Add a role to an existing bundle

1. Add an entry to that bundle's `roles[]` in `index.json` with a new unique
   `slug` and `version: 1`.
2. Add a role object with the same `slug` to **every** `<lang>.json` of the
   bundle, translating `name`, `description`, `instructions`, and
   `launchMessage`.
3. Run the check (see below).

### Add a bundle

1. Add a bundle object to `index.json` (`id`, `name`, `description`,
   `languages`, `roles`).
2. Create `bundles/<id>/<lang>.json` for each declared language, with one role
   object per `roles[]` entry.
3. Run the check.

### Add a language to a bundle

1. Add the language code to that bundle's `languages[]` in `index.json`.
2. Create `bundles/<id>/<lang>.json` containing every role of the bundle,
   translated.
3. Run the check.

### Change a role's content

Edit the role in the relevant `<lang>.json` file(s) and **bump that role's
`version`** in `index.json`.

## Validating

From this directory:

```sh
node scripts/check.mjs   # or: npm run check
```

It fails (exit code 1) if any slug is duplicated across the catalog, if a
bundle's index `roles[]` don't match the slugs present in each language file, if
a declared language file is missing, or if any role is missing a required field
(`slug`, `name`, `instructions`). It prints `OK` on success.
