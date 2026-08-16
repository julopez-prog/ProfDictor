/**
 * Profdictor integration self-test.
 *
 * Runs the real pipeline end to end against a mocked chrome.storage:
 *   fake API payloads -> scanner.extractRecords -> db.putTerm
 *   -> db.allRecords (with verified overrides) -> predict.run
 *
 * The important assertion is the leakage check: when the predicted term already
 * has published instructors, the model must not be allowed to see them. A
 * professor who appears only in the target term must never be ranked first,
 * because from the model's vantage point they do not exist yet.
 *
 *   node tools/selftest-integration.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(here, "..", "extension");

/* ------------------------------------------------ mock chrome.storage.local */
const store = new Map();
globalThis.self = globalThis;
globalThis.window = { addEventListener() {}, postMessage() {} };
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
globalThis.chrome = {
  runtime: { getURL: (p) => p },
  storage: {
    local: {
      async get(key) {
        if (key == null) return Object.fromEntries(store);
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
      },
    },
  },
};

for (const file of [
  "lib/terms.js",
  "lib/names.js",
  "lib/forest.js",
  "lib/features.js",
  "lib/predict.js",
  "lib/db.js",
  "scanner.js",
]) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(extRoot, file), "utf8"));
}

const { PD } = globalThis;
let failures = 0;
const lines = [];
const check = (name, cond, detail = "") => {
  if (cond) lines.push(`  PASS  ${name}`);
  else {
    failures += 1;
    lines.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};
const heading = (t) => lines.push(`\n== ${t} ==`);

/* ------------------------------------------------ synthetic AMIS payloads */

const SLOTS = {
  S1: { day: "T TH", start_time: "7:00 AM", end_time: "8:00 AM", room: "SMA LH" },
  S2: { day: "T TH", start_time: "8:00 AM", end_time: "9:00 AM", room: "SMA LH" },
  S3: { day: "W F", start_time: "10:00 AM", end_time: "11:00 AM", room: "CAS 104" },
  S4: { day: "W F", start_time: "1:00 PM", end_time: "2:00 PM", room: "EAA LH" },
};

const STABLE = {
  S1: "DELA CRUZ, JUAN P.",
  S2: "REYES, ANA M.",
  S3: "RECALDE, MARIA T.",
  S4: "VILLANUEVA, JOSE R.",
};

/** Mimics the nested shape the AMIS API is most likely to return. */
function apiPayload(term, { reveal = true, overrides = {} } = {}) {
  return Object.entries(SLOTS).map(([section, slot], i) => {
    const who = overrides[section] ?? STABLE[section];
    const instructor = reveal ? who : "TBA";
    return {
      id: term * 100 + i,
      course: { course_code: "ARTS 1", title: "Art Appreciation" },
      section,
      faculty: instructor === "TBA" ? null : { name: instructor },
      instructor: instructor === "TBA" ? "TBA" : undefined,
      schedules: [slot],
      class_status: "Open",
    };
  });
}

const HISTORY = [1231, 1232, 1233, 1241, 1242, 1243, 1251, 1252, 1253];

/* ------------------------------------------------ ingest */
heading("ingest via extractRecords -> db.putTerm");

for (const term of HISTORY) {
  const { records, fieldReport } = PD.scanner.extractRecords(apiPayload(term), "ARTS 1", term);
  if (term === 1231) {
    check("nested faculty.name resolved on ingest", records[0].instructor === STABLE.S1, records[0].instructor);
    check("schedule pulled from schedules[0]", records[0].days === "T TH" && records[0].timeStart === "7:00 AM", JSON.stringify(records[0]));
    check("field report notes the faculty path", Object.keys(fieldReport.instructorPaths).length > 0, JSON.stringify(fieldReport.instructorPaths));
  }
  const saved = await PD.db.putTerm("ARTS 1", term, records);
  if (term === 1231) {
    check("4 rows stored, 4 revealed", saved.total === 4 && saved.revealed === 4, JSON.stringify(saved));
  }
}

const tbaTerm = PD.scanner.extractRecords(apiPayload(1261, { reveal: false }), "ARTS 1", 1261);
const savedTba = await PD.db.putTerm("ARTS 1", 1261, tbaTerm.records);
check("TBA term stores rows with zero revealed", savedTba.total === 4 && savedTba.revealed === 0, JSON.stringify(savedTba));

const coTaught = await PD.db.putTerm("CO 1", 1221, [
  { term: 1221, courseCode: "CO 1", section: "S1", instructor: "DELA CRUZ, JUAN P. AND REYES, ANA M.", days: "T TH" },
  { term: 1221, courseCode: "CO 1", section: "S1", instructor: "DELA CRUZ, JUAN P." },
]);
check(
  '"AND" instructors become separate votes',
  coTaught.total === 2 && coTaught.revealed === 2 &&
    coTaught.records.map((r) => r.instructor).sort().join("|") === "DELA CRUZ, JUAN P.|REYES, ANA M.",
  JSON.stringify(coTaught.records)
);
await PD.db.clearCourse("CO 1");

/* ------------------------------------------------ caching */
heading("cache freshness rules");
check("revealed past term is cached permanently", await PD.db.isFresh("ARTS 1", 1251));
check("all-TBA term is fresh only while recent", await PD.db.isFresh("ARTS 1", 1261));
check("unscanned term is not fresh", !(await PD.db.isFresh("ARTS 1", 1211)));
await PD.db.putTerm("HUM 1", 1251, []);
check("empty scan is never treated as fresh", !(await PD.db.isFresh("HUM 1", 1251)));
await PD.db.putTerm(
  "HUM 1",
  1241,
  [{ term: 1241, courseCode: "HUM 1", section: "A", instructor: "DELA CRUZ, JUAN" }],
  { source: "dom", fieldReport: { pages: 1 } }
);
check("thin first-page DOM cache is not fresh", !(await PD.db.isFresh("HUM 1", 1241)));
await PD.db.putTerm(
  "HUM 1",
  1242,
  [
    { term: 1242, courseCode: "HUM 1", section: "A", instructor: "DELA CRUZ, JUAN" },
    { term: 1242, courseCode: "HUM 1", section: "B1", instructor: "REYES, ANA" },
  ],
  { source: "dom", fieldReport: { pages: 2, exhausted: true } }
);
check("exhausted DOM cache is fresh", await PD.db.isFresh("HUM 1", 1242));
const midCopy = [
  { term: 1233, courseCode: "HUM 1", section: "A", instructor: "DELA CRUZ, JUAN", days: "T TH", timeStart: "7:00 AM" },
];
const secondCopy = [
  { term: 1232, courseCode: "HUM 1", section: "A", instructor: "DELA CRUZ, JUAN", days: "T TH", timeStart: "7:00 AM" },
];
await PD.db.putTerm("HUM 1", 1232, secondCopy, { source: "dom", fieldReport: { pages: 2, exhausted: true, termVerified: true } });
await PD.db.putTerm("HUM 1", 1233, midCopy, { source: "dom", fieldReport: { pages: 2, exhausted: true } });
check("copied midyear cache is not fresh", !(await PD.db.isFresh("HUM 1", 1233)));
check(
  "copied midyear matches the preceding second sem",
  PD.db.looksCopiedFromPriorTerm(await PD.db.getTerm("HUM 1", 1233), await PD.db.getTerm("HUM 1", 1232))
);
await PD.db.clearCourse("HUM 1");
check(
  "missingTerms only reports unscanned terms",
  JSON.stringify(await PD.db.missingTerms("ARTS 1", [1231, 1251, 1211, 1221])) === JSON.stringify([1211, 1221]),
  JSON.stringify(await PD.db.missingTerms("ARTS 1", [1231, 1251, 1211, 1221]))
);

// Expire the TBA term by hand and confirm it becomes rescannable.
const dbRaw = (await chrome.storage.local.get(PD.db.DB_KEY))[PD.db.DB_KEY];
dbRaw.courses["ARTS 1"].terms["1261"].scannedAt = Date.now() - PD.db.UNRESOLVED_TTL_MS - 1000;
await chrome.storage.local.set({ [PD.db.DB_KEY]: dbRaw });
check("stale all-TBA term goes stale after its TTL", !(await PD.db.isFresh("ARTS 1", 1261)));

check("course key is case/space insensitive", PD.db.courseKey("  arts   1 ") === "ARTS 1", PD.db.courseKey("  arts   1 "));
const summary = await PD.db.courseSummary("arts 1");
check("summary reachable with sloppy casing", summary?.terms.length === 10, String(summary?.terms.length));

/* ------------------------------------------------ predict 1261 */
heading("predict 1261 (all TBA) from stored data");

let records = await PD.db.allRecords("ARTS 1");
check("allRecords returns every stored row", records.length === 40, String(records.length));

const p1261 = PD.predict.run({
  records,
  targetTerm: 1261,
  targetSections: records.filter((r) => r.term === 1261),
  verified: await PD.db.getVerified("ARTS 1"),
  limit: 3,
});
check("prediction ok", p1261.ok, JSON.stringify(p1261).slice(0, 200));
check("does not use 1261 itself as evidence", !p1261.historyTerms.includes(1261), JSON.stringify(p1261.historyTerms));
if (p1261.ok) {
  const by = Object.fromEntries(p1261.sections.map((s) => [s.section, s]));
  for (const [section, who] of Object.entries(STABLE)) {
    check(
      `${section} top pick is ${who}`,
      by[section].candidates[0]?.profKey === PD.names.canonicalKey(who),
      by[section].candidates[0]?.name
    );
  }
  check("every section flagged TBA", p1261.sections.every((s) => s.isTba));
}

/* ------------------------------------------------ leakage check */
heading("no leakage when the target term is already revealed");

// 1253 is stored WITH instructors. Replace S4's prof with someone who exists
// only in 1253 - the model must not be able to see them.
const leakPayload = apiPayload(1253, { overrides: { S4: "NEWCOMER, ONLY ONCE" } });
await PD.db.putTerm("ARTS 1", 1253, PD.scanner.extractRecords(leakPayload, "ARTS 1", 1253).records);
records = await PD.db.allRecords("ARTS 1");

const p1253 = PD.predict.run({
  records,
  targetTerm: 1253,
  targetSections: records.filter((r) => r.term === 1253),
  limit: 3,
});
check("prediction ok", p1253.ok);
if (p1253.ok) {
  const s4 = p1253.sections.find((s) => s.section === "S4");
  const newcomerKey = PD.names.canonicalKey("NEWCOMER, ONLY ONCE");
  check(
    "target-only professor is absent from the candidate pool",
    !s4.candidates.some((c) => c.profKey === newcomerKey),
    JSON.stringify(s4.candidates.map((c) => c.name))
  );
  check(
    "S4 instead predicts the professor from prior terms",
    s4.candidates[0]?.profKey === PD.names.canonicalKey(STABLE.S4),
    s4.candidates[0]?.name
  );
  check("history stops before the target term", Math.max(...p1253.historyTerms) < 1253, JSON.stringify(p1253.historyTerms));
}

// Restore 1253 so later assertions use clean data.
await PD.db.putTerm("ARTS 1", 1253, PD.scanner.extractRecords(apiPayload(1253), "ARTS 1", 1253).records);

/* ------------------------------------------------ backtest mode */
heading("backtest mode: user types an already-revealed term");

records = await PD.db.allRecords("ARTS 1");
const p1251 = PD.predict.run({
  records,
  targetTerm: 1251,
  targetSections: records.filter((r) => r.term === 1251),
  limit: 3,
});
check("prediction ok", p1251.ok);
if (p1251.ok) {
  const actual = new Map(records.filter((r) => r.term === 1251 && r.profKey).map((r) => [r.section, r.profKey]));
  const hits = p1251.sections.filter((s) => s.candidates[0]?.profKey === actual.get(s.section)).length;
  check(`ground truth recovered for 1251 (${hits}/4)`, hits === 4, `${hits}/4`);
  check("only older terms used", Math.max(...p1251.historyTerms) < 1251, JSON.stringify(p1251.historyTerms));
}

/* ------------------------------------------------ verified override */
heading("moderator verification overrides AMIS");

await PD.db.setVerified("ARTS 1", 1261, "S1", "SUBSTITUTE, BRAND NEW", "unit-test");
records = await PD.db.allRecords("ARTS 1");
const s1_1261 = records.find((r) => r.term === 1261 && r.section === "S1");
check("verified row overrides the stored TBA", s1_1261.instructor === "SUBSTITUTE, BRAND NEW", JSON.stringify(s1_1261));
check("verified row is tagged as such", s1_1261.source === "verified", s1_1261.source);

const verified = await PD.db.getVerified("ARTS 1");
check("verified list returns the entry", verified.length === 1 && verified[0].section === "S1", JSON.stringify(verified));

const pVerified = PD.predict.run({
  records,
  targetTerm: 1261,
  targetSections: records.filter((r) => r.term === 1261),
  verified,
  limit: 3,
});
const s1Pred = pVerified.sections.find((s) => s.section === "S1");
check(
  "verified professor wins S1 outright",
  s1Pred.candidates[0]?.profKey === PD.names.canonicalKey("SUBSTITUTE, BRAND NEW"),
  s1Pred.candidates[0]?.name
);
check("verified flag surfaces to the UI", s1Pred.candidates[0]?.verified === true, JSON.stringify(s1Pred.candidates[0]));
check(
  "verified pick is near-certain",
  s1Pred.candidates[0].probability > 0.8,
  s1Pred.candidates[0].percentLabel
);

await PD.db.setVerified("ARTS 1", 1261, "S1", "", "unit-test");
records = await PD.db.allRecords("ARTS 1");
check(
  "clearing a verification restores TBA",
  records.find((r) => r.term === 1261 && r.section === "S1").instructor === "",
  JSON.stringify(records.find((r) => r.term === 1261 && r.section === "S1"))
);

/* ------------------------------------------------ remote merge */
heading("remote verified merge");
const added = await PD.db.mergeRemoteVerified([
  { courseCode: "ARTS 1", term: 1261, section: "S2", instructor: "REMOTE, MOD", at: Date.now() },
  { courseCode: "ARTS 1", term: 1261, section: "S2", instructor: "OLDER, ENTRY", at: 1 },
  { courseCode: "", term: 1261, section: "S3", instructor: "BAD ROW" },
]);
check("newer row accepted, stale and malformed rejected", added === 1, String(added));
const merged = await PD.db.getVerified("ARTS 1");
check("merged row wins", merged.find((v) => v.section === "S2")?.instructor === "REMOTE, MOD", JSON.stringify(merged));

/* ------------------------------------------------ identify */
heading("identify against stored data");
records = await PD.db.allRecords("ARTS 1");
const ident = PD.predict.identify("recaldi maria", records, { limit: 3 });
check("typo'd query finds RECALDE", ident[0]?.profKey === PD.names.canonicalKey(STABLE.S3), JSON.stringify(ident.map((i) => i.name)));
check("reports which sections they held", ident[0]?.sections.includes("S3"), JSON.stringify(ident[0]?.sections));

/* ------------------------------------------------ config */
heading("config round-trip");
await PD.db.saveConfig({ courseCode: "ARTS 1", targetTerm: 1261, limit: 5 });
const cfg = await PD.db.loadConfig();
check("config persists", cfg.courseCode === "ARTS 1" && cfg.limit === 5, JSON.stringify(cfg));
check(
  "defaults fill the gaps",
  cfg.throttleMs === 80 &&
    cfg.scanMode === "dom" &&
    cfg.sectionFilter === "ALL" &&
    cfg.votePad === 1 &&
    cfg.voteDepth === 0 &&
    cfg.voteMix === 0.4 &&
    cfg.voteFloor === 0.02 &&
    cfg.crossPrior === 5 &&
    cfg.tuneWeights === true &&
    cfg.lineup === "auto" &&
    cfg.goal === "topn",
  JSON.stringify(cfg)
);

const stats = await PD.db.stats();
check("stats report the dataset", stats.courses === 1 && stats.records === 40, JSON.stringify(stats));

/* ------------------------------------------------ export/import */
heading("export / import");
const json = await PD.db.exportJson();
await PD.db.clearAll();
check("clearAll empties the store", (await PD.db.listCourses()).length === 0);
await PD.db.importJson(json);
check("import restores the dataset", (await PD.db.allRecords("ARTS 1")).length === 40, String((await PD.db.allRecords("ARTS 1")).length));

let importFailed = false;
try {
  await PD.db.importJson('{"version":99}');
} catch (_) {
  importFailed = true;
}
check("import rejects a foreign version", importFailed);

console.log(lines.join("\n"));
console.log(`\n${failures ? `${failures} FAILURE(S)` : "ALL CHECKS PASSED"}`);
process.exit(failures ? 1 : 0);
