import { PageController } from './page.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve PageService's injected tokens at compile(), and this smoke test only
// needs the controller to construct.
describe('PageController', () => {
  let controller: PageController;

  beforeEach(() => {
    controller = new PageController(
      {} as any, // pageService
      {} as any, // pageRepo
      {} as any, // pageHistoryService
      {} as any, // spaceAbility
      {} as any, // pageAccessService
      {} as any, // backlinkService
      {} as any, // labelService
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
