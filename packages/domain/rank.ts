import { type AssignableRef, RANKS } from "./types.ts";

/**
 * Display order for ranks. Lower sorts first. `Reserve` sorts last by design:
 * it means "still one of us, not currently active", so it is not the bottom of
 * the ladder, it is off to one side of it.
 */
export const RANK_SORT_ORDER: Record<string, number> = Object.fromEntries(
  RANKS.map((name, i) => [name, i]),
);

export function isRank(a: AssignableRef): boolean {
  return a.kind === "rank";
}

export function ranksOf(
  assignables: readonly AssignableRef[],
): AssignableRef[] {
  return assignables.filter(isRank);
}

export interface RankResolution {
  /** The rank to treat the member as holding, or null if they hold none. */
  rank: AssignableRef | null;
  /**
   * The other rank(s) the member holds. Non-empty means Discord is in a state
   * it should not be in: rank is exclusive. Callers log a warning and carry on,
   * because Discord is the source of truth and the fix belongs there, not here.
   */
  conflicting: AssignableRef[];
}

/**
 * Rank is exclusive: a Member holds exactly one. Discord is the source of
 * truth, so this does not enforce that, it reports it. If a member somehow
 * holds several, the most senior wins and the rest are surfaced as conflicts.
 */
export function resolveRank(
  assignables: readonly AssignableRef[],
): RankResolution {
  const held = ranksOf(assignables).sort(
    (a, b) =>
      (RANK_SORT_ORDER[a.name] ?? Infinity) -
      (RANK_SORT_ORDER[b.name] ?? Infinity),
  );
  const [rank = null, ...conflicting] = held;
  return { rank, conflicting };
}
