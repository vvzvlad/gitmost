import { pathToFileURL } from 'node:url';
import { esmImport } from '../../common/helpers/esm-import';
import type {
  VaultGit as VaultGitClass,
  vaultGitEnv as vaultGitEnvFn,
  runCycle as runCycleFn,
  parseDocmostMarkdown as parseDocmostMarkdownFn,
  markdownToProseMirror as markdownToProseMirrorFn,
  sanitizeTitle as sanitizeTitleFn,
  docsCanonicallyEqual as docsCanonicallyEqualFn,
} from '@docmost/git-sync';

/**
 * Runtime value-export surface of the ESM-only `@docmost/git-sync` package that
 * the server consumes. Types are imported with `import type` (erased at compile,
 * no runtime require); only the VALUE exports below need the dynamic-load
 * treatment so a CJS `require()` of the ESM package never happens.
 */
interface GitSyncModule {
  VaultGit: typeof VaultGitClass;
  vaultGitEnv: typeof vaultGitEnvFn;
  runCycle: typeof runCycleFn;
  parseDocmostMarkdown: typeof parseDocmostMarkdownFn;
  markdownToProseMirror: typeof markdownToProseMirrorFn;
  sanitizeTitle: typeof sanitizeTitleFn;
  docsCanonicallyEqual: typeof docsCanonicallyEqualFn;
}

// The CJS->ESM dynamic-import bridge lives in one shared helper
// (common/helpers/esm-import.ts); see it for why `import()` must be hidden from
// the TS commonjs downleveler. The typed `loadGitSync()` wrapper stays here.

// Memoize the in-flight/loaded module so the dynamic import runs at most once.
let modulePromise: Promise<GitSyncModule> | null = null;

/**
 * Lazily load the ESM-only `@docmost/git-sync` package (cached). Resolves the
 * package entry to an absolute path, then imports it as a `file://` URL so the
 * package "exports" map is honoured without bare-specifier resolution-base
 * fragility.
 */
export async function loadGitSync(): Promise<GitSyncModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const entry = require.resolve('@docmost/git-sync');
      const mod = (await esmImport(
        pathToFileURL(entry).href,
      )) as GitSyncModule;
      return mod;
    })().catch((err) => {
      // Do not cache a rejected import — allow the next call to retry.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}
