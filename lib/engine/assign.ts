/**
 * Hungarian algorithm (O(n^3)) for maximum-weight assignment.
 *
 * A greedy fill looks right most weeks and is quietly wrong in exactly the cases
 * that matter: when a flex-eligible stud should be bumped to FLEX so a scarcer
 * slot can be filled. Rosters are small enough that the exact answer is cheap.
 */
export function maximizeAssignment(weights: number[][]): number[] {
  const rows = weights.length;
  if (rows === 0) return [];
  const cols = weights[0].length;

  // Pad with `rows` extra dummy columns so every row always has a zero-cost
  // "unassigned" option. Padding only to max(rows, cols) forces a perfect
  // matching, which would shove a player into an ineligible slot rather than
  // leave him on the bench.
  const n = rows + cols;

  // Hungarian minimizes, so negate the weights.
  const INF = 1e9;
  const cost: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i < rows && j < cols ? -(weights[i][j] ?? 0) : 0,
    ),
  );

  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);   // p[j] = row matched to column j
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  // result[row] = assigned column, or -1
  const result = new Array(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const row = p[j] - 1;
    if (row >= 0 && row < rows && j - 1 < cols) result[row] = j - 1;
  }
  return result;
}
