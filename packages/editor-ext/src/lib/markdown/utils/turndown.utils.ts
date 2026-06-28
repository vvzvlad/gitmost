import * as _TurndownService from '@joplin/turndown';
import * as TurndownPluginGfm from '@joplin/turndown-plugin-gfm';
import { getBasename } from './basename';

// CJS/ESM interop: .default exists in Vite, not in NestJS
const TurndownService = (_TurndownService as any).default || _TurndownService;

function sanitizeMdLinkText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]!])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

// Tags turndown treats as void (self-closing). Footnote references render as an
// empty <sup data-footnote-ref> whose meaning lives entirely in its data-id;
// without marking it void, turndown's blank-node removal drops it before our
// rule runs, losing the `[^id]` marker. Mirrors turndown's built-in list.
const TURNDOWN_VOID_ELEMENTS = [
  'AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT',
  'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
];

function isVoidNode(node: any): boolean {
  const name = node?.nodeName?.toUpperCase?.();
  if (!name) return false;
  if (name === 'SUP' && node.hasAttribute?.('data-footnote-ref')) {
    return true;
  }
  return TURNDOWN_VOID_ELEMENTS.indexOf(name) !== -1;
}

/**
 * An empty <sup data-footnote-ref> is "blank" to turndown, which removes blank
 * inline nodes (RootNode/Node use a module-level isVoid the options cannot
 * override). To survive, inject the id as text content so the node is non-blank;
 * the footnoteReference rule then reads data-id and emits `[^id]`.
 */
function fillEmptyFootnoteRefs(html: string): string {
  return html.replace(
    /<sup\b([^>]*\bdata-footnote-ref\b[^>]*)>\s*<\/sup>/gi,
    (_m, attrs) => `<sup${attrs}>​</sup>`,
  );
}

/**
 * `pageBreak` and `transclusionReference` are childless atom <div>s. Like an
 * empty footnote ref (see above), turndown treats a childless block as "blank"
 * and replaces it with the blankRule BEFORE any custom rule can fire — so the
 * node disappears from the export with no trace (#206 mdrt-2). Inject a
 * zero-width space so the node is non-blank and our lossless rule runs; the
 * rule rebuilds the tag from the element's attributes, so the injected char
 * never reaches the output.
 */
function fillEmptyAtomBlocks(html: string): string {
  return html.replace(
    /<div\b([^>]*\bdata-type="(?:pageBreak|transclusionReference)"[^>]*)>\s*<\/div>/gi,
    (_m, attrs) => `<div${attrs}>​</div>`,
  );
}

/** HTML-escape an attribute value so a re-emitted raw-HTML tag is well-formed. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** HTML-escape text placed inside a re-emitted raw-HTML element. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serialize ALL of an element's attributes back to a raw-HTML attribute string
 * (leading space included). Generic on purpose: a custom node's identity lives
 * entirely in its `data-*` attributes (data-id, data-color, data-source-page-id,
 * data-transclusion-id, …), and serializing every attribute keeps the export
 * lossless regardless of which attributes a given node carries.
 */
function serializeAttrs(node: any): string {
  const attrs = node?.attributes;
  if (!attrs) return '';
  return Array.from(attrs as ArrayLike<{ name: string; value: string }>)
    .map((attr) => ` ${attr.name}="${escapeHtmlAttr(attr.value ?? '')}"`)
    .join('');
}

export function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
    isVoid: isVoidNode,
  });

  turndownService.use([
    TurndownPluginGfm.tables,
    TurndownPluginGfm.strikethrough,
    TurndownPluginGfm.highlightedCodeBlock,
    taskList,
    callout,
    preserveDetail,
    listParagraph,
    orderedListItem,
    mathInline,
    mathBlock,
    iframeEmbed,
    htmlEmbed,
    image,
    video,
    footnoteReference,
    footnotesList,
    pageBreak,
    transclusionReference,
    mention,
    status,
  ]);
  return turndownService
    .turndown(fillEmptyAtomBlocks(fillEmptyFootnoteRefs(html)))
    .replaceAll('<br>', ' ');
}

/**
 * Lossless export rules for custom nodes that have NO native Markdown syntax
 * (#206 mdrt-2). Markdown cannot represent a page break, a transclusion
 * reference, a mention's stable id, or a status chip's color — so rather than
 * letting turndown silently drop them, each rule re-emits the node as raw HTML
 * carrying every `data-*` attribute. Plain-Markdown viewers ignore the inert
 * tag, and the import path round-trips it: `markdownToHtml` passes raw HTML
 * through and each node's `parseHTML` (`div[data-type="…"]`, `span[…]`) rebuilds
 * the ProseMirror node with its attributes intact.
 */
function pageBreak(turndownService: _TurndownService) {
  turndownService.addRule('pageBreak', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'pageBreak'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      return `\n\n<div${serializeAttrs(node)}></div>\n\n`;
    },
  });
}

function transclusionReference(turndownService: _TurndownService) {
  turndownService.addRule('transclusionReference', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'transclusionReference'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      return `\n\n<div${serializeAttrs(node)}></div>\n\n`;
    },
  });
}

function mention(turndownService: _TurndownService) {
  turndownService.addRule('mention', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' &&
        node.getAttribute('data-type') === 'mention'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const text = escapeHtmlText(node.textContent || '');
      return `<span${serializeAttrs(node)}>${text}</span>`;
    },
  });
}

function status(turndownService: _TurndownService) {
  turndownService.addRule('status', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' && node.getAttribute('data-type') === 'status'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const text = escapeHtmlText(node.textContent || '');
      return `<span${serializeAttrs(node)}>${text}</span>`;
    },
  });
}

/**
 * Serialize the `htmlEmbed` node to Markdown.
 *
 * Markdown has no native representation for an arbitrary-HTML block, so we
 * preserve the node losslessly as an HTML comment carrying the base64-encoded
 * source (the same `data-source` payload the node stores). `markdownToHtml`
 * recognizes the same marker and rebuilds the node, so the round-trip
 * MD -> HTML -> JSON keeps the source intact. The comment also keeps the raw
 * markup inert in the exported `.md` file (it does not render in plain Markdown
 * viewers).
 */
function htmlEmbed(turndownService: _TurndownService) {
  turndownService.addRule('htmlEmbed', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'htmlEmbed'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const encoded = node.getAttribute('data-source') || '';
      return `\n\n<!--html-embed:${encoded}-->\n\n`;
    },
  });
}

function listParagraph(turndownService: _TurndownService) {
  turndownService.addRule('paragraph', {
    filter: ['p'],
    replacement: (content: string, node: HTMLInputElement) => {
      if (node.parentElement?.nodeName === 'LI') {
        return content;
      }
      return `\n\n${content}\n\n`;
    },
  });
}

function orderedListItem(turndownService: _TurndownService) {
  turndownService.addRule('orderedListItem', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem';
    },
    replacement: (content: string, node: HTMLInputElement, options: any) => {
      const parent = node.parentNode as HTMLElement;
      if (parent.nodeName !== 'OL' && parent.nodeName !== 'UL') {
        return content;
      }

      content = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');

      let prefix: string;
      if (parent.nodeName === 'OL') {
        const start = parseInt(parent.getAttribute('start') || '1', 10);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      } else {
        prefix = `${options.bulletListMarker} `;
      }

      return (
        prefix +
        content +
        (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
      );
    },
  });
}

function callout(turndownService: _TurndownService) {
  turndownService.addRule('callout', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'callout'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const calloutType = node.getAttribute('data-callout-type');
      return `\n\n:::${calloutType}\n${content.trim()}\n:::\n\n`;
    },
  });
}

function taskList(turndownService: _TurndownService) {
  turndownService.addRule('taskListItem', {
    filter: function (node: HTMLInputElement) {
      return (
        node.getAttribute('data-type') === 'taskItem' &&
        node.parentNode.nodeName === 'UL'
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const isChecked = node.getAttribute('data-checked') === 'true';
      const div = node.querySelector('div');
      const text = div ? div.textContent.trim() : node.textContent.trim();

      const prefix = `- ${isChecked ? '[x]' : '[ ]'} `;

      return (
        prefix +
        text +
        (node.nextSibling && !/\n$/.test(text) ? '\n' : '')
      );
    },
  });
}

function preserveDetail(turndownService: _TurndownService) {
  turndownService.addRule('preserveDetail', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'DETAILS';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const summary = node.querySelector(':scope > summary');
      let detailSummary = '';

      if (summary) {
        detailSummary = `<summary>${turndownService.turndown(summary.innerHTML)}</summary>`;
      }

      const detailsContent = Array.from(node.childNodes)
        .filter((child) => child.nodeName !== 'SUMMARY')
        .map((child) =>
          child.nodeType === 1
            ? turndownService.turndown((child as HTMLElement).outerHTML)
            : child.textContent,
        )
        .join('');

      return `\n<details>\n${detailSummary}\n\n${detailsContent}\n\n</details>\n`;
    },
  });
}

function mathInline(turndownService: _TurndownService) {
  turndownService.addRule('mathInline', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' &&
        node.getAttribute('data-type') === 'mathInline'
      );
    },
    replacement: function (content: string) {
      return `$${content}$`;
    },
  });
}

function mathBlock(turndownService: _TurndownService) {
  turndownService.addRule('mathBlock', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'mathBlock'
      );
    },
    replacement: function (content: string) {
      return `\n$$\n${content}\n$$\n`;
    },
  });
}

function iframeEmbed(turndownService: _TurndownService) {
  turndownService.addRule('iframeEmbed', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'IFRAME';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src');
      return '[' + src + '](' + src + ')';
    },
  });
}

function image(turndownService: _TurndownService) {
  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = sanitizeMdLinkText(node.getAttribute('alt') || '');
      const title = node.getAttribute('title') || '';
      const titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '![' + alt + '](' + src + titlePart + ')';
    },
  });
}

/**
 * Footnote reference (inline atom) -> pandoc/GFM marker `[^id]`.
 * The visible number is derived (not stored), so the id is the stable anchor.
 */
function footnoteReference(turndownService: _TurndownService) {
  turndownService.addRule('footnoteReference', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SUP' && node.hasAttribute('data-footnote-ref')
      );
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const id = node.getAttribute('data-id') || '';
      return id ? `[^${id}]` : '';
    },
  });
}

/**
 * Footnotes container -> the list of `[^id]: text` definitions at the end of
 * the document (one per line). Each footnoteDefinition inside emits its own
 * `[^id]: ...` line; turndown joins them with the surrounding block spacing.
 */
function footnotesList(turndownService: _TurndownService) {
  turndownService.addRule('footnoteDefinition', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.hasAttribute('data-footnote-def')
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const id = node.getAttribute('data-id') || '';
      // Collapse internal newlines so the definition stays a single MD line;
      // continuation lines are a v2 refinement.
      const text = content.replace(/\s*\n+\s*/g, ' ').trim();
      return id ? `\n[^${id}]: ${text}\n` : '';
    },
  });

  turndownService.addRule('footnotesList', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SECTION' && node.hasAttribute('data-footnotes')
      );
    },
    replacement: function (content: string) {
      return `\n\n${content.trim()}\n`;
    },
  });
}

function video(turndownService: _TurndownService) {
  turndownService.addRule('video', {
    filter: function (node: HTMLInputElement) {
      return node.tagName === 'VIDEO';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      const ariaLabel = node.getAttribute('aria-label');
      const name = sanitizeMdLinkText(
        ariaLabel || getBasename(src) || src,
      );
      return '[' + name + '](' + src + ')';
    },
  });
}
