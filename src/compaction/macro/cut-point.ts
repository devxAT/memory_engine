export interface CutPointResult {
  firstKeptIndex: number;
  /** -1 unless `isSplitTurn`. */
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/**
 * Where to cut a list of slots so that roughly `keepRecentTokens` stay raw. Pure function over
 * per-slot arrays; returns `null` when there is nothing to compact (everything fits in the kept
 * window, or no valid cut leaves anything before it).
 */
export function findCutPoint(
  tokens: number[],
  validCut: boolean[],
  isTurnStart: boolean[],
  keepRecentTokens: number,
): CutPointResult | null {
  // 1. The first index, walking backward, at which the kept window reaches keepRecentTokens.
  let j = -1;
  let sum = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    sum += tokens[i];
    if (sum >= keepRecentTokens) {
      j = i;
      break;
    }
  }
  if (j === -1) return null;

  // 2. The nearest valid cut: at or after j, else the closest one before it.
  let cut = validCut.indexOf(true, j);
  if (cut === -1) cut = validCut.lastIndexOf(true, j - 1);
  if (cut <= 0) return null;

  // 3–4. A cut that is not a turn start splits the turn it falls in, if that turn started here.
  if (isTurnStart[cut]) return { firstKeptIndex: cut, turnStartIndex: -1, isSplitTurn: false };
  const turnStart = isTurnStart.lastIndexOf(true, cut - 1);
  return turnStart === -1
    ? { firstKeptIndex: cut, turnStartIndex: -1, isSplitTurn: false }
    : { firstKeptIndex: cut, turnStartIndex: turnStart, isSplitTurn: true };
}
