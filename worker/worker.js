/**
 * Profdictor registry Worker.
 *
 * Three jobs:
 *   1. /claim         burn one-time access hashes globally (KV is the authority,
 *                     so a hash cannot be reused on another browser or PC).
 *   2. /admin/verify  authenticate moderators and hand out a short-lived token.
 *   3. /verified      the shared ground-truth database of real professors, so
 *                     one moderator's correction reaches every user.
 *
 * KV layout (single namespace, prefixed keys):
 *   valid:<sha256>            -> "1"                 access hash not yet used
 *   burn:<sha256>             -> {username, at}      access hash consumed
 *   admin:<sha256>            -> {name}              moderator credential
 *   token:<random>            -> {name, exp}         moderator session
 *   ver:<COURSE>|<term>|<SEC> -> {instructor, by, at}
 *
 * Hashes are stored as SHA-256 of the passphrase, never the passphrase itself.
 */

const TOKEN_TTL_SECONDS = 8 * 60 * 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-profdictor-key",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Accept either a raw passphrase or an already-hashed hex string. */
async function normalizeHash(code) {
  const raw = String(code || "").trim();
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  return sha256Hex(raw);
}

function authorised(request, env) {
  if (!env.CLAIM_KEY) return true; // no key configured = open registry
  return request.headers.get("x-profdictor-key") === env.CLAIM_KEY;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

function verifiedKey(courseCode, term, section) {
  const course = String(courseCode || "").toUpperCase().replace(/\s+/g, " ").trim();
  const sec = String(section || "").toUpperCase().trim();
  return `ver:${course}|${Number(term)}|${sec}`;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handleClaim(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  const username = String(body.username || "").trim();
  if (username.length < 2) return json({ ok: false, error: "username_required" }, 400);
  if (!body.code) return json({ ok: false, error: "code_required" }, 400);

  const hash = await normalizeHash(body.code);

  const burned = await env.PD_KV.get(`burn:${hash}`);
  if (burned) return json({ ok: false, error: "code_already_used" }, 409);

  const valid = await env.PD_KV.get(`valid:${hash}`);
  if (!valid) return json({ ok: false, error: "invalid_code" }, 400);

  await env.PD_KV.put(`burn:${hash}`, JSON.stringify({ username, at: Date.now() }));
  await env.PD_KV.delete(`valid:${hash}`);

  return json({ ok: true, username, burned: true });
}

async function handleAdminVerify(request, env) {
  const body = await readJson(request);
  if (!body?.code) return json({ ok: false, error: "code_required" }, 400);

  const hash = await normalizeHash(body.code);
  const record = await env.PD_KV.get(`admin:${hash}`, { type: "json" });
  if (!record) return json({ ok: false, error: "not_admin" }, 403);

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.PD_KV.put(
    `token:${token}`,
    JSON.stringify({ name: record.name || "moderator", exp: Date.now() + TOKEN_TTL_SECONDS * 1000 }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

  return json({ ok: true, name: record.name || "moderator", token });
}

async function requireToken(env, token) {
  if (!token) return null;
  const session = await env.PD_KV.get(`token:${token}`, { type: "json" });
  if (!session || session.exp < Date.now()) return null;
  return session;
}

async function handleGetVerified(request, env) {
  const url = new URL(request.url);
  const course = url.searchParams.get("course");
  const prefix = course
    ? `ver:${course.toUpperCase().replace(/\s+/g, " ").trim()}|`
    : "ver:";

  const rows = [];
  let cursor;
  // KV list is paginated; walk it so a large registry still returns fully.
  do {
    const page = await env.PD_KV.list({ prefix, cursor, limit: 1000 });
    for (const key of page.keys) {
      const value = await env.PD_KV.get(key.name, { type: "json" });
      if (!value) continue;
      const [courseCode, term, section] = key.name.slice(4).split("|");
      rows.push({
        courseCode,
        term: Number(term),
        section,
        instructor: value.instructor,
        by: value.by || "",
        at: value.at || 0,
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  return json({ ok: true, rows, count: rows.length });
}

async function handlePostVerified(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  const session = await requireToken(env, body.token);
  if (!session) return json({ ok: false, error: "not_admin" }, 403);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ ok: false, error: "no_rows" }, 400);
  if (rows.length > 500) return json({ ok: false, error: "too_many_rows" }, 413);

  let written = 0;
  for (const row of rows) {
    const instructor = String(row.instructor || "").trim();
    if (!row.courseCode || !row.term || !row.section || !instructor) continue;
    const key = verifiedKey(row.courseCode, row.term, row.section);
    const existing = await env.PD_KV.get(key, { type: "json" });
    const at = Number(row.at || Date.now());
    if (existing && Number(existing.at || 0) >= at) continue; // keep the newer record
    await env.PD_KV.put(
      key,
      JSON.stringify({ instructor, by: body.by || session.name || "moderator", at })
    );
    written += 1;
  }

  return json({ ok: true, written, received: rows.length });
}

/**
 * Load access hashes or moderator credentials.
 * Protected by CLAIM_KEY - this is an admin-only maintenance endpoint.
 */
async function handleSeed(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);

  let access = 0;
  let admins = 0;

  for (const code of body.accessCodes || []) {
    await env.PD_KV.put(`valid:${await normalizeHash(code)}`, "1");
    access += 1;
  }
  for (const entry of body.admins || []) {
    const code = typeof entry === "string" ? entry : entry.code;
    const name = typeof entry === "string" ? "moderator" : entry.name || "moderator";
    if (!code) continue;
    await env.PD_KV.put(`admin:${await normalizeHash(code)}`, JSON.stringify({ name }));
    admins += 1;
  }

  return json({ ok: true, access, admins });
}

async function handleStats(env) {
  const count = async (prefix) => {
    let total = 0;
    let cursor;
    do {
      const page = await env.PD_KV.list({ prefix, cursor, limit: 1000 });
      total += page.keys.length;
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return total;
  };
  return json({
    ok: true,
    unusedAccessCodes: await count("valid:"),
    burnedAccessCodes: await count("burn:"),
    moderators: await count("admin:"),
    verifiedRows: await count("ver:"),
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.PD_KV) return json({ ok: false, error: "kv_not_bound" }, 500);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (!authorised(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

    try {
      if (path === "/claim" && request.method === "POST") return handleClaim(request, env);
      if (path === "/admin/verify" && request.method === "POST") return handleAdminVerify(request, env);
      if (path === "/verified" && request.method === "GET") return handleGetVerified(request, env);
      if (path === "/verified" && request.method === "POST") return handlePostVerified(request, env);
      if (path === "/admin/seed" && request.method === "POST") return handleSeed(request, env);
      if (path === "/stats" && request.method === "GET") return handleStats(env);
      if (path === "/") return json({ ok: true, service: "profdictor-registry" });
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      return json({ ok: false, error: "internal_error", detail: String(err?.message || err) }, 500);
    }
  },
};
