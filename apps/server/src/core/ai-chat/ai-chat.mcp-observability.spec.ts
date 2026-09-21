import {
  buildMcpFailures,
  truncateMcpReason,
  chatStreamMetadata,
  flushAssistant,
  type McpFailureRecord,
} from './ai-chat.service';
import {
  MCP_FAILURES_CAP,
  MCP_FAILURE_REASON_MAX,
} from './external-mcp/mcp.constants';

/**
 * #686 P4 — external-MCP failure observability. The failures a turn hit are
 * (a) delivered to the client on the stream `start` part via chatStreamMetadata,
 * and (b) persisted into the assistant message metadata via flushAssistant —
 * the SAME seams that carry {chatId,runId} and contextTokens today.
 */

describe('buildMcpFailures — shape + bounded budget (#686)', () => {
  it('keeps ONLY ok:false outcomes, mapped to {name, reason}', () => {
    const out = buildMcpFailures([
      { name: 'Tavily', ok: true },
      { name: 'Down', ok: false, reason: 'connection failed' },
      { name: 'Auth', ok: false, reason: 'auth-unreadable' },
    ]);
    expect(out).toEqual([
      { name: 'Down', reason: 'connection failed' },
      { name: 'Auth', reason: 'auth-unreadable' },
    ]);
  });

  it('caps the number of records at MCP_FAILURES_CAP', () => {
    const many = Array.from({ length: MCP_FAILURES_CAP + 5 }, (_, i) => ({
      name: `s${i}`,
      ok: false,
      reason: 'x',
    }));
    expect(buildMcpFailures(many)).toHaveLength(MCP_FAILURES_CAP);
  });

  it('truncates each reason to MCP_FAILURE_REASON_MAX chars', () => {
    const long = 'z'.repeat(MCP_FAILURE_REASON_MAX + 50);
    const [rec] = buildMcpFailures([{ name: 's', ok: false, reason: long }]);
    expect(rec.reason).toHaveLength(MCP_FAILURE_REASON_MAX);
    expect(truncateMcpReason(long)).toHaveLength(MCP_FAILURE_REASON_MAX);
  });

  it('tolerates undefined / empty', () => {
    expect(buildMcpFailures(undefined)).toEqual([]);
    expect(buildMcpFailures([])).toEqual([]);
  });
});

describe('chatStreamMetadata delivers mcpFailures on the start part (#686)', () => {
  const failures: McpFailureRecord[] = [{ name: 'Down', reason: 'boom' }];

  it('attaches mcpFailures alongside {chatId, runId} on the start part', () => {
    const meta = chatStreamMetadata(
      { type: 'start' } as any,
      'chat-1',
      undefined,
      'run-1',
      failures,
    );
    expect(meta).toEqual({
      chatId: 'chat-1',
      runId: 'run-1',
      mcpFailures: failures,
    });
  });

  it('omits mcpFailures entirely when there are none (unchanged legacy wire)', () => {
    const meta = chatStreamMetadata(
      { type: 'start' } as any,
      'chat-1',
      undefined,
      'run-1',
      [],
    );
    expect(meta).toEqual({ chatId: 'chat-1', runId: 'run-1' });
    expect((meta as any).mcpFailures).toBeUndefined();
  });

  it('does NOT attach failures to non-start parts', () => {
    const meta = chatStreamMetadata(
      { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1 } } as any,
      'chat-1',
      undefined,
      'run-1',
      failures,
    );
    expect((meta as any)?.mcpFailures).toBeUndefined();
  });
});

describe('flushAssistant persists mcpFailures into message metadata (#686)', () => {
  const failures: McpFailureRecord[] = [
    { name: 'Down', reason: 'connection failed' },
  ];

  it('writes metadata.mcpFailures when non-empty', () => {
    const flushed = flushAssistant([], '', 'completed', { mcpFailures: failures });
    expect((flushed.metadata as any).mcpFailures).toEqual(failures);
  });

  it('omits metadata.mcpFailures on a clean turn (empty/absent)', () => {
    const clean = flushAssistant([], '', 'completed', { mcpFailures: [] });
    expect((clean.metadata as any).mcpFailures).toBeUndefined();
    const none = flushAssistant([], '', 'completed', {});
    expect((none.metadata as any).mcpFailures).toBeUndefined();
  });

  it('carries the synthetic total-build-failure record shape', () => {
    // The service synthesizes this on a total build failure (non-Stop catch).
    const synthetic: McpFailureRecord[] = [
      { name: '(external toolset)', reason: 'build failed: boom' },
    ];
    const flushed = flushAssistant([], '', 'error', {
      error: 'x',
      mcpFailures: synthetic,
    });
    expect((flushed.metadata as any).mcpFailures).toEqual(synthetic);
  });
});
