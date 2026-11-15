import { activeProfileId } from "@/lib/active-profile-id";
import {
  manualEpisodeKeys,
  reconcileSimklWatchedEpisodes,
  type ManualWatchedMeta,
} from "@/lib/manual-watched";
import { isMovieWatchedLocal, reconcileSimklMovieWatched } from "@/lib/movie-watched";
import { isWatchedFlagged, reconcileSimklWatchedFlags } from "@/lib/watched-flag";
import { isSimklBlocked, SimklApiError } from "./client";
import { invalidateSimklListStatus, loadSimklProgress, type SimklProgress } from "./list-status";
import { getSession } from "./session";

export type SimklSyncResult =
  | { ok: true; addedMovies: number; addedEpisodes: number }
  | { ok: false; message: string };

function mapSimklSyncError(error: unknown): string {
  if (error instanceof SimklApiError) {
    if (error.status === 401) return "Simkl sign-in expired, reconnect it";
    if (error.status === 429 || error.status === 412)
      return "Simkl is rate-limited. Try again later.";
  }
  return "Couldn't reach Simkl";
}

type Owner = { session: ReturnType<typeof getSession>; profile: string };

function captureOwner(): Owner {
  return { session: getSession(), profile: activeProfileId() };
}

function ownerChanged(owner: Owner): boolean {
  return getSession() !== owner.session || activeProfileId() !== owner.profile;
}

/**
 * Diff Simkl Completed titles against local watched state and commit only what
 * is missing, in three batched writes (movies, watched flags, episodes).
 * Additive and one-way only: nothing already watched locally is unmarked, and
 * an episode the user manually unmarked stays unmarked.
 */
function diffAndCommit(progress: SimklProgress): SimklSyncResult {
  const movieIds = new Set<string>();
  const flagIds = new Set<string>();
  const episodeKeys = new Set<string>();
  const metas = new Map<string, ManualWatchedMeta>();
  let addedMovies = 0;
  let addedEpisodes = 0;

  for (const entry of progress.entries) {
    if (entry.status !== "completed") continue;
    if (entry.kind === "movie") {
      if (isMovieWatchedLocal(entry.id) || isWatchedFlagged(entry.id)) continue;
      movieIds.add(entry.id);
      flagIds.add(entry.id);
      addedMovies += 1;
      continue;
    }
    // Shows: trust Simkl's explicit episode list exactly. Only a Completed
    // show with no watched episodes at all is expanded to every episode
    // Simkl lists for it — a partial list (3 of 10) is never expanded.
    // entry.seasons comes from the Simkl payload itself, so no per-show
    // catalog fetch is needed for the expansion.
    const episodes = entry.watched.size > 0 ? entry.watched : entry.seasons;
    const local = manualEpisodeKeys(entry.id);
    let showAdded = 0;
    for (const coord of episodes) {
      if (local.watched.has(coord) || local.unwatched.has(coord)) continue;
      episodeKeys.add(`${entry.id}|${coord.replace(":", "|")}`);
      showAdded += 1;
    }
    if (showAdded > 0) {
      addedEpisodes += showAdded;
      if (entry.title)
        metas.set(entry.id, {
          type: "series",
          name: entry.title,
          poster: entry.poster ?? undefined,
        });
    }
    // The flag is the series-level watched signal; set it for every Completed
    // show that does not already have it, even when its episodes were already
    // watched locally.
    if (!isWatchedFlagged(entry.id)) flagIds.add(entry.id);
  }

  if (movieIds.size > 0) reconcileSimklMovieWatched(movieIds);
  if (flagIds.size > 0) reconcileSimklWatchedFlags(flagIds);
  if (episodeKeys.size > 0) reconcileSimklWatchedEpisodes(episodeKeys, metas);
  return { ok: true, addedMovies, addedEpisodes };
}

async function reconcileSimklWatchedOnce(force: boolean): Promise<SimklSyncResult> {
  const owner = captureOwner();
  if (!owner.session) return { ok: true, addedMovies: 0, addedEpisodes: 0 };
  // Fail fast while Simkl is in a rate-limit cooldown; the next loop run retries.
  if (isSimklBlocked()) return { ok: false, message: "Simkl is rate-limited. Try again later." };
  try {
    // Force re-pulls from Simkl (connect and the manual button). Otherwise the
    // activities gate inside loadSimklProgress decides: unchanged data still
    // reconciles, from the cache, instead of skipping the run.
    if (force) invalidateSimklListStatus();
    const progress = await loadSimklProgress();
    // A profile switch or disconnect mid-pull must not write into the wrong
    // profile's stores. An aborted run is a silent no-op, not a failure.
    if (ownerChanged(owner)) return { ok: true, addedMovies: 0, addedEpisodes: 0 };
    // No await between here and the commit, so the owner cannot change under it.
    return diffAndCommit(progress);
  } catch (error) {
    if (ownerChanged(owner)) return { ok: true, addedMovies: 0, addedEpisodes: 0 };
    return { ok: false, message: mapSimklSyncError(error) };
  }
}

// Singleflight coordinator, mirroring the Nuvio one: concurrent triggers join
// the in-flight run, and a force requested while one runs queues a fresh force
// run afterwards instead of starting a duplicate pull.
let inFlight: Promise<SimklSyncResult> | null = null;
let queuedForce = false;

/**
 * The single entry point for Simkl watched sync. Silent: callers that want
 * feedback (the manual button) read the returned result; the background loop
 * ignores it.
 */
export function requestSimklSync(force = false): Promise<SimklSyncResult> {
  if (!getSession()) return Promise.resolve({ ok: true, addedMovies: 0, addedEpisodes: 0 });
  if (inFlight) {
    if (force) queuedForce = true;
    return inFlight;
  }
  const run = reconcileSimklWatchedOnce(force);
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
    if (queuedForce) {
      queuedForce = false;
      void requestSimklSync(true);
    }
  });
  return run;
}
