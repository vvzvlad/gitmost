import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PageIdDto } from './page.dto';

// #435: PageIdDto.pageId carries a page's DOUBLE identity (internal UUID OR
// public 10-char slugId), both as bare strings. The DTO must accept exactly
// those two FORMATS and reject a malformed / swapped identity at the boundary.
async function pageIdErrors(pageId: unknown) {
  const dto = plainToInstance(PageIdDto, { pageId });
  const errors = await validate(dto as object);
  return errors.some((e) => e.property === 'pageId');
}

const UUID = '019f499a-9f8c-7d68-b7be-ce100d7c6c56';
const SLUG = 'aB3xQ7kR2p';

describe('PageIdDto pageId format validation', () => {
  it('accepts a canonical page UUID', async () => {
    expect(await pageIdErrors(UUID)).toBe(false);
  });

  it('accepts a 10-char slugId', async () => {
    expect(await pageIdErrors(SLUG)).toBe(false);
  });

  it('rejects a truncated / wrong-length slug', async () => {
    expect(await pageIdErrors('aB3xQ7kR2')).toBe(true); // 9 chars
    expect(await pageIdErrors('aB3xQ7kR2pX')).toBe(true); // 11 chars
  });

  it('rejects a slug with an illegal character', async () => {
    expect(await pageIdErrors('aB3xQ7kR2!')).toBe(true);
  });

  it('rejects a full URL / path-shaped identity (not the bare id)', async () => {
    expect(await pageIdErrors(`my-page-title-${SLUG}`)).toBe(true);
    expect(await pageIdErrors(`https://x/p/${SLUG}`)).toBe(true);
  });

  it('rejects a malformed UUID', async () => {
    expect(await pageIdErrors('019f499a-9f8c-7d68-b7be')).toBe(true);
    expect(await pageIdErrors('not-a-uuid-at-all-really')).toBe(true);
  });

  it('rejects an empty string', async () => {
    expect(await pageIdErrors('')).toBe(true);
  });
});
