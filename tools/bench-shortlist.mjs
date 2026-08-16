/**
 * Focused bench for the Top-N shortlist rescue path.
 *
 * The main bench averages four departments and takes minutes. This one only
 * asks the question that matters when a user reports "top-5 is trash": on a
 * department hard enough to backtest under 50%, does the automatic retune
 * (top-5 weight search, wider vote recipes, seat lift, half-life widening)
 * actually raise the real top-5 on the held-out term?
 *
 *   node tools/bench-shortlist.mjs
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
 * Same generator as bench.mjs, plus `labs`: every letter also gets a "-1L"
 * laboratory seat, usually held by a different person than the lecture.
 */
function makeDepartment({ seed = 7, churn = 0.35, newHireRate = 0.15, hogShare = 0.1, labs = false } = {}) {
  const rand = rng(seed);
  const sections = [];
  LETTERS.forEach((letter, i) => {
    sections.push({ section: letter, days: DAYS[i % DAYS.length], timeStart: `${7 + (i % 6)}:00 AM` });
    sections.push({ section: `${letter}1`, days: DAYS[(i + 1) % DAYS.length], timeStart: `${1 + (i % 4)}:00 PM` });
    if (labs) {
      sections.push({ section: `${letter}-1L`, days: DAYS[(i + 3) % DAYS.length], timeStart: `${8 + (i % 4)}:00 AM` });
    } else {
      sections.push({ section: `${letter}2`, days: DAYS[(i + 2) % DAYS.length], timeStart: `${8 + (i % 5)}:00 AM` });
    }
  });

  const faculty = [];
  for (let i = 0; i < 30; i += 1) faculty.push(`SURNAME${i}, GIVEN${i % 7}`);
  const labPool = [];
  for (let i = 0; i < 10; i += 1) labPool.push(`LABBER${i}, ASSIST`);
  const hog = "BUSY, PROFESSOR";
  let nextHire = 0;

  const holder = new Map();
  const records = [];
  for (const term of TERMS) {
    const active = new Set();
    for (const s of sections) {
      if (String(term).endsWith("3")) continue;
      const isLab = PD.features.sectionKind(s.section) === "lab";
      const pool = isLab && labs ? labPool : faculty;
      let who = holder.get(s.section);
      if (!who || rand() < churn) {
        if (!isLab && rand() < hogShare) who = hog;
        else if (rand() < newHireRate) who = `HIRE${nextHire++}, FRESH`;
        else who = pool[Math.floor(rand() * pool.length)];
      }
      const slot = `${s.days}|${s.timeStart}`;
      if (active.has(`${who}|${slot}`)) who = pool[Math.floor(rand() * pool.length)];
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
  return { records };
}

function score(records, targetTerm, options) {
  const evidence = records.filter((r) => r.term !== targetTerm);
  const truth = new Map(records.filter((r) => r.term === targetTerm).map((r) => [r.section, r.profKey]));
  const targetSections = records
    .filter((r) => r.term === targetTerm)
    .map((r) => ({ ...r, instructor: "TBA", profKey: "" }));
  const out = PD.predict.run({ records: evidence, targetTerm, targetSections, limit: 5, ...options });
  if (!out.ok) return { error: out.error };

  const priorKeys = new Set(evidence.filter((r) => r.profKey).map((r) => r.profKey));
  let top1 = 0;
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
    if (rank >= 0 && rank < 5) top5 += 1;
    if (canReach && rank >= 0 && rank < 5) reachableTop5 += 1;
  }
  return {
    total,
    top1: top1 / total,
    top5: top5 / total,
    reachableTop5: reachableTop5 / (reachable || 1),
    ceiling: reachable / total,
    model: out.model,
    components: (out.components || []).map((c) => c.kind),
  };
}

const cases = [
  { name: "brutal churn", opts: { seed: 11, churn: 0.75, newHireRate: 0.25, hogShare: 0.1 } },
  { name: "brutal + hoarder", opts: { seed: 3, churn: 0.7, newHireRate: 0.2, hogShare: 0.3 } },
  { name: "lecture + lab course", opts: { seed: 5, churn: 0.55, newHireRate: 0.2, hogShare: 0.1, labs: true } },
];

for (const c of cases) {
  const { records } = makeDepartment(c.opts);
  console.log(`\n${c.name}`);
  for (const v of [
    { name: "Top 1 focus", options: { goal: "top1" } },
    { name: "Top N (auto rescue)", options: { goal: "topn" } },
  ]) {
    const got = score(records, 1261, v.options);
    if (got.error) {
      console.log(`  ${v.name.padEnd(20)} ERROR ${got.error}`);
      continue;
    }
    const m = got.model;
    const notes = [
      m.shortlistRetuned ? "retuned" : null,
      m.shortlistLift ? "lift" : null,
      m.halfLifeSearched ? `half-life ${m.halfLife}` : null,
      m.shortlistBacktest ? `backtest top-5 ${(m.shortlistBacktest.top5 * 100).toFixed(0)}%` : null,
      got.components.length ? `components ${got.components.join("+")}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${v.name.padEnd(20)} top-1 ${(got.top1 * 100).toFixed(0)}%  TOP-5 ${(got.top5 * 100).toFixed(0)}%  ` +
        `ceiling ${(got.ceiling * 100).toFixed(0)}%  reachable top-5 ${(got.reachableTop5 * 100).toFixed(0)}%` +
        (notes ? `   [${notes}]` : "")
    );
  }
}
