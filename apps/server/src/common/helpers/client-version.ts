import { join } from 'path';
import * as fs from 'node:fs';

/**
 * Resolve the absolute path to the built client bundle directory
 * (`apps/client/dist`) shipped into the runtime image.
 *
 * The `../` depth is anchored on THIS module's compiled location
 * (`dist/common/helpers`). `integrations/static` sits at the same depth under
 * the compiled root, so both callers (StaticModule and readClientBuildVersion)
 * MUST share this single helper rather than duplicating the depth — a copy in a
 * module at a different depth would silently resolve to the wrong directory.
 */
export function resolveClientDistPath(): string {
  return join(__dirname, '..', '..', '..', '..', 'client/dist');
}

/**
 * Read the build version the client bundle was compiled with, from
 * `<clientDistPath>/version.json` (written by the Vite build — the single
 * source of truth shared by the baked-in `APP_VERSION` global and this file).
 *
 * Fail-safe: any error (missing file, unreadable, bad JSON, non-string
 * version) yields `''`. The caller treats an empty version as "unknown" and
 * the whole version-coherence feature stays silently inert — existing deploys
 * without the file keep working unchanged.
 */
export function readClientBuildVersion(clientDistPath: string): string {
  try {
    const raw = fs.readFileSync(join(clientDistPath, 'version.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version.trim() : '';
  } catch {
    return '';
  }
}
