/**
 * Profdictor registry configuration.
 *
 * The extension is fully usable with none of this filled in: scanning,
 * prediction, the fuzzy prof lookup and locally saved corrections all work
 * offline. The registry only adds three things:
 *
 *   1. one-time access hashes (gating who can install it),
 *   2. the shared verified-professor database (one mod's correction reaches
 *      everyone),
 *   3. moderator authentication.
 *
 * Leave REQUIRE_ACCESS_GATE false while testing so you are not locked out of
 * your own build. Deploy `worker/worker.js`, paste the URL below, then flip it.
 */

/** Base URL of the deployed Worker, no trailing slash. Empty = local-only mode. */
const PROFDICTOR_REGISTRY_URL = "";

/** Must match the Worker's CLAIM_KEY secret. */
const PROFDICTOR_REGISTRY_KEY = "";

/** When true, the popup stays locked until a valid one-time hash is redeemed. */
const PROFDICTOR_REQUIRE_ACCESS_GATE = false;

/**
 * Optional offline moderator hashes: SHA-256 hex of each admin passphrase.
 * Lets you use the moderator page before the Worker exists. Generate with:
 *   node tools/make-hash.mjs "your passphrase"
 */
const PROFDICTOR_LOCAL_ADMIN_HASHES = [];

function getRegistryConfig() {
  return {
    url: String(PROFDICTOR_REGISTRY_URL || "").replace(/\/+$/, ""),
    key: String(PROFDICTOR_REGISTRY_KEY || "").trim(),
    requireGate: !!PROFDICTOR_REQUIRE_ACCESS_GATE,
    localAdminHashes: PROFDICTOR_LOCAL_ADMIN_HASHES.slice(),
  };
}

if (typeof self !== "undefined") {
  self.PROFDICTOR_REGISTRY_URL = PROFDICTOR_REGISTRY_URL;
  self.PROFDICTOR_REGISTRY_KEY = PROFDICTOR_REGISTRY_KEY;
  self.PROFDICTOR_REQUIRE_ACCESS_GATE = PROFDICTOR_REQUIRE_ACCESS_GATE;
  self.PROFDICTOR_LOCAL_ADMIN_HASHES = PROFDICTOR_LOCAL_ADMIN_HASHES;
  self.getRegistryConfig = getRegistryConfig;
}
