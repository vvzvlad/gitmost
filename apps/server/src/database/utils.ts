import { sql, RawBuilder } from 'kysely';
import { KyselyDB, KyselyTransaction } from './types/kysely.types';

/*
 * Executes a transaction or a callback using the provided database instance.
 * If an existing transaction is provided, it directly executes the callback with it.
 * Otherwise, it starts a new transaction using the provided database instance and executes the callback within that transaction.
 */
/**
 * Post-commit side-effect hooks, keyed by the transaction they were registered
 * against. A WeakMap so an abandoned/never-drained transaction's entry is GC'd
 * with the trx object (no leak). Used by {@link registerAfterCommit} /
 * {@link executeTx}.
 */
const afterCommitHooks = new WeakMap<
  KyselyTransaction,
  Array<() => Promise<void> | void>
>();

/**
 * Register a side effect to run ONLY AFTER the transaction that owns `trx`
 * commits. THE fix for "bust the cache inside the open transaction" bugs: a
 * cache-invalidation (or any read-your-write-visible side effect) done while the
 * writing transaction is still open opens a window where a concurrent reader
 * repopulates the cache with the PRE-COMMIT (stale) row, so after commit the
 * cache holds the old value until its TTL. Deferring the effect to post-commit
 * closes that window.
 *
 * The hook is drained by the OUTERMOST {@link executeTx} that actually owns
 * (created) this transaction — so registering against a passed-through
 * `existingTrx` still fires at the real commit boundary, not at the inner call.
 * NOTE: a hook registered against a transaction that was NOT created via
 * `executeTx` (untracked) will never be drained — always create transactions
 * through `executeTx` when you rely on post-commit hooks.
 */
export function registerAfterCommit(
  trx: KyselyTransaction,
  hook: () => Promise<void> | void,
): void {
  const existing = afterCommitHooks.get(trx);
  if (existing) existing.push(hook);
  else afterCommitHooks.set(trx, [hook]);
}

export async function executeTx<T>(
  db: KyselyDB,
  callback: (trx: KyselyTransaction) => Promise<T>,
  existingTrx?: KyselyTransaction,
): Promise<T> {
  if (existingTrx) {
    // Reuse the caller's transaction. Any post-commit hooks registered here are
    // drained by the OUTER executeTx that created `existingTrx`, at the true
    // commit boundary — so we must NOT drain them now.
    return await callback(existingTrx);
  }
  // We OWN this transaction: run the body, then (only once it has COMMITTED)
  // drain the post-commit hooks registered against it during the body.
  let ownTrx: KyselyTransaction | undefined;
  const result = await db.transaction().execute((trx) => {
    ownTrx = trx;
    return callback(trx);
  });
  if (ownTrx) {
    const hooks = afterCommitHooks.get(ownTrx);
    if (hooks) {
      afterCommitHooks.delete(ownTrx);
      for (const hook of hooks) {
        // Best-effort: a failed side effect (e.g. a cache del) must not fail the
        // already-committed transaction.
        try {
          await hook();
        } catch {
          // swallow — the durable write already committed
        }
      }
    }
  }
  return result;
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

/** Postgres `query_canceled` SQLSTATE — raised when statement_timeout fires. */
const PG_QUERY_CANCELED = '57014';

/**
 * Whether `err` is a Postgres statement-timeout cancellation (SQLSTATE `57014`).
 * Used by #530 semantic search to degrade a slow vector scan to lexical-only
 * instead of hanging/500-ing. Matches on the SQLSTATE (the driver surfaces it as
 * `.code`), with a message fallback for any wrapper that drops the code.
 */
export function isStatementTimeout(err: unknown): boolean {
  if ((err as { code?: unknown } | null | undefined)?.code === PG_QUERY_CANCELED) {
    return true;
  }
  const msg = err instanceof Error ? err.message : '';
  return /canceling statement due to statement timeout/i.test(msg);
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
 * Returns `null` for null/undefined. By default it ALSO returns `null` for
 * "empty" values (an empty array, or an object with no own enumerable keys) —
 * most callers treat empty as "clear/unset", so an empty config never
 * round-trips as `[]`/`{}`.
 *
 * `preserveEmpty` (issue #476) opts a column OUT of that empty-to-null
 * normalization so `[]`/`{}` are persisted as real jsonb values. Needed where
 * empty and null mean DIFFERENT things: an empty `tool_allowlist` is
 * deny-all ("zero tools allowed"), while null is "no restriction" — collapsing
 * `[]` to null silently widened deny-all to allow-all. Deliberately an opt-in
 * flag, NOT a global change: the other jsonb callers (model_config, source)
 * keep the empty-means-unset contract.
 */
export function jsonbBind<T>(
  value: T | null | undefined,
  opts?: { preserveEmpty?: boolean },
): RawBuilder<T> | null {
  if (value === null || value === undefined) return null;
  if (!opts?.preserveEmpty) {
    if (Array.isArray(value)) {
      if (value.length === 0) return null;
    } else if (typeof value === 'object') {
      if (Object.keys(value as object).length === 0) return null;
    }
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
