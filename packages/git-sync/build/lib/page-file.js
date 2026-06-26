/**
 * The native-Obsidian page-file format (design: docs/backlog/git-sync-thin-meta.md).
 * A page file is CLEAN markdown with a minimal YAML frontmatter carrying ONLY the
 * page's durable identity:
 *
 *   ---
 *   gitmost_id: 019ef6fc-2638-7ce1-9ce3-2756ce038480
 *   ---
 *   <clean markdown body>
 *
 * Everything else is derived (title = filename, parentPageId = enclosing folder,
 * spaceId = the vault, updatedAt = git). `gitmost_id` (a Docmost pageId) is the
 * only non-derivable bit and travels WITH the file so identity survives any move,
 * even one git's rename detection misses. Third-party editors (Obsidian, …) see
 * clean markdown; the frontmatter is hidden in their preview.
 *
 * No backward-compat with the old `docmost:meta` format: vaults are a cache, wiped
 * and rebuilt native. A file WITHOUT a `gitmost_id` frontmatter is an un-tracked
 * (e.g. hand-written) file -> the caller ADOPTS it (creates a page, writes the id).
 */
/**
 * The frontmatter key carrying the Docmost pageId. NAMESPACED (not a bare `id`)
 * so it never collides with a user's own frontmatter fields.
 */
export const ID_KEY = "gitmost_id";
/** Leading YAML frontmatter block: `---\n…\n---` at the very start of the file. */
const FRONTMATTER_RE = /^﻿?---\n([\s\S]*?)\n---\n?/;
/** The top-level `<ID_KEY>: <value>` line inside the frontmatter (quotes optional). */
function readIdFromYaml(yaml) {
    const re = new RegExp(`^${ID_KEY}:\\s*(.+?)\\s*$`);
    for (const line of yaml.split("\n")) {
        const m = line.match(re);
        if (m) {
            const v = m[1].trim().replace(/^["']|["']$/g, "");
            return v === "" ? null : v;
        }
    }
    return null;
}
/**
 * Parse a page file into its identity (`id`) and clean markdown `body`. Tolerant:
 * a file with no frontmatter (a hand-written third-party file) returns `id: null`
 * and the whole text as the body — the caller then ADOPTS it (creates a page,
 * writes the id back).
 *
 * KNOWN LIMITATION (phase 4 — adoption, see docs/backlog/git-sync-thin-meta.md):
 * a leading frontmatter block is stripped from `body` even when it carries NO
 * `gitmost_id` but DOES carry the user's own Obsidian properties (`tags:` etc.).
 * On adoption those fields are not yet round-tripped — `serializePageFile`
 * write-back persists only `gitmost_id`. Preserving arbitrary user frontmatter
 * across the Docmost round-trip (BOTH adoption write-back AND the next pull's
 * re-serialize) is deferred to the adoption phase; until then, do NOT roll the
 * native format onto a real Obsidian vault whose notes carry properties.
 */
export function parsePageFile(full) {
    const text = (full ?? "").replace(/\r\n/g, "\n");
    // Native format: a `gitmost_id` YAML frontmatter. Anything else (no frontmatter,
    // or frontmatter without the key) is an un-tracked file -> adopt.
    const fm = text.match(FRONTMATTER_RE);
    if (fm) {
        return { id: readIdFromYaml(fm[1]), body: text.slice(fm[0].length).trim() };
    }
    return { id: null, body: text.trim() };
}
/**
 * Serialize a page into the thin format: `id` frontmatter + a blank line + the
 * clean body + a trailing newline. Deterministic so an unchanged page re-syncs to
 * byte-identical output (no churn — the loop-guard relies on it).
 */
export function serializePageFile(id, body) {
    return `---\n${ID_KEY}: ${id}\n---\n\n${body.trim()}\n`;
}
