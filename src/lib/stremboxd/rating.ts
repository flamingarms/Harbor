import { safeFetch as fetch } from "@/lib/safe-fetch";
import { fetchLetterboxdStreams, type LetterboxdStreamInfo } from "./client";

const STREMBOXD_BASE = "https://api.stremboxd.com";

export function parseRateUrl(
  rateUrl: string,
): { userId: string; filmId: string; tok: string; imdb: string } | null {
  try {
    const u = new URL(rateUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    // /action/:userId/rate/:filmId
    if (parts.length < 4 || parts[2] !== "rate") return null;
    return {
      userId: parts[1]!,
      filmId: parts[3]!,
      tok: u.searchParams.get("tok") ?? "",
      imdb: u.searchParams.get("imdb") ?? "",
    };
  } catch {
    return null;
  }
}

export function buildRateSubmitUrl(
  parsed: { userId: string; filmId: string; tok: string; imdb: string },
  rating: number | "remove",
): string {
  const params = new URLSearchParams();
  if (parsed.imdb) params.set("imdb", parsed.imdb);
  params.set("tok", parsed.tok);
  params.set("rating", rating === "remove" ? "remove" : rating.toFixed(1));
  return `${STREMBOXD_BASE}/action/${parsed.userId}/rate/${parsed.filmId}/submit?${params.toString()}`;
}

/**
 * The user's own Letterboxd rating for a movie, in stars (0.5-5), plus the
 * pre-signed action URL a write needs. Movies only; Full connection required.
 * The server caches rating data for ~5 minutes, so callers must not re-fetch
 * right after a write — update optimistically instead.
 */
export async function fetchLetterboxdUserRating(
  userId: string,
  imdbId: string,
): Promise<{ stars: number | null; rateUrl: string | null }> {
  let info: LetterboxdStreamInfo | null = null;
  try {
    info = await fetchLetterboxdStreams(userId, imdbId);
  } catch {
    return { stars: null, rateUrl: null };
  }
  if (!info) return { stars: null, rateUrl: null };
  return { stars: info.userRating, rateUrl: info.rateUrl };
}

/** Submit a Letterboxd rating in stars (0.5-5), or "remove" to clear it. */
export async function submitLetterboxdRating(
  rateUrl: string,
  stars: number | "remove",
): Promise<boolean> {
  const parsed = parseRateUrl(rateUrl);
  if (!parsed) return false;
  try {
    const res = await fetch(buildRateSubmitUrl(parsed, stars));
    return res.ok;
  } catch {
    return false;
  }
}
