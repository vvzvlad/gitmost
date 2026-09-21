import { VitalsService } from './vitals.service';
import { MAX_ATTR_LENGTH } from './client-metrics.constants';

// buildRows is pure (no DB access), so a null db is fine here.
const svc = new VitalsService(null as any);

describe('VitalsService.buildRows', () => {
  const WS = 'ws-uuid';

  it('accepts a valid batch and maps whitelisted fields to rows', () => {
    const body = {
      events: [
        { name: 'INP', value: 123.4, rating: 'good', route: '/s/:space/p/:slug' },
        { name: 'editor_tx_ms', value: 12, route: '/s/:space/p/:slug', docSize: 4096 },
      ],
    };
    const rows = svc.buildRows(body, WS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'INP',
      value: 123.4,
      rating: 'good',
      route: '/s/:space/p/:slug',
      attr: null,
      docSize: null,
      workspaceId: WS,
    });
    expect(rows[1].name).toBe('editor_tx_ms');
    expect(rows[1].docSize).toBe(4096);
    expect(rows[1].workspaceId).toBe(WS);
  });

  it('accepts a bare array body', () => {
    const rows = svc.buildRows([{ name: 'LCP', value: 1 }], WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('LCP');
  });

  it('drops events with foreign metric names', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'evil_metric', value: 1 }, { name: 'LCP', value: 2 }] },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('LCP');
  });

  // #639 criterion 6 — the two new body-paint metric names are registered in
  // ALLOWED_METRIC_NAMES (accepted), while an unknown name is still dropped. A
  // name missing from this server allowlist is silently dropped even if the
  // client sends it, so this guards the server half of the 3-site registration.
  it('accepts page_open_body_ms / body_paint_timeout and still drops unknown names (#639)', () => {
    const rows = svc.buildRows(
      {
        events: [
          { name: 'page_open_body_ms', value: 842, route: '/s/:space/p/:slug' },
          { name: 'body_paint_timeout', value: 1, route: '/s/:space/p/:slug' },
          { name: 'not_a_real_metric', value: 1 }, // still dropped
        ],
      },
      WS,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'page_open_body_ms',
      'body_paint_timeout',
    ]);
  });

  // #683 criterion 6 — the single operation_ms metric is accepted and its op name
  // (carried in `attr`) survives the CSS-selector-shaped charset check, since op
  // values are short lowercase-and-underscore identifiers. An unknown name is
  // still dropped. Guards the server half of the client<->server name lockstep.
  it('accepts operation_ms with an op attr and still drops unknown names (#683)', () => {
    const rows = svc.buildRows(
      {
        events: [
          {
            name: 'operation_ms',
            value: 123,
            attr: 'comments_open',
            route: '/s/:space/p/:slug',
          },
          { name: 'operation_ms', value: 45, attr: 'diagram_mermaid' },
          { name: 'operation_ms', value: 12, attr: 'tree_expand' },
          { name: 'not_a_real_metric', value: 1 }, // still dropped
        ],
      },
      WS,
    );
    expect(rows.map((r) => r.name)).toEqual([
      'operation_ms',
      'operation_ms',
      'operation_ms',
    ]);
    // The op name is preserved in `attr` (not stripped by the charset guard).
    expect(rows.map((r) => r.attr)).toEqual([
      'comments_open',
      'diagram_mermaid',
      'tree_expand',
    ]);
  });

  // #681 criterion 3 — the new editor_key_latency_ms name is registered in the
  // server ALLOWED_METRIC_NAMES (accepted, not dropped as unknown), guarding the
  // server half of the client<->server name lockstep (#639). A name missing here
  // is silently dropped even when the client sends it.
  it('accepts editor_key_latency_ms and still drops unknown names (#681)', () => {
    const rows = svc.buildRows(
      {
        events: [
          {
            name: 'editor_key_latency_ms',
            value: 48,
            route: '/s/:space/p/:slug',
          },
          { name: 'not_a_real_metric', value: 1 }, // still dropped
        ],
      },
      WS,
    );
    expect(rows.map((r) => r.name)).toEqual(['editor_key_latency_ms']);
    expect(rows[0].value).toBe(48);
  });

  it('drops events with a non-numeric or missing value', () => {
    const rows = svc.buildRows(
      {
        events: [
          { name: 'CLS', value: 'nan' },
          { name: 'CLS' },
          { name: 'CLS', value: 0.1 },
        ],
      },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0.1);
  });

  it('strips foreign fields and only keeps whitelisted columns', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'TTFB', value: 5, secret: 'drop-me', title: 'my page' }] },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['attr', 'docSize', 'name', 'rating', 'route', 'value', 'workspaceId'].sort(),
    );
    expect((rows[0] as any).secret).toBeUndefined();
    expect((rows[0] as any).title).toBeUndefined();
  });

  it('rejects a rating outside the allowed set (-> null)', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'INP', value: 1, rating: 'terrible' }] },
      WS,
    );
    expect(rows[0].rating).toBeNull();
  });

  it('truncates attr to 120 chars', () => {
    const longAttr = 'a'.repeat(500);
    const rows = svc.buildRows(
      { events: [{ name: 'INP', value: 1, attr: longAttr }] },
      WS,
    );
    expect(rows[0].attr).toHaveLength(MAX_ATTR_LENGTH);
  });

  it('keeps a known route template but DROPS an unknown/free-text route (#495)', () => {
    const rows = svc.buildRows(
      {
        events: [
          { name: 'INP', value: 1, route: '/s/:space/p/:slug' }, // known
          { name: 'INP', value: 2, route: '/s/acme-corp/p/secret-slug' }, // raw path (slugs) — not a template
          { name: 'INP', value: 3, route: 'DROP TABLE client_metrics;--' }, // injected free text
          { name: 'INP', value: 4, route: '/home' }, // known static
        ],
      },
      WS,
    );
    expect(rows.map((r) => r.route)).toEqual([
      '/s/:space/p/:slug',
      null, // raw path dropped
      null, // free text dropped
      '/home',
    ]);
  });

  it('DROPS an attr that is not a CSS-selector-shaped string (#495)', () => {
    const rows = svc.buildRows(
      {
        events: [
          { name: 'INP', value: 1, attr: 'div#app>button.cta' }, // valid selector
          { name: 'INP', value: 2, attr: 'user@example.com wrote a note' }, // free text / PII
          { name: 'INP', value: 3, attr: '<script>alert(1)</script>' }, // markup
        ],
      },
      WS,
    );
    expect(rows.map((r) => r.attr)).toEqual([
      'div#app>button.cta',
      null,
      null,
    ]);
  });

  it('caps the batch at 50 events', () => {
    const events = Array.from({ length: 200 }, () => ({ name: 'CLS', value: 1 }));
    const rows = svc.buildRows({ events }, WS);
    expect(rows).toHaveLength(50);
  });

  it('drops an oversized (>16KB) payload wholesale', () => {
    const events = Array.from({ length: 50 }, () => ({
      name: 'INP',
      value: 1,
      attr: 'x'.repeat(400),
      route: '/s/:space/p/:slug',
    }));
    // Serialised body far exceeds 16KB.
    const rows = svc.buildRows({ events }, WS);
    expect(rows).toHaveLength(0);
  });

  it('returns [] for malformed bodies', () => {
    expect(svc.buildRows(null, WS)).toEqual([]);
    expect(svc.buildRows('nope', WS)).toEqual([]);
    expect(svc.buildRows({ notEvents: 1 }, WS)).toEqual([]);
    expect(svc.buildRows(42, WS)).toEqual([]);
  });

  it('carries a null workspaceId through', () => {
    const rows = svc.buildRows({ events: [{ name: 'LCP', value: 1 }] }, null);
    expect(rows[0].workspaceId).toBeNull();
  });

  it('drops an out-of-int4-range docSize to null without losing the batch', () => {
    const rows = svc.buildRows(
      {
        events: [
          // Garbage docSize overflowing int4 must NOT reject the whole batch:
          // the field is dropped to null and the event is kept.
          { name: 'editor_tx_ms', value: 10, docSize: 9_999_999_999 },
          { name: 'editor_tx_ms', value: 20, docSize: -5 },
          { name: 'editor_tx_ms', value: 30, docSize: 4096 },
        ],
      },
      WS,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].docSize).toBeNull();
    expect(rows[1].docSize).toBeNull();
    expect(rows[2].docSize).toBe(4096);
  });

  it('keeps a docSize exactly at the int4 max', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'editor_tx_ms', value: 1, docSize: 2147483647 }] },
      WS,
    );
    expect(rows[0].docSize).toBe(2147483647);
  });
});
