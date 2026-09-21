import { type Kysely, sql } from 'kysely';

/**
 * #355 — `client_metrics`: raw sink for client-side perf telemetry (web-vitals
 * + custom editor/page metrics) posted to /api/telemetry/vitals.
 *
 * The table/columns/indexes here are a FIXED contract shared with the deployed
 * Grafana infra (the `grafana_ro` role reads this table; a separate maintenance
 * container prunes rows >90d and re-GRANTs daily). No app-side retention is
 * added on purpose. Written as raw SQL to match that contract 1:1 (identity PK,
 * conditional GRANT).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE client_metrics (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      name text NOT NULL,          -- INP|LCP|CLS|TTFB|editor_tx_ms|page_open_ms|longtask_ms
      value double precision NOT NULL,
      rating text,                 -- good|needs-improvement|poor (web-vitals only)
      route text,                  -- templated: /s/:space/p/:slug — never raw slugs
      attr text,                   -- attribution target, truncated to 120 chars
      doc_size int,                -- editor_tx_ms only
      workspace_id uuid
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_client_metrics_name_created
      ON client_metrics (name, created_at)
  `.execute(db);

  await sql`
    CREATE INDEX idx_client_metrics_created
      ON client_metrics (created_at)
  `.execute(db);

  // The read-only Grafana role only exists in the deployed environment; guard so
  // the migration still applies cleanly in dev/CI where the role is absent.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        GRANT SELECT ON client_metrics TO grafana_ro;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS client_metrics`.execute(db);
}
