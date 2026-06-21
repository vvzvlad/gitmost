import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';

/**
 * db.ts — THE canonical place to seed prerequisite rows for integration tests.
 *
 * Seeders here use minimal, explicit `insertInto(...).values(...)` calls and are
 * DELIBERATELY decoupled from the app's repo `insert*` methods. Those repo
 * methods carry side effects integration specs do not want — password hashing,
 * validation, default/derived columns, event emission — so reproducing only the
 * columns a test needs keeps the fixtures small, fast and predictable.
 *
 * CONVENTIONS:
 *  - New entity seeders go HERE (a `createX(db, ...)` helper) rather than as raw
 *    `insertInto` calls scattered across spec files, so the schema knowledge
 *    lives in one place.
 *  - Each seeder inserts only the NOT NULL / uniquely-constrained columns plus
 *    whatever the consuming tests assert on; everything else is left to DB
 *    defaults.
 *  - Plain `randomUUID()` (v4) is fine for FK integrity; the app uses uuid v7,
 *    but tests never depend on id ordering.
 *
 * TRADE-OFF: because the column/constraint knowledge below is mirrored from the
 * Kysely schema rather than derived from it, a migration that changes a NOT NULL
 * column or a unique constraint can make an insert here fail. When that happens
 * the fix is to update the relevant seeder, not the spec that calls it.
 */

/**
 * Isolated test database connection string. The dev DB is `docmost`; tests run
 * against a dedicated `docmost_test` that global-setup drops + recreates +
 * migrates so nothing here touches dev data. Overridable via env (global-setup
 * also sets it so the value is consistent across the run).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://docmost:docmost_dev_pw@localhost:5432/docmost_test';

/**
 * Build a Kysely instance that MIRRORS the app's setup in database.module.ts:
 * PostgresJSDialect over postgres(), CamelCasePlugin, and the bigint type
 * parsing (to:20 / from:[20,1700] / serialize toString / parse parseInt). The
 * repos rely on camelCase columns + bigint-as-number, so the test Kysely must
 * match or queries break.
 */
export function buildTestDb(url: string = TEST_DATABASE_URL): Kysely<any> {
  return new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(url, {
        max: 5,
        onnotice: () => {},
        types: {
          bigint: {
            to: 20,
            from: [20, 1700],
            serialize: (value: number) => value.toString(),
            parse: (value: string) => Number.parseInt(value),
          },
        },
      }),
    }),
    plugins: [new CamelCasePlugin()],
  });
}

let singleton: Kysely<any> | undefined;

/** Lazily-built shared Kysely for the test suite (one per worker; maxWorkers=1). */
export function getTestDb(): Kysely<any> {
  if (!singleton) {
    singleton = buildTestDb();
  }
  return singleton;
}

export async function destroyTestDb(): Promise<void> {
  if (singleton) {
    await singleton.destroy();
    singleton = undefined;
  }
}

// --- Seeding helpers ---------------------------------------------------------
// Each helper inserts a minimal valid row (only the columns the tests need plus
// the NOT NULL / uniquely-constrained ones) and returns the generated id. See
// the module doc comment above for why these bypass the app's repo layer.

// Short, human-readable suffix derived from a row's uuid. Used to build unique
// names/slugs/hostnames for seeded rows so unique constraints never collide.
const shortId = (id: string): string => id.slice(0, 8);

export async function createWorkspace(
  db: Kysely<any>,
  overrides: { settings?: unknown; name?: string } = {},
): Promise<{ id: string; settings: any }> {
  const id = randomUUID();
  const suffix = shortId(id);
  const row = await db
    .insertInto('workspaces')
    .values({
      id,
      name: overrides.name ?? `ws-${suffix}`,
      // hostname is uniquely constrained; keep it unique per workspace.
      hostname: `host-${suffix}`,
      settings: overrides.settings === undefined ? null : (overrides.settings as any),
    })
    .returning(['id', 'settings'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string, settings: row.settings };
}

export async function createUser(
  db: Kysely<any>,
  workspaceId: string,
  overrides: { email?: string; name?: string } = {},
): Promise<{ id: string }> {
  const id = randomUUID();
  const suffix = shortId(id);
  const row = await db
    .insertInto('users')
    .values({
      id,
      email: overrides.email ?? `user-${suffix}@example.test`,
      name: overrides.name ?? `user-${suffix}`,
      workspaceId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string };
}

export async function createSpace(
  db: Kysely<any>,
  workspaceId: string,
  overrides: { slug?: string; name?: string } = {},
): Promise<{ id: string }> {
  const id = randomUUID();
  const suffix = shortId(id);
  const row = await db
    .insertInto('spaces')
    .values({
      id,
      name: overrides.name ?? `space-${suffix}`,
      // slug is unique per workspace + NOT NULL.
      slug: overrides.slug ?? `space-${suffix}`,
      workspaceId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string };
}

export async function createPage(
  db: Kysely<any>,
  args: { workspaceId: string; spaceId: string; title?: string },
): Promise<{ id: string }> {
  const id = randomUUID();
  const suffix = shortId(id);
  const row = await db
    .insertInto('pages')
    .values({
      id,
      // slug_id is NOT NULL + globally unique.
      slugId: `slug-${suffix}`,
      title: args.title ?? `page-${suffix}`,
      spaceId: args.spaceId,
      workspaceId: args.workspaceId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string };
}

export async function createRole(
  db: Kysely<any>,
  args: {
    workspaceId: string;
    creatorId?: string | null;
    name: string;
    emoji?: string | null;
    instructions?: string;
    enabled?: boolean;
    deletedAt?: Date | null;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  const row = await db
    .insertInto('aiAgentRoles')
    .values({
      id,
      workspaceId: args.workspaceId,
      creatorId: args.creatorId ?? null,
      name: args.name,
      emoji: args.emoji ?? null,
      instructions: args.instructions ?? 'be helpful',
      enabled: args.enabled ?? true,
      deletedAt: args.deletedAt ?? null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string };
}

export async function createChat(
  db: Kysely<any>,
  args: {
    workspaceId: string;
    creatorId: string;
    roleId?: string | null;
    title?: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  const row = await db
    .insertInto('aiChats')
    .values({
      id,
      workspaceId: args.workspaceId,
      creatorId: args.creatorId,
      roleId: args.roleId ?? null,
      title: args.title ?? `chat-${shortId(id)}`,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id as string };
}
