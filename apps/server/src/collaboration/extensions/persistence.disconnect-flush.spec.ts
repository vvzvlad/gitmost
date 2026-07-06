import { PersistenceExtension } from './persistence.extension';

/**
 * Regression for the QA #119 "loss-on-fast-close" data loss: editing a page then
 * closing the tab within the collab debounce window (~3-18s) lost the edit
 * because, with `unloadImmediately: false`, Hocuspocus does NOT flush the
 * debounced onStoreDocument on a last-client disconnect. PersistenceExtension
 * now flushes the pending store on the LAST disconnect (and only then).
 */
describe('PersistenceExtension.onDisconnect flush (loss-on-fast-close)', () => {
  function makeExt(): PersistenceExtension {
    // onDisconnect touches none of the injected deps; pass casts.
    return new PersistenceExtension(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
    );
  }

  function makeData(opts: {
    clientsCount: number;
    isDebounced: boolean;
    isLoading?: boolean;
  }) {
    const executeNow = jest.fn(async () => undefined);
    const isDebounced = jest.fn(() => opts.isDebounced);
    return {
      executeNow,
      isDebounced,
      payload: {
        clientsCount: opts.clientsCount,
        context: {},
        document: { isLoading: opts.isLoading ?? false } as any,
        documentName: 'page.abc',
        instance: { debouncer: { isDebounced, executeNow } } as any,
        requestHeaders: {},
        requestParameters: new URLSearchParams(),
        socketId: 's',
      } as any,
    };
  }

  it('flushes the pending store when the LAST client disconnects', async () => {
    const ext = makeExt();
    const { executeNow, payload } = makeData({
      clientsCount: 0,
      isDebounced: true,
    });
    await ext.onDisconnect(payload);
    expect(executeNow).toHaveBeenCalledTimes(1);
    expect(executeNow).toHaveBeenCalledWith('onStoreDocument-page.abc');
  });

  it('does NOT flush while other editors remain connected', async () => {
    const ext = makeExt();
    const { executeNow, payload } = makeData({
      clientsCount: 2,
      isDebounced: true,
    });
    await ext.onDisconnect(payload);
    expect(executeNow).not.toHaveBeenCalled();
  });

  it('does NOT write when nothing is pending (already persisted)', async () => {
    const ext = makeExt();
    const { executeNow, payload } = makeData({
      clientsCount: 0,
      isDebounced: false,
    });
    await ext.onDisconnect(payload);
    expect(executeNow).not.toHaveBeenCalled();
  });

  it('does NOT flush a doc that is still loading (load error guard)', async () => {
    const ext = makeExt();
    const { executeNow, payload } = makeData({
      clientsCount: 0,
      isDebounced: true,
      isLoading: true,
    });
    await ext.onDisconnect(payload);
    expect(executeNow).not.toHaveBeenCalled();
  });
});
