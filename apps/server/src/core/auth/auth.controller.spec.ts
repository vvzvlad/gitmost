import { AuthController } from './auth.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the injected dependency tokens (e.g. AUDIT_SERVICE) at compile(),
// and this smoke test only needs the controller to construct.
describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(() => {
    controller = new AuthController(
      {} as any, // authService
      {} as any, // sessionService
      {} as any, // environmentService
      {} as any, // moduleRef
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

// The collab-token handler is the ARM-SEAM of the #501 anti-laundering defense:
// it derives the api-key origin args ({ apiKeyId }) from the SIGNED-derived
// `req.raw` fields (stamped by jwt.strategy) and threads them into the collab
// token mint, forcing principal='api_key' so a later key revoke rejects NEW
// collab connections. A regression here (reading `body`, dropping `apiKeyId`,
// or inverting the ternary) would silently mint api-key requests as
// principal='session' and reopen the laundering hole with a green suite. These
// tests pin the EXACT args the controller passes to authService.getCollabToken.
describe('AuthController.collabToken arms the api-key origin (#501)', () => {
  let controller: AuthController;
  let getCollabToken: jest.Mock;

  const user = { id: 'u-1', workspaceId: 'ws-1' } as any;
  const workspace = { id: 'ws-1' } as any;

  beforeEach(() => {
    getCollabToken = jest.fn().mockResolvedValue({ token: 'ct' });
    controller = new AuthController(
      { getCollabToken } as any, // authService
      {} as any, // sessionService
      {} as any, // environmentService
      {} as any, // moduleRef
      {} as any, // auditService
    );
  });

  it('threads { apiKeyId } when req.raw marks an api_key principal (ARMED)', async () => {
    const req = { raw: { authType: 'api_key', apiKeyId: 'k-1' } } as any;

    await controller.collabToken(user, workspace, req);

    expect(getCollabToken).toHaveBeenCalledTimes(1);
    expect(getCollabToken).toHaveBeenCalledWith(user, 'ws-1', {
      apiKeyId: 'k-1',
    });
  });

  it('passes undefined for a normal session request (NOT armed)', async () => {
    const req = { raw: {} } as any;

    await controller.collabToken(user, workspace, req);

    expect(getCollabToken).toHaveBeenCalledTimes(1);
    expect(getCollabToken).toHaveBeenCalledWith(user, 'ws-1', undefined);
  });

  it('does NOT arm when api_key authType lacks an apiKeyId', async () => {
    const req = { raw: { authType: 'api_key' } } as any;

    await controller.collabToken(user, workspace, req);

    expect(getCollabToken).toHaveBeenCalledWith(user, 'ws-1', undefined);
  });

  it('reads the SIGNED req.raw, never a spoofable client body', async () => {
    // A client-supplied body claiming api_key must be ignored: only the
    // jwt.strategy-stamped req.raw can arm the api-key origin.
    const req = {
      raw: {},
      body: { authType: 'api_key', apiKeyId: 'attacker' },
    } as any;

    await controller.collabToken(user, workspace, req);

    expect(getCollabToken).toHaveBeenCalledWith(user, 'ws-1', undefined);
  });
});
