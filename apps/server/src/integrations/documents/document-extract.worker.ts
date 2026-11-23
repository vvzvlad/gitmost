import { parentPort, workerData } from 'node:worker_threads';
import * as mammoth from 'mammoth';
import * as yauzl from 'yauzl';
import { classifyPdf, extractText } from '@docmost/pdf-inspector';

const MAX_DOCX_EXPANDED_BYTES = 80 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2_000;
const MAX_PDF_PAGES = 300;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_CHARACTERS = 100_000;

function checkDocxArchive(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);

      let bytes = 0;
      let validDocument = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (validDocument) resolve();
        else reject(new Error('The DOCX archive is missing word/document.xml'));
      });
      zip.on('entry', (entry) => {
        bytes += entry.uncompressedSize;
        if (bytes > MAX_DOCX_EXPANDED_BYTES) {
          zip.close();
          reject(new Error('The expanded DOCX archive exceeds 80 MB'));
          return;
        }
        validDocument ||= entry.fileName === 'word/document.xml';
        zip.readEntry();
      });
      if (zip.entryCount > MAX_DOCX_ENTRIES) {
        zip.close();
        reject(new Error('The DOCX archive contains too many entries'));
        return;
      }
      zip.readEntry();
    });
  });
}

async function extract(): Promise<string> {
  const { format, purpose } = workerData;
  const buffer = Buffer.from(workerData.content);
  let result: string;

  if (format === 'docx') {
    await checkDocxArchive(buffer);
    if (purpose === 'search') {
      result = (await mammoth.extractRawText({ buffer })).value;
    } else {
      result = (
        await mammoth.convertToHtml(
          { buffer },
          {
            convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
          },
        )
      ).value;
    }
  } else {
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new Error('The file does not contain a PDF header');
    }
    if (classifyPdf(buffer).pageCount > MAX_PDF_PAGES) {
      throw new Error('PDF text extraction is limited to 300 pages');
    }
    result = extractText(buffer);
    if (purpose === 'import' && result.trim()) {
      const escaped = result
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      result = escaped
        .split(/\n\s*\n/)
        .map(
          (paragraph) =>
            '<p>' + paragraph.trim().replace(/\n/g, '<br>') + '</p>',
        )
        .join('');
    }
  }

  result = result.replace(/\u0000/g, '').trim();
  if (purpose === 'search') return result.slice(0, MAX_INDEX_CHARACTERS);
  if (!result) {
    throw new Error(
      format === 'pdf'
        ? 'No readable text was found. Scanned PDFs require OCR before import.'
        : 'No readable content was found in the Word document.',
    );
  }
  if (Buffer.byteLength(result) > MAX_IMPORT_BYTES) {
    throw new Error('The extracted document exceeds the 2 MB content limit');
  }
  return result;
}

extract().then(
  (content) => parentPort.postMessage({ content }),
  (error) =>
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    }),
);
