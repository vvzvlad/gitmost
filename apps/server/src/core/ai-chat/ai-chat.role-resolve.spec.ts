import { AiChatService } from './ai-chat.service';
import type { AiChatStreamBody } from './ai-chat.service';
import type { AiAgentRole, Workspace } from '@docmost/db/types/entity.types';

/**
 * Security-critical unit tests for AiChatService.resolveRoleForRequest.
 *
 * This method carries the feature's role invariants:
 *  - an EXISTING chat fixes its role from the chat row (ai_chats.role_id),
 *    NEVER from the request body — so a role cannot be swapped per-turn;
 *  - every role lookup is workspace-scoped (cross-workspace roleId => null);
 *  - a disabled or soft-deleted role is downgraded to the universal assistant.
 *
 * AiChatService's constructor only stores its deps (no module graph work), so it
 * can be unit-constructed with stubbed repos. Only aiChatRepo + aiAgentRoleRepo
 * are exercised here; the rest are stubbed with empty objects.
 */
describe('AiChatService.resolveRoleForRequest', () => {
  const workspace = { id: 'ws-1' } as Workspace;

  function makeRole(over: Partial<AiAgentRole> = {}): AiAgentRole {
    return {
      id: 'role-1',
      workspaceId: 'ws-1',
      name: 'Researcher',
      enabled: true,
      instructions: 'be a researcher',
      ...over,
    } as AiAgentRole;
  }

  function makeService(opts: {
    chat?: { roleId: string | null } | undefined;
    // The role returned by findLiveEnabled (the live + enabled + workspace-scoped
    // lookup). undefined models a missing / soft-deleted / disabled / cross-
    // workspace role — the repo, not the service, now enforces those filters.
    role?: AiAgentRole | undefined;
  }) {
    const aiChatRepo = {
      findById: jest.fn().mockResolvedValue(opts.chat),
    };
    const aiAgentRoleRepo = {
      findLiveEnabled: jest.fn().mockResolvedValue(opts.role),
    };
    const service = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      {} as never, // aiChatMessageRepo
      {} as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      {} as never, // tools
      {} as never, // mcpClients
      aiAgentRoleRepo as never,
      {} as never, // pageRepo
      {} as never, // pageAccess
    );
    return { service, aiChatRepo, aiAgentRoleRepo };
  }

  it('existing chat: resolves the role from chat.roleId, NOT body.roleId (anti per-turn swap)', async () => {
    const role = makeRole({ id: 'chat-role' });
    const { service, aiChatRepo, aiAgentRoleRepo } = makeService({
      chat: { roleId: 'chat-role' },
      role,
    });
    const body: AiChatStreamBody = {
      chatId: 'chat-1',
      roleId: 'attacker-role', // differs from the chat's bound role
    };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBe(role);
    // The role lookup used the chat's role id, never the body's.
    expect(aiAgentRoleRepo.findLiveEnabled).toHaveBeenCalledWith(
      'chat-role',
      'ws-1',
    );
    expect(aiAgentRoleRepo.findLiveEnabled).not.toHaveBeenCalledWith(
      'attacker-role',
      expect.anything(),
    );
    // The chat itself was loaded workspace-scoped.
    expect(aiChatRepo.findById).toHaveBeenCalledWith('chat-1', 'ws-1');
  });

  it('scopes the role lookup to the workspace (cross-workspace roleId => null)', async () => {
    // The repo stub returns undefined to model a roleId that does not exist in
    // THIS workspace (findLiveEnabled is workspace-scoped). resolveRoleForRequest
    // must still pass workspace.id to the lookup.
    const { service, aiAgentRoleRepo } = makeService({
      chat: undefined,
      role: undefined,
    });
    const body: AiChatStreamBody = { roleId: 'role-from-other-ws' };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBeNull();
    expect(aiAgentRoleRepo.findLiveEnabled).toHaveBeenCalledWith(
      'role-from-other-ws',
      'ws-1',
    );
  });

  it('disabled role: findLiveEnabled filters it out (undefined) => null (disabled role not applied)', async () => {
    // The repo's findLiveEnabled enforces enabled=true, so a disabled role never
    // comes back; the service just maps that undefined to null.
    const { service } = makeService({
      chat: { roleId: 'role-1' },
      role: undefined,
    });
    const body: AiChatStreamBody = { chatId: 'chat-1' };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBeNull();
  });

  it('role lookup returns undefined (soft-deleted) => null', async () => {
    const { service } = makeService({
      chat: { roleId: 'role-1' },
      role: undefined,
    });
    const body: AiChatStreamBody = { chatId: 'chat-1' };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBeNull();
  });

  it('new chat (no chatId): resolves body.roleId', async () => {
    const role = makeRole({ id: 'picked' });
    const { service, aiChatRepo, aiAgentRoleRepo } = makeService({
      chat: undefined,
      role,
    });
    const body: AiChatStreamBody = { roleId: 'picked' };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBe(role);
    expect(aiAgentRoleRepo.findLiveEnabled).toHaveBeenCalledWith(
      'picked',
      'ws-1',
    );
    // No chat lookup happens when there is no chatId.
    expect(aiChatRepo.findById).not.toHaveBeenCalled();
  });

  it('stale chatId (chat not found): falls back to body.roleId', async () => {
    const role = makeRole({ id: 'body-role' });
    const { service, aiAgentRoleRepo } = makeService({
      chat: undefined, // findById => undefined: the chat does not exist here
      role,
    });
    const body: AiChatStreamBody = {
      chatId: 'ghost-chat',
      roleId: 'body-role',
    };

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBe(role);
    expect(aiAgentRoleRepo.findLiveEnabled).toHaveBeenCalledWith(
      'body-role',
      'ws-1',
    );
  });

  it('no role anywhere (universal assistant): returns null without a role lookup', async () => {
    const { service, aiAgentRoleRepo } = makeService({
      chat: undefined,
      role: undefined,
    });
    const body: AiChatStreamBody = {};

    const resolved = await service.resolveRoleForRequest(workspace, body);

    expect(resolved).toBeNull();
    // Short-circuit: no roleId means no lookup at all.
    expect(aiAgentRoleRepo.findLiveEnabled).not.toHaveBeenCalled();
  });
});
