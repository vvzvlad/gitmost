// p-limit and @sindresorhus/slugify are ESM-only and not in jest's transform
// allowlist; both are irrelevant to createDrawioSvg (a pure fs + string method),
// so they are mocked out to keep the module graph loadable under ts-jest.
jest.mock('p-limit', () => ({
  __esModule: true,
  default: () => (fn: () => unknown) => fn(),
}));
jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (input: string) => String(input),
}));

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportAttachmentService } from './import-attachment.service';

/**
 * Unit test for ImportAttachmentService.createDrawioSvg (issue #507).
 *
 * The Confluence import wraps a `.drawio` file into a `.drawio.svg` attachment.
 * The `content=` payload MUST be the mxfile XML entity-escaped (draw.io's native
 * form), NOT base64 — draw.io's editor decodes a base64 content= via Latin-1
 * atob, mangling every non-ASCII char into mojibake. createDrawioSvg touches no
 * injected dependency, so the service is built with placeholder deps.
 */
describe('ImportAttachmentService.createDrawioSvg (#507)', () => {
  const service = new ImportAttachmentService(
    {} as any,
    {} as any,
    {} as any,
  );
  const call = (p: string): Promise<Buffer> =>
    (service as any).createDrawioSvg(p);

  let tmpDir: string;
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drawio-507-'));
  });
  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeDrawio = async (name: string, xml: string): Promise<string> => {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, xml, 'utf-8');
    return p;
  };

  it('writes content= as entity-encoded XML, not base64', async () => {
    const drawio =
      '<mxfile host="Confluence"><diagram name="Схема — ёж">' +
      '<mxGraphModel><root><mxCell id="0"/>' +
      '<mxCell id="2" value="Старт-бит" vertex="1" parent="0"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const p = await writeDrawio('cyrillic.drawio', drawio);

    const svg = (await call(p)).toString('utf-8');
    const content = /content="([^"]*)"/.exec(svg)?.[1];
    expect(content).toBeDefined();

    // Entity-encoded XML form, starting with &lt;mxfile — never a base64 blob.
    expect(content).toMatch(/^&lt;mxfile/);
    expect(content).toContain('&lt;');
    // Non-ASCII survives as raw UTF-8, with no Latin-1 mojibake.
    expect(content).toContain('Старт-бит');
    expect(content).toContain('Схема — ёж');
    expect(content).not.toContain('Ð');

    // Decoding the attribute (un-escaping) yields the original drawio file.
    const decoded = content!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(drawio);
  });

  it('encodes literal tab/newline/CR as numeric char-refs, not literal control chars (#507 F1)', async () => {
    // A literal tab/newline/CR inside the mxfile XML would be collapsed to a
    // single space by XML attribute-value normalization when the draw.io editor
    // reads content=, silently flattening multi-line labels and tab-bearing
    // values. They must be emitted as numeric char-refs instead.
    const drawio =
      '<mxfile><diagram name="p">' +
      '<mxGraphModel><root><mxCell id="0"/>' +
      '<mxCell id="2" value="col1\tcol2" style="html=1;\nshadow=0" vertex="1" parent="0"/>' +
      '<mxCell id="3" value="Line1\nLine2\rLine3" vertex="1" parent="0"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const p = await writeDrawio('ctrl.drawio', drawio);

    const svg = (await call(p)).toString('utf-8');
    const content = /content="([^"]*)"/.exec(svg)?.[1];
    expect(content).toBeDefined();
    // No literal control chars survive in the attribute value.
    expect(content).not.toMatch(/[\t\n\r]/);
    // They round-trip as numeric char-refs.
    expect(content).toContain('&#x9;');
    expect(content).toContain('&#xa;');
    expect(content).toContain('&#xd;');
    // Decoding (char-refs back to literal, entities back) recovers the file.
    const decoded = content!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x9;/gi, '\t')
      .replace(/&#xa;/gi, '\n')
      .replace(/&#xd;/gi, '\r')
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(drawio);
  });

  it('escapes XML metacharacters in the drawio payload', async () => {
    const drawio = '<mxfile><diagram name="a &amp; b">"q" &lt;x&gt;</diagram></mxfile>';
    const p = await writeDrawio('meta.drawio', drawio);

    const svg = (await call(p)).toString('utf-8');
    const content = /content="([^"]*)"/.exec(svg)?.[1];
    expect(content).toBeDefined();
    // The attribute value must contain no bare `<`, `>` or `"` that would break
    // out of the content="..." attribute or the SVG element.
    expect(content).not.toMatch(/[<>"]/);
    const decoded = content!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(drawio);
  });
});
