import { sql, RawBuilder } from 'kysely';
import { KyselyDB, KyselyTransaction } from './types/kysely.types';

/*
 * Executes a transaction or a callback using the provided database instance.
 * If an existing transaction is provided, it directly executes the callback with it.
 * Otherwise, it starts a new transaction using the provided database instance and executes the callback within that transaction.
 */
export async function executeTx<T>(
  db: KyselyDB,
  callback: (trx: KyselyTransaction) => Promise<T>,
  existingTrx?: KyselyTransaction,
): Promise<T> {
  if (existingTrx) {
    return await callback(existingTrx); // Execute callback with existing transaction
  } else {
    return await db.transaction().execute((trx) => callback(trx)); // Start new transaction and execute callback
  }
}

/*
 * This function returns either an existing transaction if provided,
 * or the normal database instance.
 */
export function dbOrTx(
  db: KyselyDB,
  existingTrx?: KyselyTransaction,
): KyselyDB | KyselyTransaction {
  if (existingTrx) {
    return existingTrx; // Use existing transaction
  } else {
    return db; // Use normal database instance
  }
}

/** Postgres `unique_violation` SQLSTATE — raised when a write hits a UNIQUE index. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Whether `err` is a Postgres unique-violation (SQLSTATE `23505`). THE single
 * check so repos/services stop re-hardcoding the magic code.
 *
 * NOTE (#222): `core/ai-chat/roles/ai-agent-roles.service.ts` still carries its
 * own inline `23505` check on a separate, unmerged branch; it should adopt this
 * helper (and {@link violatedConstraint}) after #227 lands.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === PG_UNIQUE_VIOLATION;
}

/**
 * The name of the UNIQUE index/constraint a `23505` error violated, or
 * undefined. The `kysely-postgres-js` / `postgres@3.x` driver surfaces it as
 * `err.constraint_name` (NOT `.constraint`); `.constraint` is kept only as a
 * defensive fallback for other drivers.
 */
export function violatedConstraint(err: unknown): string | undefined {
  const e = err as
    | { constraint_name?: string; constraint?: string }
    | null
    | undefined;
  return e?.constraint_name ?? e?.constraint;
}

/**
 * Bind a JS array/object as a `jsonb` column value, working around a postgres
 * driver double-encoding quirk. THE single implementation — repos that persist
 * jsonb (`tool_allowlist`, `model_config`, ...) call this instead of re-deriving
 * the cast.
 *
 * THE QUIRK: with the `kysely-postgres-js` / postgres.js driver, casting a bound
 * parameter straight to `::jsonb` makes the driver infer the param type as jsonb
 * and JSON-stringify the (already-JSON) text a SECOND time, so the column ends
 * up holding a jsonb STRING SCALAR (`"[\"a\"]"` / `"{\"k\":1}"`) instead of a
 * real jsonb array/object. Read paths then see a string, not the structure, and
 * silently fall back (an allowlist becomes "unrestricted", a model override is
 * ignored). Forcing the param through `::text` first binds it as text (sent
 * verbatim); `::jsonb` then parses it into a real array/object. Read-side
 * parsers repair rows written the old buggy way without a migration.
 *
 * Returns `null` for null/undefined and for "empty" values (an empty array, or
 * an object with no own enumerable keys) — callers treat empty as "clear/unset",
 * so an empty allowlist/config never round-trips as `[]`/`{}`.
 */
export function jsonbBind<T>(
  value: T | null | undefined,
): RawBuilder<T> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
  } else if (typeof value === 'object') {
    if (Object.keys(value as object).length === 0) return null;
  }
  return sql<T>`${JSON.stringify(value)}::text::jsonb`;
}

/**
 * READ-side counterpart to {@link jsonbBind}: tolerantly decode a jsonb value
 * read back from the DB and validate its shape with `guard`. THE single place
 * the legacy double-encoding self-heal lives, so repos keep only a type-guard.
 *
 * A row written by the old `::jsonb` bind round-trips as a JSON STRING (see the
 * quirk in jsonbBind), so the driver hands back e.g. `'["a"]'` / `'{"k":1}'`
 * rather than the structure. This parses such a string once, then applies the
 * caller's `guard`. Returns `null` for null / an unparseable string / a value
 * the guard rejects (so a corrupt or wrong-shaped value degrades to "unset").
 */
export function parseJsonbValue<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
): T | null {
  let v: unknown = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v); // legacy double-encoded read
    } catch {
      return null;
    }
  }
  return guard(v) ? v : null;
}
