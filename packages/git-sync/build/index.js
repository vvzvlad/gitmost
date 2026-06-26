/**
 * Public surface of `@docmost/git-sync`.
 *
 * Exposes the pure converter (markdown <-> ProseMirror, file envelope,
 * canonicalization) and the sync engine (reconcile planner, vault layout,
 * pull/push, the git wrapper, and the settings parser) that the gitmost server
 * drives in-process.
 */
// Pure converter (markdown <-> ProseMirror, file envelope, canonicalization).
export { serializeDocmostMarkdown, serializeDocmostMarkdownBody, parseDocmostMarkdown, convertProseMirrorToMarkdown, markdownToProseMirror, canonicalizeContent, docsCanonicallyEqual, } from "./lib/index.js";
// Pure engine (no IO): reconcile planner, vault layout, sanitize, stabilize,
// loop-guard body hash.
export { planReconciliation, decideAbsenceDeletions, MASS_DELETE_MIN_EXISTING, MASS_DELETE_FRACTION, } from "./engine/reconcile.js";
export { buildVaultLayout } from "./engine/layout.js";
export { sanitizeTitle, disambiguate } from "./engine/sanitize.js";
export { stabilizePageFile } from "./engine/stabilize.js";
export { bodyHash } from "./engine/loop-guard.js";
export { VaultGit, vaultGitEnv, buildCommitMessage, BOT_AUTHOR_NAME, BOT_AUTHOR_EMAIL, DEFAULT_BRANCH, } from "./engine/git.js";
export { readExisting, computePullActions, applyPullActions, } from "./engine/pull.js";
export { classifyRenameMoves, computePushActions, applyPushActions, runPush, parentFolderFile, parseArgs, LAST_PUSHED_REF, DOCMOST_BRANCH, LOCAL_AUTHOR_NAME, LOCAL_AUTHOR_EMAIL, LOCAL_SOURCE_TRAILER, } from "./engine/push.js";
export { parseSettings, envSchema } from "./engine/settings.js";
export { loadSettingsOrExit } from "./engine/config-errors.js";
export { runCycle } from "./engine/cycle.js";
export { parsePageFile, serializePageFile } from "./lib/page-file.js";
