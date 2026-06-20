import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import {
  InsertablePageTemplateReference,
  PageTemplateReference,
} from '@docmost/db/types/entity.types';

@Injectable()
export class PageTemplateReferencesRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findByReferencePageId(
    referencePageId: string,
    trx?: KyselyTransaction,
  ): Promise<PageTemplateReference[]> {
    return dbOrTx(this.db, trx)
      .selectFrom('pageTemplateReferences')
      .selectAll()
      .where('referencePageId', '=', referencePageId)
      .execute();
  }

  async insertMany(
    rows: InsertablePageTemplateReference[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (rows.length === 0) return;
    await dbOrTx(this.db, trx)
      .insertInto('pageTemplateReferences')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['referencePageId', 'sourcePageId']).doNothing(),
      )
      .execute();
  }

  async deleteByReferenceAndSources(
    referencePageId: string,
    sourcePageIds: string[],
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (sourcePageIds.length === 0) return;
    await dbOrTx(this.db, trx)
      .deleteFrom('pageTemplateReferences')
      .where('referencePageId', '=', referencePageId)
      .where('sourcePageId', 'in', sourcePageIds)
      .execute();
  }
}
