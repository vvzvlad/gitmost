import { join } from 'path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { readClientBuildVersion } from './client-version';

describe('readClientBuildVersion', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'client-version-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeVersionJson = (content: string) =>
    fs.writeFileSync(join(dir, 'version.json'), content);

  it('returns the version from a valid version.json', () => {
    writeVersionJson(JSON.stringify({ version: 'test-A' }));
    expect(readClientBuildVersion(dir)).toBe('test-A');
  });

  it('trims surrounding whitespace in the version', () => {
    writeVersionJson(JSON.stringify({ version: '  v1.2.3  ' }));
    expect(readClientBuildVersion(dir)).toBe('v1.2.3');
  });

  it('returns "" when version.json is missing', () => {
    expect(readClientBuildVersion(dir)).toBe('');
  });

  it('returns "" on malformed JSON', () => {
    writeVersionJson('{ not json');
    expect(readClientBuildVersion(dir)).toBe('');
  });

  it('returns "" when the version field is absent', () => {
    writeVersionJson(JSON.stringify({ notVersion: 'x' }));
    expect(readClientBuildVersion(dir)).toBe('');
  });

  it('returns "" when the version field is not a string', () => {
    writeVersionJson(JSON.stringify({ version: 123 }));
    expect(readClientBuildVersion(dir)).toBe('');
  });

  it('returns "" when the path does not exist at all', () => {
    expect(readClientBuildVersion(join(dir, 'nope'))).toBe('');
  });
});
