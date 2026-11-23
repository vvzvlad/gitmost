import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type DocumentFormat = 'docx' | 'pdf';
export const MAX_DOCUMENT_FILE_BYTES = 30 * 1024 * 1024;
export const INDEXABLE_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];
const WORKER_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_WORKERS = 4;
let activeWorkers = 0;

export class DocumentExtractionBusyError extends Error {
  constructor() {
    super('Document processing capacity reached. Please try again.');
  }
}

export function extractDocument(
  format: DocumentFormat,
  content: Buffer,
  purpose: 'import' | 'search',
): Promise<string> {
  if (content.byteLength > MAX_DOCUMENT_FILE_BYTES) {
    return Promise.reject(new Error('Document extraction is limited to 30 MB'));
  }

  return runDocumentWorker('document-extract.worker.js', {
    format,
    content,
    purpose,
  });
}

export function runDocumentWorker<T>(
  script: string,
  workerData: unknown,
): Promise<T> {
  if (activeWorkers >= MAX_DOCUMENT_WORKERS) {
    return Promise.reject(new DocumentExtractionBusyError());
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, script), {
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    activeWorkers++;
    const timeout = setTimeout(() => {
      reject(new Error('Document processing timed out'));
      void worker.terminate();
    }, WORKER_TIMEOUT_MS);

    worker.once('message', (result: { content: T; error?: string }) => {
      clearTimeout(timeout);
      if (result.error) reject(new Error(result.error));
      else resolve(result.content);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      activeWorkers--;
      clearTimeout(timeout);
      reject(
        new Error(`Document worker exited before returning a result (${code})`),
      );
    });
  });
}
