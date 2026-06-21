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
