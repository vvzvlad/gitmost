import { Kysely } from 'kysely';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiMcpServerRepo } from '@docmost/db/repos/ai-chat/ai-mcp-server.repo';
import { AccountMcpServersService } from '../../src/core/ai-chat/external-mcp/account-mcp-servers.service';
import { CreateMcpServerDto } from '../../src/core/ai-chat/external-mcp/dto/create-mcp-server.dto';
import { getTestDb, destroyTestDb, createWorkspace, createUser } from './db';

/**
 * Personal MCP CRUD service (#686 phase 2) against a real Postgres.
 *
 * The security-critical properties here are DB-observable and cannot be seen by
 * a mocked unit test (ARCH INVARIANT #8): owner-only isolation is enforced by
 * the repo's WHERE-scoping, and the per-user cap is enforced by a `FOR NO KEY
 * UPDATE` row lock that only serializes under a REAL transaction. So these run
 * against live PG.
 *
 * The service's collaborators that are NOT under test are stubbed to keep the
 * spec deterministic and offline:
 *  - SecretBoxService: a visible reversible marker so we can assert the raw
 *    header value NEVER reaches the view (only `hasHeaders`);
 *  - McpClientsService: a fixed testServer() result (the transport itself is
 *    the admin path's concern, already covered) + invalidateUser (#686 phase 3:
 *    every personal mutation evicts the owner's per-user toolset cache);
 *  - EnvironmentService: only `getMcpPersonalServersMax()` is consumed.
 */
const secretBoxStub = {
  encryptSecret: (plaintext: string) => `ENC(${plaintext})`,
} as any;

const clientsStub = {
  testServer: jest.fn().mockResolvedValue({ ok: true, tools: ['search'] }),
  // #686 phase 3: personal CRUD now evicts this user's cache entry.
  invalidateUser: jest.fn(),
} as any;

function envStub(max: number) {
  return { getMcpPersonalServersMax: () => max } as any;
}

function buildService(db: Kysely<any>, max: number): AccountMcpServersService {
  const repo = new AiMcpServerRepo(db as any);
  return new AccountMcpServersService(
    db as any,
    repo,
    secretBoxStub,
    clientsStub,
    envStub(max),
  );
}

const baseDto = (over: Partial<CreateMcpServerDto> = {}): CreateMcpServerDto => ({
  name: `srv-${Math.random().toString(36).slice(2, 8)}`,
  transport: 'http',
  url: 'https://example.com/mcp',
  ...over,
});

describe('AccountMcpServersService [integration]', () => {
  let db: Kysely<any>;
  let ws: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    db = getTestDb();
    ws = (await createWorkspace(db)).id;
    userA = (await createUser(db, ws)).id;
    userB = (await createUser(db, ws)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  describe('create + own-only visibility', () => {
    it('create returns hasHeaders (never the raw headers) and shows in the owner list only', async () => {
      const svc = buildService(db, 10);

      const view = await svc.createPersonal(ws, userA, {
        ...baseDto({ name: 'own-only-A' }),
        headers: { Authorization: 'Bearer super-secret' },
      });

      // The view signals headers are set but NEVER leaks the encrypted blob or
      // the plaintext secret (§8.10).
      expect(view.hasHeaders).toBe(true);
      expect('headersEnc' in (view as any)).toBe(false);
      expect(JSON.stringify(view)).not.toContain('super-secret');
      expect(JSON.stringify(view)).not.toContain('ENC(');

      // It appears in the owner's list...
      const listA = await svc.list(ws, userA);
      expect(listA.some((r) => r.id === view.id)).toBe(true);

      // ...and NOT in a different user's list (own-only isolation).
      const listB = await svc.list(ws, userB);
      expect(listB.some((r) => r.id === view.id)).toBe(false);
    });
  });

  describe('update / delete are owner-scoped (a non-owner gets 404)', () => {
    it('another user cannot update or delete; the owner can', async () => {
      const svc = buildService(db, 10);
      const created = await svc.createPersonal(ws, userA, baseDto({ name: 'a-owned' }));

      // userB cannot update A's row -> 404.
      await expect(
        svc.update(ws, userB, created.id, { name: 'stolen' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // userB cannot delete A's row -> 404.
      await expect(svc.remove(ws, userB, created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      // The row is untouched and still owned by A.
      const stillThere = await svc.list(ws, userA);
      expect(stillThere.find((r) => r.id === created.id)?.name).toBe('a-owned');

      // The owner can update...
      const updated = await svc.update(ws, userA, created.id, {
        name: 'renamed',
      });
      expect(updated.name).toBe('renamed');

      // ...and delete.
      expect(await svc.remove(ws, userA, created.id)).toEqual({ success: true });
      expect((await svc.list(ws, userA)).some((r) => r.id === created.id)).toBe(
        false,
      );
    });

    it('update of a non-existent id -> 404', async () => {
      const svc = buildService(db, 10);
      await expect(
        svc.update(ws, userA, '00000000-0000-0000-0000-000000000000', {
          name: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('SSRF guard (reused from the admin path)', () => {
    it('a blocked (loopback) URL is rejected with 400 and nothing is persisted', async () => {
      const w = (await createWorkspace(db)).id;
      const u = (await createUser(db, w)).id;
      const svc = buildService(db, 10);

      await expect(
        svc.createPersonal(w, u, baseDto({ url: 'http://127.0.0.1/mcp' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The rejected create left NO row behind.
      expect((await svc.list(w, u)).length).toBe(0);
    });

    // F-2 (#686 ARCH #8): the SSRF guard also runs on UPDATE when the url
    // changes (service:120 `if (dto.url !== existing.url) assertMcpUrlAllowed`).
    // This is defense-in-depth (the primary gate is the unconditional
    // connect-time re-check), but the create-vs-update asymmetry is cheap to
    // close: a rejected re-point must throw 400 AND persist nothing (the stored
    // url is unchanged). Non-vacuous: if the update path dropped the guard, the
    // blocked url would be persisted and the final assertion would redden.
    it('re-pointing a server at a blocked (loopback) URL is rejected with 400 and the stored url is unchanged', async () => {
      const w = (await createWorkspace(db)).id;
      const u = (await createUser(db, w)).id;
      const svc = buildService(db, 10);

      const created = await svc.createPersonal(
        w,
        u,
        baseDto({ url: 'https://example.com/mcp' }),
      );

      // Re-pointing at a loopback target trips the SSRF guard on update.
      await expect(
        svc.update(w, u, created.id, { url: 'http://127.0.0.1/mcp' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The blocked url was NOT persisted: the row still holds the original.
      const after = await svc.list(w, u);
      expect(after.find((r) => r.id === created.id)?.url).toBe(
        'https://example.com/mcp',
      );
    });
  });

  // F-1 (#686 ARCH #8): the migration declares
  //   `user_id ... references users(id) ON DELETE CASCADE`
  // so a personal server (which holds the encrypted per-user `headersEnc` blob)
  // MUST be destroyed when its owner is deleted — NOT nulled, which would
  // silently promote it to an admin/workspace-wide server and expose it. This
  // is a DB-observable property invisible to a mocked unit test, so it runs
  // against real Postgres. Non-vacuous: if the FK were `SET NULL` (or had no
  // ON DELETE action, which would make the user delete fail), the personal row
  // would survive the owner deletion and the post-delete assertions redden.
  describe('CASCADE: deleting the owner destroys their personal servers', () => {
    it('a personal server is GONE after its owning user is deleted', async () => {
      const w = (await createWorkspace(db)).id;
      const owner = (await createUser(db, w)).id;
      const svc = buildService(db, 10);

      const view = await svc.createPersonal(
        w,
        owner,
        baseDto({
          name: 'cascade-target',
          headers: { Authorization: 'Bearer owner-secret' },
        }),
      );

      // Sanity: the row exists and is owned by this user before the delete.
      expect((await svc.list(w, owner)).some((r) => r.id === view.id)).toBe(
        true,
      );

      // Delete the owner via the same table the harness seeds users into
      // (mirrors db.ts createUser). The FK CASCADE must take the personal row
      // with it.
      await db.deleteFrom('users').where('id', '=', owner).execute();

      // The personal row is gone from EVERY read path: a scope-agnostic raw
      // lookup finds nothing...
      const repo = new AiMcpServerRepo(db as any);
      expect(await repo.findByIdRaw(view.id)).toBeUndefined();

      // ...and it was destroyed, not promoted to an admin (user_id IS NULL)
      // row: the admin/workspace list does not see it either.
      expect(
        (await repo.listByWorkspace(w)).some((r) => r.id === view.id),
      ).toBe(false);
    });
  });

  describe('per-user cap', () => {
    it('the (MAX+1)th create is rejected with a 400 limit message', async () => {
      const MAX = 3;
      const w = (await createWorkspace(db)).id;
      const u = (await createUser(db, w)).id;
      const svc = buildService(db, MAX);

      for (let i = 0; i < MAX; i++) {
        await svc.createPersonal(w, u, baseDto({ name: `srv-${i}` }));
      }
      expect((await svc.list(w, u)).length).toBe(MAX);

      // The next one trips the cap.
      await expect(
        svc.createPersonal(w, u, baseDto({ name: 'over-the-cap' })),
      ).rejects.toThrow(/limit reached/i);

      // Still exactly MAX rows (the rejected create inserted nothing).
      expect((await svc.list(w, u)).length).toBe(MAX);
    });

    it('a burst of parallel creates ends at exactly MAX (FOR NO KEY UPDATE serialization)', async () => {
      const MAX = 2;
      const BURST = 4; // deliberately > MAX, and <= the test pool size (5)
      const w = (await createWorkspace(db)).id;
      const u = (await createUser(db, w)).id;
      const svc = buildService(db, MAX);

      const results = await Promise.allSettled(
        Array.from({ length: BURST }, (_, i) =>
          svc.createPersonal(w, u, baseDto({ name: `burst-${i}` })),
        ),
      );

      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected');

      // The lock closes the count-then-insert race: NEVER more than MAX succeed.
      expect(ok).toBe(MAX);
      // Every rejection is the cap BadRequest, not a DB/locking error.
      for (const r of rejected as PromiseRejectedResult[]) {
        expect(r.reason).toBeInstanceOf(BadRequestException);
      }
      // The durable count matches: exactly MAX rows landed.
      expect((await svc.list(w, u)).length).toBe(MAX);
    });
  });
});
