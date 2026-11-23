import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { seatBuildCacheEnv, sharedCacheDir } from "../../lib/seat-cache.mjs";

test("seat build cache defaults to one per-project cargo target and shared cache", () => {
  const home = "/tmp/trantor-home";
  const cache = sharedCacheDir("trantor", home);
  assert.equal(seatBuildCacheEnv({}, "trantor", home).CARGO_TARGET_DIR, join(cache, "cargo-target"));
  assert.equal(seatBuildCacheEnv({}, "trantor", home).TRANTOR_SHARED_CACHE, cache);
});

test("operator CARGO_TARGET_DIR override wins", () => {
  const env = seatBuildCacheEnv({ CARGO_TARGET_DIR: "/mnt/rust-cache" }, "trantor", "/tmp/home");
  assert.equal(env.CARGO_TARGET_DIR, "/mnt/rust-cache");
});
