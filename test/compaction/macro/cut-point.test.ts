import { describe, expect, it } from "vitest";
import { findCutPoint } from "../../../src/compaction/macro/cut-point.js";

const T = true;
const F = false;
const all = (n: number, value: boolean) => new Array<boolean>(n).fill(value);
const tokens = (...values: number[]) => values;

describe("findCutPoint", () => {
  it("returns null when everything fits in the kept window", () => {
    expect(findCutPoint(tokens(100, 100, 100), all(3, T), all(3, T), 301)).toBeNull();
  });

  it("cuts cleanly at a turn start once the kept window reaches keepRecentTokens", () => {
    //                     0    1    2    3    4
    const result = findCutPoint(tokens(100, 100, 100, 100, 100), all(5, T), all(5, T), 250);

    expect(result).toEqual({ firstKeptIndex: 2, turnStartIndex: -1, isSplitTurn: false });
  });

  it("moves forward to the next valid cut so no call is separated from its result", () => {
    // Message 2 is a call's result: cutting before it is invalid.
    const result = findCutPoint(
      tokens(100, 100, 100, 100, 100),
      [T, T, F, T, T],
      [T, F, F, T, F],
      250,
    );

    expect(result).toEqual({ firstKeptIndex: 3, turnStartIndex: -1, isSplitTurn: false });
  });

  it("falls back to the closest valid cut before the window when none follows it", () => {
    const result = findCutPoint(
      tokens(100, 100, 100, 100, 100),
      [T, T, F, F, F],
      [T, T, F, F, F],
      250,
    );

    expect(result).toEqual({ firstKeptIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("returns null when the only valid cut would leave nothing to summarize", () => {
    expect(findCutPoint(tokens(100, 100, 100), [T, F, F], all(3, F), 150)).toBeNull();
  });

  it("returns null for one huge recent tool result that cannot be cut from its call", () => {
    // Message 0 calls the tool, message 1 is its 50,000-token result.
    expect(findCutPoint(tokens(100, 50_000), [T, F], [T, F], 20_000)).toBeNull();
  });

  it("marks a split turn when the cut falls inside a turn that started after the boundary", () => {
    // The turn starts at 1; the window reaches 250 tokens at index 2, mid-turn.
    const result = findCutPoint(tokens(100, 100, 100, 100, 100), all(5, T), [T, T, F, F, F], 250);

    expect(result).toEqual({ firstKeptIndex: 2, turnStartIndex: 1, isSplitTurn: true });
  });

  it("does not split a turn that began before the boundary", () => {
    // No slot is a turn start: the turn's request is already in the previous summary.
    const result = findCutPoint(tokens(100, 100, 100, 100), all(4, T), all(4, F), 150);

    expect(result).toEqual({ firstKeptIndex: 2, turnStartIndex: -1, isSplitTurn: false });
  });

  it("keeps only the last slot with keepRecentTokens of 0", () => {
    expect(findCutPoint(tokens(100, 100, 100), all(3, T), all(3, T), 0)).toEqual({
      firstKeptIndex: 2,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });
});
