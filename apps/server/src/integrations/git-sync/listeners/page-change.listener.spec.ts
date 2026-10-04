// Unit tests for the event-driven git-sync trigger. The orchestrator
// and page repo are hand-built mocks; the debounce coalescing is exercised with
// jest fake timers. We assert the gate, the loop-guard (anti-echo), the
// missing-page short-circuit, the heterogeneous event-shape id resolution, the
// debounce collapse, and that errors are swallowed + logged.
import { Logger } from '@nestjs/common';
import { PageChangeListener } from './page-change.listener';

type AnyMock = jest.Mock;

interface Built {
  listener: PageChangeListener;
  env: { isGitSyncEnabled: AnyMock; getGitSyncDebounceMs: AnyMock };
  orchestrator: { runOnce: AnyMock };
  pageRepo: { findById: AnyMock };
}

function build(opts: { enabled?: boolean; debounceMs?: number } = {}): Built {
  const { enabled = true, debounceMs = 2000 } = opts;
  const env = {
    isGitSyncEnabled: jest.fn(() => enabled),
    getGitSyncDebounceMs: jest.fn(() => debounceMs),
  };
  const orchestrator = { runOnce: jest.fn(async () => undefined) };
  const pageRepo = { findById: jest.fn() };

  const listener = new PageChangeListener(
    env as any,
    orchestrator as any,
    pageRepo as any,
  );
  return { listener, env, orchestrator, pageRepo };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PageChangeListener', () => {
  describe('gate', () => {
    it('does nothing when git-sync is disabled (no findById, no schedule)', async () => {
      const { listener, orchestrator, pageRepo } = build({ enabled: false });
      await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
      expect(pageRepo.findById).not.toHaveBeenCalled();
      expect(orchestrator.runOnce).not.toHaveBeenCalled();
    });
  });

  describe('loop-guard (anti-echo)', () => {
    it("does NOT schedule a cycle when the page row's source is 'git-sync'", async () => {
      jest.useFakeTimers();
      try {
        const { listener, orchestrator, pageRepo } = build();
        pageRepo.findById.mockResolvedValue({
          id: 'p1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          lastUpdatedSource: 'git-sync',
        });
        await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
        jest.runOnlyPendingTimers();
        expect(orchestrator.runOnce).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('schedules exactly one cycle for a normal (non-git-sync) source', async () => {
      jest.useFakeTimers();
      try {
        const { listener, orchestrator, pageRepo } = build();
        pageRepo.findById.mockResolvedValue({
          id: 'p1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          lastUpdatedSource: 'user',
        });
        await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
        jest.runOnlyPendingTimers();
        expect(orchestrator.runOnce).toHaveBeenCalledTimes(1);
        expect(orchestrator.runOnce).toHaveBeenCalledWith('space-1', 'ws-1');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('missing page', () => {
    it('does not schedule when findById returns null/undefined', async () => {
      jest.useFakeTimers();
      try {
        const { listener, orchestrator, pageRepo } = build();
        pageRepo.findById.mockResolvedValue(undefined);
        await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
        jest.runOnlyPendingTimers();
        expect(orchestrator.runOnce).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('spaceId/workspaceId resolution', () => {
    // The page row used to fill in any ids the event omits.
    const pageRow = {
      id: 'p1',
      spaceId: 'row-space',
      workspaceId: 'row-ws',
      lastUpdatedSource: 'user',
    };

    async function resolve(event: Record<string, unknown>) {
      jest.useFakeTimers();
      try {
        const { listener, orchestrator, pageRepo } = build();
        pageRepo.findById.mockResolvedValue(pageRow);
        await listener.handlePageEvent(event as any);
        jest.runOnlyPendingTimers();
        return { orchestrator, pageRepo };
      } finally {
        jest.useRealTimers();
      }
    }

    it("resolves pageId + event.spaceId + event.workspaceId", async () => {
      const { orchestrator, pageRepo } = await resolve({
        pageId: 'p1',
        spaceId: 'evt-space',
        workspaceId: 'evt-ws',
      });
      expect(pageRepo.findById).toHaveBeenCalledWith('p1', { includeContent: false });
      expect(orchestrator.runOnce).toHaveBeenCalledWith('evt-space', 'evt-ws');
    });

    it('resolves pageId from pageIds[0]', async () => {
      const { orchestrator, pageRepo } = await resolve({
        pageIds: ['p1', 'p2'],
        spaceId: 'evt-space',
        workspaceId: 'evt-ws',
      });
      expect(pageRepo.findById).toHaveBeenCalledWith('p1', { includeContent: false });
      expect(orchestrator.runOnce).toHaveBeenCalledWith('evt-space', 'evt-ws');
    });

    it('resolves pageId + spaceId from pages[]', async () => {
      const { orchestrator } = await resolve({
        pages: [{ id: 'p1', spaceId: 'pages-space' }],
        workspaceId: 'evt-ws',
      });
      expect(orchestrator.runOnce).toHaveBeenCalledWith('pages-space', 'evt-ws');
    });

    it('resolves pageId + spaceId from node', async () => {
      const { orchestrator } = await resolve({
        node: { id: 'p1', spaceId: 'node-space' },
        workspaceId: 'evt-ws',
      });
      expect(orchestrator.runOnce).toHaveBeenCalledWith('node-space', 'evt-ws');
    });

    it('falls back to the fetched page row when the event omits spaceId/workspaceId', async () => {
      const { orchestrator } = await resolve({ pageId: 'p1' });
      // No spaceId/workspaceId on the event -> use the page row's values.
      expect(orchestrator.runOnce).toHaveBeenCalledWith('row-space', 'row-ws');
    });
  });

  describe('debounce coalescing', () => {
    it('collapses a burst of N events for one space into exactly one runOnce', async () => {
      jest.useFakeTimers();
      try {
        const { listener, orchestrator, pageRepo } = build({ debounceMs: 500 });
        pageRepo.findById.mockResolvedValue({
          id: 'p1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          lastUpdatedSource: 'user',
        });

        // Fire a burst of 5 events; await each so its findById promise settles
        // and schedule() runs before the next event resets the timer.
        for (let i = 0; i < 5; i++) {
          await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
        }

        // Nothing fired yet (still within the debounce window).
        expect(orchestrator.runOnce).not.toHaveBeenCalled();

        // Advance past the debounce window: the coalesced cycle fires once.
        jest.advanceTimersByTime(500);
        expect(orchestrator.runOnce).toHaveBeenCalledTimes(1);
        expect(orchestrator.runOnce).toHaveBeenCalledWith('space-1', 'ws-1');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('onModuleDestroy', () => {
    it('clears every pending debounce timer and empties the map', async () => {
      jest.useFakeTimers();
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      try {
        const { listener, orchestrator, pageRepo } = build({ debounceMs: 500 });
        pageRepo.findById.mockResolvedValue({
          id: 'p1',
          spaceId: 'space-1',
          workspaceId: 'ws-1',
          lastUpdatedSource: 'user',
        });

        // Schedule a pending cycle, then tear the module down before it fires.
        await listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' });
        clearSpy.mockClear(); // ignore any clears done by schedule() itself

        listener.onModuleDestroy();

        // The pending timer was cleared and the map drained, so advancing past
        // the debounce window fires NO cycle.
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect((listener as any).debounce.size).toBe(0);
        jest.advanceTimersByTime(500);
        expect(orchestrator.runOnce).not.toHaveBeenCalled();
      } finally {
        clearSpy.mockRestore();
        jest.useRealTimers();
      }
    });
  });

  describe('error swallowing', () => {
    it('does not throw and logs a warning when findById throws', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { listener, orchestrator, pageRepo } = build();
        pageRepo.findById.mockRejectedValue(new Error('db down'));

        await expect(
          listener.handlePageEvent({ pageId: 'p1', workspaceId: 'ws-1' }),
        ).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('db down');
        expect(orchestrator.runOnce).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
