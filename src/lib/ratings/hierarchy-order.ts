import type { RatingProviderId } from "./types";

/** Trackers whose ratings participate in the hierarchy, in canonical order. */
export const RATING_PROVIDER_IDS: RatingProviderId[] = ["trakt", "simkl", "letterboxd"];

export const RATING_PROVIDER_LABELS: Record<RatingProviderId, string> = {
  trakt: "Trakt",
  simkl: "Simkl",
  letterboxd: "Letterboxd",
};

function isRatingProviderId(id: string): id is RatingProviderId {
  return (RATING_PROVIDER_IDS as string[]).includes(id);
}

/**
 * The hierarchy is read top-down: the first connected tracker with a rating
 * for the title supplies the displayed rating. The stored order is the user's
 * order; providers that are not connected right now are kept in storage (so a
 * reconnect restores their place) but left out of the live order, and
 * connected providers missing from storage are appended in canonical order.
 */
export function resolveRatingOrder(
  stored: RatingProviderId[] | undefined,
  connected: RatingProviderId[],
): RatingProviderId[] {
  const valid = (stored ?? []).filter(isRatingProviderId);
  const seen = new Set(valid);
  const order = valid.filter((id) => connected.includes(id));
  for (const id of connected) {
    if (!seen.has(id)) order.push(id);
  }
  return order;
}

/**
 * Append newly connected providers to the stored order, preserving the user's
 * existing order. Called whenever the hierarchy is observed (Detail page,
 * settings panels), so each newly connected tracker takes the next slot in
 * login order. Returns the stored array unchanged when nothing is missing.
 */
export function ensureProvidersInOrder(
  stored: RatingProviderId[] | undefined,
  connected: RatingProviderId[],
): RatingProviderId[] {
  const valid = (stored ?? []).filter(isRatingProviderId);
  const seen = new Set(valid);
  let changed = false;
  for (const id of connected) {
    if (!seen.has(id)) {
      valid.push(id);
      seen.add(id);
      changed = true;
    }
  }
  return changed ? valid : (stored ?? []);
}

/**
 * Reorder the live (connected) list after a drag/button move. Providers that
 * are stored but not connected keep their relative order behind the live
 * list, so disconnecting never loses the user's placement.
 */
export function applyRatingOrder(
  stored: RatingProviderId[] | undefined,
  connected: RatingProviderId[],
  nextLiveOrder: RatingProviderId[],
): RatingProviderId[] {
  const valid = (stored ?? []).filter(isRatingProviderId);
  const live = new Set(nextLiveOrder.filter((id) => connected.includes(id)));
  const rest = valid.filter((id) => !live.has(id));
  return [...nextLiveOrder.filter((id) => connected.includes(id)), ...rest];
}

/**
 * The hierarchy's internal scale is integer 1-10. Simkl and Trakt are natively
 * 1-10. Letterboxd is 0.5-5 half-stars, which maps losslessly: x2 on read,
 * /2 on write (4.5 stars = 9, 3 stars = 6, 0.5 stars = 1).
 */
export function normalizeToTen(provider: RatingProviderId, value: number): number {
  if (provider === "letterboxd") return Math.round(value * 2);
  return value;
}

export function denormalizeFromTen(provider: RatingProviderId, score10: number): number {
  if (provider === "letterboxd") return score10 / 2;
  return score10;
}
