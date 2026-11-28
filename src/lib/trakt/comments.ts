import { traktRequest } from "./client";
import { TRAKT_API_BASE, TRAKT_CLIENT_ID } from "./config";
import { getSession } from "./session";
import type { TraktTarget, TraktIds } from "./types";

export type TraktComment = {
  id: number;
  comment: string;
  spoiler: boolean;
  review: boolean;
  replies: number;
  likes: number;
  createdAt: string;
  userRating: number | null;
  user: {
    username: string;
    name: string | null;
    avatar: string | null;
    slug: string | null;
  };
};

type RawComment = {
  id: number;
  parent_id: number;
  created_at: string;
  updated_at: string;
  comment: string;
  spoiler: boolean;
  review: boolean;
  replies: number;
  likes: number;
  user_stats?: { rating: number; play_count: number; completed_count: number };
  user: {
    username: string;
    private: boolean;
    name: string | null;
    vip: boolean;
    vip_ep: boolean;
    ids: { slug: string };
    images?: { avatar?: { full?: string } };
  };
};

function pickId(ids: { tmdb?: number; imdb?: string }): string {
  if (ids.imdb) return ids.imdb;
  if (ids.tmdb) return `tmdb:${ids.tmdb}`;
  return "";
}

function showPath(target: TraktTarget): string {
  if (target.kind === "episode") return pickId(target.show.ids);
  return pickId(target.ids);
}

export function commentsPath(target: TraktTarget, sort: string): string {
  const id = showPath(target);
  if (target.kind === "episode") {
    return `/shows/${id}/seasons/${target.season}/episodes/${target.number}/comments/${sort}`;
  }
  if (target.kind === "movie") {
    return `/movies/${id}/comments/${sort}`;
  }
  return `/shows/${id}/comments/${sort}`;
}

function mapComment(raw: RawComment): TraktComment {
  return {
    id: raw.id,
    comment: raw.comment,
    spoiler: raw.spoiler,
    review: raw.review,
    replies: raw.replies,
    likes: raw.likes,
    createdAt: raw.created_at,
    userRating: raw.user_stats?.rating ?? null,
    user: {
      username: raw.user.username,
      name: raw.user.name,
      avatar: raw.user.images?.avatar?.full ?? null,
      slug: raw.user.ids.slug,
    },
  };
}

export async function fetchCommentsStrict(
  target: TraktTarget,
  sort: string = "likes",
  page = 1,
  limit = 20,
): Promise<TraktComment[]> {
  const path = commentsPath(target, sort) + `?extended=images&page=${page}&limit=${limit}`;
  const raw = await traktRequest<RawComment[]>(path);
  return raw.map(mapComment);
}

export async function fetchComments(
  target: TraktTarget,
  sort: string = "likes",
  page = 1,
  limit = 20,
): Promise<TraktComment[]> {
  return fetchCommentsStrict(target, sort, page, limit).catch(() => [] as TraktComment[]);
}

export async function fetchReplies(commentId: number): Promise<TraktComment[]> {
  const raw = await traktRequest<RawComment[]>(
    `/comments/${commentId}/replies?extended=images`,
  ).catch(() => [] as RawComment[]);
  return raw.map(mapComment);
}

export async function likeComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}/like`, { method: "POST", authed: true });
}

export async function unlikeComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}/like`, { method: "DELETE", authed: true });
}

export async function deleteComment(id: number): Promise<void> {
  await traktRequest(`/comments/${id}`, { method: "DELETE", authed: true });
}

function subjectBody(target: TraktTarget) {
  const ids: Record<string, string | number> = {};
  const src =
    target.kind === "episode"
      ? ((target as { ids?: { tmdb?: number; imdb?: string } }).ids ??
        (target as { show: { ids: { tmdb?: number; imdb?: string } } }).show.ids)
      : target.ids;
  if (src.tmdb) ids.tmdb = src.tmdb;
  if (src.imdb) ids.imdb = src.imdb;
  const key = target.kind === "episode" ? "episode" : target.kind;
  return { [key]: { ids } };
}

export async function postComment(
  target: TraktTarget,
  comment: string,
  spoiler: boolean = false,
): Promise<TraktComment> {
  const body = {
    comment,
    spoiler,
    review: false,
    share: false,
    ...subjectBody(target),
  };
  const raw = await traktRequest<RawComment>("/comments?extended=images", {
    method: "POST",
    authed: true,
    body,
  });
  return mapComment(raw);
}

export function ratingPath(target: TraktTarget): string {
  const id = showPath(target);
  if (target.kind === "episode") {
    return `/shows/${id}/seasons/${target.season}/episodes/${target.number}/rating`;
  }
  if (target.kind === "movie") return `/movies/${id}/rating`;
  return `/shows/${id}/rating`;
}

function syncIds(target: TraktTarget): { tmdb?: number } | null {
  if (target.kind === "episode") {
    const epIds = (target as { ids?: TraktIds }).ids;
    return epIds?.tmdb ? { tmdb: epIds.tmdb } : null;
  }
  return target.ids?.tmdb ? { tmdb: target.ids.tmdb } : null;
}

function syncType(target: TraktTarget): string {
  return target.kind === "episode" ? "episodes" : target.kind === "movie" ? "movies" : "shows";
}

export async function rateContent(target: TraktTarget, rating: number): Promise<void> {
  const ids = syncIds(target);
  if (!ids) throw new Error("No TMDB ID available for rating");
  const body = { [syncType(target)]: [{ rating, ids }] };
  await traktRequest("/sync/ratings", { method: "POST", authed: true, body });
}

export async function removeRating(target: TraktTarget): Promise<void> {
  const ids = syncIds(target);
  if (!ids) throw new Error("No TMDB ID available for rating");
  const body = { [syncType(target)]: [{ ids }] };
  await traktRequest("/sync/ratings/remove", { method: "POST", authed: true, body });
}

type RawUserRating = {
  rating?: number;
  movie?: { ids?: TraktIds };
  show?: { ids?: TraktIds };
  episode?: { ids?: TraktIds };
};

/** The rated title's ids live in the node named after the list type. */
function ratingEntryIds(entry: RawUserRating, kind: TraktTarget["kind"]): TraktIds | undefined {
  if (kind === "movie") return entry.movie?.ids;
  if (kind === "episode") return entry.episode?.ids;
  return entry.show?.ids;
}

/**
 * Match a ratings-list entry against the requested title. Trakt's
 * /sync/ratings/{type} endpoint takes no id filter, so it returns the whole
 * list; taking data[0] would return an arbitrary title's rating. TMDB decides
 * when both sides carry it, otherwise IMDb; an entry carrying neither matching
 * id never matches.
 */
function ratingEntryMatches(entry: RawUserRating, target: TraktTarget): boolean {
  const entryIds = ratingEntryIds(entry, target.kind);
  if (!entryIds) return false;
  const want: TraktIds =
    target.kind === "episode" ? (target.episodeIds ?? target.show.ids) : target.ids;
  if (want.tmdb != null && entryIds.tmdb != null) return want.tmdb === entryIds.tmdb;
  if (want.imdb && entryIds.imdb) return want.imdb === entryIds.imdb;
  return false;
}

export async function getUserRating(target: TraktTarget): Promise<number | null> {
  const session = getSession();
  if (!session?.accessToken) return null;

  const epIds = (target as { ids?: TraktIds }).ids;
  const itemId =
    target.kind === "episode"
      ? (epIds?.tmdb ?? epIds?.imdb)
      : (target.ids?.tmdb ?? target.ids?.imdb);
  if (!itemId) return null;

  const param = typeof itemId === "number" ? `tmdb=${itemId}` : `imdb=${itemId}`;
  const type =
    target.kind === "movie" ? "movies" : target.kind === "episode" ? "episodes" : "shows";

  try {
    const res = await fetch(`${TRAKT_API_BASE}/sync/ratings/${type}?${param}`, {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID,
        Authorization: `Bearer ${session.accessToken}`,
      },
      redirect: "manual",
    });
    if (res.status >= 200 && res.status < 300) {
      const data = (await res.json()) as RawUserRating[];
      const match = data.find((entry) => ratingEntryMatches(entry, target));
      return typeof match?.rating === "number" ? match.rating : null;
    }
    return null;
  } catch {
    return null;
  }
}
