import { WorkspaceService } from './workspace.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue()/AUDIT_SERVICE tokens at compile();
// this smoke test only needs the service to construct.
describe('WorkspaceService', () => {
  let service: WorkspaceService;

  beforeEach(() => {
    service = new WorkspaceService(
      {} as any, // workspaceRepo
      {} as any, // spaceService
      {} as any, // spaceMemberService
      {} as any, // groupRepo
      {} as any, // groupUserRepo
      {} as any, // userRepo
      {} as any, // environmentService
      {} as any, // domainService
      {} as any, // licenseCheckService
      {} as any, // shareRepo
      {} as any, // watcherRepo
      {} as any, // favoriteRepo
      {} as any, // db
      {} as any, // attachmentQueue
      {} as any, // billingQueue
      {} as any, // aiQueue
      {} as any, // auditService
      {} as any, // userSessionRepo
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
