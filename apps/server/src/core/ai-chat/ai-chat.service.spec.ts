import { compactToolOutput } from './ai-chat.service';

/**
 * Unit tests for compactToolOutput: the pure helper that shrinks LARGE tool
 * outputs before they are persisted (and re-sent to the provider on later
 * turns). The contract is: small outputs pass through unchanged (by identity);
 * large outputs keep their shape and small scalar fields (id/title/pageId — the
 * client reads these to render citations) while big payloads are truncated.
 */
describe('compactToolOutput', () => {
  it('returns a small object unchanged (by identity)', () => {
    const small = { id: 'p1', title: 'Hello', trashed: true };
    expect(compactToolOutput(small)).toBe(small);
  });

  it('truncates a large getPage-shaped markdown body but keeps the title', () => {
    const big = 'x'.repeat(20000);
    const result = compactToolOutput({ title: 'T', markdown: big }) as {
      title: string;
      markdown: string;
    };
    // Shallow scalar field is preserved (citations depend on it).
    expect(result.title).toBe('T');
    // The big payload is shrunk far below the original size.
    expect(result.markdown.length).toBeLessThan(20000);
    expect(result.markdown).toContain('[truncated');
  });

  it('caps a long array and appends a single truncation marker', () => {
    // 200 small objects, each padded so the total serialized size > 4000 bytes.
    const long = Array.from({ length: 200 }, (_, i) => ({
      id: 'n' + i,
      pad: 'y'.repeat(40),
    }));
    const result = compactToolOutput(long) as Array<Record<string, unknown>>;
    // 50 kept + 1 marker.
    expect(result).toHaveLength(51);
    const marker = result[result.length - 1];
    expect(marker._truncated).toBe(true);
    expect(marker.omittedItems).toBe(150);
  });

  it('passes through null, undefined and primitives unchanged', () => {
    expect(compactToolOutput(null)).toBeNull();
    expect(compactToolOutput(undefined)).toBeUndefined();
    expect(compactToolOutput(42)).toBe(42);
  });

  it('replaces a subtree beyond the depth cap with a marker', () => {
    // Build a deeply nested object (> TOOL_OUTPUT_MAX_DEPTH levels) with a big
    // string at the bottom so the total serialized size exceeds the threshold.
    let nested: Record<string, unknown> = { leaf: 'z'.repeat(8000) };
    for (let i = 0; i < 20; i++) {
      nested = { child: nested };
    }
    const result = compactToolOutput(nested);
    expect(JSON.stringify(result)).toContain('nested content omitted');
  });

  it('produces a much smaller JSON than the original for a large input', () => {
    const big = 'x'.repeat(20000);
    const original = { title: 'T', markdown: big };
    const result = compactToolOutput(original);
    const originalBytes = Buffer.byteLength(JSON.stringify(original), 'utf8');
    const compactedBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    expect(compactedBytes).toBeLessThan(originalBytes / 10);
  });
});
