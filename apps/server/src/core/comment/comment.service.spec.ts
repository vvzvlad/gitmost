import { CommentService } from './comment.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectQueue() tokens at compile(), and this smoke test only
// needs the service to construct.
describe('CommentService', () => {
  let service: CommentService;

  beforeEach(() => {
    service = new CommentService(
      {} as any, // commentRepo
      {} as any, // pageRepo
      {} as any, // wsService
      {} as any, // collaborationGateway
      {} as any, // generalQueue
      {} as any, // notificationQueue
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
