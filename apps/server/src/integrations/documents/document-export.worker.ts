import { parentPort, workerData } from 'node:worker_threads';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import PDFDocument = require('pdfkit');
import { loadFontBuffer } from '../ai/rasterize/rasterize.assets';

interface ContentNode {
  type: string;
  text?: string;
  content?: ContentNode[];
  marks?: { type: string }[];
  attrs?: Record<string, unknown>;
}

interface TextBlock {
  text: string;
  heading?: number;
  code?: boolean;
  runs?: TextRun[];
}

type ExportBlock = TextBlock | { rows: string[][] };
const WORD_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function nodeText(node: ContentNode): string {
  if (node.type === 'hardBreak') return '\n';
  if (node.text != null) return node.text;
  if (
    node.type === 'mention' ||
    node.type === 'attachment' ||
    node.type === 'image' ||
    node.type === 'pdf'
  ) {
    return String(
      node.attrs?.label ||
        node.attrs?.fileName ||
        node.attrs?.title ||
        node.attrs?.alt ||
        '',
    );
  }
  return (node.content ?? []).map(nodeText).join('');
}

function blocksFor(document: ContentNode, styled: boolean): ExportBlock[] {
  const result: ExportBlock[] = [];

  function visit(node: ContentNode, listPrefix = '') {
    if (node.type === 'table') {
      const rows = (node.content ?? [])
        .map((row) =>
          (row.content ?? []).map((cell) =>
            (cell.content ?? []).map(nodeText).join('\n'),
          ),
        )
        .filter((row) => row.length);
      if (rows.length) result.push({ rows });
      return;
    }
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) {
      const start = Number(node.attrs?.start) || 1;
      (node.content ?? []).forEach((item, index) => {
        const prefix =
          node.type === 'orderedList'
            ? `${start + index}. `
            : node.type === 'taskList'
              ? item.attrs?.checked
                ? '[x] '
                : '[ ] '
              : '• ';
        (item.content ?? []).forEach((child, i) =>
          visit(child, i === 0 ? prefix : ''),
        );
      });
      return;
    }
    if (['heading', 'paragraph', 'codeBlock'].includes(node.type)) {
      const heading =
        node.type === 'heading'
          ? Math.max(1, Math.min(6, Number(node.attrs?.level) || 1))
          : undefined;
      const runs = styled
        ? [
            ...(listPrefix ? [new TextRun(listPrefix)] : []),
            ...(node.content ?? []).map((child) => {
              if (child.type === 'hardBreak') return new TextRun({ break: 1 });
              const marks = new Set(child.marks?.map((mark) => mark.type));
              return new TextRun({
                text: nodeText(child),
                bold: marks.has('bold'),
                italics: marks.has('italic'),
                strike: marks.has('strike'),
                underline: marks.has('underline') ? {} : undefined,
                font:
                  node.type === 'codeBlock' || marks.has('code')
                    ? 'Courier New'
                    : undefined,
              });
            }),
          ]
        : undefined;
      result.push({
        text: listPrefix + nodeText(node),
        heading,
        runs,
        code: node.type === 'codeBlock',
      });
      return;
    }
    if (node.content?.length) {
      for (const child of node.content) visit(child);
    } else {
      const text = nodeText(node);
      if (text) result.push({ text });
    }
  }

  visit(document);
  return result;
}

async function exportDocx(document: ContentNode): Promise<Buffer> {
  const children = blocksFor(document, true).map((block) => {
    if ('rows' in block) {
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (text) =>
                  new TableCell({
                    children: text
                      .split('\n')
                      .map((line) => new Paragraph(line)),
                  }),
              ),
            }),
        ),
      });
    }
    return new Paragraph({
      heading: block.heading ? WORD_HEADINGS[block.heading - 1] : undefined,
      children: block.runs ?? [new TextRun(block.text)],
      spacing: { after: 120 },
    });
  });
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

async function exportPdf(document: ContentNode): Promise<Buffer> {
  const blocks = blocksFor(document, false);
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.once('error', reject);
    pdf.once('end', () => resolve(Buffer.concat(chunks)));
    pdf.font(loadFontBuffer());
    for (const block of blocks) {
      if ('rows' in block) {
        pdf.fontSize(10);
        for (const row of block.rows)
          pdf.text(row.map((cell) => cell.replace(/\n/g, ' ')).join('  |  '));
      } else {
        pdf.fontSize(
          block.heading
            ? Math.max(12, 25 - 3 * block.heading)
            : block.code
              ? 9
              : 11,
        );
        pdf.text(block.text || ' ', { lineGap: 2 });
      }
      pdf.moveDown(0.5);
    }
    pdf.end();
  });
}

const render = workerData.format === 'docx' ? exportDocx : exportPdf;
render(workerData.document).then(
  (content) => parentPort.postMessage({ content }),
  (error) =>
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    }),
);
