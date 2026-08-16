/**
 * Tune Profdictor against a REAL exported scan.
 *
 * The synthetic bench cannot settle questions like "does the seat lift help?",
 * because its faculty churn is random by construction — so "who held this seat
 * last" is deliberately uninformative there, while in a real department it is
 * the strongest signal available. This script grid-searches the shipped options
 * on an actual dataset export and prints what maximises TOP-5.
 *
 * Get the file: extension moderator page -> "Export dataset JSON".
 *
 *   node tools/tune-real.mjs <export.json> [COURSE CODE] [targetTerm]
 *
 * The target term must be one whose instructors are already published, so the
 * result can be scored. It is never used as evidence.
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

const [fileArg, courseArg, termArg] = process.argv.slice(2);
if (!fileArg) {
  console.error("usage: node tools/tune-real.mjs <export.json> [COURSE CODE] [targetTerm]");
  process.exit(2);
}

const db = JSON.parse(fs.readFileSync(path.resolve(fileArg), "utf8"));
if (db?.version !== 2) {
  console.error(`Unsupported dataset version: ${db?.version}. Export again from the moderator page.`);
  process.exit(2);
}

/** Records for one course, with moderator verifications merged in. */
function recordsFor(courseKey) {
  const course = db.courses?.[courseKey];
  if (!course) return [];
  const verified = db.verified?.[courseKey] || {};
  return Object.values(course.terms)
    .flatMap((t) => t.records || [])
    .map((r) => {
      const hit = verified[`${r.term}|${r.section}`];
      return hit ? { ...r, instructor: hit.instructor, profKey: hit.profKey } : r;
    });
}

const courseKeys = Object.keys(db.courses || {});
if (!courseKeys.length) {
  console.error("No courses in this export.");
  process.exit(2);
}

const wanted = courseArg ? PD.names.normalize(courseArg).replace(/\s+/g, " ").trim() : null;
const courseKey = wanted && courseKeys.includes(wanted) ? wanted : courseKeys[0];
if (wanted && courseKey !== wanted) {
  console.error(`"${courseArg}" not in export. Available: ${courseKeys.join(", ")}`);
  process.exit(2);
}

const records = recordsFor(courseKey);
const revealedTerms = [...new Set(records.filter((r) => r.profKey).map((r) => Number(r.term)))].sort(
  (a, b) => a - b
);
const targetTerm = Number(termArg) || revealedTerms[revealedTerms.length - 1];
if (!revealedTerms.includes(targetTerm)) {
  console.error(
    `Term ${targetTerm} has no published instructors in this export. Scored terms: ${revealedTerms.join(", ")}`
  );
  process.exit(2);
}

const truth = new Map(
  records.filter((r) => Number(r.term) === targetTerm && r.profKey).map((r) => [r.section, r.profKey])
);
const targetSections = records
  .filter((r) => Number(r.term) === targetTerm)
  .map((r) => ({ ...r, instructor: "TBA", profKey: "" }));
const evidence = records.filter((r) => Number(r.term) !== targetTerm);
const priorKeys = new Set(evidence.filter((r) => r.profKey).map((r) => r.profKey));

console.log(`course      ${courseKey}`);
console.log(`scoring     ${PD.terms.label(targetTerm)} (${targetTerm})`);
console.log(`evidence    ${[...new Set(evidence.map((r) => r.term))].sort().join(", ")}`);
console.log(`sections    ${targetSections.length}, ${truth.size} with a published name`);
const reachableTotal = [...truth.values()].filter((k) => priorKeys.has(k)).length;
console.log(
  `ceiling     ${reachableTotal}/${truth.size} = ${((reachableTotal / (truth.size || 1)) * 100).toFixed(0)}%` +
    ` (names absent from every older term can never be predicted)\n`
);

function score(options) {
  const out = PD.predict.run({ records: evidence, targetTerm, targetSections, limit: 5, ...options });
  if (!out.ok) return { error: out.error };
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let reachableTop5 = 0;
  let total = 0;
  for (const s of out.sections) {
    const actual = truth.get(s.section);
    if (!actual) continue;
    total += 1;
    const rank = PD.predict.truthRank(s.candidates, actual);
    if (rank === 0) top1 += 1;
    if (rank >= 0 && rank < 3) top3 += 1;
    if (rank >= 0 && rank < 5) top5 += 1;
    if (priorKeys.has(actual) && rank >= 0 && rank < 5) reachableTop5 += 1;
  }
  return {
    total,
    top1: top1 / total,
    top3: top3 / total,
    top5: top5 / total,
    reachableTop5: reachableTop5 / (reachableTotal || 1),
    model: out.model,
  };
}

const TOPN = { goal: "topn" };
const trials = [
  { name: "shipped Top N", options: TOPN },
  { name: "Top 1 focus", options: { goal: "top1" } },
  { name: "half-life 6", options: { ...TOPN, halfLife: 6 } },
  { name: "half-life 8", options: { ...TOPN, halfLife: 8 } },
  { name: "half-life 3", options: { ...TOPN, halfLife: 3 } },
  { name: "no weight tuning", options: { ...TOPN, tuneWeights: false } },
  { name: "timetable off", options: { ...TOPN, lineup: "off" } },
  { name: "cross-section 2x", options: { ...TOPN, crossPrior: 2 } },
  { name: "cross-section 9x", options: { ...TOPN, crossPrior: 9 } },
  { name: "vote mix 60", options: { ...TOPN, vote: { mix: 0.6 } } },
  { name: "vote mix 0 (no pad)", options: { ...TOPN, vote: { mix: 0 } } },
  { name: "vote depth 8 pad 2", options: { ...TOPN, vote: { depth: 8, pad: 2 } } },
];

const rows = [];
for (const t of trials) {
  const got = score(t.options);
  if (got.error) {
    console.log(`${t.name.padEnd(22)} ERROR ${got.error}`);
    continue;
  }
  rows.push({ name: t.name, ...got });
  const m = got.model;
  const notes = [
    m.shortlistLift ? "lift" : null,
    m.halfLifeSearched ? `half-life ${m.halfLife}` : null,
    m.lineupApplied ? "timetable" : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `${t.name.padEnd(22)} top-1 ${(got.top1 * 100).toFixed(0).padStart(3)}%  ` +
      `top-3 ${(got.top3 * 100).toFixed(0).padStart(3)}%  ` +
      `TOP-5 ${(got.top5 * 100).toFixed(0).padStart(3)}%  ` +
      `reachable top-5 ${(got.reachableTop5 * 100).toFixed(0).padStart(3)}%` +
      (notes ? `   [${notes}]` : "")
  );
}

rows.sort((a, b) => b.top5 - a.top5 || b.top1 - a.top1);
if (rows.length) {
  const best = rows[0];
  console.log(
    `\nbest TOP-5: ${best.name} at ${(best.top5 * 100).toFixed(0)}% ` +
      `(${(best.reachableTop5 * 100).toFixed(0)}% of the reachable names)`
  );
}
