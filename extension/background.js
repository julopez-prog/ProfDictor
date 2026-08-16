/**
 * Profdictor service worker.
 *
 * Thin router, on purpose. The heavy work (scanning, modelling) happens in the
 * content script where the AMIS session lives; this file handles injection,
 * the access gate, moderator auth, and talking to the shared registry.
 */

importScripts("access-codes.js");

const ACCESS_SESSION_KEY = "profdictor.access.session";
const ADMIN_SESSION_KEY = "profdictor.admin.session";
const SYNC_META_KEY = "profdictor.sync.meta";
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

const AMIS_URL = /^https?:\/\/([a-z0-9-]+\.)*uplb\.edu\.ph\//i;

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function registry() {
  return self.getRegistryConfig();
}

async function registryFetch(path, { method = "GET", body } = {}) {
  const cfg = registry();
  if (!cfg.url) return { ok: false, error: "registry_not_configured" };
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (cfg.key) headers["x-profdictor-key"] = cfg.key;
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, error: data?.error || `http_${res.status}`, status: res.status, data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: "registry_unreachable", detail: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

const CONTENT_FILES = [
  "lib/terms.js",
  "lib/names.js",
  "lib/forest.js",
  "lib/features.js",
  "lib/predict.js",
  "lib/db.js",
  "scanner.js",
  "content.js",
];

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: false }, files: ["panel.css"] });
  } catch (err) {
    console.warn("[Profdictor] CSS inject:", err?.message || err);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: CONTENT_FILES,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function sendToTab(tabId, payload, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, payload);
      if (res !== undefined) return res;
    } catch (_) {
      /* content script may still be booting */
    }
    await new Promise((r) => setTimeout(r, 90));
  }
  return { ok: false, error: "no_response_from_tab" };
}

async function activeAmisTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "No active tab." };
  if (!tab.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
    return { error: "Open https://amis.uplb.edu.ph/student/enrollment first." };
  }
  return { tab, isAmis: AMIS_URL.test(tab.url) };
}

/* ------------------------------------------------------------------ *
 * Access gate
 * ------------------------------------------------------------------ */

async function getAccessSession() {
  const cfg = registry();
  if (!cfg.requireGate) {
    return { unlocked: true, username: "local", reason: "gate_disabled" };
  }
  const got = await chrome.storage.local.get(ACCESS_SESSION_KEY);
  const session = got?.[ACCESS_SESSION_KEY];
  return session?.unlocked ? session : { unlocked: false };
}

async function redeemAccessCode(username, code) {
  const user = String(username || "").trim();
  const hash = String(code || "").trim();
  if (user.length < 2) return { ok: false, error: "username_required" };
  if (hash.length < 8) return { ok: false, error: "code_required" };

  const existing = await getAccessSession();
  if (existing.unlocked) return { ok: true, already: true, username: existing.username };

  const res = await registryFetch("/claim", { method: "POST", body: { code: hash, username: user } });
  if (!res.ok) return { ok: false, error: res.error };

  const session = {
    unlocked: true,
    username: user,
    at: Date.now(),
    codeHint: hash.slice(0, 4),
  };
  await chrome.storage.local.set({ [ACCESS_SESSION_KEY]: session });
  return { ok: true, username: user };
}

/* ------------------------------------------------------------------ *
 * Moderator auth
 *
 * The hash is typed into the TERM field in the popup. A four-digit value is a
 * term; anything longer is treated as a possible moderator hash. Verified
 * remotely when a registry is configured, otherwise against local SHA-256
 * hashes so the moderator page is usable before any deployment exists.
 * ------------------------------------------------------------------ */

async function getAdminSession() {
  const got = await chrome.storage.local.get(ADMIN_SESSION_KEY);
  const session = got?.[ADMIN_SESSION_KEY];
  if (!session?.isAdmin) return { isAdmin: false };
  if (Date.now() - session.at > ADMIN_SESSION_MS) {
    await chrome.storage.local.remove(ADMIN_SESSION_KEY);
    return { isAdmin: false, expired: true };
  }
  return session;
}

async function verifyAdminHash(code) {
  const raw = String(code || "").trim();
  if (raw.length < 8) return { ok: false, error: "hash_too_short" };

  const cfg = registry();
  const digest = await sha256Hex(raw);

  if (cfg.localAdminHashes.includes(digest) || cfg.localAdminHashes.includes(raw)) {
    const session = { isAdmin: true, at: Date.now(), via: "local", name: "local-mod" };
    await chrome.storage.local.set({ [ADMIN_SESSION_KEY]: session });
    return { ok: true, session };
  }

  if (!cfg.url) return { ok: false, error: "not_admin" };

  const res = await registryFetch("/admin/verify", { method: "POST", body: { code: raw } });
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.data?.ok) return { ok: false, error: res.data?.error || "not_admin" };

  const session = {
    isAdmin: true,
    at: Date.now(),
    via: "registry",
    name: res.data.name || "moderator",
    token: res.data.token || "",
  };
  await chrome.storage.local.set({ [ADMIN_SESSION_KEY]: session });
  return { ok: true, session };
}

async function openModerator() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("moderator.html") });
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Shared verified-professor registry
 * ------------------------------------------------------------------ */

async function pullVerified(courseCode) {
  const query = courseCode ? `?course=${encodeURIComponent(courseCode)}` : "";
  const res = await registryFetch(`/verified${query}`);
  if (!res.ok) return res;
  const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
  await chrome.storage.local.set({ [SYNC_META_KEY]: { at: Date.now(), count: rows.length } });
  return { ok: true, rows };
}

async function pushVerified(entries) {
  const session = await getAdminSession();
  if (!session.isAdmin) return { ok: false, error: "not_admin" };
  return registryFetch("/verified", {
    method: "POST",
    body: { rows: entries, token: session.token || "", by: session.name || "moderator" },
  });
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

const HANDLERS = {
  async PING_BG() {
    const access = await getAccessSession();
    const admin = await getAdminSession();
    const cfg = registry();
    return {
      ok: true,
      version: chrome.runtime.getManifest().version,
      access,
      admin: { isAdmin: !!admin.isAdmin, name: admin.name || "" },
      registryConfigured: !!cfg.url,
      gateRequired: cfg.requireGate,
    };
  },

  async INJECT_INTO_ACTIVE_TAB() {
    const { tab, error, isAmis } = await activeAmisTab();
    if (error) return { ok: false, error };
    const res = await injectIntoTab(tab.id);
    return { ...res, tabId: tab.id, url: tab.url, isAmis };
  },

  async FORWARD_TO_TAB(msg) {
    const access = await getAccessSession();
    if (!access.unlocked) return { ok: false, error: "access_locked" };
    const { tab, error } = await activeAmisTab();
    if (error) return { ok: false, error };
    const injected = await injectIntoTab(tab.id);
    if (!injected.ok) return injected;
    return sendToTab(tab.id, msg.payload);
  },

  GET_ACCESS_SESSION: () => getAccessSession().then((s) => ({ ok: true, ...s })),
  REDEEM_ACCESS_CODE: (msg) => redeemAccessCode(msg.username, msg.code),

  GET_ADMIN_SESSION: () => getAdminSession().then((s) => ({ ok: true, ...s })),
  VERIFY_ADMIN_HASH: (msg) => verifyAdminHash(msg.code),
  OPEN_MODERATOR: () => openModerator(),
  async ADMIN_LOGOUT() {
    await chrome.storage.local.remove(ADMIN_SESSION_KEY);
    return { ok: true };
  },

  PULL_VERIFIED: (msg) => pullVerified(msg.courseCode),
  PUSH_VERIFIED: (msg) => pushVerified(msg.entries),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Profdictor] installed", chrome.runtime.getManifest().version);
});
