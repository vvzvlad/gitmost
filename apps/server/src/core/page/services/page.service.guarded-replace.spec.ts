// #647 §C/§D — PageService.replacePageContentGuarded maps the collab CAS verdict
// to the REST fail-closed contract (409 / 422 / 503) and threads B3 attribution,
// and PageService.update routes a `replace`+`baseHash` write to it (else keeps the
// legacy unguarded path). The Yjs encode / text extract are stubbed and
// parseProsemirrorContent is spied so the mapping is isolated from schema/Yjs.
jest.mock('@docmost/editor-ext', () => {
  const actual = jest.requireActual('@docmost/editor-ext');
  return {
    ...actual,
    createYdocFromJson: jest.fn(() => Buffer.from([])),
    jsonToText: jest.fn(() => ''),
  };
});

import {
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PageService } from './page.service';

const simpleDoc = () => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
});

function makeService() {
  let yjsEvent: { evt: string; name: string; payload: any } | null = null;
  const handleYjsEvent = jest.fn(
    async (evt: string, name: string, payload: any): Promise<any> => {
      yjsEvent = { evt, name, payload };
      // Default verdict; individual tests override via mockImplementationOnce.
      return { applied: true, newHash: 'h-new' };
    },
  );
  const collaborationGateway = { handleYjsEvent };

  const findById = jest.fn(async () => ({
    id: 'page-id',
    slugId: 'slug',
    content: simpleDoc(),
  }));
  const pageRepo = {
    findById,
    updatePage: jest.fn(async () => {}),
  };
  const generalQueue = { add: jest.fn().mockReturnValue({ catch: jest.fn() }) };

  const service = new PageService(
    pageRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    generalQueue as any,
    {} as any,
    collaborationGateway as any,
    {} as any,
    {} as any,
  );
  jest
    .spyOn(service as any, 'parseProsemirrorContent')
    .mockImplementation(async (c: any) => structuredClone(c));

  return {
    service,
    handleYjsEvent,
    findById,
    updatePage: pageRepo.updatePage,
    getYjsEvent: () => yjsEvent,
  };
}

const pageRow = () =>
  ({
    id: 'page-id',
    slugId: 'slug',
    title: 'T',
    icon: null,
    content: simpleDoc(),
    contributorIds: [],
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    parentPageId: null,
    lastUpdatedSource: 'user',
  }) as any;

describe('PageService.replacePageContentGuarded (#647 §C/§D)', () => {
  it('applied → returns the verdict and threads B3 attribution into the payload', async () => {
    const { service, getYjsEvent } = makeService();
    const res = await service.replacePageContentGuarded(
      'page-id',
      simpleDoc(),
      'json',
      'base-hash',
      { id: 'u1' } as any,
      { actor: 'agent', aiChatId: 'chat-1', apiKeyId: 'key-1' } as any,
    );
    expect(res).toMatchObject({ applied: true, newHash: 'h-new' });
    const ev = getYjsEvent()!;
    expect(ev.evt).toBe('replaceIfMatch');
    expect(ev.name).toBe('page.page-id');
    expect(ev.payload).toMatchObject({
      baseHash: 'base-hash',
      user: { id: 'u1' },
      actor: 'agent',
      aiChatId: 'chat-1',
      apiKeyId: 'key-1',
    });
  });

  it('hash mismatch → 409 ConflictException carrying currentHash (no DB compare)', async () => {
    const { service, handleYjsEvent, findById } = makeService();
    handleYjsEvent.mockImplementationOnce(async () => ({
      applied: false,
      currentHash: 'h-current',
    }));
    const err = await service
      .replacePageContentGuarded(
        'page-id',
        simpleDoc(),
        'json',
        'stale',
        { id: 'u1' } as any,
        undefined,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      currentHash: 'h-current',
    });
    // Fail-closed: the compare NEVER falls back to a DB read of the page.
    expect(findById).not.toHaveBeenCalled();
  });

  it('empty-replace-refused → 422 UnprocessableEntity', async () => {
    const { service, handleYjsEvent } = makeService();
    handleYjsEvent.mockImplementationOnce(async () => ({
      applied: false,
      currentHash: 'h',
      reason: 'empty-replace-refused',
    }));
    await expect(
      service.replacePageContentGuarded(
        'page-id',
        simpleDoc(),
        'json',
        'base',
        { id: 'u1' } as any,
        undefined,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('owner unreachable (bridge throws) → 503, fail-closed, no DB read', async () => {
    const { service, handleYjsEvent, findById } = makeService();
    handleYjsEvent.mockImplementationOnce(async () => {
      throw 'TIMEOUT';
    });
    await expect(
      service.replacePageContentGuarded(
        'page-id',
        simpleDoc(),
        'json',
        'base',
        { id: 'u1' } as any,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('PageService.update guarded-replace routing (#647 §D)', () => {
  const dto = (extra: any) => ({
    pageId: 'page-id',
    content: simpleDoc(),
    format: 'json',
    ...extra,
  });

  it('replace + baseHash rejected → 409 BEFORE any metadata write (nothing touched)', async () => {
    const { service, handleYjsEvent, updatePage } = makeService();
    handleYjsEvent.mockImplementationOnce(async () => ({
      applied: false,
      currentHash: 'H',
    }));
    await expect(
      service.update(
        pageRow(),
        dto({ operation: 'replace', baseHash: 'stale' }) as any,
        { id: 'u1' } as any,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // The CAS ran and rejected before the metadata write → updatedAt/contributors
    // are NOT bumped and no history is created for a rejected write (crit 18).
    expect(updatePage).not.toHaveBeenCalled();
  });

  it('replace + baseHash applied → runs the guarded CAS exactly once (no double write)', async () => {
    const { service, handleYjsEvent, getYjsEvent } = makeService();
    await service.update(
      pageRow(),
      dto({ operation: 'replace', baseHash: 'ok' }) as any,
      { id: 'u1' } as any,
      undefined,
    );
    const calls = handleYjsEvent.mock.calls.filter(
      (c: any[]) => c[0] === 'replaceIfMatch',
    );
    expect(calls).toHaveLength(1);
    // The legacy updatePageContent path must NOT also fire (no double write).
    expect(
      handleYjsEvent.mock.calls.filter((c: any[]) => c[0] === 'updatePageContent'),
    ).toHaveLength(0);
    expect(getYjsEvent()!.evt).toBe('replaceIfMatch');
  });

  it('replace WITHOUT baseHash → legacy unguarded path (no replaceIfMatch)', async () => {
    const { service, handleYjsEvent } = makeService();
    await service.update(
      pageRow(),
      dto({ operation: 'replace' }) as any, // no baseHash
      { id: 'u1' } as any,
      undefined,
    );
    expect(
      handleYjsEvent.mock.calls.filter((c: any[]) => c[0] === 'replaceIfMatch'),
    ).toHaveLength(0);
    expect(
      handleYjsEvent.mock.calls.filter((c: any[]) => c[0] === 'updatePageContent'),
    ).toHaveLength(1);
  });
});
