import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "@/lib/settings";
import { useTrakt } from "@/lib/trakt/provider";
import { useSimkl } from "@/lib/simkl/provider";
import { useLetterboxd } from "@/lib/stremboxd/provider";
import { stremioIdToTraktTarget } from "@/lib/trakt/ids";
import { stremioIdToSimklTarget } from "@/lib/simkl/ids";
import { kitsuToMal } from "@/lib/providers/anime-mapping";
import {
  getUserRating as getTraktUserRating,
  rateContent as rateTraktContent,
  removeRating as removeTraktRating,
} from "@/lib/trakt/comments";
import { addSimklRating, fetchSimklUserRating, removeSimklRating } from "@/lib/simkl/ratings";
import { fetchLetterboxdUserRating, submitLetterboxdRating } from "@/lib/stremboxd/rating";
import { tmdbIdFromImdb } from "@/lib/providers/tmdb/tmdb-imdb-resolve";
import type { SimklTarget } from "@/lib/simkl/types";
import type { TraktTarget } from "@/lib/trakt/types";
import {
  applyRatingOrder,
  denormalizeFromTen,
  ensureProvidersInOrder,
  normalizeToTen,
  resolveRatingOrder,
} from "./hierarchy-order";
import type { RatingProviderId } from "./types";

export type HierarchyRatingInput = {
  /** Stremio/Harbor id of the title (itemKey). */
  harborId: string;
  mediaType: "movie" | "series" | "anime" | "manga";
  imdbId?: string | null;
};

export type ResolvedRating = {
  provider: RatingProviderId;
  /** Integer 1-10. */
  score: number;
};

export type FanOutResult = {
  provider: RatingProviderId;
  ok: boolean;
};

/** Live connections needed by the hierarchy. Built by useHierarchyRating. */
export type HierarchyConnections = {
  trakt: boolean;
  simkl: boolean;
  letterboxd: boolean;
  letterboxdUserId: string | null;
  tmdbKey: string;
};

function imdbIdOf(input: HierarchyRatingInput): string | null {
  if (input.imdbId) return input.imdbId;
  if (input.harborId.startsWith("tt")) return input.harborId;
  return null;
}

/** Mirrors the Simkl rating picker's target resolution (incl. kitsu -> MAL). */
async function resolveSimklTarget(
  harborId: string,
  mediaType: HierarchyRatingInput["mediaType"],
): Promise<SimklTarget | null> {
  let tgt: SimklTarget | null = null;
  const resolution = stremioIdToSimklTarget(harborId);
  if (resolution.ok) {
    tgt = resolution.target;
  } else if (harborId.startsWith("kitsu:")) {
    const n = Number(harborId.split(":")[1]);
    const mal = Number.isFinite(n) ? await kitsuToMal(n).catch(() => null) : null;
    if (mal != null) tgt = { kind: "show", ids: { mal } };
  }
  if (!tgt) return null;
  if (mediaType === "series" && tgt.kind === "movie") tgt = { kind: "show", ids: tgt.ids };
  if (mediaType === "movie" && (tgt.kind === "show" || tgt.kind === "anime")) {
    tgt = { kind: "movie", ids: tgt.ids };
  }
  return tgt;
}

/**
 * Resolve a Trakt target for a title, correcting the kind from the Detail
 * page's mediaType. stremioIdToTraktTarget infers kind from the id shape
 * alone, so a bare series IMDb id ("tt…") comes back as a movie; without the
 * correction a series would read /sync/ratings/movies and never find its
 * rating. Mirrors resolveSimklTarget. Exported for tests.
 */
export function resolveTraktTarget(
  harborId: string,
  mediaType: HierarchyRatingInput["mediaType"],
): TraktTarget | null {
  const resolution = stremioIdToTraktTarget(harborId);
  if (!resolution.ok) return null;
  let target = resolution.target;
  if (target.kind === "episode") return null;
  if ((mediaType === "series" || mediaType === "anime") && target.kind === "movie") {
    target = { kind: "show", ids: target.ids };
  }
  if (mediaType === "movie" && target.kind === "show") {
    target = { kind: "movie", ids: target.ids };
  }
  return target;
}

/**
 * Trakt writes need a TMDB id; reads accept IMDb too. Resolve one from the
 * IMDb id when the target only carries IMDb. Exported for tests.
 */
export async function resolveTraktTargetForWrite(
  harborId: string,
  mediaType: HierarchyRatingInput["mediaType"],
  tmdbKey: string,
): Promise<TraktTarget | null> {
  const target = resolveTraktTarget(harborId, mediaType);
  if (!target || target.kind === "episode") return null;
  if (target.ids.tmdb != null) return target;
  const imdb = target.ids.imdb;
  if (!imdb || !tmdbKey) return null;
  const resolved = await tmdbIdFromImdb(
    tmdbKey,
    imdb,
    target.kind === "movie" ? "movie" : "series",
  ).catch(() => null);
  if (!resolved) return null;
  const match = resolved.match(/^tmdb:(movie|tv):(\d+)$/);
  if (!match) return null;
  const tmdb = Number(match[2]);
  if (!Number.isFinite(tmdb)) return null;
  // Respect the kind TMDB resolved: a series whose IMDb has no movie match
  // falls back to a tv id, which must stay a show — building it as a movie
  // would rate the wrong movie that happens to share the TMDB id.
  return match[1] === "tv" ? { kind: "show", ids: { tmdb } } : { kind: "movie", ids: { tmdb } };
}

async function readTrakt(input: HierarchyRatingInput): Promise<number | null> {
  const target = resolveTraktTarget(input.harborId, input.mediaType);
  if (!target) return null;
  return getTraktUserRating(target);
}

async function readSimkl(input: HierarchyRatingInput): Promise<number | null> {
  const target = await resolveSimklTarget(input.harborId, input.mediaType);
  if (!target) return null;
  return fetchSimklUserRating(target);
}

async function readLetterboxd(input: HierarchyRatingInput, userId: string): Promise<number | null> {
  if (input.mediaType !== "movie") return null;
  const imdbId = imdbIdOf(input);
  if (!imdbId) return null;
  const { stars } = await fetchLetterboxdUserRating(userId, imdbId);
  if (stars == null) return null;
  return normalizeToTen("letterboxd", stars);
}

/**
 * Walk the hierarchy top-down and return the first rating found. A provider
 * failing (network, unresolvable id) is skipped, never fatal.
 */
export async function fetchHierarchyRating(
  input: HierarchyRatingInput,
  order: RatingProviderId[],
  connections: HierarchyConnections,
): Promise<ResolvedRating | null> {
  for (const provider of order) {
    try {
      let score: number | null = null;
      if (provider === "trakt" && connections.trakt) score = await readTrakt(input);
      else if (provider === "simkl" && connections.simkl) score = await readSimkl(input);
      else if (
        provider === "letterboxd" &&
        connections.letterboxd &&
        connections.letterboxdUserId
      ) {
        score = await readLetterboxd(input, connections.letterboxdUserId);
      }
      if (score != null) return { provider, score };
    } catch {
      // Skip a failing provider and try the next one down the hierarchy.
    }
  }
  return null;
}

async function writeTrakt(
  input: HierarchyRatingInput,
  score10: number,
  connections: HierarchyConnections,
): Promise<boolean> {
  try {
    const target = await resolveTraktTargetForWrite(
      input.harborId,
      input.mediaType,
      connections.tmdbKey,
    );
    if (!target) return false;
    await rateTraktContent(target, score10);
    return true;
  } catch {
    return false;
  }
}

async function writeSimkl(input: HierarchyRatingInput, score10: number): Promise<boolean> {
  try {
    const target = await resolveSimklTarget(input.harborId, input.mediaType);
    if (!target) return false;
    return await addSimklRating(target, score10);
  } catch {
    return false;
  }
}

async function writeLetterboxd(
  input: HierarchyRatingInput,
  score10: number,
  userId: string,
): Promise<boolean> {
  try {
    if (input.mediaType !== "movie") return false;
    const imdbId = imdbIdOf(input);
    if (!imdbId) return false;
    const { rateUrl } = await fetchLetterboxdUserRating(userId, imdbId);
    if (!rateUrl) return false;
    return await submitLetterboxdRating(rateUrl, denormalizeFromTen("letterboxd", score10));
  } catch {
    return false;
  }
}

async function removeTrakt(
  input: HierarchyRatingInput,
  connections: HierarchyConnections,
): Promise<boolean> {
  try {
    const target = await resolveTraktTargetForWrite(
      input.harborId,
      input.mediaType,
      connections.tmdbKey,
    );
    if (!target) return false;
    await removeTraktRating(target);
    return true;
  } catch {
    return false;
  }
}

async function removeSimkl(input: HierarchyRatingInput): Promise<boolean> {
  try {
    const target = await resolveSimklTarget(input.harborId, input.mediaType);
    if (!target) return false;
    return await removeSimklRating(target);
  } catch {
    return false;
  }
}

async function removeLetterboxd(input: HierarchyRatingInput, userId: string): Promise<boolean> {
  try {
    if (input.mediaType !== "movie") return false;
    const imdbId = imdbIdOf(input);
    if (!imdbId) return false;
    const { rateUrl } = await fetchLetterboxdUserRating(userId, imdbId);
    if (!rateUrl) return false;
    return await submitLetterboxdRating(rateUrl, "remove");
  } catch {
    return false;
  }
}

/**
 * Fan a rating out to every connected rating tracker so they stay in sync.
 * Each provider is attempted independently; a failure is reported per
 * provider and never blocks the others.
 */
export async function fanOutRating(
  input: HierarchyRatingInput,
  score10: number,
  connections: HierarchyConnections,
): Promise<FanOutResult[]> {
  const tasks: Array<Promise<FanOutResult>> = [];
  if (connections.trakt) {
    tasks.push(
      writeTrakt(input, score10, connections).then((ok) => ({ provider: "trakt" as const, ok })),
    );
  }
  if (connections.simkl) {
    tasks.push(writeSimkl(input, score10).then((ok) => ({ provider: "simkl" as const, ok })));
  }
  if (connections.letterboxd && connections.letterboxdUserId) {
    tasks.push(
      writeLetterboxd(input, score10, connections.letterboxdUserId).then((ok) => ({
        provider: "letterboxd" as const,
        ok,
      })),
    );
  }
  return Promise.all(tasks);
}

/** Fan a rating removal out to every connected rating tracker. */
export async function fanOutRemoveRating(
  input: HierarchyRatingInput,
  connections: HierarchyConnections,
): Promise<FanOutResult[]> {
  const tasks: Array<Promise<FanOutResult>> = [];
  if (connections.trakt) {
    tasks.push(removeTrakt(input, connections).then((ok) => ({ provider: "trakt" as const, ok })));
  }
  if (connections.simkl) {
    tasks.push(removeSimkl(input).then((ok) => ({ provider: "simkl" as const, ok })));
  }
  if (connections.letterboxd && connections.letterboxdUserId) {
    tasks.push(
      removeLetterboxd(input, connections.letterboxdUserId).then((ok) => ({
        provider: "letterboxd" as const,
        ok,
      })),
    );
  }
  return Promise.all(tasks);
}

/** Live order for the settings list: the stored order, auto-filled, filtered to connected. */
export function useRatingHierarchyOrder(): {
  order: RatingProviderId[];
  connected: RatingProviderId[];
  move: (provider: RatingProviderId, delta: -1 | 1) => void;
} {
  const { settings, update } = useSettings();
  const { isConnected: traktConnected } = useTrakt();
  const { isConnected: simklConnected } = useSimkl();
  const lb = useLetterboxd();

  const connected = useMemo<RatingProviderId[]>(() => {
    const list: RatingProviderId[] = [];
    if (traktConnected) list.push("trakt");
    if (simklConnected) list.push("simkl");
    if (lb.isFullConnected) list.push("letterboxd");
    return list;
  }, [traktConnected, simklConnected, lb.isFullConnected]);

  const storedOrder = settings.ratingProviderOrder;
  useEffect(() => {
    const next = ensureProvidersInOrder(storedOrder, connected);
    if (next !== storedOrder) update({ ratingProviderOrder: next });
  }, [storedOrder, connected, update]);

  const order = useMemo(() => resolveRatingOrder(storedOrder, connected), [storedOrder, connected]);

  const move = useCallback(
    (provider: RatingProviderId, delta: -1 | 1) => {
      const live = resolveRatingOrder(storedOrder, connected);
      const idx = live.indexOf(provider);
      const nextIdx = idx + delta;
      if (idx < 0 || nextIdx < 0 || nextIdx >= live.length) return;
      const nextLive = [...live];
      [nextLive[idx], nextLive[nextIdx]] = [nextLive[nextIdx]!, nextLive[idx]!];
      update({ ratingProviderOrder: applyRatingOrder(storedOrder, connected, nextLive) });
    },
    [storedOrder, connected, update],
  );

  return { order, connected, move };
}

/**
 * The Detail page rating, read-first: the hierarchy's first hit, or null when
 * no connected tracker has rated the title. The caller falls back to the
 * Harbor-local rating. Also hands back the fan-out writers bound to this
 * title and its current connections.
 */
export function useHierarchyRating(input: HierarchyRatingInput): {
  rating: ResolvedRating | null;
  loading: boolean;
  connected: RatingProviderId[];
  order: RatingProviderId[];
  writeRating: (score10: number) => Promise<FanOutResult[]>;
  removeRating: () => Promise<FanOutResult[]>;
} {
  const { settings, update } = useSettings();
  const { isConnected: traktConnected } = useTrakt();
  const { isConnected: simklConnected } = useSimkl();
  const lb = useLetterboxd();

  const { harborId, mediaType, imdbId } = input;

  const connected = useMemo<RatingProviderId[]>(() => {
    const list: RatingProviderId[] = [];
    if (traktConnected) list.push("trakt");
    if (simklConnected) list.push("simkl");
    if (lb.isFullConnected) list.push("letterboxd");
    return list;
  }, [traktConnected, simklConnected, lb.isFullConnected]);

  const storedOrder = settings.ratingProviderOrder;
  useEffect(() => {
    const next = ensureProvidersInOrder(storedOrder, connected);
    if (next !== storedOrder) update({ ratingProviderOrder: next });
  }, [storedOrder, connected, update]);

  const order = useMemo(() => resolveRatingOrder(storedOrder, connected), [storedOrder, connected]);

  const connections = useMemo<HierarchyConnections>(
    () => ({
      trakt: traktConnected,
      simkl: simklConnected,
      letterboxd: lb.isFullConnected,
      letterboxdUserId: lb.session?.userId ?? null,
      tmdbKey: settings.tmdbKey,
    }),
    [traktConnected, simklConnected, lb.isFullConnected, lb.session?.userId, settings.tmdbKey],
  );

  const [rating, setRating] = useState<ResolvedRating | null>(null);
  const [loading, setLoading] = useState(false);
  const orderKey = order.join(",");
  const connectedKey = connected.join(",");

  useEffect(() => {
    if (mediaType === "manga" || connected.length === 0) {
      setRating(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const snapshot: HierarchyRatingInput = { harborId, mediaType, imdbId };
    void fetchHierarchyRating(snapshot, order, connections).then((resolved) => {
      if (cancelled) return;
      setRating(resolved);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // The string keys stand in for the derived arrays/objects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harborId, mediaType, imdbId, orderKey, connectedKey, lb.session?.userId, settings.tmdbKey]);

  const writeRating = useCallback(
    async (score10: number) => {
      const snapshot: HierarchyRatingInput = { harborId, mediaType, imdbId };
      const results = await fanOutRating(snapshot, score10, connections);
      // Fan-out aims to make every tracker agree; optimistically show the new
      // score from the first provider in hierarchy order that accepted it.
      for (const provider of order) {
        if (results.some((r) => r.provider === provider && r.ok)) {
          setRating({ provider, score: score10 });
          break;
        }
      }
      return results;
    },
    [harborId, mediaType, imdbId, order, connections],
  );

  const removeRating = useCallback(async () => {
    const snapshot: HierarchyRatingInput = { harborId, mediaType, imdbId };
    const results = await fanOutRemoveRating(snapshot, connections);
    if (results.some((r) => r.ok)) setRating(null);
    return results;
  }, [harborId, mediaType, imdbId, connections]);

  return { rating, loading, connected, order, writeRating, removeRating };
}
