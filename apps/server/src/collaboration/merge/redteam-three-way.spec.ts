import { diff3Plan, type Pick } from './three-way-merge';

// Materialize a plan into the merged key sequence for assertion.
function apply(plan: Pick[], live: string[], target: string[]): string[] {
  return plan.map((p) => (p.src === 'live' ? live[p.index] : target[p.index]));
}

const merge = (o: string[], a: string[], b: string[]): string[] =>
  apply(diff3Plan(o, a, b), a, b);

describe('diff3Plan red-team #9 (human edit + adjacent git insert)', () => {
  it('keeps human block-2 edit AND applies git insert of 2.5', () => {
    // base:   1 2 3
    // live:   1 H 3   (human rewrote block 2)
    // target: 1 2 2.5 3 (git inserted 2.5 after block 2)
    expect(
      merge(['1', '2', '3'], ['1', 'H', '3'], ['1', '2', '2.5', '3']),
    ).toEqual(['1', 'H', '2.5', '3']);
  });
});
