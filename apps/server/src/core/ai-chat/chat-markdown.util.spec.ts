import { buildChatMarkdown, normalizeLang } from './chat-markdown.util';
import type { AiChatMessage } from '@docmost/db/types/entity.types';

/**
 * normalizeLang: the client sends `i18n.language` — a FULL locale tag like
 * 'en-US' / 'ru-RU', NOT a bare 'en'/'ru'. A `@IsIn(['en','ru'])` DTO rejected
 * that with a 400 (caught in real-browser testing); the export now accepts any
 * string and normalizes here. Guards that regression.
 */
describe('normalizeLang', () => {
  it("maps any 'ru…' locale tag to ru", () => {
    expect(normalizeLang('ru')).toBe('ru');
    expect(normalizeLang('ru-RU')).toBe('ru');
    expect(normalizeLang('RU-ru')).toBe('ru');
  });

  it('maps everything else (incl. region-qualified English) to en', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang('fr-FR')).toBe('en');
    expect(normalizeLang(undefined)).toBe('en');
    expect(normalizeLang('')).toBe('en');
  });
});

/**
 * Unit tests for the SERVER Markdown export (#183). Mirrors the coverage of the
 * (now-removed) client chat-markdown tests: heading/metadata, role labels, text
 * + tool blocks, token footers, the interrupted-turn note, and NULL-status
 * (legacy) rows. The export embeds a live `new Date().toISOString()` timestamp;
 * we never assert it, only the deterministic structure.
 */

function row(partial: Partial<AiChatMessage>): AiChatMessage {
  return {
    id: partial.id ?? 'id',
    chatId: partial.chatId ?? 'chat-1',
    workspaceId: partial.workspaceId ?? 'ws-1',
    userId: partial.userId ?? null,
    role: partial.role ?? 'user',
    content: partial.content ?? null,
    toolCalls: partial.toolCalls ?? null,
    metadata: partial.metadata ?? null,
    status: partial.status ?? null,
    createdAt: partial.createdAt ?? ('2026-06-21T00:00:00.000Z' as never),
    updatedAt: partial.updatedAt ?? ('2026-06-21T00:00:00.000Z' as never),
    deletedAt: partial.deletedAt ?? null,
  } as AiChatMessage;
}

describe('buildChatMarkdown (server) — structure', () => {
  it('emits the title heading, chat id and message count', () => {
    const md = buildChatMarkdown({
      title: 'My chat',
      chatId: 'chat-123',
      rows: [],
    });
    expect(md).toContain('# My chat');
    expect(md).toContain('- Chat ID: `chat-123`');
    expect(md).toContain('- Messages: 0');
  });

  it('falls back to "Untitled chat" with no title (en)', () => {
    const md = buildChatMarkdown({ title: null, chatId: 'c', rows: [] });
    expect(md).toContain('# Untitled chat');
  });

  it('localizes fixed labels with lang=ru (structure stays English)', () => {
    const md = buildChatMarkdown({
      title: null,
      chatId: 'c',
      lang: 'ru',
      rows: [row({ role: 'assistant', content: 'hi' })],
    });
    expect(md).toContain('# Без названия');
    expect(md).toContain('## 1. ИИ-агент');
    // Structural words remain English.
    expect(md).toContain('- Chat ID:');
  });

  it('numbers messages and labels roles (You / AI agent)', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({ role: 'user', content: 'question' }),
        row({ role: 'assistant', content: 'answer' }),
      ],
    });
    expect(md).toContain('## 1. You');
    expect(md).toContain('question');
    expect(md).toContain('## 2. AI agent');
    expect(md).toContain('answer');
  });

  it('renders a tool part with fenced input/output and the friendly label', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'done',
          metadata: {
            parts: [
              {
                type: 'tool-getPage',
                state: 'output-available',
                input: { id: 'p1' },
                output: { title: 'Hello' },
              },
              { type: 'text', text: 'done' },
            ],
          } as never,
        }),
      ],
    });
    expect(md).toContain('**Tool: Read page** (`getPage`) — done');
    expect(md).toContain('Input:');
    expect(md).toContain('"id": "p1"');
    expect(md).toContain('Output:');
    expect(md).toContain('"title": "Hello"');
  });

  // #186 re-review pt 1: restore the parity coverage of the removed client spec —
  // error state, unknown-tool fallback (en + ru), and the circular-stringify catch.
  it('renders a tool part in the error state with its errorText', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          metadata: {
            parts: [
              {
                type: 'tool-getPage',
                state: 'output-error',
                input: { id: 'p1' },
                errorText: 'page not found',
              },
            ],
          } as never,
        }),
      ],
    });
    expect(md).toContain('**Tool: Read page** (`getPage`) — error');
    expect(md).toContain('**Error:** page not found');
  });

  it('falls back to "Ran tool <name>" for an unknown tool (en) and the ru variant', () => {
    const parts = [
      {
        type: 'tool-mysteryTool',
        state: 'output-available',
        output: { ok: 1 },
      },
    ];
    const en = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [row({ role: 'assistant', metadata: { parts } as never })],
    });
    expect(en).toContain('**Tool: Ran tool mysteryTool** (`mysteryTool`)');
    const ru = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      lang: 'ru',
      rows: [row({ role: 'assistant', metadata: { parts } as never })],
    });
    expect(ru).toContain('Выполнил инструмент mysteryTool');
  });

  it('does not throw on a circular tool output (falls back to String)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      buildChatMarkdown({
        title: 'T',
        chatId: 'c',
        rows: [
          row({
            role: 'assistant',
            metadata: {
              parts: [
                {
                  type: 'tool-getPage',
                  state: 'output-available',
                  output: circular,
                },
              ],
            } as never,
          }),
        ],
      }),
    ).not.toThrow();
  });

  it('emits a token footer + total when usage is present', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'a',
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              reasoningTokens: 8,
            },
          } as never,
        }),
      ],
    });
    expect(md).toContain('- Total tokens: 120');
    expect(md).toContain(
      '_Tokens — in: 100, out: 20, reasoning: 8, total: 120_',
    );
  });

  it('flags a still-streaming (interrupted) row', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({ role: 'assistant', content: 'partial', status: 'streaming' }),
      ],
    });
    expect(md).toContain('still being generated');
  });

  it('does NOT flag a completed row', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [row({ role: 'assistant', content: 'final', status: 'completed' })],
    });
    expect(md).not.toContain('still being generated');
  });

  it('renders a legacy NULL-status row (no parts) from plain content', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({ role: 'assistant', content: 'legacy answer', status: null }),
      ],
    });
    expect(md).toContain('legacy answer');
    expect(md).not.toContain('still being generated');
  });

  it('renders a persisted error', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: '',
          status: 'error',
          metadata: { error: '401: Unauthorized' } as never,
        }),
      ],
    });
    expect(md).toContain('**⚠️ Error:** 401: Unauthorized');
  });

  it('escapes embedded triple-backtick fences with a longer delimiter', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'x',
          metadata: {
            parts: [
              {
                type: 'tool-getPage',
                state: 'output-available',
                output: '```inner```',
              },
            ],
          } as never,
        }),
      ],
    });
    // A 4-backtick fence wraps content that itself contains a 3-backtick run.
    expect(md).toContain('````');
  });
});
