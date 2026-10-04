import {
  diff3Plan,
  diff3PlanWithConflicts,
  type Pick,
} from './three-way-merge';

// Materialize a plan into the merged key sequence for assertion.
function apply(plan: Pick[], live: string[], target: string[]): string[] {
  return plan.map((p) => (p.src === 'live' ? live[p.index] : target[p.index]));
}

const merge = (o: string[], a: string[], b: string[]): string[] =>
  apply(diff3Plan(o, a, b), a, b);

describe('diff3Plan (block-level three-way merge)', () => {
  it('identical on all three sides -> unchanged (all from live)', () => {
    const plan = diff3Plan(['1', '2', '3'], ['1', '2', '3'], ['1', '2', '3']);
    expect(plan.every((p) => p.src === 'live')).toBe(true);
    expect(apply(plan, ['1', '2', '3'], ['1', '2', '3'])).toEqual(['1', '2', '3']);
  });

  it('git changed a block the human did not -> takes git', () => {
    expect(merge(['1', '2', '3'], ['1', '2', '3'], ['1', '9', '3'])).toEqual([
      '1',
      '9',
      '3',
    ]);
  });

  it('human changed a block git did not -> KEEPS the human edit (the core 3-way win)', () => {
    expect(merge(['1', '2', '3'], ['1', 'H', '3'], ['1', '2', '3'])).toEqual([
      '1',
      'H',
      '3',
    ]);
  });

  // Bug #2 observability: diff3PlanWithConflicts reports SAME-BLOCK conflicts so
  // the caller can surface the "git wins" loss (log + history pin) instead of
  // dropping the human side silently.
  describe('diff3PlanWithConflicts (same-block conflict reporting)', () => {
    it('reports 0 conflicts when sides changed DIFFERENT blocks (clean merge)', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['H', '2', '3'],
        ['1', '2', 'G'],
      );
      expect(r.conflicts).toBe(0);
      expect(apply(r.picks, ['H', '2', '3'], ['1', '2', 'G'])).toEqual([
        'H',
        '2',
        'G',
      ]);
    });

    it('reports 1 conflict and git wins when BOTH rewrote the SAME block', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['1', 'H', '3'], // human rewrote block 2
        ['1', 'G', '3'], // git rewrote block 2
      );
      expect(r.conflicts).toBe(1);
      // Git wins the contested block; the human 'H' is NOT in the picks.
      expect(apply(r.picks, ['1', 'H', '3'], ['1', 'G', '3'])).toEqual([
        '1',
        'G',
        '3',
      ]);
    });

    it('does NOT count a git-only region (no human content to lose) as a conflict', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['1', '2', '3'], // human unchanged
        ['1', '9', '3'], // git rewrote block 2
      );
      expect(r.conflicts).toBe(0);
    });
  });

  it('human and git changed DIFFERENT blocks -> both preserved', () => {
    // human rewrote block 1, git rewrote block 3.
    expect(merge(['1', '2', '3'], ['H', '2', '3'], ['1', '2', 'G'])).toEqual([
      'H',
      '2',
      'G',
    ]);
  });

  it('human inserted a block AND git changed a different block -> both preserved', () => {
    expect(
      merge(['1', '2', '3'], ['1', '1.5', '2', '3'], ['1', '2', 'G']),
    ).toEqual(['1', '1.5', '2', 'G']);
  });

  it('both changed the SAME block -> conflict resolves to git', () => {
    expect(merge(['1', '2', '3'], ['1', 'H', '3'], ['1', 'G', '3'])).toEqual([
      '1',
      'G',
      '3',
    ]);
  });

  it('both made the SAME edit -> that edit (no duplication)', () => {
    expect(merge(['1', '2', '3'], ['1', 'X', '3'], ['1', 'X', '3'])).toEqual([
      '1',
      'X',
      '3',
    ]);
  });

  it('human deleted a block git left alone -> deletion preserved', () => {
    expect(merge(['1', '2', '3'], ['1', '3'], ['1', '2', '3'])).toEqual([
      '1',
      '3',
    ]);
  });

  it('git deleted a block the human left alone -> deletion applied', () => {
    expect(merge(['1', '2', '3'], ['1', '2', '3'], ['1', '3'])).toEqual([
      '1',
      '3',
    ]);
  });

  it('both deleted the same block -> gone (no conflict)', () => {
    expect(merge(['1', '2', '3'], ['1', '3'], ['1', '3'])).toEqual(['1', '3']);
  });

  it('git appended a trailing block -> appended', () => {
    expect(merge(['1', '2'], ['1', '2'], ['1', '2', '3'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('human appended a trailing block git did not -> kept', () => {
    expect(merge(['1', '2'], ['1', '2', '3'], ['1', '2'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('empty base, git provides content (brand-new page body) -> git content', () => {
    expect(merge([], [], ['1', '2'])).toEqual(['1', '2']);
  });

  it('git changed block 1, human edited block 3, far apart -> both kept', () => {
    expect(
      merge(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b', 'c', 'd', 'E'],
        ['A', 'b', 'c', 'd', 'e'],
      ),
    ).toEqual(['A', 'b', 'c', 'd', 'E']);
  });
});
