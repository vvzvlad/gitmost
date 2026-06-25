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
export declare const envSchema: z.ZodObject<{
    DOCMOST_API_URL: z.ZodString;
    DOCMOST_EMAIL: z.ZodString;
    DOCMOST_PASSWORD: z.ZodString;
    DOCMOST_SPACE_ID: z.ZodString;
    VAULT_PATH: z.ZodDefault<z.ZodString>;
    GIT_REMOTE: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodOptional<z.ZodString>>;
    POLL_INTERVAL_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    DEBOUNCE_MS: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<{
        info: "info";
        error: "error";
        debug: "debug";
        warn: "warn";
    }>>;
}, z.core.$strip>;
export type Settings = {
    docmostApiUrl: string;
    docmostEmail: string;
    docmostPassword: string;
    docmostSpaceId: string;
    vaultPath: string;
    gitRemote?: string;
    pollIntervalMs: number;
    debounceMs: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
};
export declare function parseSettings(env: NodeJS.ProcessEnv): Settings;
