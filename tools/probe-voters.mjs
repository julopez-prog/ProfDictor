/**
 * Why does the card say "4/6 agree" instead of "N/25"?
 *
 * Prints how many of the 25 models keep enough weight to cast a ballot under
 * each focus, so a shrinking denominator can be traced to the weight search
 * rather than guessed at.
 *
 *   node tools/probe-voters.mjs
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

function makeDepartment({ seed = 7, churn = 0.55, newHireRate = 0.2, hogShare = 0.1 } = {}) {
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
  const holder = new Map();
  const records = [];
  for (const term of TERMS) {
    const active = new Set();
    for (const s of sections) {
      if (String(term).endsWith("3")) continue;
      let who = holder.get(s.section);
      if (!who || rand() < churn) {
        if (rand() < hogShare) who = hog;
        else if (rand() < newHireRate) who = `HIRE${nextHire++}, FRESH`;
        else who = faculty[Math.floor(rand() * faculty.length)];
      }
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
  return records;
}

const records = makeDepartment();
const targetTerm = 1261;
const evidence = records.filter((r) => r.term !== targetTerm);
const targetSections = records
  .filter((r) => r.term === targetTerm)
  .map((r) => ({ ...r, instructor: "TBA", profKey: "" }));

for (const [name, options] of [
  ["top1", { goal: "top1" }],
  ["top3", { goal: "top3" }],
  ["topn", { goal: "topn" }],
  ["topn, no tuning", { goal: "topn", tuneWeights: false }],
]) {
  const out = PD.predict.run({ records: evidence, targetTerm, targetSections, limit: 5, ...options });
  if (!out.ok) {
    console.log(`${name.padEnd(16)} ERROR ${out.error}`);
    continue;
  }
  const w = out.model.weights;
  const floor = out.model.vote.floor;
  const voters = PD.predict.MODEL_KEYS.filter((k) => (w[k] || 0) > floor);
  const nonzero = PD.predict.MODEL_KEYS.filter((k) => (w[k] || 0) > 1e-6);
  const denominators = [...new Set(out.sections.map((s) => s.modelsTotal))].sort((a, b) => a - b);
  console.log(
    `${name.padEnd(16)} weight>0: ${String(nonzero.length).padStart(2)}/25   ` +
      `above vote floor ${floor}: ${String(voters.length).padStart(2)}/25   ` +
      `card shows /${denominators.join(",/")}`
  );
  console.log(`                 voters: ${voters.join(", ") || "(none)"}`);
}
