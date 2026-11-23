// @ts-expect-error Node tests are outside the browser tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node tests are outside the browser tsconfig.
import test from "node:test";
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
