import { AiService, computeEmbeddingFingerprint } from './ai.service';

/**
 * #530 Search Phase B (PR-1) unit coverage for the embedding layer:
 *  - computeEmbeddingFingerprint: a revision bump / prefix toggle MUST change the
 *    fingerprint even when the bare model name + dimension are unchanged (it is
 *    deliberately NOT the bare model name);
 *  - embedQuery: applies the QUERY prefix and embeds under the short SEARCH embed
 *    timeout (not the long batch timeout);
 *  - embedWithModel: a hung model + short timeout degrades with a clear timeout
 *    error (the search caller then falls back to the lexical path).
 */
describe('computeEmbeddingFingerprint (#530)', () => {
  const base = {
    modelId: 'intfloat/multilingual-e5-small',
    revision: 'sha-aaa',
    queryPrefix: 'query: ',
    docPrefix: 'passage: ',
    dimensions: 384,
  };

  it('is deterministic for identical inputs', () => {
    expect(computeEmbeddingFingerprint(base)).toBe(
      computeEmbeddingFingerprint({ ...base }),
    );
  });

  it('CHANGES on a revision bump (same model name + dimension)', () => {
    const a = computeEmbeddingFingerprint(base);
    const b = computeEmbeddingFingerprint({ ...base, revision: 'sha-bbb' });
    expect(b).not.toBe(a);
  });

  it('CHANGES on a query-prefix toggle (same model name + dimension + revision)', () => {
    const a = computeEmbeddingFingerprint(base);
    const b = computeEmbeddingFingerprint({ ...base, queryPrefix: '' });
    expect(b).not.toBe(a);
  });

  it('CHANGES on a doc-prefix toggle', () => {
    const a = computeEmbeddingFingerprint(base);
    const b = computeEmbeddingFingerprint({ ...base, docPrefix: '' });
    expect(b).not.toBe(a);
  });

  it('CHANGES on a dimension change', () => {
    const a = computeEmbeddingFingerprint(base);
    const b = computeEmbeddingFingerprint({ ...base, dimensions: 768 });
    expect(b).not.toBe(a);
  });

  it('is NOT the bare model name (guards the mutation)', () => {
    // If the fingerprint were the bare model name, a revision bump would not
    // change it — the tests above would red. Assert it directly too.
    expect(computeEmbeddingFingerprint(base)).not.toBe(base.modelId);
  });

  it('distinguishes swapped prefixes — ("q","") != ("","q")', () => {
    const a = computeEmbeddingFingerprint({
      ...base,
      queryPrefix: 'q',
      docPrefix: '',
    });
    const b = computeEmbeddingFingerprint({
      ...base,
      queryPrefix: '',
      docPrefix: 'q',
    });
    expect(a).not.toBe(b);
  });
});

describe('AiService.embedQuery (#530)', () => {
  function makeService(): AiService {
    // The constructor body only stores its deps; embedQuery is fully driven by
    // the spied resolveEmbeddingProvider + embedWithModel below.
    return new AiService({} as any, {} as any, {} as any);
  }

  it('prepends the query prefix and returns the provider fingerprint', async () => {
    const svc = makeService();
    jest.spyOn(svc, 'resolveEmbeddingProvider').mockResolvedValue({
      model: { modelId: 'm' } as any,
      modelId: 'm',
      queryPrefix: 'query: ',
      docPrefix: 'passage: ',
      fingerprint: 'fp-active',
    });
    const embedSpy = jest
      .spyOn(svc, 'embedWithModel')
      .mockResolvedValue([[0.1, 0.2, 0.3]]);

    const res = await svc.embedQuery('ws-1', 'кофе');

    // The single embedded value carries the query prefix.
    expect(embedSpy).toHaveBeenCalledTimes(1);
    const [, wsArg, valuesArg, timeoutArg] = embedSpy.mock.calls[0];
    expect(wsArg).toBe('ws-1');
    expect(valuesArg).toEqual(['query: кофе']);
    // Bound by the SHORT search-embed timeout (default 800ms), not the 120000ms
    // batch timeout.
    expect(timeoutArg).toBe(800);
    // #599: embedQuery also reports the MODEL id, which the reader compares against
    // the served generation's model to decide whether the two share an embedding
    // space (a cross-model cosine is noise; see EmbeddingGenerationService).
    expect(res).toEqual({
      vector: [0.1, 0.2, 0.3],
      fingerprint: 'fp-active',
      modelId: 'm',
    });
  });

  it('propagates a no-provider error (drives the no-provider degrade)', async () => {
    const svc = makeService();
    const { AiEmbeddingNotConfiguredException } = await import(
      './ai-embedding-not-configured.exception'
    );
    jest
      .spyOn(svc, 'resolveEmbeddingProvider')
      .mockRejectedValue(new AiEmbeddingNotConfiguredException());
    await expect(svc.embedQuery('ws-1', 'x')).rejects.toBeInstanceOf(
      AiEmbeddingNotConfiguredException,
    );
  });
});

describe('AiService.embedWithModel timeout (#530)', () => {
  it('degrades a hung model with a timeout error under the short window', async () => {
    const svc = new AiService({} as any, {} as any, {} as any);
    // A model whose doEmbed never resolves but honours the abort signal, so the
    // AbortSignal.timeout fires and embedWithModel raises a clear timeout error.
    const hangingModel: any = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'fake',
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      doEmbed: ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };
    await expect(
      svc.embedWithModel(hangingModel, 'ws-1', ['x'], 30),
    ).rejects.toThrow(/timed out/i);
  });
});
