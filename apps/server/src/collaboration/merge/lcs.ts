/**
 * Backward-filled LCS length table for sequences `a` and `b`: `dp[i][j]` is the
 * length of the longest common subsequence of the suffixes `a[i:]` and `b[j:]`.
 * O(n*m) time/space — fine for page block counts.
 *
 * Shared by the two-way block diff (`yjs-body-merge.diffBlocks`) and the
 * three-way merge planner (`three-way-merge.lcsPairs`) so the (identical) table
 * construction lives in ONE place; each caller does its own traceback over the
 * returned table.
 */
export function buildLcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}
