import { GroupService } from './group.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely() connection token (and AUDIT_SERVICE) at
// compile(); this smoke test only needs the service to construct.
describe('GroupService', () => {
  let service: GroupService;

  beforeEach(() => {
    service = new GroupService(
      {} as any, // groupRepo
      {} as any, // groupUserRepo
      {} as any, // spaceMemberRepo
      {} as any, // groupUserService
      {} as any, // watcherRepo
      {} as any, // favoriteRepo
      {} as any, // db
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
