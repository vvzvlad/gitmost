import { Kysely } from 'kysely';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createUser,
  createRole,
  createChat,
} from './db';

/**
 * E (stretch) — AiChatRepo.findByCreator role-badge LEFT JOIN. The badge
 * (roleName/roleEmoji) is populated ONLY when the bound role is live AND
 * enabled; a soft-deleted or disabled role resolves to NULL, matching the
 * stream's resolveRoleForRequest downgrade. Real SQL join, not a mock.
 */
describe('AiChatRepo.findByCreator role-badge join [integration]', () => {
  let db: Kysely<any>;
  let repo: AiChatRepo;
  let roleRepo: AiAgentRoleRepo;
  let workspaceId: string;
  let creatorId: string;

  beforeAll(async () => {
    db = getTestDb();
    repo = new AiChatRepo(db as any);
    roleRepo = new AiAgentRoleRepo(db as any);
    workspaceId = (await createWorkspace(db)).id;
    creatorId = (await createUser(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  async function badgeFor(chatId: string) {
    const { items } = await repo.findByCreator(creatorId, workspaceId, {
      limit: 50,
    } as any);
    const row = items.find((c: any) => c.id === chatId);
    expect(row).toBeDefined();
    return { roleName: (row as any).roleName, roleEmoji: (row as any).roleEmoji };
  }

  it('enabled role -> roleName/roleEmoji populated', async () => {
    const role = await createRole(db, {
      workspaceId,
      name: 'Proofreader',
      emoji: '📝',
      enabled: true,
    });
    const chat = await createChat(db, { workspaceId, creatorId, roleId: role.id });

    const badge = await badgeFor(chat.id);
    expect(badge.roleName).toBe('Proofreader');
    expect(badge.roleEmoji).toBe('📝');
  });

  it('soft-deleted role -> badge NULL', async () => {
    const role = await createRole(db, {
      workspaceId,
      name: 'Deleted Persona',
      emoji: '🗑️',
      enabled: true,
    });
    const chat = await createChat(db, { workspaceId, creatorId, roleId: role.id });
    await roleRepo.softDelete(role.id, workspaceId);

    const badge = await badgeFor(chat.id);
    expect(badge.roleName).toBeNull();
    expect(badge.roleEmoji).toBeNull();
  });

  it('disabled role -> badge NULL (mirrors resolveRoleForRequest downgrade)', async () => {
    const role = await createRole(db, {
      workspaceId,
      name: 'Disabled Persona',
      emoji: '🚫',
      enabled: false,
    });
    const chat = await createChat(db, { workspaceId, creatorId, roleId: role.id });

    const badge = await badgeFor(chat.id);
    expect(badge.roleName).toBeNull();
    expect(badge.roleEmoji).toBeNull();
  });

  it('chat with no role -> badge NULL', async () => {
    const chat = await createChat(db, { workspaceId, creatorId, roleId: null });
    const badge = await badgeFor(chat.id);
    expect(badge.roleName).toBeNull();
    expect(badge.roleEmoji).toBeNull();
  });
});
