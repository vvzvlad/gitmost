import { SearchService, buildTsQuery } from './search.service';

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

// Unit tests for `buildTsQuery` (extracted from search.service.ts). It turns a raw
// user query into a prefix tsquery string fed to `to_tsquery('english', ...)`.
//
// REAL BUG (Gitea #139, item 10): the previous inline `tsquery(query.trim() + '*')`
// let to_tsquery operator characters through, so adversarial inputs could produce a
// fragment that to_tsquery rejects -> 500. The extraction sanitizes the input
// (strip everything but letters/numbers/whitespace) so these inputs degrade to a
// safe, neutral query with NO throw, while normal queries keep working.
describe('buildTsQuery', () => {
  it('builds a prefix query for a normal single word', () => {
    expect(buildTsQuery('hello')).toBe('hello:*');
  });

  it('joins multiple words with AND and a trailing prefix match', () => {
    expect(buildTsQuery('foo bar')).toBe('foo&bar:*');
  });

  it('preserves accented and non-Latin words', () => {
    expect(buildTsQuery('héllo café')).toBe('héllo&café:*');
    expect(buildTsQuery('日本語')).toBe('日本語:*');
  });

  it('neutralizes to_tsquery operator inputs without throwing', () => {
    // Each of these previously risked an invalid to_tsquery -> 500. They must now
    // produce a safe (here empty) query and never throw.
    for (const input of ['&', '!', '*', '<->', '\\']) {
      expect(() => buildTsQuery(input)).not.toThrow();
      expect(buildTsQuery(input)).toBe('');
    }
  });

  it('handles stopword-only input safely', () => {
    // pg-tsquery still tokenizes stopwords; to_tsquery reduces them to nothing.
    // The important contract is: no throw, and a deterministic string.
    expect(() => buildTsQuery('the a of')).not.toThrow();
    expect(buildTsQuery('the a of')).toBe('the&a&of:*');
  });

  it('returns empty string for empty / whitespace-only / null-ish input', () => {
    expect(buildTsQuery('')).toBe('');
    expect(buildTsQuery('   ')).toBe('');
    expect(buildTsQuery(undefined as unknown as string)).toBe('');
  });

  it('handles a very long input without throwing', () => {
    const long = 'a'.repeat(10000);
    expect(() => buildTsQuery(long)).not.toThrow();
    expect(buildTsQuery(long)).toBe(`${long}:*`);
  });

  it('strips punctuation embedded in otherwise valid words', () => {
    expect(buildTsQuery('c++ code')).toBe('c&code:*');
    expect(buildTsQuery('a-b-c')).toBe('a&b&c:*');
  });
});
