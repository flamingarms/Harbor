import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import "./_localstorage-stub.ts";

// Runtime test for the Simkl watched reconcile (src/lib/simkl/reconcile-watched.ts).
// The harness transpiles the real reconcile module plus the real watched stores,
// mocking only the Simkl network/session boundary, following the pattern in
// tests/simkl-list-status.test.ts.

const nodeRequire = createRequire(import.meta.url);
const moduleCache = new Map<string, Record<string, unknown>>();

let profileId = "fixture-1";
let session: { username: string; accessToken: string } | null = {
  username: "fixture",
  accessToken: "token",
};
let blocked = false;
let progressFixture: unknown = null;
let progressError: unknown = null;

class SimklApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Simkl HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

const activeProfileMock = {
  activeProfileId: () => profileId,
  stremioProfileId: () => profileId,
  primaryProfileId: () => profileId,
  isNuvioProviderActive: () => false,
  nuvioWatchedScope: () => "nuvio.v2.unowned",
  canPersistWatched: () => true,
  getNuvioActiveSlot: () => 0,
};

function transpile(path: string): string {
  return ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function resolveName(name: string, fromDir: string): string {
  if (name.startsWith("@/")) return `src/${name.slice(2)}.ts`;
  const parts = fromDir.split("/").filter(Boolean);
  for (const seg of name.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join("/");
  return joined.endsWith(".ts") || joined.endsWith(".tsx") ? joined : `${joined}.ts`;
}

function loadModule(resolved: string): Record<string, unknown> {
  const cached = moduleCache.get(resolved);
  if (cached) return cached;
  const module = { exports: {} as Record<string, unknown> };
  moduleCache.set(resolved, module.exports);
  const dir = resolved.slice(0, resolved.lastIndexOf("/"));
  const req = (name: string) => requireMock(name, dir);
  new Function("require", "module", "exports", transpile(resolved))(req, module, module.exports);
  return module.exports;
}

function requireMock(name: string, fromDir: string): unknown {
  if (name === "react") return nodeRequire("react");
  const resolved = resolveName(name, fromDir);
  if (resolved === "src/lib/active-profile-id.ts") return activeProfileMock;
  if (resolved === "src/lib/simkl/client.ts")
    return { isSimklBlocked: () => blocked, SimklApiError };
  if (resolved === "src/lib/simkl/list-status.ts")
    return {
      invalidateSimklListStatus: () => {},
      loadSimklProgress: async () => {
        if (progressError) throw progressError;
        return progressFixture;
      },
    };
  if (resolved === "src/lib/simkl/session.ts") return { getSession: () => session };
  return loadModule(resolved);
}

const reconcile = loadModule("src/lib/simkl/reconcile-watched.ts") as {
  requestSimklSync: (force?: boolean) => Promise<unknown>;
};
const manualWatched = loadModule("src/lib/manual-watched.ts") as {
  setManualWatched: (metaId: string, season: number, episode: number, watched: boolean) => void;
  manualEpisodeKeys: (metaId: string) => { watched: Set<string>; unwatched: Set<string> };
};
const movieWatched = loadModule("src/lib/movie-watched.ts") as {
  setMovieWatchedLocal: (metaId: string, watched: boolean) => void;
  isMovieWatchedLocal: (metaId: string) => boolean;
};
const watchedFlag = loadModule("src/lib/watched-flag.ts") as {
  isWatchedFlagged: (metaId: string) => boolean;
  setWatchedFlag: (metaId: string, watched: boolean) => void;
};

function fixtureProgress(
  entries: Array<{
    id: string;
    kind: "movie" | "show";
    status: string;
    watched?: string[];
    seasons?: string[];
    title?: string;
  }>,
) {
  return {
    statuses: new Map(entries.map((e) => [e.id, e.status])),
    watched: new Map(),
    watchedAt: new Map(),
    completedSeries: [],
    entries: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      poster: null,
      status: e.status,
      watched: new Set(e.watched ?? []),
      seasons: new Set(e.seasons ?? []),
    })),
  };
}

function readStore(key: string): string[] {
  return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
}

test("completed movie is imported into the native movie stores", async () => {
  profileId = "fixture-movie";
  progressFixture = fixtureProgress([
    { id: "tt123", kind: "movie", status: "completed" },
    { id: "tt456", kind: "movie", status: "watching" },
  ]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 1, addedEpisodes: 0 });
  assert.ok(readStore("harbor.moviewatched.v1.fixture-movie").includes("tt123"));
  assert.ok(!readStore("harbor.moviewatched.v1.fixture-movie").includes("tt456"));
  assert.ok(watchedFlag.isWatchedFlagged("tt123"));
  assert.ok(!watchedFlag.isWatchedFlagged("tt456"));
});

test("completed show trusts the explicit episode list and never expands a partial set", async () => {
  profileId = "fixture-show-partial";
  progressFixture = fixtureProgress([
    {
      id: "tt789",
      kind: "show",
      status: "completed",
      title: "Partial Show",
      watched: ["1:1", "1:2", "1:3"],
      seasons: ["1:1", "1:2", "1:3", "1:4", "1:5", "1:6", "1:7", "1:8", "1:9", "1:10"],
    },
  ]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 0, addedEpisodes: 3 });
  const keys = manualWatched.manualEpisodeKeys("tt789");
  assert.deepEqual([...keys.watched].sort(), ["1:1", "1:2", "1:3"]);
  assert.ok(watchedFlag.isWatchedFlagged("tt789"));
});

test("completed show with no watched episodes expands to the Simkl season list", async () => {
  profileId = "fixture-show-empty";
  progressFixture = fixtureProgress([
    {
      id: "tt101",
      kind: "show",
      status: "completed",
      title: "Empty Show",
      watched: [],
      seasons: ["1:1", "1:2", "2:1"],
    },
  ]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 0, addedEpisodes: 3 });
  const keys = manualWatched.manualEpisodeKeys("tt101");
  assert.deepEqual([...keys.watched].sort(), ["1:1", "1:2", "2:1"]);
});

test("a locally unmarked episode is not re-marked by the sync", async () => {
  profileId = "fixture-show-override";
  manualWatched.setManualWatched("tt202", 1, 2, false);
  progressFixture = fixtureProgress([
    {
      id: "tt202",
      kind: "show",
      status: "completed",
      title: "Override Show",
      watched: ["1:1", "1:2"],
      seasons: ["1:1", "1:2"],
    },
  ]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 0, addedEpisodes: 1 });
  const keys = manualWatched.manualEpisodeKeys("tt202");
  assert.deepEqual([...keys.watched].sort(), ["1:1"]);
  assert.deepEqual([...keys.unwatched].sort(), ["1:2"]);
});

test("a completed movie that is flagged but missing from the movie store still gains a movie-store entry", async () => {
  profileId = "fixture-flag-only";
  watchedFlag.setWatchedFlag("tt404", true);
  assert.ok(!movieWatched.isMovieWatchedLocal("tt404"));
  progressFixture = fixtureProgress([{ id: "tt404", kind: "movie", status: "completed" }]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 1, addedEpisodes: 0 });
  assert.ok(movieWatched.isMovieWatchedLocal("tt404"));
  assert.ok(watchedFlag.isWatchedFlagged("tt404"));
});

test("a completed movie already in the movie store still gains the flag if it is missing", async () => {
  profileId = "fixture-movie-only";
  movieWatched.setMovieWatchedLocal("tt505", true);
  assert.ok(!watchedFlag.isWatchedFlagged("tt505"));
  progressFixture = fixtureProgress([{ id: "tt505", kind: "movie", status: "completed" }]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 0, addedEpisodes: 0 });
  assert.ok(movieWatched.isMovieWatchedLocal("tt505"));
  assert.ok(watchedFlag.isWatchedFlagged("tt505"));
});

test("already-watched titles are a no-op", async () => {
  profileId = "fixture-noop";
  movieWatched.setMovieWatchedLocal("tt303", true);
  progressFixture = fixtureProgress([{ id: "tt303", kind: "movie", status: "completed" }]);
  const result = await reconcile.requestSimklSync(true);
  assert.deepEqual(result, { ok: true, addedMovies: 0, addedEpisodes: 0 });
  assert.ok(movieWatched.isMovieWatchedLocal("tt303"));
});

test("a rate-limit block fails fast with the mapped message", async () => {
  profileId = "fixture-blocked";
  blocked = true;
  try {
    progressFixture = fixtureProgress([]);
    const result = await reconcile.requestSimklSync(true);
    assert.deepEqual(result, { ok: false, message: "Simkl is rate-limited. Try again later." });
  } finally {
    blocked = false;
  }
});

test("a 401 maps to the sign-in-expired message", async () => {
  profileId = "fixture-401";
  progressError = new SimklApiError(401, "unauthorized");
  try {
    const result = await reconcile.requestSimklSync(true);
    assert.deepEqual(result, { ok: false, message: "Simkl sign-in expired, reconnect it" });
  } finally {
    progressError = null;
  }
});
