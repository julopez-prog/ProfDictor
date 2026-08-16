/**
 * Self-test for the page bridge's endpoint discovery.
 *
 * The bug this guards against is the one that shipped: a hard-coded endpoint and
 * parameter names that did not match the live deployment, so every term returned
 * nothing and the extension blamed the course code.
 *
 * The bridge is written for the page context, so it runs here inside a `vm`
 * sandbox whose `window` is the global object, exactly as in a browser. Three
 * fake AMIS deployments exercise the three discovery routes: learned from
 * recorded traffic, probed by path, and probed with no usable course filter.
 *
 * Run: node tools/selftest-bridge.mjs
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "extension", "page-bridge.js"), "utf8");

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}
function section(name) {
  console.log(`\n== ${name} ==`);
}

/* -------------------------------------------------------------------- *
 * Fake AMIS deployments
 * -------------------------------------------------------------------- */

const ROWS = [
  { id: 1, course_code: "PI 10", section: "S1", term_id: 1261, instructor: "DELA CRUZ, JUAN P." },
  { id: 2, course_code: "PI 10", section: "S2", term_id: 1261, instructor: "REYES, ANA M." },
  { id: 3, course_code: "HUM 1", section: "S1", term_id: 1261, instructor: "SANTOS, PEDRO L." },
];

/** Terms this fake registrar has offerings for. Anything else is empty. */
const REAL_TERMS = [1231, 1241, 1251, 1261];

/**
 * Rows for one term, or the whole catalogue when the term parameter was not
 * recognised - which is how a real API behaves when handed a parameter name it
 * does not know, and the case discovery has to detect.
 */
function rowsFor(termId, code) {
  if (termId != null && !REAL_TERMS.includes(Number(termId))) return [];
  const term = Number(termId) || 1261;
  return ROWS.filter((r) => !code || r.course_code.toUpperCase() === String(code).toUpperCase()).map((r) => ({
    ...r,
    term_id: term,
  }));
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? "Not Found" : "OK",
  text: async () => JSON.stringify(body),
  clone() {
    return this;
  },
});

/** Laravel-ish: students/classes, term_id + course_code, both honoured. */
function deploymentStandard(url) {
  const u = new URL(url);
  if (!u.pathname.endsWith("/api/students/classes")) return json({ message: "Not Found" }, 404);
  const data = rowsFor(u.searchParams.get("term_id"), u.searchParams.get("course_code"));
  return json({ classes: { data, last_page: 1, current_page: 1, total: data.length } });
}

/** Renamed path, renamed term param, and no course filtering at all. */
function deploymentRenamed(url) {
  const u = new URL(url);
  if (!u.pathname.endsWith("/api/class-offerings")) return json({ message: "Not Found" }, 404);
  const data = rowsFor(u.searchParams.get("academic_term_id"), null);
  return json({ data, meta: { last_page: 1, total: data.length } });
}

/** Nothing guessable: only a versioned path with bespoke parameter names. */
function deploymentExotic(url) {
  const u = new URL(url);
  if (!u.pathname.endsWith("/api/v2/enlistment/class-list")) return json({ message: "Not Found" }, 404);
  const data = rowsFor(u.searchParams.get("ay_term"), u.searchParams.get("subject"));
  return json({ payload: { items: data }, page_info: { total_pages: 1, total: data.length } });
}

/* -------------------------------------------------------------------- *
 * Sandbox
 * -------------------------------------------------------------------- */

function makeBridge(handler) {
  const calls = [];
  const ctx = createContext({});
  ctx.console = console;
  ctx.URL = URL;
  ctx.setTimeout = setTimeout;
  ctx.location = {
    origin: "https://amis.uplb.edu.ph",
    href: "https://amis.uplb.edu.ph/student/enrollment",
  };
  ctx.document = {
    cookie: "",
    querySelectorAll: () => [],
    getElementById: () => null,
    body: { innerText: "" },
  };
  ctx.$nuxt = undefined; // no axios: force the credentialed-fetch path
  ctx.XMLHttpRequest = undefined;

  ctx.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };

  const listeners = [];
  const replies = new Map();
  ctx.addEventListener = (type, fn) => {
    if (type === "message") listeners.push(fn);
  };
  ctx.postMessage = (data) => {
    if (data?.id && data.id !== "ready") replies.set(data.id, data);
  };

  // `window` has to be the sandbox's own global object, not the host-side
  // context: the bridge ignores any message whose `source` is not `window`, and
  // the two are different objects across the vm boundary.
  runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", ctx);
  const innerWindow = runInContext("globalThis", ctx);

  runInContext(source, ctx);

  let seq = 0;
  const request = (type, payload) => {
    const id = `t${(seq += 1)}`;
    for (const fn of listeners) {
      fn({ source: innerWindow, data: { source: "PROFDICTOR_REQ", id, type, payload } });
    }
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (replies.has(id)) return resolve(replies.get(id));
        if (Date.now() - started > 5000) return reject(new Error(`bridge timeout on ${type}`));
        return setTimeout(poll, 5);
      };
      poll();
    });
  };

  return { ctx, request, calls };
}

/* -------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------- */

section("probe: standard deployment");
{
  const { request, calls } = makeBridge(deploymentStandard);
  const found = await request("DISCOVER", { courseCode: "PI 10", termId: 1261 });
  check("discovery succeeds", found.ok === true, found.error);
  check("finds the path", found.recipe?.path === "students/classes", found.recipe?.path);
  check("finds the term param", found.recipe?.termParam === "term_id", found.recipe?.termParam);
  check("finds the course param", found.recipe?.courseParam === "course_code", found.recipe?.courseParam);
  check("probing stayed cheap", calls.length <= 12, calls.length);

  const fetched = await request("FETCH_TERM", { courseCode: "PI 10", termId: 1251, recipe: found.recipe });
  check("fetch returns rows", fetched.classes?.length === 2, fetched.classes?.length);
  check("term filter honoured", fetched.termHonoured === true, fetched.termHonoured);
  check("rows carry the requested term", fetched.classes?.every((r) => r.term_id === 1251), fetched.classes);
}

section("probe: renamed path, renamed term param, no course filter");
{
  const { request } = makeBridge(deploymentRenamed);
  const found = await request("DISCOVER", { courseCode: "PI 10", termId: 1261 });
  check("discovery succeeds", found.ok === true, found.error);
  check("finds the renamed path", found.recipe?.path === "class-offerings", found.recipe?.path);
  check("finds the renamed term param", found.recipe?.termParam === "academic_term_id", found.recipe?.termParam);
  check(
    "gives up on a course param rather than inventing one",
    found.recipe?.courseParam === "",
    found.recipe?.courseParam
  );

  // Unfiltered means every subject comes back; the scanner filters by code.
  const fetched = await request("FETCH_TERM", { courseCode: "PI 10", termId: 1261, recipe: found.recipe });
  check("returns the whole term", fetched.classes?.length === 3, fetched.classes?.length);
}

section("learn from the app's own traffic");
{
  const { ctx, request } = makeBridge(deploymentExotic);
  // Nothing about this deployment is guessable, so simulate the page loading its
  // own class list first - which is what the recorder exists to catch.
  await ctx.fetch(
    "https://api-amis.uplb.edu.ph/api/v2/enlistment/class-list?ay_term=1261&subject=PI%2010&page=1&per_page=1000&status=Active"
  );
  await new Promise((r) => setTimeout(r, 20)); // let the response hook settle

  const diag = await request("DIAG", { courseCode: "PI 10" });
  check("recorded the call", diag.recorded?.length === 1, diag.recorded);
  check("recognised it as classes", diag.recorded?.[0]?.looksLikeClasses === true, diag.recorded?.[0]);

  const learned = diag.learnedRecipe;
  check("learned the path", learned?.path === "v2/enlistment/class-list", learned?.path);
  check("kept the API root as the base", learned?.base === "https://api-amis.uplb.edu.ph/api", learned?.base);
  check("learned the term param by value", learned?.termParam === "ay_term", learned?.termParam);
  check("learned the course param by value", learned?.courseParam === "subject", learned?.courseParam);
  check("learned pagination", learned?.perPageParam === "per_page", learned?.perPageParam);
  check("kept status as a constant", learned?.extra?.status === "Active", learned?.extra);
  check(
    "did not pin the course code into the recipe",
    !Object.values(learned?.extra || {}).some((v) => String(v).toUpperCase() === "PI 10"),
    learned?.extra
  );
  check(
    "did not mistake per_page=1000 for the term",
    learned?.termParam !== "per_page",
    learned?.termParam
  );

  const found = await request("DISCOVER", { courseCode: "PI 10", termId: 1261 });
  check("discovery prefers what it learned", found.recipe?.via === "learned", found.recipe?.via);

  const fetched = await request("FETCH_TERM", { courseCode: "PI 10", termId: 1241, recipe: found.recipe });
  check("replays it against another term", fetched.classes?.length === 2, fetched.classes?.length);
  check("rows follow the new term", fetched.classes?.[0]?.term_id === 1241, fetched.classes?.[0]);
}

section("SET_TERM from page context");
{
  const { request } = makeBridge(deploymentStandard);
  const set = await request("SET_TERM", { termId: 1241 });
  check("SET_TERM answers", set.ok === false && set.current == null, set);
  check("reports whether Vue/store were touched", set.vueTouched === false && set.storeTouched === false, set);
}

section("dead end reports itself");
{
  const { request } = makeBridge(() => json({ message: "Unauthenticated." }, 401));
  const found = await request("DISCOVER", { courseCode: "PI 10", termId: 1261 });
  check("discovery fails cleanly", found.ok === false, found);
  check("names the reason", found.error === "no_endpoint", found.error);
  check("reports what it tried", (found.attempts || []).length >= 8, found.attempts?.length);
  check("keeps the HTTP status", found.attempts?.[0]?.status === 401, found.attempts?.[0]);
}

section("term filter silently ignored");
{
  // The nastiest failure: rows come back, but for the wrong semester. Training on
  // these would leak the present into the past.
  const { request } = makeBridge((url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith("/api/students/classes")) return json({ message: "Not Found" }, 404);
    return json({ data: ROWS }); // always term 1261, whatever was asked
  });
  const fetched = await request("FETCH_TERM", {
    courseCode: "PI 10",
    termId: 1241,
    recipe: { path: "students/classes", termParam: "term_id", courseParam: "", pageParam: "page", perPageParam: "per_page", extra: {} },
  });
  check("rows are returned", fetched.classes?.length === 3, fetched.classes?.length);
  check("but flagged as the wrong term", fetched.termHonoured === false, fetched.termHonoured);
  check("counts the offending rows", fetched.wrongTerm === 3, fetched.wrongTerm);
}

console.log(`\n${failed ? "FAILURES" : "ALL CHECKS PASSED"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
