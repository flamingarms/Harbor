// @ts-expect-error Node tests are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node tests are outside the browser tsconfig.
import test from "node:test";
// @ts-expect-error Node tests are outside the browser tsconfig.
import { readFileSync } from "node:fs";
import * as React from "react";
import ts from "typescript";
import {
  applyRatingOrder,
  denormalizeFromTen,
  ensureProvidersInOrder,
  normalizeToTen,
  resolveRatingOrder,
} from "../src/lib/ratings/hierarchy-order";

test("resolveRatingOrder keeps the stored order, filtered to connected trackers", () => {
  assert.deepEqual(resolveRatingOrder(["simkl", "trakt", "letterboxd"], ["trakt", "simkl"]), [
    "simkl",
    "trakt",
  ]);
});

test("resolveRatingOrder appends newly connected trackers in canonical order", () => {
  assert.deepEqual(resolveRatingOrder(["simkl"], ["trakt", "simkl", "letterboxd"]), [
    "simkl",
    "trakt",
    "letterboxd",
  ]);
});

test("resolveRatingOrder drops unknown ids and tolerates a missing stored order", () => {
  assert.deepEqual(resolveRatingOrder(["bogus" as never, "trakt"], ["trakt"]), ["trakt"]);
  assert.deepEqual(resolveRatingOrder(undefined, ["simkl"]), ["simkl"]);
  assert.deepEqual(resolveRatingOrder([], []), []);
});

test("ensureProvidersInOrder appends newly connected trackers without reordering", () => {
  assert.deepEqual(ensureProvidersInOrder(["trakt"], ["trakt", "simkl"]), ["trakt", "simkl"]);
});

test("ensureProvidersInOrder returns the stored order unchanged when nothing is missing", () => {
  const stored = ["trakt", "simkl"] as const;
  assert.equal(ensureProvidersInOrder([...stored], ["trakt", "simkl"]).join(","), "trakt,simkl");
  assert.deepEqual(ensureProvidersInOrder(undefined, []), []);
});

test("applyRatingOrder reorders the live list and keeps disconnected providers behind it", () => {
  assert.deepEqual(
    applyRatingOrder(["trakt", "letterboxd", "simkl"], ["trakt", "simkl"], ["simkl", "trakt"]),
    ["simkl", "trakt", "letterboxd"],
  );
});

test("Letterboxd half-stars normalize losslessly to the 1-10 scale", () => {
  assert.equal(normalizeToTen("letterboxd", 4.5), 9);
  assert.equal(normalizeToTen("letterboxd", 3), 6);
  assert.equal(normalizeToTen("letterboxd", 0.5), 1);
  assert.equal(normalizeToTen("letterboxd", 5), 10);
  assert.equal(denormalizeFromTen("letterboxd", 9), 4.5);
  assert.equal(denormalizeFromTen("letterboxd", 6), 3);
  assert.equal(denormalizeFromTen("letterboxd", 1), 0.5);
});

test("Simkl and Trakt scores pass through the 1-10 scale unchanged", () => {
  assert.equal(normalizeToTen("simkl", 8), 8);
  assert.equal(normalizeToTen("trakt", 8), 8);
  assert.equal(denormalizeFromTen("simkl", 8), 8);
  assert.equal(denormalizeFromTen("trakt", 8), 8);
});

// --- Mocked module tests for the Trakt fixes ---------------------------------
// The resolvers and getUserRating live in modules that import React and the
// providers, so load single source files with a mocked require map instead of
// importing them (same harness shape as episode-reviews.test.ts).

function loadModule<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {} as T;
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected import ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}

let tmdbStub: (key: string, imdb: string, type?: "movie" | "series") => Promise<string | null> =
  async () => null;
const tmdbCalls: Array<{ key: string; imdb: string; type?: "movie" | "series" }> = [];

function loadHierarchy() {
  const ids = loadModule<typeof import("../src/lib/trakt/ids")>("src/lib/trakt/ids.ts", {});
  const order = loadModule<typeof import("../src/lib/ratings/hierarchy-order")>(
    "src/lib/ratings/hierarchy-order.ts",
    {},
  );
  return loadModule<typeof import("../src/lib/ratings/hierarchy")>(
    "src/lib/ratings/hierarchy.ts",
    {
      react: React,
      "@/lib/settings": { useSettings: () => ({ settings: {}, update: () => {} }) },
      "@/lib/trakt/provider": { useTrakt: () => ({}) },
      "@/lib/simkl/provider": { useSimkl: () => ({}) },
      "@/lib/stremboxd/provider": { useLetterboxd: () => ({}) },
      "@/lib/trakt/ids": ids,
      "@/lib/simkl/ids": { stremioIdToSimklTarget: () => ({ ok: false }) },
      "@/lib/providers/anime-mapping": { kitsuToMal: async () => null },
      "@/lib/trakt/comments": {
        getUserRating: async () => null,
        rateContent: async () => {},
        removeRating: async () => {},
      },
      "@/lib/simkl/ratings": {
        addSimklRating: async () => false,
        fetchSimklUserRating: async () => null,
        removeSimklRating: async () => false,
      },
      "@/lib/stremboxd/rating": {
        fetchLetterboxdUserRating: async () => ({}),
        submitLetterboxdRating: async () => false,
      },
      "@/lib/providers/tmdb/tmdb-imdb-resolve": {
        tmdbIdFromImdb: (key: string, imdb: string, type?: "movie" | "series") => {
          tmdbCalls.push({ key, imdb, type });
          return tmdbStub(key, imdb, type);
        },
      },
      "./hierarchy-order": order,
    },
  );
}

test("resolveTraktTarget corrects a series or anime IMDb id to a show", () => {
  const { resolveTraktTarget } = loadHierarchy();
  assert.deepEqual(resolveTraktTarget("tt1234567", "series"), {
    kind: "show",
    ids: { imdb: "tt1234567" },
  });
  assert.deepEqual(resolveTraktTarget("tt1234567", "anime"), {
    kind: "show",
    ids: { imdb: "tt1234567" },
  });
  assert.deepEqual(resolveTraktTarget("tt1234567", "movie"), {
    kind: "movie",
    ids: { imdb: "tt1234567" },
  });
});

test("resolveTraktTarget trusts mediaType over the id shape for tmdb ids", () => {
  const { resolveTraktTarget } = loadHierarchy();
  assert.deepEqual(resolveTraktTarget("tmdb:tv:123", "series"), {
    kind: "show",
    ids: { tmdb: 123 },
  });
  assert.deepEqual(resolveTraktTarget("tmdb:tv:123", "movie"), {
    kind: "movie",
    ids: { tmdb: 123 },
  });
  assert.deepEqual(resolveTraktTarget("tmdb:movie:456", "series"), {
    kind: "show",
    ids: { tmdb: 456 },
  });
});

test("resolveTraktTarget still excludes episode targets and unknown ids", () => {
  const { resolveTraktTarget } = loadHierarchy();
  assert.equal(resolveTraktTarget("tt1234567:1:2", "series"), null);
  assert.equal(resolveTraktTarget("kitsu:123", "anime"), null);
  assert.equal(resolveTraktTarget("garbage", "movie"), null);
});

test("resolveTraktTargetForWrite keeps a series tv fallback as a show", async () => {
  const { resolveTraktTargetForWrite } = loadHierarchy();
  tmdbCalls.length = 0;
  tmdbStub = async (_key, _imdb, type) => {
    assert.equal(type, "series");
    return "tmdb:tv:111";
  };
  assert.deepEqual(await resolveTraktTargetForWrite("tt1234567", "series", "tmdb-key"), {
    kind: "show",
    ids: { tmdb: 111 },
  });
  assert.equal(tmdbCalls.length, 1);
});

test("resolveTraktTargetForWrite respects the movie/tv part of the resolved id", async () => {
  const { resolveTraktTargetForWrite } = loadHierarchy();
  tmdbStub = async () => "tmdb:movie:222";
  assert.deepEqual(await resolveTraktTargetForWrite("tt1234567", "series", "tmdb-key"), {
    kind: "movie",
    ids: { tmdb: 222 },
  });
  tmdbStub = async () => "tmdb:tv:999";
  assert.deepEqual(await resolveTraktTargetForWrite("tt1234567", "movie", "tmdb-key"), {
    kind: "show",
    ids: { tmdb: 999 },
  });
});

test("resolveTraktTargetForWrite returns a TMDB target without resolving", async () => {
  const { resolveTraktTargetForWrite } = loadHierarchy();
  tmdbCalls.length = 0;
  assert.deepEqual(await resolveTraktTargetForWrite("tmdb:tv:123", "series", "tmdb-key"), {
    kind: "show",
    ids: { tmdb: 123 },
  });
  assert.equal(tmdbCalls.length, 0);
});

test("resolveTraktTargetForWrite returns null when the id cannot resolve", async () => {
  const { resolveTraktTargetForWrite } = loadHierarchy();
  tmdbStub = async () => null;
  assert.equal(await resolveTraktTargetForWrite("tt1234567", "series", "tmdb-key"), null);
  assert.equal(await resolveTraktTargetForWrite("tt1234567", "series", ""), null);
  assert.equal(await resolveTraktTargetForWrite("tt1234567:1:2", "series", "tmdb-key"), null);
});

let sessionStub: { accessToken: string } | null = { accessToken: "test-token" };

function loadComments() {
  return loadModule<typeof import("../src/lib/trakt/comments")>("src/lib/trakt/comments.ts", {
    "./client": {
      traktRequest: async () => {
        throw new Error("unused in these tests");
      },
    },
    "./config": { TRAKT_API_BASE: "https://api.trakt.test", TRAKT_CLIENT_ID: "test-client-id" },
    "./session": { getSession: () => sessionStub },
  });
}

test("getUserRating returns the matching title's rating, never another title's", async () => {
  const { getUserRating } = loadComments();
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return {
      status: 200,
      json: async () => [
        { rating: 7, show: { ids: { imdb: "tt9999999", tmdb: 1 } } },
        { rating: 9, show: { ids: { imdb: "tt1234567", tmdb: 2 } } },
      ],
    };
  }) as unknown as typeof fetch;
  try {
    sessionStub = { accessToken: "test-token" };
    assert.equal(await getUserRating({ kind: "show", ids: { imdb: "tt1234567" } }), 9);
    assert.equal(urls[0], "https://api.trakt.test/sync/ratings/shows?imdb=tt1234567");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUserRating matches by TMDB id for movies and returns null when absent", async () => {
  const { getUserRating } = loadComments();
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return {
      status: 200,
      json: async () => [
        { rating: 5, movie: { ids: { tmdb: 111 } } },
        { rating: 8, movie: { ids: { tmdb: 456, imdb: "tt0000001" } } },
      ],
    };
  }) as unknown as typeof fetch;
  try {
    sessionStub = { accessToken: "test-token" };
    assert.equal(await getUserRating({ kind: "movie", ids: { tmdb: 456 } }), 8);
    assert.equal(urls[0], "https://api.trakt.test/sync/ratings/movies?tmdb=456");
    // No entry for this title: null, not the first entry's rating.
    assert.equal(await getUserRating({ kind: "movie", ids: { tmdb: 789 } }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUserRating does not match on IMDb when the TMDB ids disagree", async () => {
  const { getUserRating } = loadComments();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200,
    json: async () => [{ rating: 6, movie: { ids: { tmdb: 789, imdb: "tt0000001" } } }],
  })) as unknown as typeof fetch;
  try {
    sessionStub = { accessToken: "test-token" };
    assert.equal(
      await getUserRating({ kind: "movie", ids: { tmdb: 456, imdb: "tt0000001" } }),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getUserRating returns null without a session or on a failed request", async () => {
  const { getUserRating } = loadComments();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      status: 200,
      json: async () => [{ rating: 10, movie: { ids: { tmdb: 456 } } }],
    };
  }) as unknown as typeof fetch;
  try {
    sessionStub = null;
    assert.equal(await getUserRating({ kind: "movie", ids: { tmdb: 456 } }), null);
    assert.equal(calls, 0);
    sessionStub = { accessToken: "test-token" };
    globalThis.fetch = (async () => ({
      status: 500,
      json: async () => [],
    })) as unknown as typeof fetch;
    assert.equal(await getUserRating({ kind: "movie", ids: { tmdb: 456 } }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
