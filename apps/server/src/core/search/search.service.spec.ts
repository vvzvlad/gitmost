import { SearchService } from './search.service';

describe('SearchService', () => {
  it('should be defined', () => {
    // Construct directly with stub deps. The previous Test.createTestingModule
    // form could not resolve the @InjectKysely() connection token and failed at
    // compile() — manual construction mirrors the rest of these unit specs.
    const service = new SearchService(
      {} as any, // db
      {} as any, // pageRepo
      {} as any, // shareRepo
      {} as any, // spaceMemberRepo
      {} as any, // pagePermissionRepo
    );
    expect(service).toBeDefined();
  });
});

/**
 * Focused coverage for the `onlyTemplates` flag in `searchSuggestions`, which
 * restricts page suggestions to template pages (`is_template = true`). The kysely
 * query builder and repos are mocked the same way the access specs mock chainable
 * builders: every builder method returns the same builder, `.execute()` resolves
 * the supplied rows. We assert whether `.where('isTemplate', '=', true)` is added.
 */
describe('SearchService.searchSuggestions — onlyTemplates filter', () => {
  function makeService(pageRows: Array<{ id: string }>) {
    // Chainable page-search builder. Record every `.where(...)` call so we can
    // assert on the is_template restriction.
    const pageBuilder: any = {};
    pageBuilder.select = jest.fn(() => pageBuilder);
    pageBuilder.where = jest.fn(() => pageBuilder);
    pageBuilder.orderBy = jest.fn(() => pageBuilder);
    pageBuilder.limit = jest.fn(() => pageBuilder);
    pageBuilder.execute = jest.fn(async () => pageRows);

    const db: any = {
      // searchSuggestions only touches `pages` here (includePages: true).
      selectFrom: jest.fn(() => pageBuilder),
    };

    const pageRepo = {
      // `.select((eb) => this.pageRepo.withSpace(eb))` — return value is ignored
      // by our builder stub, so a sentinel is enough.
      withSpace: jest.fn(() => ({ __withSpace: true })),
    };
    const shareRepo = {};
    const spaceMemberRepo = {
      getUserSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };
    const pagePermissionRepo = {
      // Let every found page through page-level permission filtering.
      filterAccessiblePageIds: jest
        .fn()
        .mockImplementation(async ({ pageIds }: { pageIds: string[] }) => pageIds),
    };

    const service = new SearchService(
      db as any,
      pageRepo as any,
      shareRepo as any,
      spaceMemberRepo as any,
      pagePermissionRepo as any,
    );

    return { service, db, pageBuilder };
  }

  const isTemplateWhereCall = (pageBuilder: any) =>
    pageBuilder.where.mock.calls.find((c: any[]) => c[0] === 'isTemplate');

  it('restricts page suggestions to is_template = true when onlyTemplates is set', async () => {
    const { service, pageBuilder } = makeService([{ id: 'tmpl-1' }]);

    const result = await service.searchSuggestions(
      { query: 'plan', includePages: true, onlyTemplates: true } as any,
      'user-1',
      'ws-1',
    );

    // The is_template restriction must be applied to the page query.
    const call = isTemplateWhereCall(pageBuilder);
    expect(call).toEqual(['isTemplate', '=', true]);

    // Sanity: the (template) page made it through.
    expect(result.pages.map((p: any) => p.id)).toEqual(['tmpl-1']);
  });

  it('does NOT restrict to templates when onlyTemplates is absent', async () => {
    const { service, pageBuilder } = makeService([{ id: 'any-1' }]);

    await service.searchSuggestions(
      { query: 'plan', includePages: true } as any,
      'user-1',
      'ws-1',
    );

    // No is_template clause should be added for a normal page suggestion search.
    expect(isTemplateWhereCall(pageBuilder)).toBeUndefined();
  });
});
