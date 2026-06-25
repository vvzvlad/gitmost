/**
 * Engine settings.
 *
 * The engine is driven IN-PROCESS by the NestJS server, which builds the
 * `Settings` object from `EnvironmentService` — so this module must NOT reach
 * into `process.env`. It exposes only:
 *   - the `Settings` type the engine consumes, and
 *   - `parseSettings(env)` as a PURE function (validate a raw env object -> typed
 *     `Settings`), kept for unit tests and for the server to reuse if it wants
 *     to validate an env-shaped object.
 * There is no `.env`-loading side-effecting entry point.
 */
import { z } from 'zod';
// Schema keyed by the real ENV variable names so validation errors name the
// exact variable. Credentials and the address of our OWN Docmost instance have
// NO default — a missing value must fail at startup, never silently fall back.
export const envSchema = z.object({
    // Docmost connection — address of our own instance, no default.
    DOCMOST_API_URL: z.string().url(),
    // Credentials for /auth/login — no default, never hardcoded.
    DOCMOST_EMAIL: z.string().min(1),
    DOCMOST_PASSWORD: z.string().min(1),
    // Which Docmost space to mirror.
    DOCMOST_SPACE_ID: z.string().min(1),
    // Local git vault (state store) — kept under data/ so the volume persists it.
    VAULT_PATH: z.string().min(1).default('data/vault'),
    // Optional git remote the vault pushes to. Empty string is treated as unset.
    GIT_REMOTE: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
    // Non-secret tunables — sensible defaults are fine.
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
    DEBOUNCE_MS: z.coerce.number().int().positive().default(2000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
// Pure: validate a raw environment object and map it to a typed Settings.
// Throws ZodError on bad config. No side effects — safe to import in tests.
export function parseSettings(env) {
    const e = envSchema.parse(env);
    return {
        docmostApiUrl: e.DOCMOST_API_URL,
        docmostEmail: e.DOCMOST_EMAIL,
        docmostPassword: e.DOCMOST_PASSWORD,
        docmostSpaceId: e.DOCMOST_SPACE_ID,
        vaultPath: e.VAULT_PATH,
        gitRemote: e.GIT_REMOTE,
        pollIntervalMs: e.POLL_INTERVAL_MS,
        debounceMs: e.DEBOUNCE_MS,
        logLevel: e.LOG_LEVEL,
    };
}
