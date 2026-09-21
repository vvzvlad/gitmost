import { StarterKit } from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import { Superscript } from '@tiptap/extension-superscript';
import SubScript from '@tiptap/extension-subscript';
import { Typography } from '@tiptap/extension-typography';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Youtube } from '@tiptap/extension-youtube';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  Heading,
  Callout,
  Comment,
  CustomCodeBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  LinkExtension,
  MathBlock,
  MathInline,
  TableHeader,
  TableCell,
  TableRow,
  CustomTable,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  TrailingNode,
  Attachment,
  Drawio,
  Excalidraw,
  Embed,
  HtmlEmbed,
  Mention,
  Subpages,
  Highlight,
  Spoiler,
  Indent,
  UniqueID,
  Columns,
  Column,
  Status,
  addUniqueIdsToDoc,
  TransclusionSource,
  TransclusionReference,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
  PageEmbed,
  Code,
} from '@docmost/editor-ext';
import { convertProseMirrorToMarkdown } from '@docmost/prosemirror-markdown';
import { generateText, getSchema, JSONContent } from '@tiptap/core';
import { generateHTML, generateJSON } from '../common/helpers/prosemirror/html';
// @tiptap/html library works best for generating prosemirror json state but not HTML
// see: https://github.com/ueberdosis/tiptap/issues/5352
// see:https://github.com/ueberdosis/tiptap/issues/4089
//import { generateJSON } from '@tiptap/html';
import { Node, Schema } from '@tiptap/pm/model';
import { updateYFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { Logger } from '@nestjs/common';

export const tiptapExtensions = [
  StarterKit.configure({
    codeBlock: false,
    link: false,
    trailingNode: false,
    heading: false,
    // #515: StarterKit's stock `code` mark ships `excludes: "_"`, which strips
    // every co-occurring inline mark on the HTML -> PM parse (htmlToJson) and on
    // editor transactions. Use the shared Docmost `Code` (excludes: "code") instead,
    // so bold/italic/… around inline code survive import and editing.
    code: false,
  }),
  Code,
  Heading,
  UniqueID.configure({
    types: ['heading', 'paragraph', 'transclusionSource'],
  }),
  Comment,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Indent,
  TaskList,
  TaskItem.configure({
    nested: true,
  }),
  LinkExtension,
  Superscript,
  SubScript,
  Highlight,
  Spoiler,
  Typography,
  TrailingNode,
  TextStyle,
  Color,
  MathInline,
  MathBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  CustomTable,
  TableCell,
  TableRow,
  TableHeader,
  Youtube,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  Callout,
  Attachment,
  CustomCodeBlock,
  Drawio,
  Excalidraw,
  Embed,
  // Registered server-side so the node survives schema parsing/serialization.
  // Authoring is gated to admins at the document WRITE paths (see
  // stripHtmlEmbedNodes usage in persistence/page services), NOT here.
  HtmlEmbed,
  Mention,
  Subpages,
  Columns,
  Column,
  Status,
  TransclusionSource,
  TransclusionReference,
  FootnoteReference,
  FootnotesList,
  FootnoteDefinition,
  PageEmbed,
] as any;

export function jsonToHtml(tiptapJson: any) {
  return generateHTML(tiptapJson, tiptapExtensions);
}

export function htmlToJson(html: string) {
  const pmJson = generateJSON(html, tiptapExtensions);

  try {
    return addUniqueIdsToDoc(pmJson, tiptapExtensions);
  } catch (error) {
    console.warn('failed to add unique ids to doc', error);
    return pmJson;
  }
}

/**
 * Deterministic text-serializer overrides for the `format:"text"` page read
 * (#502). Non-text nodes render to a STABLE placeholder instead of their
 * (structure-dependent) inner text, so a machine diff of two text reads is
 * driven only by the page's actual prose — output stability across package
 * versions IS the contract (pinned by a snapshot test). Returning a string from
 * a `textSerializer` also stops `generateText` descending into the node, so a
 * table renders as ONE token rather than its flattened cell text.
 *
 * Only nodes with no meaningful flat-text form are overridden; every other node
 * (paragraph/heading/list/code/blockquote/callout/…) keeps its natural text so
 * a config written as markdown reads back byte-identical.
 */
const TEXT_READ_SERIALIZERS: Record<string, (props: { node: any }) => string> =
  {
    // Image atom: no inner text -> a fixed placeholder.
    image: () => '[image]',
    // Table: `[table RxC]` where R = row count, C = the first row's cell count
    // (a table's columns are uniform per the schema). Computed from the PM node,
    // so it is independent of cell contents.
    table: ({ node }) => {
      const rows = node?.childCount ?? 0;
      const cols = rows > 0 ? (node.child(0)?.childCount ?? 0) : 0;
      return `[table ${rows}x${cols}]`;
    },
  };

/**
 * Serialize a ProseMirror/TipTap document to plain text.
 *
 * Default (no options): the long-standing search-index behavior — bare
 * concatenated node text with `generateText`'s default `\n\n` block separator.
 * This feeds the page `textContent` tsvector and MUST NOT change.
 *
 * `deterministic:true` (#502 `format:"text"` page read): a flat, machine-diffable
 * rendering — one line per block (`\n` block separator; `hardBreak` already
 * serializes to `\n`), inline marks/anchors/autoformat dropped, and non-text
 * nodes replaced by the stable placeholders above (`[image]`, `[table RxC]`).
 */
export function jsonToText(
  // `any` (like jsonToHtml/jsonToMarkdown) so a loosely-typed DB `page.content`
  // (JsonValue) can be passed straight through, as the controller does.
  tiptapJson: any,
  options?: { deterministic?: boolean },
) {
  if (options?.deterministic) {
    return generateText(tiptapJson, tiptapExtensions, {
      blockSeparator: '\n',
      textSerializers: TEXT_READ_SERIALIZERS,
    });
  }
  return generateText(tiptapJson, tiptapExtensions);
}

export function jsonToNode(tiptapJson: JSONContent) {
  const schema = getSchema(tiptapExtensions);
  try {
    return Node.fromJSON(schema, tiptapJson);
  } catch (error) {
    if (
      error instanceof RangeError &&
      error.message.includes('Unknown node type')
    ) {
      Logger.warn('Stripping unknown node types from document:', error.message);
      const cleanedJson = stripUnknownNodes(tiptapJson, schema);
      return Node.fromJSON(schema, cleanedJson);
    }
    throw error;
  }
}

export function getPageId(documentName: string) {
  return documentName.split('.')[1];
}

export function isEmptyParagraphDoc(tiptapJson: JSONContent): boolean {
  if (!tiptapJson || tiptapJson.type !== 'doc') return false;
  const content = tiptapJson.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const child = content[0];
  if (!child || child.type !== 'paragraph') return false;
  return (
    !child.content ||
    (Array.isArray(child.content) && child.content.length === 0)
  );
}

function stripUnknownNodes(
  json: JSONContent,
  schema: Schema,
): JSONContent | null {
  if (!json || typeof json !== 'object') return json;

  // Recursively clean children first, flattening any unwrapped content
  if (json.content && Array.isArray(json.content)) {
    const newContent: JSONContent[] = [];
    for (const child of json.content) {
      const cleaned = stripUnknownNodes(child, schema);
      if (Array.isArray(cleaned)) {
        newContent.push(...cleaned);
      } else if (cleaned) {
        newContent.push(cleaned);
      }
    }
    json.content = newContent;
  }

  // Check if this node is unknown AFTER processing children
  if (json.type && !schema.nodes[json.type]) {
    // Unwrap: return cleaned children directly instead of wrapping
    return (
      json.content && json.content.length > 0 ? json.content : null
    ) as any;
  }

  return json;
}

export function prosemirrorNodeToYElement(node: any): Y.XmlElement | Y.XmlText {
  if (node.type === 'text') {
    const ytext = new Y.XmlText();
    ytext.insert(0, node.text || '');
    if (node.marks?.length > 0) {
      const attrs: Record<string, any> = {};
      for (const mark of node.marks) {
        attrs[mark.type] = mark.attrs || true;
      }
      ytext.format(0, node.text?.length || 0, attrs);
    }
    return ytext;
  }

  const element = new Y.XmlElement(node.type);
  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value !== null && value !== undefined) {
        element.setAttribute(key, value as any);
      }
    }
  }
  if (node.content?.length > 0) {
    const children = node.content.map(prosemirrorNodeToYElement);
    element.insert(0, children);
  }
  return element;
}

/**
 * #647 §C / R1 — write a ProseMirror JSON doc into the live Yjs fragment by
 * STRUCTURAL DIFF (`updateYFragment`), the exact routine the editor itself uses
 * to sync ProseMirror edits into Yjs. It diffs the new node against the current
 * fragment and touches only the changed children, so unchanged nodes keep their
 * Yjs identity (node ids). y-prosemirror anchors the editor selection to those
 * ids, so a naive `fragment.delete(0,len)` + `toYdoc` + `applyUpdate` full replace
 * (what `updatePageContent` operation='replace' does) discards every id and snaps
 * an idle human editor's cursor to the end of the document on every agent write
 * (the #152 regression). The guarded CAS replace uses THIS instead.
 *
 * MUST run inside a `doc.transact` (the caller's `connection.transact`) so the
 * diff applies atomically with no remote update interleaving. Mirrors the MCP
 * client's `applyDocToFragment` (packages/mcp/src/lib/collaboration.ts) but over
 * the server's own schema (`jsonToNode`, which strips unknown node types).
 */
export function applyPmJsonToFragment(doc: Y.Doc, pmJson: JSONContent): void {
  const pmNode = jsonToNode(pmJson);
  const fragment = doc.getXmlFragment('default');
  updateYFragment(doc, fragment, pmNode as any, {
    mapping: new Map(),
    isOMark: new Map(),
  });
}

export function jsonToMarkdown(tiptapJson: any): string {
  // Direct ProseMirror JSON -> Markdown via the canonical converter
  // (`@docmost/prosemirror-markdown`) — no HTML intermediate, no second
  // editor-ext markdown layer. Same serializer as the page/space export and the
  // git-sync vault writer, so every server PM->MD path emits identical canonical
  // markdown (issue #345).
  return convertProseMirrorToMarkdown(tiptapJson);
}
