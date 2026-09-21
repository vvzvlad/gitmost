import { ForbiddenException } from '@nestjs/common';
import { AccountMcpServersController } from './account-mcp-servers.controller';

/**
 * Kill-switch guard for the personal MCP CRUD API (#686). When
 * MCP_PERSONAL_SERVERS_ENABLED=false, EVERY endpoint must answer 403 and MUST
 * NOT reach the service (no read/write happens against a disabled feature). The
 * observable property is "403 + service untouched", so we drive the real
 * controller methods with a spying service stub.
 *
 * With the flag ON, each handler must delegate to the service passing the
 * caller's OWN (workspace.id, user.id) — the wiring that makes the API
 * owner-scoped rather than admin-scoped.
 */
describe('AccountMcpServersController kill-switch (#686)', () => {
  const user = { id: 'user-1' } as any;
  const workspace = { id: 'ws-1' } as any;

  function build(enabled: boolean) {
    const service = {
      list: jest.fn().mockResolvedValue([]),
      createPersonal: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({ success: true }),
      test: jest.fn().mockResolvedValue({ ok: true, tools: [] }),
    };
    const env = { isMcpPersonalServersEnabled: () => enabled };
    const controller = new AccountMcpServersController(
      service as any,
      env as any,
    );
    return { controller, service };
  }

  describe('disabled => 403 on every endpoint, service never called', () => {
    it('list', async () => {
      const { controller, service } = build(false);
      await expect(controller.list(user, workspace)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(service.list).not.toHaveBeenCalled();
    });

    it('create', async () => {
      const { controller, service } = build(false);
      await expect(
        controller.create({} as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.createPersonal).not.toHaveBeenCalled();
    });

    it('update', async () => {
      const { controller, service } = build(false);
      await expect(
        controller.update({ id: 'srv-1' } as any, {} as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('delete', async () => {
      const { controller, service } = build(false);
      await expect(
        controller.remove({ id: 'srv-1' } as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('test', async () => {
      const { controller, service } = build(false);
      await expect(
        controller.test({ id: 'srv-1' } as any, user, workspace),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.test).not.toHaveBeenCalled();
    });
  });

  describe('enabled => delegates with the caller own (workspace.id, user.id)', () => {
    it('list passes (workspace.id, user.id)', async () => {
      const { controller, service } = build(true);
      await controller.list(user, workspace);
      expect(service.list).toHaveBeenCalledWith('ws-1', 'user-1');
    });

    it('create passes (workspace.id, user.id, dto)', async () => {
      const { controller, service } = build(true);
      const dto = { name: 'n' } as any;
      await controller.create(dto, user, workspace);
      expect(service.createPersonal).toHaveBeenCalledWith('ws-1', 'user-1', dto);
    });

    it('update passes (workspace.id, user.id, id, dto)', async () => {
      const { controller, service } = build(true);
      const dto = { name: 'n' } as any;
      await controller.update({ id: 'srv-9' } as any, dto, user, workspace);
      expect(service.update).toHaveBeenCalledWith('ws-1', 'user-1', 'srv-9', dto);
    });

    it('delete passes (workspace.id, user.id, id)', async () => {
      const { controller, service } = build(true);
      await controller.remove({ id: 'srv-9' } as any, user, workspace);
      expect(service.remove).toHaveBeenCalledWith('ws-1', 'user-1', 'srv-9');
    });

    it('test passes (workspace.id, user.id, id)', async () => {
      const { controller, service } = build(true);
      await controller.test({ id: 'srv-9' } as any, user, workspace);
      expect(service.test).toHaveBeenCalledWith('ws-1', 'user-1', 'srv-9');
    });
  });
});
