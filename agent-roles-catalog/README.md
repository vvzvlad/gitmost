# Agent roles catalog

This directory is **data, not application code**. It holds the content of an
"agent roles catalog": reusable agent role definitions (system prompts plus a
little metadata), grouped into bundles and translated into one or more
languages. A separate server reads these files and serves them; nothing here is
executable application logic except the validation script.

## File layout

```
agent-roles-catalog/
  index.yaml                  # the catalog manifest: bundles, languages, role versions
  bundles/
    <bundle-id>/
      <lang>.yaml             # one file per declared language (e.g. ru.yaml, en.yaml)
  scripts/
    check.mjs                 # validates the catalog (uses the `yaml` parser)
    content-hashes.json       # check artifact: per-role content-hash lock (NOT served)
  package.json                # defines the `check` script
  README.md
```

The content files are **YAML** so the long `instructions` system prompt can be
stored as a literal block scalar (`|-`): edits show up as line-by-line diffs and
the prompt is editable as plain multi-line text instead of a single escaped JSON
string. The `content-hashes.json` lockfile under `scripts/` stays JSON — it is a
check artifact, never served.

Currently shipped bundles:

- `editorial` — the editorial suite (structural-editor, line-editor,
  fact-checker, proofreader, narrator), languages `ru`, `en`.
- `research` — a single `researcher` role, languages `ru`, `en`.

## How it's served

The server does not bundle this data; it reads it at request time from a single
configured location, the `AI_AGENT_ROLES_CATALOG_URL` env var
(`EnvironmentService.getAiAgentRolesCatalogSource()`), an `http(s)://` base URL
to the catalog's raw files. The server fetches `<base>/index.yaml` for the
manifest and `<base>/bundles/<bundle-id>/<lang>.yaml` for each opened bundle
file (REMOTE only).

That base URL is provided as a per-branch default in the Docker image (set in
CI: a `develop` build points at the `develop` raw URL, a release build at the
`main` raw URL) and can be overridden at runtime via the
`AI_AGENT_ROLES_CATALOG_URL` env var. Local-filesystem sources are no longer
supported; if the value is unset the catalog is unavailable.

The fetched YAML is parsed with a safe, JSON-compatible schema and re-validated
server-side (the catalog is treated as untrusted input). See `.env.example` for
the variable and the CHANGELOG for the rollout.

## `index.yaml` schema

```yaml
schemaVersion: 1
bundles:
  - id: editorial # unique bundle id; matches bundles/<id>/
    name: # localized display name
      ru: "..."
      en: "..."
    description:
      ru: "..."
      en: "..."
    languages: # which <lang>.yaml files must exist
      - ru
      - en
    roles:
      - slug: structural-editor
        version: 1
      # ...
```

`version` lives **here, in index.yaml**, per role. Bump it whenever a role's
content (instructions, name, description, etc.) changes, so consumers can detect
updates.

## Bundle (`<lang>.yaml`) schema

```yaml
schemaVersion: 1
language: ru
roles:
  - slug: structural-editor # REQUIRED, unique across the whole catalog
    emoji: "🧱"
    name: "..." # REQUIRED, localized
    description: "..." # localized
    instructions: |- # REQUIRED, the system prompt, localized (literal block scalar)
      First line of the prompt.
      Second line.
    autoStart: true # whether the role starts working immediately
    launchMessage: "..." # first message sent on launch (or null)
```

Keep `instructions` as a literal block scalar (`|-`, chomp — no trailing
newline) so the resolved prompt is byte-for-byte what you typed and diffs stay
line-by-line.

Notes:

- `modelConfig` is intentionally absent; the server treats an absent
  `modelConfig` as `null`.
- A role's `slug`, `emoji`, and `autoStart` are identical across all language
  files of the same bundle. Only `name`, `description`, `instructions`, and
  `launchMessage` are translated.

## Slug uniqueness

**Every `slug` must be UNIQUE ACROSS THE WHOLE CATALOG**, not just within a
bundle. A slug appears once per language file of its bundle (same slug in
`ru.yaml` and `en.yaml`), but no two different bundles may share a slug.
`scripts/check.mjs` enforces this.

## How to add things

### Add a role to an existing bundle

1. Add an entry to that bundle's `roles[]` in `index.yaml` with a new unique
   `slug` and `version: 1`.
2. Add a role object with the same `slug` to **every** `<lang>.yaml` of the
   bundle, translating `name`, `description`, `instructions`, and
   `launchMessage`.
3. Run the check (see below).

### Add a bundle

1. Add a bundle object to `index.yaml` (`id`, `name`, `description`,
   `languages`, `roles`).
2. Create `bundles/<id>/<lang>.yaml` for each declared language, with one role
   object per `roles[]` entry.
3. Run the check.

### Add a language to a bundle

1. Add the language code to that bundle's `languages[]` in `index.yaml`.
2. Create `bundles/<id>/<lang>.yaml` containing every role of the bundle,
   translated.
3. Run the check.

### Change a role's content

Edit the role in the relevant `<lang>.yaml` file(s) and **bump that role's
`version`** in `index.yaml`. Then run `node scripts/check.mjs --update-hashes`
to refresh the content-hash lock (`scripts/content-hashes.json`). `check.mjs`
now **fails if a role's content changed but its `version` was not bumped**, so
this step is mandatory — the lock can only be refreshed after the bump.

## Validating

From this directory:

```sh
node scripts/check.mjs   # or: npm run check
```

It fails (exit code 1) if any slug is duplicated across the catalog, if a
bundle's index `roles[]` don't match the slugs present in each language file, if
a declared language file is missing, or if any role is missing a required field
(`slug`, `name`, `instructions`). It prints `OK` on success.

### Content-hash guard

`check.mjs` also guards against changing a role's content without bumping its
`version`. It keeps a lockfile, `scripts/content-hashes.json`, mapping each role
`slug` to `{ version, hash }`, where `hash` is a SHA-256 over the role's
content fields (`emoji`, `autoStart`, `name`, `description`, `instructions`,
`launchMessage`) across all of its language files, in a deterministic canonical
form. This lockfile is a **check artifact only** — the server fetches only
`index.yaml` and the bundle `<lang>.yaml` files, never this file, so it has no
effect on the served catalog or its schema.

On a normal run, for every role the check recomputes the hash and compares it
against the lock:

- content unchanged and versions agree → OK;
- content changed but `version` not bumped above the lock → **error** asking you
  to bump and refresh;
- content changed and `version` bumped → **error** asking you to record it by
  refreshing the lock;
- role missing from the lock, or a lock entry for a role that no longer exists →
  **error** asking you to refresh.

Refresh the lock with:

```sh
node scripts/check.mjs --update-hashes   # alias: --fix
```

This recomputes the lock from the current catalog, prunes entries for removed
roles, and prints what changed — but it **refuses to write** (exit 1) if any
role's content changed while its `index.yaml` version was not bumped, so the
version bump is always enforced first. The check also requires every
`index.yaml` role to carry a finite numeric `version` (the server requires the
same).

Known, accepted limitation: a deliberate prune-then-readd of a slug (remove the
role and run `--update-hashes`, then re-add it with changed content at the same
version) is **not** caught, because a brand-new slug has no lock baseline to
enforce a bump against.
