import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ClientMetricRow,
  MAX_BODY_BYTES,
  MAX_EVENTS_PER_BATCH,
  sanitizeVitalEvent,
} from './client-metrics.constants';

@Injectable()
export class VitalsService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Turn a raw request body into the (bounded, whitelisted) rows to persist.
   * Pure/synchronous so it is unit-testable without a DB. Returns [] for any
   * malformed / oversized / foreign input — the caller still responds 200.
   */
  buildRows(body: unknown, workspaceId: string | null): ClientMetricRow[] {
    if (!body || typeof body !== 'object') return [];

    // Defence-in-depth body cap (~16KB): drop oversized batches wholesale.
    try {
      if (JSON.stringify(body).length > MAX_BODY_BYTES) return [];
    } catch {
      return [];
    }

    // Accept either a bare array or `{ events: [...] }`.
    const events = Array.isArray(body)
      ? body
      : Array.isArray((body as { events?: unknown }).events)
        ? ((body as { events: unknown[] }).events as unknown[])
        : null;
    if (!events) return [];

    const rows: ClientMetricRow[] = [];
    for (const event of events) {
      if (rows.length >= MAX_EVENTS_PER_BATCH) break;
      const row = sanitizeVitalEvent(event, workspaceId);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** Batch-insert the sanitised rows in a single statement. No-op on []. */
  async insertRows(rows: ClientMetricRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insertInto('clientMetrics')
      .values(
        rows.map((r) => ({
          name: r.name,
          value: r.value,
          rating: r.rating,
          route: r.route,
          attr: r.attr,
          docSize: r.docSize,
          workspaceId: r.workspaceId,
        })),
      )
      .execute();
  }

  async ingest(body: unknown, workspaceId: string | null): Promise<void> {
    const rows = this.buildRows(body, workspaceId);
    await this.insertRows(rows);
  }
}
