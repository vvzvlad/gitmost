import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { WorkspaceInvitationService } from 'src/core/workspace/services/workspace-invitation.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createDefaultGroup,
  createInvitation,
} from './db';

/**
 * acceptInvitation atomicity (issue #324, tail of #244).
 *
 * acceptInvitation() reads the invitation OUTSIDE the transaction, then inside a
 * single tx: inserts the invited user, adds them to the default group, and
 * deletes the invitation. Two accepts of the SAME invitation therefore race to
 * insert a user with the same (email, workspaceId) — which the
 * `users_email_workspace_id_unique` constraint forbids. The service catches that
 * violation and reports "Invitation already accepted".
 *
 * These specs pin the INVARIANT that path protects: no matter how many times the
 * invitation is accepted (concurrently or repeatedly), the workspace ends up
 * with exactly ONE membership for the invited email and the invitation is
 * consumed exactly once — never a duplicate user and never a half-applied state.
 *
 * The service is wired with the REAL repos (UserRepo / GroupRepo / GroupUserRepo)
 * against the test Kysely; only the peripheral collaborators that acceptInvitation
 * touches AFTER the transaction (mail, session token, billing, audit, env) are
 * stubbed, so the exercised DB write path is the production one.
 */
describe('WorkspaceInvitationService.acceptInvitation atomicity [integration]', () => {
  let db: Kysely<any>;
  let service: WorkspaceInvitationService;

  // Count the memberships (user rows) for an email within a workspace — the
  // quantity the atomicity guarantee is about.
  async function membershipCount(
    workspaceId: string,
    email: string,
  ): Promise<number> {
    const rows = await db
      .selectFrom('users')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('email', '=', email.toLowerCase())
      .execute();
    return rows.length;
  }

  async function invitationExists(invitationId: string): Promise<boolean> {
    const row = await db
      .selectFrom('workspaceInvitations')
      .select('id')
      .where('id', '=', invitationId)
      .executeTakeFirst();
    return !!row;
  }

  beforeAll(() => {
    db = getTestDb();

    const userRepo = new UserRepo(db as any);
    const groupRepo = new GroupRepo(db as any);
    const groupUserRepo = new GroupUserRepo(db as any, groupRepo, userRepo);

    // Collaborators used only on the post-commit success tail; safe to stub.
    const mailService = { sendToQueue: jest.fn().mockResolvedValue(undefined) };
    const domainService = {} as any;
    const tokenService = {} as any;
    const sessionService = {
      createSessionAndToken: jest.fn().mockResolvedValue('test-auth-token'),
    };
    const billingQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const environmentService = { isCloud: () => false };
    const auditService = { log: jest.fn() };

    service = new WorkspaceInvitationService(
      userRepo,
      groupUserRepo,
      mailService as any,
      domainService,
      tokenService,
      sessionService as any,
      db as any,
      billingQueue as any,
      environmentService as any,
      auditService as any,
    );
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  // A workspace with its default group, an inviter, and a pending invitation.
  async function seedInvite(): Promise<{
    workspace: Workspace;
    invitationId: string;
    token: string;
    email: string;
  }> {
    const { id: workspaceId } = await createWorkspace(db);
    await createDefaultGroup(db, workspaceId);
    const inviter = await createUser(db, workspaceId);
    // Distinct address per invite so specs never collide across the suite.
    const email = `invitee-${workspaceId.slice(0, 8)}@example.test`;
    const invite = await createInvitation(db, {
      workspaceId,
      email,
      invitedById: inviter.id,
    });

    // acceptInvitation only reads id/hostname/enforceSso/emailDomains/enforceMfa
    // off the workspace; a minimal plain object is sufficient.
    const workspace = {
      id: workspaceId,
      hostname: `host-${workspaceId.slice(0, 8)}`,
      enforceSso: false,
      enforceMfa: false,
      emailDomains: [] as string[],
    } as unknown as Workspace;

    return { workspace, invitationId: invite.id, token: invite.token, email };
  }

  it('concurrent accepts create a single membership and consume the invitation once', async () => {
    const { workspace, invitationId, token, email } = await seedInvite();

    const dto = { invitationId, token, name: 'Invited User', password: 'password123' };

    // Fire two accepts of the SAME invitation at once. They race to insert the
    // same (email, workspaceId); the unique constraint lets exactly one win.
    const results = await Promise.allSettled([
      service.acceptInvitation({ ...dto }, workspace),
      service.acceptInvitation({ ...dto }, workspace),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // Exactly one accept succeeds; the other is rejected.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser fails via the caught unique-constraint path with the specific
    // "already accepted" message — not a half-state / generic failure.
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    expect(rejected[0].reason.message).toBe('Invitation already accepted');

    // Invariant: exactly one membership, and the invitation is gone.
    expect(await membershipCount(workspace.id, email)).toBe(1);
    expect(await invitationExists(invitationId)).toBe(false);
  });

  it('a repeated (sequential) accept does not create a duplicate membership', async () => {
    const { workspace, invitationId, token, email } = await seedInvite();
    const dto = { invitationId, token, name: 'Invited User', password: 'password123' };

    // First accept succeeds and returns an auth token.
    const first = await service.acceptInvitation({ ...dto }, workspace);
    expect(first?.authToken).toBe('test-auth-token');
    expect(await membershipCount(workspace.id, email)).toBe(1);
    expect(await invitationExists(invitationId)).toBe(false);

    // Re-accepting the (now consumed) invitation must be rejected and must NOT
    // add a second membership. The invitation row is gone, so this hits the
    // "Invitation not found" guard rather than the unique-constraint path.
    await expect(
      service.acceptInvitation({ ...dto }, workspace),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(await membershipCount(workspace.id, email)).toBe(1);
  });

  it('the single created membership is added to the default group (no partial state)', async () => {
    const { workspace, invitationId, token, email } = await seedInvite();
    const dto = { invitationId, token, name: 'Invited User', password: 'password123' };

    await Promise.allSettled([
      service.acceptInvitation({ ...dto }, workspace),
      service.acceptInvitation({ ...dto }, workspace),
    ]);

    // Resolve the one surviving user and assert the whole tx applied: they exist
    // AND are in the workspace default group (the mid-transaction step), proving
    // the winning accept committed as a whole rather than leaving a torn state.
    const user = await db
      .selectFrom('users')
      .select(['id'])
      .where('workspaceId', '=', workspace.id)
      .where('email', '=', email.toLowerCase())
      .executeTakeFirstOrThrow();

    const defaultGroup = await db
      .selectFrom('groups')
      .select(['id'])
      .where('workspaceId', '=', workspace.id)
      .where('isDefault', '=', true)
      .executeTakeFirstOrThrow();

    const membership = await db
      .selectFrom('groupUsers')
      .select(['userId'])
      .where('groupId', '=', defaultGroup.id)
      .where('userId', '=', user.id)
      .execute();

    expect(membership).toHaveLength(1);
  });
});
