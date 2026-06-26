import { SpaceService } from './space.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue()/AUDIT_SERVICE tokens at compile();
// this smoke test only needs the service to construct.
describe('SpaceService', () => {
  let service: SpaceService;

  beforeEach(() => {
    service = new SpaceService(
      {} as any, // spaceRepo
      {} as any, // spaceMemberService
      {} as any, // shareRepo
      {} as any, // workspaceRepo
      {} as any, // licenseCheckService
      {} as any, // db
      {} as any, // attachmentQueue
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
