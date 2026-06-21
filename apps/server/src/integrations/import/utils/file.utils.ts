import * as yauzl from 'yauzl';
import * as path from 'path';
import * as fs from 'node:fs';

export enum FileTaskType {
  Import = 'import',
  Export = 'export',
}

export enum FileImportSource {
  Generic = 'generic',
  Notion = 'notion',
}

export enum FileTaskStatus {
  Processing = 'processing',
  Success = 'success',
  Failed = 'failed',
}

export function getFileTaskFolderPath(
  type: FileTaskType,
  workspaceId: string,
): string {
  switch (type) {
    case FileTaskType.Import:
      return `${workspaceId}/imports`;
    case FileTaskType.Export:
      return `${workspaceId}/exports`;
  }
}

/**
 * Pure path-safety decision for a single ZIP entry (zip-slip / path-traversal guard).
 *
 * Reproduces exactly the inline check previously embedded in `extractZipInternal`:
 *  1. Strip any leading slashes from the entry name.
 *  2. Reject names that fail `yauzl.validateFileName` (e.g. backslashes,
 *     relative `..` segments, drive letters).
 *  3. Reject `__MACOSX/` metadata entries.
 *  4. Resolve the entry against the target directory and require it to stay
 *     strictly inside `targetDir` using a `targetResolved + path.sep` prefix check
 *     (the trailing separator prevents sibling-directory prefix confusion, e.g.
 *     `/tmp/x` must not match `/tmp/x-evil`).
 *
 * @param entryName  The decoded (UTF-8) entry file name from the archive.
 * @param targetDir  Directory the archive is being extracted into.
 * @returns `{ safe }` and, when safe, the resolved absolute path of the entry.
 */
export function isEntryPathSafe(
  entryName: string,
  targetDir: string,
): { safe: boolean; resolved?: string } {
  // Strip leading slashes so absolute-looking entries cannot escape the target.
  const safe = entryName.replace(/^\/+/, '');

  const validationError = yauzl.validateFileName(safe);
  if (validationError) {
    return { safe: false };
  }

  // Skip macOS resource-fork metadata entries.
  if (safe.startsWith('__MACOSX/')) {
    return { safe: false };
  }

  const fullPath = path.join(targetDir, safe);
  const resolved = path.resolve(fullPath);
  const targetResolved = path.resolve(targetDir);

  // Containment check: resolved path must live strictly inside the target dir.
  if (!resolved.startsWith(targetResolved + path.sep)) {
    return { safe: false };
  }

  return { safe: true, resolved };
}

/**
 * Extracts a ZIP archive.
 */
export async function extractZip(
  source: string,
  target: string,
): Promise<void> {
  return extractZipInternal(source, target, true);
}

/**
 * Internal helper to extract a ZIP, with optional single-nested-ZIP handling.
 * @param source   Path to the ZIP file
 * @param target   Directory to extract into
 * @param allowNested  Whether to check and unwrap one level of nested ZIP
 */
function extractZipInternal(
  source: string,
  target: string,
  allowNested: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      source,
      { lazyEntries: true, decodeStrings: false, autoClose: true },
      (err, zipfile) => {
        if (err) return reject(err);

        // Handle one level of nested ZIP if allowed
        if (allowNested && zipfile.entryCount === 1) {
          zipfile.readEntry();
          zipfile.once('entry', (entry) => {
            const name = entry.fileName.toString('utf8').replace(/^\/+/, '');
            const isZip =
              !/\/$/.test(entry.fileName) &&
              name.toLowerCase().endsWith('.zip');
            if (isZip) {
              // temporary name to avoid overwriting file
              const nestedPath = source.endsWith('.zip')
                ? source.slice(0, -4) + '.inner.zip'
                : source + '.inner.zip';

              zipfile.openReadStream(entry, (openErr, rs) => {
                if (openErr) return reject(openErr);
                const ws = fs.createWriteStream(nestedPath);
                rs.on('error', reject);
                ws.on('error', reject);
                ws.on('finish', () => {
                  zipfile.close();
                  extractZipInternal(nestedPath, target, false)
                    .then(() => {
                      fs.unlinkSync(nestedPath);
                      resolve();
                    })
                    .catch(reject);
                });
                rs.pipe(ws);
              });
            } else {
              zipfile.close();
              extractZipInternal(source, target, false).then(resolve, reject);
            }
          });
          zipfile.once('error', reject);
          return;
        }

        // Normal extraction
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          const name = entry.fileName.toString('utf8');
          const safe = name.replace(/^\/+/, '');

          // Zip-slip / path-traversal guard (see isEntryPathSafe).
          if (!isEntryPathSafe(name, target).safe) {
            console.warn(`Skipping unsafe entry: ${safe}`);
            zipfile.readEntry();
            return;
          }

          const fullPath = path.join(target, safe);

          // Handle directories
          if (/\/$/.test(name)) {
            try {
              fs.mkdirSync(fullPath, { recursive: true });
            } catch (mkdirErr: any) {
              if (mkdirErr.code === 'ENAMETOOLONG') {
                console.warn(`Skipping directory (path too long): ${fullPath}`);
                zipfile.readEntry();
                return;
              }
              return reject(mkdirErr);
            }
            zipfile.readEntry();
            return;
          }

          // Handle files
          try {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          } catch (mkdirErr: any) {
            if (mkdirErr.code === 'ENAMETOOLONG') {
              console.warn(
                `Skipping file directory creation (path too long): ${fullPath}`,
              );
              zipfile.readEntry();
              return;
            }
            return reject(mkdirErr);
          }

          zipfile.openReadStream(entry, (openErr, rs) => {
            if (openErr) return reject(openErr);

            let ws: fs.WriteStream;
            try {
              ws = fs.createWriteStream(fullPath);
            } catch (openWsErr: any) {
              if (openWsErr.code === 'ENAMETOOLONG') {
                console.warn(
                  `Skipping file write (path too long): ${fullPath}`,
                );
                zipfile.readEntry();
                return;
              }
              return reject(openWsErr);
            }

            rs.on('error', (err) => reject(err));
            ws.on('error', (err) => {
              if ((err as any).code === 'ENAMETOOLONG') {
                console.warn(
                  `Skipping file write on stream (path too long): ${fullPath}`,
                );
                zipfile.readEntry();
              } else {
                reject(err);
              }
            });
            ws.on('finish', () => zipfile.readEntry());
            rs.pipe(ws);
          });
        });

        zipfile.on('end', () => resolve());
        zipfile.on('error', (err) => reject(err));
      },
    );
  });
}

export function cleanUrlString(url: string): string {
  if (!url) return null;
  const [mainUrl] = url.split('?', 1);
  return mainUrl;
}
