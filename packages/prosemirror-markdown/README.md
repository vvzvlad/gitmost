# @docmost/prosemirror-markdown

The single, canonical **ProseMirror ↔ Markdown converter** plus the Docmost
schema mirror (#293/#345/#347). Headless and framework-free: no React. There is
exactly ONE copy of this converter in the repo, consumed by:

- `packages/mcp` (the MCP server),
- `packages/git-sync` (two-way Git sync),
- `apps/server` (server-side markdown import/export, #345),
- `apps/client` (markdown paste/copy + AI-chat render, #347).

### Node vs browser entry

The HTML→DOM stage of markdown import runs on `jsdom` in Node and the native
`DOMParser` in the browser, injected per environment so **jsdom never enters a
client bundle**:

- default entry (`@docmost/prosemirror-markdown`) — Node: registers jsdom +
  `@tiptap/html`'s happy-dom `server` `generateJSON`. Used by mcp / git-sync /
  apps/server.
- `browser` entry (`@docmost/prosemirror-markdown/browser`, via the `"browser"`
  exports condition) — registers the native `DOMParser` + `@tiptap/html`'s
  browser `generateJSON`. Used by `apps/client`; carries no jsdom/happy-dom.

Both entries expose the identical converter surface; only the injected
DOM/`generateJSON` implementations differ (`src/lib/dom-parser.ts`). A
`markdownToProseMirrorSync` variant exists for callers that cannot await (the
client's synchronous chat renderer).

`src/lib/docmost-schema.ts` **mirrors** the upstream Tiptap schema that lives in
`packages/editor-ext`. The mirror is not free-floating: `serializer-contract.test.ts`
guards the boundary — every schema node must have a converter case, so a drift
between `editor-ext` and this package surfaces as a failing test rather than a
silent divergence.

## Why byte-stability matters

Git sync exports a page to markdown, and re-imports it on the next pull. If
`export → import → export` is not **byte-stable**, every pull rewrites files
that nobody edited, and the user's history churns with phantom diffs. So the
converter is held to more than "it roughly round-trips": the second export pass
must be a byte-for-byte fixpoint. That is what the property suite below proves.

## Two golden layers (do not mix them)

1. **Corpus fixtures** — `test/fixtures/corpus/`. A fixed, hand-curated set of
   representative documents (headings, marks, lists, tables, diagrams, columns,
   details, mentions, …). These are the readable, deterministic "known-good"
   snapshots. Edit them deliberately.

2. **Generative property suite** — `test/generative/`. fast-check draws random
   documents and asserts invariants over them. Two entry points:
   - `flat-roundtrip.property.test.ts` — flat documents, attribute-level fuzzing.
   - `nested-roundtrip.property.test.ts` — deeply nested structures.

   The invariants (**P1–P4**):
   - **P1** — semantic round-trip: `mdToPm(pmToMd(doc))` is canonically equal to
     `doc` (no data loss for the round-trip-supported space).
   - **P2** — byte fixpoint: `pmToMd(mdToPm(pmToMd(doc))) === pmToMd(doc)` (the
     first pass may normalize once; the second pass must be a fixpoint).
   - **P3** — totality: neither converter throws; output is bounded.
   - **P4** — parser fuzz totality: for ANY input string, `markdownToProseMirror`
     does not throw and returns a schema-valid document.

   These invariants are kept **STRICT** — no `it.fails`, skip, or weakening. A
   failure means the generator found a REAL converter bug.

## The counterexample process (the DoD)

This is the point of the generative layer. When a property run diverges:

1. **A property run surfaces a divergence** (locally, in CI, or in the nightly
   cron — see below).
2. **fast-check shrinks it** to a minimal, human-readable counterexample and
   prints the reproducing seed.
3. **Commit the shrunk doc as a permanent fixture** under
   `test/fixtures/counterexamples/`, with a matching case in
   `counterexamples.test.ts`. The fixture stays forever, as a regression pin.
4. **FIX the converter** so the counterexample round-trips. **Never weaken a
   property to hide the bug.**
5. If — and only if — a maintainer decides a particular markdown-representable
   loss is genuinely acceptable, it is recorded as an **explicit ACCEPTED /
   allowlist entry with a written reason**, not by silently relaxing an
   invariant.

### Attribute-coverage allowlist

`flat-roundtrip.property.test.ts` maintains `ATTR_VALUE_FUZZ_ALLOWLIST`. The
suite asserts that every attribute in the live schema is EITHER value-fuzzed by
the generator OR explicitly listed in this allowlist. This forces any newly
added node attribute to be consciously classified — you cannot add an attr and
leave it silently un-exercised; the coverage test fails until you either fuzz it
or record why it is held out.

## Running

```sh
# The full package suite (corpus + generative + contract tests):
pnpm --filter @docmost/prosemirror-markdown test
```

The generative suite honours two env knobs (invalid/empty → falls back to the
default):

| Env var              | Default (flat) | Default (nested) | Meaning                          |
| -------------------- | -------------- | ---------------- | -------------------------------- |
| `PROPERTY_SEED`      | `20250705`     | `20250705`       | fast-check seed (reproducibility) |
| `PROPERTY_NUM_RUNS`  | `300`          | `100`            | runs per property                |

```sh
# Reproduce a specific counterexample seed with a bigger budget:
PROPERTY_SEED=12345 PROPERTY_NUM_RUNS=5000 \
  pnpm --filter @docmost/prosemirror-markdown exec vitest run test/generative/
```

### Nightly cron

`.github/workflows/nightly-property.yml` runs the generative suite every night
with `PROPERTY_NUM_RUNS` cranked to ~5000 and a **random** seed, to reach deeper
counterexamples than a fixed-seed PR run can. On failure it files a Gitea issue
containing the reproducing seed, the run count, and the tail of the output (the
shrunk counterexample), which kicks off the counterexample → fixture process
above. It can also be triggered manually (`workflow_dispatch`) with custom
`num_runs` / `seed`.
