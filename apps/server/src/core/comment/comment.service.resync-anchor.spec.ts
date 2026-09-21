import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommentService } from './comment.service';

/**
 * Coverage for CommentService.resyncSuggestionAnchor (#496): re-anchoring a
 * suggestion's stored selection (== apply-time expectedText) to the live-doc
 * substring. The service is built directly with jest-mocked deps (the
 * @InjectQueue tokens can't be resolved by Test.createTestingModule — see the
 * sibling specs).
 */
describe('CommentService — resyncSuggestionAnchor', () => {
  const UPDATED = { id: 'c-1', selection: 'new anchor', __updated: true } as any;

  function makeService() {
    const commentRepo: any = {
      updateComment: jest.fn(async () => undefined),
      findById: jest.fn(async () => UPDATED),
    };
    const service = new CommentService(
      commentRepo,
      {} as any,
      { emitCommentEvent: jest.fn() } as any,
      {} as any,
      { add: jest.fn() } as any,
      { add: jest.fn() } as any,
      { log: jest.fn() } as any,
    );
    return { service, commentRepo };
  }

  const suggestion = (over?: Partial<any>): any => ({
    id: 'c-1',
    creatorId: 'user-1',
    parentCommentId: null,
    selection: 'old anchor',
    suggestedText: 'new text',
    suggestionAppliedAt: null,
    resolvedAt: null,
    ...over,
  });
  const user = (over?: Partial<any>): any => ({ id: 'user-1', ...over });

  it('persists the new selection and returns the enriched comment', async () => {
    const { service, commentRepo } = makeService();

    const out = await service.resyncSuggestionAnchor(
      suggestion(),
      'new anchor',
      user(),
    );

    expect(commentRepo.updateComment).toHaveBeenCalledWith(
      { selection: 'new anchor' },
      'c-1',
    );
    expect(out).toBe(UPDATED);
  });

  it('is idempotent: no write when the anchor already matches', async () => {
    const { service, commentRepo } = makeService();

    const out = await service.resyncSuggestionAnchor(
      suggestion({ selection: 'same' }),
      'same',
      user(),
    );

    expect(commentRepo.updateComment).not.toHaveBeenCalled();
    expect(out).toEqual(suggestion({ selection: 'same' }));
  });

  it('rejects a non-author (only the suggestion owner may re-anchor)', async () => {
    const { service, commentRepo } = makeService();
    await expect(
      service.resyncSuggestionAnchor(suggestion(), 'new anchor', user({ id: 'other' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(commentRepo.updateComment).not.toHaveBeenCalled();
  });

  it('rejects a reply / a comment with no suggestion', async () => {
    const { service } = makeService();
    await expect(
      service.resyncSuggestionAnchor(
        suggestion({ parentCommentId: 'p-1' }),
        'x',
        user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resyncSuggestionAnchor(
        suggestion({ suggestedText: null }),
        'x',
        user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects re-anchoring an already applied or resolved suggestion', async () => {
    const { service } = makeService();
    await expect(
      service.resyncSuggestionAnchor(
        suggestion({ suggestionAppliedAt: new Date() }),
        'x',
        user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resyncSuggestionAnchor(
        suggestion({ resolvedAt: new Date() }),
        'x',
        user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a no-op selection equal to the suggested text', async () => {
    const { service } = makeService();
    await expect(
      service.resyncSuggestionAnchor(
        suggestion({ suggestedText: 'new text' }),
        'new text',
        user(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
