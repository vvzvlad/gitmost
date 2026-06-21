import { AuthService } from './auth.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely() connection token (and AUDIT_SERVICE) at
// compile(); this smoke test only needs the service to construct.
describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService(
      {} as any, // signupService
      {} as any, // tokenService
      {} as any, // sessionService
      {} as any, // userSessionRepo
      {} as any, // userRepo
      {} as any, // userTokenRepo
      {} as any, // mailService
      {} as any, // domainService
      {} as any, // environmentService
      {} as any, // db
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
