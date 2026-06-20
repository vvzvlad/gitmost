import { htmlToJson, jsonToHtml } from './collaboration.util';

const findFirst = (json: any, type: string): any | undefined => {
  if (!json || typeof json !== 'object') return undefined;
  if (json.type === type) return json;
  if (Array.isArray(json.content)) {
    for (const child of json.content) {
      const found = findFirst(child, type);
      if (found) return found;
    }
  }
  return undefined;
};

/**
 * Guards the fragile parse-priority approach that lets a `footnoteReference`
 * NODE win over the `Superscript` MARK for `<sup>` elements. In the server
 * `tiptapExtensions` list, Superscript is registered BEFORE the footnote nodes,
 * so without the priority guard a `<sup data-footnote-ref>` would be parsed as
 * an (empty) superscript mark and the footnote reference would be lost.
 */
describe('footnote reference vs superscript mark (server schema round-trip)', () => {
  const HTML =
    '<p>Water' +
    '<sup data-footnote-ref data-id="fn1"></sup>' +
    ' here.</p>' +
    '<section data-footnotes>' +
    '<div data-footnote-def data-id="fn1"><p>First note.</p></div>' +
    '</section>';

  it('parses <sup data-footnote-ref> into a footnoteReference NODE (not a superscript mark)', () => {
    const json = htmlToJson(HTML);

    const ref = findFirst(json, 'footnoteReference');
    expect(ref).toBeDefined();
    expect(ref.attrs.id).toBe('fn1');

    // It must NOT have been swallowed as a superscript mark on text.
    const superscriptText = JSON.stringify(json).includes('"superscript"');
    expect(superscriptText).toBe(false);

    // The matching definition survives too.
    const def = findFirst(json, 'footnoteDefinition');
    expect(def).toBeDefined();
    expect(def.attrs.id).toBe('fn1');
  });

  it('round-trips an empty footnoteReference back to <sup data-footnote-ref>', () => {
    const json = htmlToJson(HTML);
    const html = jsonToHtml(json);

    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('data-id="fn1"');

    // And a second parse still yields the node (stable round-trip).
    const json2 = htmlToJson(html);
    const ref2 = findFirst(json2, 'footnoteReference');
    expect(ref2).toBeDefined();
    expect(ref2.attrs.id).toBe('fn1');
  });
});
