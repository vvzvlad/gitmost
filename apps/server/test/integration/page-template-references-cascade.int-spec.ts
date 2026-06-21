import { Kysely } from 'kysely';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
} from './db';

/**
 * C — page_template_references FK onDelete('cascade') (migration
 * 20260620T131000-page-template-references.ts). Both reference_page_id and
 * source_page_id reference pages.id ON DELETE CASCADE; deleting either page
 * must remove the reference row.
 */
describe('page_template_references FK cascade [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  async function seedRef() {
    const source = await createPage(db, { workspaceId, spaceId, title: 'source' });
    const reference = await createPage(db, { workspaceId, spaceId, title: 'reference' });
    const ref = await db
      .insertInto('pageTemplateReferences')
      .values({ workspaceId, sourcePageId: source.id, referencePageId: reference.id })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return { source, reference, refId: ref.id as string };
  }

  async function refExists(refId: string): Promise<boolean> {
    const row = await db
      .selectFrom('pageTemplateReferences')
      .select('id')
      .where('id', '=', refId)
      .executeTakeFirst();
    return Boolean(row);
  }

  it('deleting the referenced page cascades the reference row away', async () => {
    const { reference, refId } = await seedRef();
    expect(await refExists(refId)).toBe(true);

    await db.deleteFrom('pages').where('id', '=', reference.id).execute();

    expect(await refExists(refId)).toBe(false);
  });

  it('deleting the source page also cascades the reference row away', async () => {
    const { source, refId } = await seedRef();
    expect(await refExists(refId)).toBe(true);

    await db.deleteFrom('pages').where('id', '=', source.id).execute();

    expect(await refExists(refId)).toBe(false);
  });
});
