/**
 * Profdictor accuracy bench.
 *
 * The self-test uses a tiny, tidy department where everybody keeps their section
 * forever, so it scores ~95% and cannot tell a good change from a bad one. This
 * builds a deliberately hard department instead -- ~39 sections, churn between
 * semesters, one professor who hoards sections, retirements and fresh hires --
 * then scores the real prediction pipeline on a held-out term.
 *
 * Techniques are toggled through the same public options the extension uses, so
 * a number moving here means the shipped behaviour moved.
 *
 *   node tools/bench.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(here, "..", "extension");

globalThis.self = globalThis;
globalThis.window = globalThis;

for (const file of ["lib/terms.js", "lib/names.js", "lib/forest.js", "lib/features.js", "lib/predict.js"]) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(extRoot, file), "utf8"));
}
const { PD } = globalThis;

/** Deterministic PRNG so a rerun compares like with like. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TERMS = [1231, 1232, 1241, 1242, 1251, 1252, 1261];
const LETTERS = "ABCDEFGHIJKLM".split("");
const DAYS = ["M W", "T TH", "W F", "M TH"];

/**
 * @param {object} opts
 * @param {number} opts.churn        chance a seat changes hands between years
 * @param {number} opts.newHireRate  share of seats handed to a first-timer
 * @param {number} opts.hogShare     share of seats taken by one busy professor
 */
function makeDepartment({ seed = 7, churn = 0.35, newHireRate = 0.15, hogShare = 0.1 } = {}) {
  const rand = rng(seed);
  const sections = [];
  LETTERS.forEach((letter, i) => {
    sections.push({ section: letter, days: DAYS[i % DAYS.length], timeStart: `${7 + (i % 6)}:00 AM` });
    sections.push({ section: `${letter}1`, days: DAYS[(i + 1) % DAYS.length], timeStart: `${1 + (i % 4)}:00 PM` });
    sections.push({ section: `${letter}2`, days: DAYS[(i + 2) % DAYS.length], timeStart: `${8 + (i % 5)}:00 AM` });
  });

  const faculty = [];
  for (let i = 0; i < 30; i += 1) faculty.push(`SURNAME${i}, GIVEN${i % 7}`);
  const hog = "BUSY, PROFESSOR";
  let nextHire = 0;

  // Who holds each seat, carried forward term to term with churn.
  const holder = new Map();
  const records = [];
  for (const term of TERMS) {
    const active = new Set();
    for (const s of sections) {
      const isMidyear = String(term).endsWith("3");
      if (isMidyear) continue;
      let who = holder.get(s.section);
      if (!who || rand() < churn) {
        if (rand() < hogShare) who = hog;
        else if (rand() < newHireRate) who = `HIRE${nextHire++}, FRESH`;
        else who = faculty[Math.floor(rand() * faculty.length)];
      }
      // One person cannot be in two places at once.
      const slot = `${s.days}|${s.timeStart}`;
      if (active.has(`${who}|${slot}`)) who = faculty[Math.floor(rand() * faculty.length)];
      active.add(`${who}|${slot}`);
      holder.set(s.section, who);
      records.push({
        term,
        section: s.section,
        days: s.days,
        timeStart: s.timeStart,
        timeEnd: "",
        room: `RM${s.section}`,
        instructor: who,
        profKey: PD.names.canonicalKey(who),
      });
    }
  }
  return { records, sections };
}

/** Score the shipped pipeline on `targetTerm`, which is withheld from evidence. */
function score(records, targetTerm, limit, options = {}) {
  const evidence = records.filter((r) => r.term !== targetTerm);
  const truth = new Map(records.filter((r) => r.term === targetTerm).map((r) => [r.section, r.profKey]));
  const targetSections = records
    .filter((r) => r.term === targetTerm)
    .map((r) => ({ ...r, instructor: "TBA", profKey: "" }));

  const out = PD.predict.run({ records: evidence, targetTerm, targetSections, limit, ...options });
  if (!out.ok) return { error: out.error };

  const priorKeys = new Set(evidence.filter((r) => r.profKey).map((r) => r.profKey));
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let reachable = 0;
  let reachableTop5 = 0;
  let total = 0;
  for (const s of out.sections) {
    const actual = truth.get(s.section);
    if (!actual) continue;
    total += 1;
    const canReach = priorKeys.has(actual);
    if (canReach) reachable += 1;
    const rank = PD.predict.truthRank(s.candidates, actual);
    if (rank === 0) top1 += 1;
    if (rank >= 0 && rank < 3) top3 += 1;
    if (rank >= 0 && rank < 5) top5 += 1;
    if (canReach && rank >= 0 && rank < 5) reachableTop5 += 1;
  }
  const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;
  return {
    total,
    top1: top1 / total,
    top5: top5 / total,
    label: `top-1 ${pct(top1)}  top-3 ${pct(top3)}  TOP-5 ${pct(top5)}  ceiling ${pct(reachable)}  (reachable top-5 ${(
      (reachableTop5 / (reachable || 1)) * 100
    ).toFixed(0)}%)`,
    tuned: out.model.weightsTuned,
    lineup: out.model.lineupApplied,
    lift: out.model.shortlistLift,
    backtest: out.backtest.lineup,
  };
}

const scenarios = [
  { name: "stable department (low churn)", churn: 0.15, newHireRate: 0.05, hogShare: 0.05 },
  { name: "realistic churn", churn: 0.35, newHireRate: 0.15, hogShare: 0.1 },
  { name: "high churn + many new hires", churn: 0.6, newHireRate: 0.3, hogShare: 0.15 },
  { name: "one professor hoards sections", churn: 0.4, newHireRate: 0.1, hogShare: 0.35 },
];

// Focus=Top N is what the popup ships, so that is the recipe under test.
const TOPN = { goal: "topn" };
const variants = [
  { name: "shipped (Top N)", options: TOPN },
  { name: "Top 1 focus", options: { goal: "top1" } },
  { name: "no weight tuning", options: { ...TOPN, tuneWeights: false } },
  { name: "no timetable", options: { ...TOPN, lineup: "off" } },
  { name: "timetable forced on", options: { ...TOPN, lineup: "always" } },
  { name: "half-life 6", options: { ...TOPN, halfLife: 6 } },
  { name: "half-life 8", options: { ...TOPN, halfLife: 8 } },
];

const totals = new Map(variants.map((v) => [v.name, []]));
console.log(`sections per term: ${makeDepartment().records.filter((r) => r.term === 1261).length}`);
for (const s of scenarios) {
  console.log(`\n${s.name}`);
  const { records } = makeDepartment(s);
  for (const v of variants) {
    const got = score(records, 1261, 5, v.options);
    if (got.error) {
      console.log(`  ${v.name.padEnd(20)} ERROR ${got.error}`);
      continue;
    }
    totals.get(v.name).push(got.top5);
    const flags = `${got.tuned ? "tuned" : "-"}/${got.lineup ? "timetable" : "-"}/${got.lift ? "lift" : "-"}`;
    console.log(`  ${v.name.padEnd(20)} ${got.label}   [${flags}]`);
  }
}

console.log("\nmean TOP-5 across scenarios");
for (const [name, xs] of totals) {
  if (!xs.length) continue;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`  ${name.padEnd(20)} ${(mean * 100).toFixed(1)}%`);
}
