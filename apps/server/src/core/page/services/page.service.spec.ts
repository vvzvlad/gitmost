import { PageService } from './page.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue() tokens at compile(), and this
// smoke test only needs the service to construct.
describe('PageService', () => {
  let service: PageService;

  beforeEach(() => {
    service = new PageService(
      {} as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // attachmentRepo
      {} as any, // db
      {} as any, // storageService
      {} as any, // attachmentQueue
      {} as any, // aiQueue
      {} as any, // generalQueue
      {} as any, // eventEmitter
      {} as any, // collaborationGateway
      {} as any, // watcherService
      {} as any, // transclusionService
      {} as any, // workspaceRepo
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
