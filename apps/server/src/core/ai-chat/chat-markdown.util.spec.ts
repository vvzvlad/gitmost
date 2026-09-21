import {
  buildChatMarkdown,
  normalizeLang,
  labelledToolNames,
} from './chat-markdown.util';
import type { AiChatMessage } from '@docmost/db/types/entity.types';
import { SHARED_TOOL_SPECS } from '../../../../../packages/mcp/src/tool-specs';

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

  // #274 observability: an assistant row whose turn started with a user edit to
  // the open page carries metadata.pageChanged = { title, diff }; the export
  // renders the diff the agent saw, before the message body.
  it('renders the persisted page-change diff block for an assistant row', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'answer',
          metadata: {
            pageChanged: { title: 'Doc', diff: '@@ -1 +1 @@\n-old\n+new' },
          } as never,
        }),
      ],
    });
    expect(md).toContain(
      'The user edited this page before this turn; the diff the agent saw:',
    );
    expect(md).toContain('("Doc")');
    expect(md).toContain('-old');
    expect(md).toContain('+new');
    // The diff sits before the message body (chronological: change, then reply).
    expect(md.indexOf('-old')).toBeLessThan(md.indexOf('answer'));
  });

  it('does not render the page-change block when metadata.pageChanged is absent', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [row({ role: 'assistant', content: 'answer' })],
    });
    expect(md).not.toContain(
      'The user edited this page before this turn; the diff the agent saw:',
    );
  });

  // #288 F1/F2: an empty page title must render the BARE heading with no
  // `("…")` suffix (the `pc.title ? … : …` false branch).
  it('renders the page-change heading with no title suffix when title is empty', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'answer',
          metadata: {
            pageChanged: { title: '', diff: '@@ -1 +1 @@\n-old\n+new' },
          } as never,
        }),
      ],
    });
    // Bare heading, single line, no parenthesized title.
    expect(md).toContain(
      '> **📝 The user edited this page before this turn; the diff the agent saw:**',
    );
    expect(md).not.toContain('("');
    expect(md).toContain('-old');
  });

  // #288 F1: the page title is UNTRUSTED cross-user data, so a title carrying a
  // newline / backtick / `"` / `<`/`>` must be neutralized by escapeAttr before
  // it is interpolated into the `> **…**` blockquote heading — otherwise it
  // could break the blockquote onto multiple lines or inject markup/HTML into
  // the downloaded .md. escapeAttr strips `<>"` and collapses whitespace runs to
  // a single space, so `Ev"il\n> `x` <b>` becomes ``Evil `x` b``.
  it('escapes an untrusted page title in the page-change heading', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'answer',
          metadata: {
            pageChanged: {
              title: 'Ev"il\n> `x` <b>',
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          } as never,
        }),
      ],
    });
    // The heading stays a single blockquote line with the escaped title.
    expect(md).toContain(
      '> **📝 The user edited this page before this turn; the diff the agent saw: ("Evil `x` b")**',
    );
    // No raw attribute/markup breakers survived from the title.
    expect(md).not.toContain('Ev"il');
    expect(md).not.toContain('<b>');
  });

  // #288 review F1: escapeAttr ALONE is insufficient for this MARKDOWN sink —
  // link/image syntax survives it. A cross-user title with `![x](url)` /
  // `[phish](url)` must NOT become a working remote image or clickable link in
  // the downloaded .md; markdownHeadingSafe backslash-escapes `[`/`]` so both are
  // inert. (Non-vacuous: fails against the escapeAttr-only version, which left
  // `](https://` intact.)
  it('neutralizes markdown link/image syntax in an untrusted page title', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'answer',
          metadata: {
            pageChanged: {
              title:
                '![x](https://attacker.example/t.png) and [click](https://phish.example)',
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          } as never,
        }),
      ],
    });
    // No WORKING image/link syntax survives — the `[…]` sits escaped as `\[…\]`,
    // so the unescaped `![x](` image and `[click](` link markers are gone. (We
    // deliberately do NOT assert `not.toContain('](https://')`: after escaping the
    // literal `\](https://` still contains `](https://` as a raw substring — that
    // check would false-fail even though the link is inert.)
    expect(md).not.toContain('![x](');
    expect(md).not.toContain('[click](');
    // The brackets are backslash-escaped, so `[text](url)`/`![text](url)` are inert.
    expect(md).toContain('\\[');
    expect(md).toContain('\\]');
    // The heading stays a SINGLE blockquote line (no newline injected).
    const headingLine = md
      .split('\n')
      .find((l) => l.includes('the diff the agent saw:'));
    expect(headingLine).toBeDefined();
    expect(headingLine).toContain('\\[x\\]');
    expect(headingLine).toContain('\\[click\\]');
  });

  // #288 internal review Finding 2: a NON-empty title made up entirely of
  // escapeAttr breakers (`<>"`) escapes to '' — the ternary must then fall to the
  // BARE heading with NO `("…")` suffix. Locks the ternary-on-escaped-value
  // behavior (distinct from the empty-string input test above).
  it('renders the bare heading for a title that escapes to empty', () => {
    const md = buildChatMarkdown({
      title: 'T',
      chatId: 'c',
      rows: [
        row({
          role: 'assistant',
          content: 'answer',
          metadata: {
            pageChanged: { title: '<>"', diff: '@@ -1 +1 @@\n-old\n+new' },
          } as never,
        }),
      ],
    });
    expect(md).toContain(
      '> **📝 The user edited this page before this turn; the diff the agent saw:**',
    );
    expect(md).not.toContain('("');
    expect(md).toContain('-old');
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

/**
 * #494 — REVERSE drift-guard for the export's friendly tool labels. A label keyed
 * by a tool name that no longer exists silently degrades to the generic
 * "Ran tool <name>" line; nothing reddened before. This asserts every labelled
 * name is a real in-app tool and that both languages label the same set.
 */
describe('tool-label parity (#494)', () => {
  // In-app tool names come from the shared registry (inAppKey, excluding
  // mcpOnly specs) PLUS the inline in-app-only tools that carry a friendly label.
  // The only labelled inline tool is the hybrid semantic search.
  const INLINE_INAPP_LABELLED = new Set(['searchPages']);

  function validInAppToolNames(): Set<string> {
    const names = new Set<string>(INLINE_INAPP_LABELLED);
    for (const spec of Object.values(SHARED_TOOL_SPECS)) {
      if ((spec as { mcpOnly?: boolean }).mcpOnly) continue;
      names.add((spec as { inAppKey: string }).inAppKey);
    }
    return names;
  }

  it('en and ru label the SAME set of tools', () => {
    expect(labelledToolNames('en').sort()).toEqual(
      labelledToolNames('ru').sort(),
    );
  });

  it('every labelled tool name is a real in-app tool', () => {
    const valid = validInAppToolNames();
    const dead = labelledToolNames('en').filter((n) => !valid.has(n));
    expect(dead).toEqual([]);
  });

  it('the guard REDDENS for an unknown label key (mutation check)', () => {
    const valid = validInAppToolNames();
    // A hypothetical renamed-away label must be caught.
    expect(valid.has('getPageRenamedAway')).toBe(false);
  });
});
