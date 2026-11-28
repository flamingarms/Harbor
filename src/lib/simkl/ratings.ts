import { useEffect, useState } from "react";
import { safeFetch } from "@/lib/safe-fetch";
import { simklRequest } from "./client";
import { getSession } from "./session";
import type { SimklIds, SimklTarget } from "./types";
import { updateCachedRatingByTarget, getCachedRatingByTarget } from "./activities";
import { HARBOR_API_BASE } from "@/lib/config/endpoints";

export { getCachedRatingByTarget };

const RATINGS_PROXY = `${HARBOR_API_BASE}/api/simkl/ratings`;
const MAX_BATCH = 120;

const ratingCache = new Map<string, number | null>();
const pending = new Map<string, Array<(v: number | null) => void>>();
let flushTimer: number | null = null;

function flush(): void {
  flushTimer = null;
  const specs = Array.from(pending.keys()).slice(0, MAX_BATCH);
  if (specs.length === 0) return;

  const resolvers = specs.map((s) => [s, pending.get(s)!] as const);
  specs.forEach((s) => pending.delete(s));
  if (pending.size > 0) scheduleFlush();

  const url = `${RATINGS_PROXY}?ids=${encodeURIComponent(specs.join(","))}`;
  safeFetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { ratings?: Record<string, { rating?: number } | null> } | null) => {
      for (const [spec, fns] of resolvers) {
        const hit = data?.ratings?.[spec];
        const val = hit && typeof hit.rating === "number" ? hit.rating : null;
        ratingCache.set(spec, val);
        fns.forEach((fn) => fn(val));
      }
    })
    .catch(() => {
      for (const [, fns] of resolvers) fns.forEach((fn) => fn(null));
    });
}

function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(flush, 60);
}

function resolveRatingBySpec(rawSpec: string): Promise<number | null> {
  const spec = rawSpec.toLowerCase();
  if (ratingCache.has(spec)) return Promise.resolve(ratingCache.get(spec) ?? null);
  return new Promise((resolve) => {
    const arr = pending.get(spec);
    if (arr) arr.push(resolve);
    else pending.set(spec, [resolve]);
    scheduleFlush();
  });
}

function useProxyRating(spec: string | null): { rating: number | null; loading: boolean } {
  const [rating, setRating] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!spec) {
      setRating(null);
      setLoading(false);
      return;
    }
    const key = spec.toLowerCase();
    if (ratingCache.has(key)) {
      setRating(ratingCache.get(key) ?? null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    resolveRatingBySpec(key).then((v) => {
      if (!cancelled) {
        setRating(v);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [spec]);

  return { rating, loading };
}

export function useSimklCommunityRating(imdbId: string | null): {
  rating: number | null;
  loading: boolean;
} {
  return useProxyRating(imdbId ? `imdb:${imdbId}` : null);
}

export function useSimklCardScores(imdbId: string | undefined): {
  score: number | null;
  loading: boolean;
} {
  const { rating, loading } = useProxyRating(imdbId ? `imdb:${imdbId}` : null);
  return { score: rating, loading };
}

const ANIME_SPEC = /^(mal|kitsu|anidb|anilist|simkl):\d+$/;

export function useSimklCardScoresByAnimeId(animeId: string | undefined): {
  score: number | null;
  loading: boolean;
} {
  const spec = animeId && ANIME_SPEC.test(animeId) ? animeId : null;
  const { rating, loading } = useProxyRating(spec);
  return { score: rating, loading };
}

function getRatingPayload(target: SimklTarget): { key: string; ids: SimklIds } {
  const isMovie = target.kind === "movie";
  const isAnime = target.kind === "anime" || target.kind === "anime-episode";

  const ids =
    target.kind === "episode"
      ? target.show.ids
      : target.kind === "anime-episode"
        ? target.anime.ids
        : target.ids;

  const key = isMovie ? "movies" : isAnime ? "anime" : "shows";
  return { key, ids };
}

export async function addSimklRating(target: SimklTarget, rating: number): Promise<boolean> {
  const { key, ids } = getRatingPayload(target);
  try {
    await simklRequest("/sync/ratings", {
      method: "POST",
      body: { [key]: [{ rating, ids }] },
    });
    updateCachedRatingByTarget(target, rating);
    invalidateUserRatings();
    return true;
  } catch (e) {
    console.error("Failed to add SIMKL rating", e);
    return false;
  }
}

export async function removeSimklRating(target: SimklTarget): Promise<boolean> {
  const { key, ids } = getRatingPayload(target);
  try {
    await simklRequest("/sync/ratings/remove", {
      method: "POST",
      body: { [key]: [{ ids }] },
    });
    updateCachedRatingByTarget(target, null);
    invalidateUserRatings();
    return true;
  } catch (e) {
    console.error("Failed to remove SIMKL rating", e);
    return false;
  }
}

type RawRatingEntry = {
  rating?: number;
  movie?: { ids?: SimklIds };
  show?: { ids?: SimklIds };
  anime?: { ids?: SimklIds };
};

type RawRatingsResponse = {
  movies?: RawRatingEntry[];
  shows?: RawRatingEntry[];
  anime?: RawRatingEntry[];
};

/**
 * The user's own Simkl ratings, fetched live. The Detail page previously read
 * only the bootstrap cache (getCachedRatingByTarget), which it never
 * refreshes, so a rating set on Simkl after startup never showed up. This
 * fetches GET /sync/ratings once per session and answers from it, merging
 * every entry into the activities cache too (so the picker and other cache
 * readers stay consistent). Writes invalidate the fetch so the next read
 * sees the new value. The in-memory id map keeps reads working even before
 * the bootstrap cache has ever been built.
 */
let userRatingsRequest: Promise<void> | null = null;
let userRatingsToken: string | null = null;
const userRatingsById = new Map<string, number>();

function invalidateUserRatings(): void {
  userRatingsRequest = null;
  userRatingsToken = null;
  userRatingsById.clear();
}

function ratingKey(kind: "movie" | "show" | "anime", ids: SimklIds): string[] {
  const keys: string[] = [];
  if (ids.simkl != null) keys.push(`simkl:${ids.simkl}`);
  if (ids.imdb) keys.push(`imdb:${ids.imdb}`);
  if (ids.tmdb != null) keys.push(`tmdb:${kind === "movie" ? "movie" : "tv"}:${ids.tmdb}`);
  if (ids.mal != null) keys.push(`mal:${ids.mal}`);
  return keys;
}

async function loadUserRatings(): Promise<void> {
  const data = await simklRequest<RawRatingsResponse>("/sync/ratings");
  const mergeList = (list: RawRatingEntry[] | undefined, kind: "movie" | "show" | "anime") => {
    for (const entry of list ?? []) {
      const node =
        kind === "movie"
          ? entry.movie
          : kind === "anime"
            ? entry.anime || entry.show || entry.movie
            : entry.show;
      const ids = node?.ids;
      if (!ids || typeof entry.rating !== "number") continue;
      for (const key of ratingKey(kind, ids)) userRatingsById.set(key, entry.rating);
      if (ids.simkl != null) {
        updateCachedRatingByTarget({ kind, ids: { simkl: ids.simkl } }, entry.rating);
      }
    }
  };
  mergeList(data?.movies, "movie");
  mergeList(data?.shows, "show");
  mergeList(data?.anime, "anime");
}

export async function fetchSimklUserRating(target: SimklTarget): Promise<number | null> {
  const token = getSession()?.accessToken ?? null;
  if (!token) return getCachedRatingByTarget(target);
  if (!userRatingsRequest || userRatingsToken !== token) {
    userRatingsToken = token;
    userRatingsRequest = loadUserRatings().catch(() => {});
  }
  await userRatingsRequest;
  const cached = getCachedRatingByTarget(target);
  if (cached != null) return cached;
  const kind =
    target.kind === "movie"
      ? "movie"
      : target.kind === "anime" || target.kind === "anime-episode"
        ? "anime"
        : "show";
  const ids =
    target.kind === "episode"
      ? target.show.ids
      : target.kind === "anime-episode"
        ? target.anime.ids
        : target.ids;
  for (const key of ratingKey(kind, ids)) {
    const hit = userRatingsById.get(key);
    if (hit != null) return hit;
  }
  return null;
}
