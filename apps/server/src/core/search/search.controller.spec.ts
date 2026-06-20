import { SearchController } from './search.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve SearchService's @InjectKysely() connection token at compile() (the
// same Nest-DI/Kysely-token issue addressed in search.service.spec), and this
// unit only needs the controller to construct.
describe('SearchController', () => {
  let controller: SearchController;

  beforeEach(() => {
    controller = new SearchController(
      {} as any, // searchService
      {} as any, // spaceAbility
      {} as any, // environmentService
      {} as any, // moduleRef
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
