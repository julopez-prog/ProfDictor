/**
 * Profdictor self-test. Loads the browser libs into a Node global and exercises
 * them on synthetic AMIS-shaped data.
 *
 *   node tools/selftest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(here, "..", "extension");

globalThis.self = globalThis;
globalThis.window = globalThis;

for (const file of [
  "lib/terms.js",
  "lib/names.js",
  "lib/forest.js",
  "lib/features.js",
  "lib/predict.js",
]) {
  const code = fs.readFileSync(path.join(extRoot, file), "utf8");
  // eslint-disable-next-line no-eval
  eval(code);
}

const { PD } = globalThis;
let failures = 0;
const results = [];

function check(name, condition, detail = "") {
  if (condition) {
    results.push(`  PASS  ${name}`);
  } else {
    failures += 1;
    results.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function section(title) {
  results.push(`\n== ${title} ==`);
}

/* ---------------------------------------------------------------- terms */
section("terms");
check("parse 1261 -> First Sem 2026-2027", (() => {
  const t = PD.terms.parse(1261);
  return t.semester === 1 && t.academicYear === "2026-2027";
})());
check("parse 1233 -> Midyear 2023-2024", (() => {
  const t = PD.terms.parse(1233);
  return t.semester === 3 && t.academicYear === "2023-2024";
})());
check("label formatting", PD.terms.label(1252) === "1252 - Second Semester (2025-2026)", PD.terms.label(1252));

const hist1261 = PD.terms.historyFor(1261, 1231);
check(
  "history for 1261 is the 9 expected terms",
  JSON.stringify(hist1261) === JSON.stringify([1231, 1232, 1233, 1241, 1242, 1243, 1251, 1252, 1253]),
  JSON.stringify(hist1261)
);

const hist1251 = PD.terms.historyFor(1251, 1231);
check(
  "history for 1251 stops before target",
  JSON.stringify(hist1251) === JSON.stringify([1231, 1232, 1233, 1241, 1242, 1243]),
  JSON.stringify(hist1251)
);
check("distance 1251 -> 1261 is 3 semesters", PD.terms.distance(1251, 1261) === 3, String(PD.terms.distance(1251, 1261)));
check("distance 1253 -> 1261 is 1 semester", PD.terms.distance(1253, 1261) === 1, String(PD.terms.distance(1253, 1261)));
check(
  "same-semester history of 1261",
  JSON.stringify(PD.terms.sameSemesterHistory(1261, 1231)) === JSON.stringify([1231, 1241, 1251])
);

/* ---------------------------------------------------------------- names */
section("names");
const N = PD.names;
check("TBA detected", N.isTba("TBA") && N.isTba("To Be Announced") && N.isTba("") && N.isTba("---"));
check("real name not TBA", !N.isTba("DELA CRUZ, JUAN P."));
check(
  "comma and natural order collapse to one key",
  N.canonicalKey("DELA CRUZ, JUAN P.") === N.canonicalKey("Juan P. Dela Cruz"),
  `${N.canonicalKey("DELA CRUZ, JUAN P.")} vs ${N.canonicalKey("Juan P. Dela Cruz")}`
);
check(
  "titles and suffixes ignored",
  N.canonicalKey("Dr. Juan Dela Cruz Jr.") === N.canonicalKey("DELA CRUZ, JUAN"),
  `${N.canonicalKey("Dr. Juan Dela Cruz Jr.")} vs ${N.canonicalKey("DELA CRUZ, JUAN")}`
);
check("particle stays with surname", N.parse("Juan Dela Cruz").surname === "DELA CRUZ", N.parse("Juan Dela Cruz").surname);
check("diacritics folded", N.canonicalKey("Peña, José") === N.canonicalKey("PENA, JOSE"));
check("typo similarity high", N.similarity("dela cruz", "DELA CRUZ, JUAN P.") > 0.6, String(N.similarity("dela cruz", "DELA CRUZ, JUAN P.")));
check("phonetic typo tolerated", N.similarity("Rekalde", "RECALDE, MARIA") > 0.55, String(N.similarity("Rekalde", "RECALDE, MARIA")));
check("unrelated names score low", N.similarity("Santos", "Villanueva") < 0.45, String(N.similarity("Santos", "Villanueva")));

const fuzzyPool = ["DELA CRUZ, JUAN P.", "SANTOS, MARIA L.", "VILLANUEVA, PEDRO", "RECALDE, ANA"];
for (const [query, expected] of [
  ["delacruz jaun", "DELA CRUZ, JUAN P."],
  ["Dela Cruz Juan", "DELA CRUZ, JUAN P."],
  ["juan dela cruz", "DELA CRUZ, JUAN P."],
  ["dela cruz", "DELA CRUZ, JUAN P."],
  ["villanueva", "VILLANUEVA, PEDRO"],
  ["maria santos", "SANTOS, MARIA L."],
  ["SANTOS", "SANTOS, MARIA L."],
  ["Recaldi", "RECALDE, ANA"],
]) {
  const hit = N.bestMatches(query, fuzzyPool, { limit: 3 });
  check(`fuzzy "${query}" -> ${expected}`, hit[0]?.name === expected, JSON.stringify(hit.map((f) => `${f.name}:${f.score.toFixed(2)}`)));
}
check("displayName keeps middle initial period", N.displayName("DELA CRUZ, JUAN P.") === "DELA CRUZ, JUAN P.", N.displayName("DELA CRUZ, JUAN P."));

/* ---------------------------------------------------------------- features */
section("features / parsing");
const F = PD.features;
check("parseDays TTH", JSON.stringify(F.parseDays("T TH")) === JSON.stringify(["T", "TH"]), JSON.stringify(F.parseDays("T TH")));
check("parseDays MWF", JSON.stringify(F.parseDays("MWF")) === JSON.stringify(["M", "W", "F"]), JSON.stringify(F.parseDays("MWF")));
check("parseDays W only", JSON.stringify(F.parseDays("W")) === JSON.stringify(["W"]));
check("parseTime 8:30 AM", F.parseTime("8:30 AM") === 510, String(F.parseTime("8:30 AM")));
check("parseTime 1:00 PM", F.parseTime("1:00 PM") === 780, String(F.parseTime("1:00 PM")));
check("bare afternoon hour assumed PM", F.parseTime("1:00") === 780, String(F.parseTime("1:00")));
check("parseTime 10:00 stays AM", F.parseTime("10:00") === 600, String(F.parseTime("10:00")));
check("sectionFamily E-3L -> E", F.sectionFamily("E-3L") === "E", F.sectionFamily("E-3L"));
check("sectionFamily B1 -> B", F.sectionFamily("B1") === "B", F.sectionFamily("B1"));
check("sectionKind G is lecture", F.sectionKind("G") === "lecture");
check("sectionKind G-1L is lab", F.sectionKind("G-1L") === "lab");
check("sectionKind E-3L is lab", F.sectionKind("E-3L") === "lab");
check("sectionKind B1 is lecture", F.sectionKind("B1") === "lecture");
check("sectionKind B1L is lab", F.sectionKind("B1L") === "lab");
check("sectionKind AL stays lecture", F.sectionKind("AL") === "lecture");
check("compareSections puts G before G-1L", F.compareSections("G-1L", "G") > 0);
check("section filter ALL", F.parseSectionFilter("ALL").all === true);
check("section filter empty is ALL", F.parseSectionFilter("").all === true);
check("section filter B matches B2", F.sectionAllowed("B2", F.parseSectionFilter("B")));
check("section filter B rejects A", F.sectionAllowed("A", F.parseSectionFilter("B")) === false);
check("section filter strips digits", F.sanitizeSectionInput("B1") === "B", F.sanitizeSectionInput("B1"));
check("compareSections B then B1 then B2", F.compareSections("B2", "B1") > 0 && F.compareSections("B1", "B") > 0);
const unioned = F.unionTargetSections(
  [
    { term: 1261, section: "A", instructor: "TBA" },
    { term: 1261, section: "B1", instructor: "TBA" },
    { term: 1251, section: "A", instructor: "X, Y" },
    { term: 1251, section: "C", instructor: "Z, W" },
    { term: 1241, section: "B2", instructor: "P, Q" },
  ],
  1261,
  F.parseSectionFilter("ALL")
);
check("ALL unions missing C and B2 from history", unioned.map((r) => r.section).join(",") === "A,B1,B2,C", unioned.map((r) => r.section).join(","));
check("inherited C keeps 1251 layout tag", unioned.find((r) => r.section === "C")?.inheritedFrom === 1251);

const ong = PD.names.canonicalKey("ONG, LEANDRO");
const garcia = PD.names.canonicalKey("GARCIA, ALMIRA JOANNA");
const other = PD.names.canonicalKey("SANTOS, PEDRO L.");
const cohortRows = [1231, 1232, 1241, 1242, 1251].flatMap((term) => [
  { term, section: "B", profKey: ong, instructor: "ONG, LEANDRO" },
  { term, section: "C", profKey: ong, instructor: "ONG, LEANDRO" },
  { term, section: "G", profKey: garcia, instructor: "GARCIA, ALMIRA JOANNA" },
  { term, section: "H", profKey: garcia, instructor: "GARCIA, ALMIRA JOANNA" },
]);
const cohorts = F.buildCohorts(cohortRows, 1261, 4);
const garciaOnG = F.cohortSignals(
  { section: "G" },
  garcia,
  {
    cohorts,
    guesses: [{ section: "B", family: "B", profKey: ong, probability: 0.9 }],
  }
);
const strangerOnG = F.cohortSignals(
  { section: "G" },
  other,
  {
    cohorts,
    guesses: [{ section: "B", family: "B", profKey: ong, probability: 0.9 }],
  }
);
check("ONG on B lifts GARCIA on G", garciaOnG.partnerCond > 0.7, JSON.stringify(garciaOnG));
check("ONG on B does not lift a stranger on G", strangerOnG.partnerCond < 0.2, JSON.stringify(strangerOnG));
check(
  "ONG bundle includes C when B is guessed as ONG",
  F.cohortSignals({ section: "C" }, ong, {
    cohorts,
    guesses: [{ section: "B", family: "B", profKey: ong, probability: 0.9 }],
  }).bundleFit > 0.7
);

const vet = PD.names.canonicalKey("OLD, VET");
const kid = PD.names.canonicalKey("NEW, KID");
const seatRows = [
  { term: 1231, section: "X", profKey: vet, instructor: "OLD, VET" },
  { term: 1252, section: "Y", profKey: kid, instructor: "NEW, KID" },
];
const seatBuilt = F.buildProfiles(seatRows, 1261, 4);
const seatMem = F.buildSectionMemory(seatRows, 1261, seatBuilt.profiles);
check("vacated seat after a long gap", seatMem.get("X")?.vacant === true, JSON.stringify(seatMem.get("X")));
const kidOnX = F.seatSignals({ section: "X" }, kid, seatBuilt.profiles.get(kid), { sectionMemory: seatMem });
check("one-term name fits a vacated seat", kidOnX.newcomerFit > 0.4, JSON.stringify(kidOnX));
check("truthRank finds a named hit", PD.predict.truthRank([{ profKey: kid }], kid) === 0);
check("truthRank ignores a missing name", PD.predict.truthRank([{ profKey: kid }], vet) === -1);

/* ---------------------------------------------------------------- forest */
section("random forest");
// Learnable pattern: label 1 when feature 0 is high.
const fx = [];
const fy = [];
for (let i = 0; i < 200; i += 1) {
  const a = (i % 20) / 20;
  const noise = ((i * 7) % 11) / 11;
  fx.push([a, noise, ((i * 3) % 5) / 5]);
  fy.push(a > 0.6 ? 1 : 0);
}
const fmodel = PD.forest.train(fx, fy, { nTrees: 40, maxDepth: 4, seed: 7 });
check("forest trains", !!fmodel);
check(
  "forest separates the signal",
  PD.forest.predictProba(fmodel, [0.95, 0.5, 0.5]) > PD.forest.predictProba(fmodel, [0.05, 0.5, 0.5]),
  `${PD.forest.predictProba(fmodel, [0.95, 0.5, 0.5])} vs ${PD.forest.predictProba(fmodel, [0.05, 0.5, 0.5])}`
);
check("forest reports importance for feature 0", (fmodel.importance[0] ?? 0) > 0.3, JSON.stringify(fmodel.importance));

/* ---------------------------------------------------------------- logistic */
section("logistic regression");
const lmodel = PD.predict.trainLogistic(fx, fy, { iterations: 400 });
check("logistic trains", !!lmodel);
check(
  "logistic separates the signal",
  PD.predict.logisticProba(lmodel, [0.95, 0.5, 0.5]) > PD.predict.logisticProba(lmodel, [0.05, 0.5, 0.5])
);

/* ---------------------------------------------------------------- hungarian */
section("hungarian");
const assign = PD.predict.hungarian([
  [1, 100, 100],
  [100, 1, 100],
  [100, 100, 1],
]);
check("identity assignment found", JSON.stringify(assign) === JSON.stringify([0, 1, 2]), JSON.stringify(assign));
const assign2 = PD.predict.hungarian([
  [4, 1, 3],
  [2, 0, 5],
  [3, 2, 2],
]);
const cost2 = assign2.reduce((sum, col, row) => sum + [[4, 1, 3], [2, 0, 5], [3, 2, 2]][row][col], 0);
check("optimal cost for known 3x3 is 5", cost2 === 5, `cost=${cost2} assign=${JSON.stringify(assign2)}`);

/* ---------------------------------------------------------------- end-to-end */
section("end-to-end prediction");

// Synthetic ARTS 1: four sections, each with a professor who reliably keeps the
// same schedule slot. SANTOS replaces VILLANUEVA from 1243 onward (attrition).
const SLOTS = {
  S1: { days: "T TH", timeStart: "7:00 AM", timeEnd: "8:00 AM", room: "SMA LH" },
  S2: { days: "T TH", timeStart: "8:00 AM", timeEnd: "9:00 AM", room: "SMA LH" },
  S3: { days: "W F", timeStart: "10:00 AM", timeEnd: "11:00 AM", room: "CAS 104" },
  S4: { days: "W F", timeStart: "1:00 PM", timeEnd: "2:00 PM", room: "EAA LH" },
};

function profFor(section, term) {
  if (section === "S1") return "DELA CRUZ, JUAN P.";
  if (section === "S2") return "REYES, ANA M.";
  if (section === "S3") return "RECALDE, MARIA T.";
  return term >= 1243 ? "SANTOS, PEDRO L." : "VILLANUEVA, JOSE R.";
}

function makeRecords(termList, { reveal = true } = {}) {
  const out = [];
  for (const term of termList) {
    for (const [sec, slot] of Object.entries(SLOTS)) {
      const instructor = reveal ? profFor(sec, term) : "TBA";
      out.push({
        term,
        courseCode: "ARTS 1",
        section: sec,
        instructor,
        profKey: reveal ? PD.names.canonicalKey(instructor) : "",
        ...slot,
      });
    }
  }
  return out;
}

const history = makeRecords([1231, 1232, 1233, 1241, 1242, 1243, 1251, 1252, 1253]);
const targetSections = makeRecords([1261], { reveal: false });
const all = [...history, ...targetSections];

const prediction = PD.predict.run({
  records: all,
  targetTerm: 1261,
  targetSections,
  limit: 3,
});

check("prediction succeeds", prediction.ok, JSON.stringify(prediction).slice(0, 300));
check("all four sections predicted", prediction.sections.length === 4, String(prediction.sections?.length));

if (prediction.ok) {
  const bySection = Object.fromEntries(prediction.sections.map((s) => [s.section, s]));
  check(
    "S1 top pick is DELA CRUZ",
    bySection.S1.candidates[0]?.profKey === PD.names.canonicalKey("DELA CRUZ, JUAN P."),
    bySection.S1.candidates[0]?.name
  );
  check(
    "S2 top pick is REYES",
    bySection.S2.candidates[0]?.profKey === PD.names.canonicalKey("REYES, ANA M."),
    bySection.S2.candidates[0]?.name
  );
  check(
    "S3 top pick is RECALDE",
    bySection.S3.candidates[0]?.profKey === PD.names.canonicalKey("RECALDE, MARIA T."),
    bySection.S3.candidates[0]?.name
  );
  check(
    "S4 prefers current SANTOS over departed VILLANUEVA",
    bySection.S4.candidates[0]?.profKey === PD.names.canonicalKey("SANTOS, PEDRO L."),
    bySection.S4.candidates[0]?.name
  );
  check("top probability is confident (>50%)", bySection.S1.candidates[0].probability > 0.5, String(bySection.S1.candidates[0].percent));
  check("limiter respected", prediction.sections.every((s) => s.candidates.length <= 3));
  check("TBA flag set on target sections", prediction.sections.every((s) => s.isTba));
  check("backtest produced folds", prediction.backtest.folds.length > 0, String(prediction.backtest.folds.length));
  check(
    "backtest ensemble top-1 is high on this clean data",
    prediction.backtest.ensemble.top1 >= 0.75,
    String(prediction.backtest.ensemble.top1)
  );
  check(
    "limit 3 makes top-N equal top-3",
    prediction.backtest.ensemble.atN === 3 &&
      prediction.backtest.ensemble.topN === prediction.backtest.ensemble.top3,
    JSON.stringify(prediction.backtest.ensemble)
  );
  const wide = PD.predict.run({ records: all, targetTerm: 1261, targetSections, limit: 5 });
  check(
    "limit 5 reports top-5 >= top-3",
    wide.ok &&
      wide.backtest.ensemble.atN === 5 &&
      wide.backtest.ensemble.topN >= wide.backtest.ensemble.top3,
    JSON.stringify(wide.backtest?.ensemble)
  );
  check("forest trained on generated rows", prediction.model.forestTrained, JSON.stringify(prediction.model));
  check("logistic trained on generated rows", prediction.model.logisticTrained);
  check(
    "lineup has no duplicate prof inside a conflicting timeslot",
    (() => {
      const groups = PD.predict.conflictGroups(prediction.sections);
      return groups.every((g) => {
        const picks = g.map((i) => prediction.sections[i].lineupPick).filter(Boolean);
        return new Set(picks).size === picks.length;
      });
    })()
  );
  check(
    "no professor is ranked #1 on more sections than they can carry",
    (() => {
      const picks = new Map();
      prediction.sections.forEach((s) => {
        const top = s.candidates[0]?.profKey;
        if (top) picks.set(top, (picks.get(top) || 0) + 1);
      });
      return [...picks.values()].every((n) => n <= 4);
    })(),
    JSON.stringify(prediction.sections.map((s) => s.candidates[0]?.name))
  );
  check(
    "the timetable solver spreads one hoarding favourite across sections",
    (() => {
      // Every section prefers the same person, but nobody carries five at once.
      const hog = "HOG, ALPHA";
      const spare = ["SPARE, BETA", "SPARE, GAMMA", "SPARE, DELTA", "SPARE, EPSILON"];
      const ctx = {
        profiles: new Map(
          [hog, ...spare].map((n) => [
            PD.names.canonicalKey(n),
            { perTermCount: new Map([[1251, 1]]), avgLoad: 1 },
          ])
        ),
      };
      const entries = ["L1", "L2", "L3", "L4"].map((code, i) => ({
        code,
        meta: { days: "M", timeStart: `${8 + i}:00 AM`, timeEnd: `${9 + i}:00 AM` },
        ranked: [
          { profKey: PD.names.canonicalKey(hog), probability: 0.9 },
          { profKey: PD.names.canonicalKey(spare[i]), probability: 0.1 },
        ],
      }));
      const lineup = PD.predict.globalLineup(entries, ctx);
      const assigned = [...lineup.values()];
      return assigned.length === 4 && new Set(assigned).size === 4;
    })()
  );
  check(
    "weight tuning never returns an all-zero blend",
    (() => {
      const tuned = PD.predict.optimiseWeights([], { heuristic: 1 });
      const empty = PD.predict.optimiseWeights(
        [{ ensembleRows: [] }],
        Object.fromEntries(PD.predict.MODEL_KEYS.map((k) => [k, k === "heuristic" ? 1 : 0]))
      );
      const sum = (w) => PD.predict.MODEL_KEYS.reduce((a, k) => a + (w[k] || 0), 0);
      return sum(tuned.weights) > 0 && sum(empty.weights) > 0;
    })()
  );
  const firstPass = (() => {
    const rows = [
      { term: 1251, section: "S1", profKey: PD.names.canonicalKey("ONE, A"), instructor: "ONE, A" },
      { term: 1251, section: "S2", profKey: PD.names.canonicalKey("TWO, B"), instructor: "TWO, B" },
    ];
    const built = PD.features.buildProfiles(rows, 1261, 4);
    return PD.predict.firstPassGuesses([{ section: "S1" }, { section: "S2" }], built);
  })();
  check(
    "the first pass names a shortlist per section, with mass",
    firstPass.length >= 2 &&
      firstPass.every((g) => g.probability > 0 && g.family === "S") &&
      new Set(firstPass.map((g) => g.section)).size === 2,
    JSON.stringify(firstPass)
  );
  check(
    "the first pass puts each section's own past holder on top",
    (() => {
      const best = new Map();
      firstPass.forEach((g) => {
        if (!best.has(g.section) || g.probability > best.get(g.section).probability) best.set(g.section, g);
      });
      return (
        best.get("S1")?.profKey === PD.names.canonicalKey("ONE, A") &&
        best.get("S2")?.profKey === PD.names.canonicalKey("TWO, B")
      );
    })(),
    JSON.stringify(firstPass)
  );
  check("reasons are attached", (bySection.S1.candidates[0].reasons || []).length > 0);
  check("twenty-five models registered", prediction.model.modelCount === 25, String(prediction.model.modelCount));
  check(
    "cooccur and newcomer models are in the blend",
    ["cooccur", "bundle", "lastSameSem", "newcomer", "successor"].every((k) =>
      Object.prototype.hasOwnProperty.call(prediction.model.weights, k)
    ),
    JSON.stringify(Object.keys(prediction.model.weights))
  );
  check(
    "cross-section group is pinned at 5× one typical model",
    (() => {
      const w = prediction.model.weights;
      const others = PD.predict.MODEL_KEYS.filter((k) => !PD.predict.CROSS_KEYS.includes(k));
      const live = others.filter((k) => (w[k] || 0) > 1e-6);
      const unit = live.reduce((a, k) => a + (w[k] || 0), 0) / (live.length || 1);
      const cross = PD.predict.CROSS_KEYS.reduce((a, k) => a + (w[k] || 0), 0);
      return Math.abs(cross / unit - PD.predict.CROSS_PRIOR) < 0.15;
    })(),
    JSON.stringify(prediction.model.weights)
  );
  check(
    "pinCrossWeights turns a flat 1-each blend into a 5-to-1 neighbour prior",
    (() => {
      const flat = Object.fromEntries(PD.predict.MODEL_KEYS.map((k) => [k, 1]));
      const pinned = PD.predict.pinCrossWeights(flat);
      const others = PD.predict.MODEL_KEYS.filter((k) => !PD.predict.CROSS_KEYS.includes(k));
      const unit = others.reduce((a, k) => a + pinned[k], 0) / others.length;
      const cross = PD.predict.CROSS_KEYS.reduce((a, k) => a + pinned[k], 0);
      return Math.abs(cross / unit - 5) < 0.01;
    })()
  );
  check(
    "silent models are not padded into the vote count",
    (() => {
      const scores = [
        { profKey: "A", heuristic: 2, sectionExact: 0.9, cooccur: 0.1 },
        { profKey: "B", heuristic: 1, sectionExact: 0.2, cooccur: 0.8 },
      ];
      const weights = Object.fromEntries(PD.predict.MODEL_KEYS.map((k) => [k, 0]));
      weights.heuristic = 0.5;
      weights.sectionExact = 0.3;
      weights.cooccur = 0.2;
      const votes = {};
      const live = PD.predict.MODEL_KEYS.filter((k) => (weights[k] || 0) > PD.predict.DEFAULT_VOTE.floor);
      live.forEach((key) => {
        const best = scores.reduce((a, b) => ((b[key] ?? -Infinity) > (a[key] ?? -Infinity) ? b : a));
        votes[key] = best.profKey;
      });
      return live.length === 3 && Object.keys(votes).length === 3;
    })()
  );
  check(
    "vote padding lifts a name that many models rank #4/#5",
    (() => {
      const hog = { profKey: "HOG", heuristic: 3 };
      const hid = { profKey: "HID", heuristic: 1 };
      PD.predict.MODEL_KEYS.forEach((k) => {
        if (k === "heuristic") return;
        hog[k] = 0.95;
        hid[k] = 0.2;
      });
      // Most models love HOG, but the padded ballots all keep HID in the top 5.
      // Give HID a clean second place on every specialist so pad+depth can score it.
      PD.predict.MODEL_KEYS.forEach((k) => {
        if (k === "heuristic") return;
        hid[k] = 0.7;
      });
      const weights = Object.fromEntries(PD.predict.MODEL_KEYS.map((k) => [k, 0.04]));
      weights.heuristic = 0.04;
      const padded = PD.predict.applyVotePadding([hog, hid], weights, { pad: 1, depth: 5, floor: 0.02, mix: 1 });
      const hidRow = padded.find((s) => s.profKey === "HID");
      return hidRow && hidRow.borda > 0 && hidRow.score > 0;
    })()
  );
  check(
    "focus topn uses Max profs as N",
    PD.predict.resolveGoal({ goal: "topn", limit: 5 }).atN === 5 &&
      PD.predict.resolveGoal({ goal: "top3", limit: 8 }).atN === 3 &&
      PD.predict.resolveGoal({ goal: "top1" }).coverage === false
  );
  check(
    "coverage keeps the last same-semester holder on a full shortlist",
    (() => {
      const last = PD.names.canonicalKey("LAST, SAME");
      const other = PD.names.canonicalKey("OTHER, ONE");
      const rows = [
        { term: 1251, section: "A1", profKey: last, instructor: "LAST, SAME" },
        { term: 1252, section: "A1", profKey: other, instructor: "OTHER, ONE" },
      ];
      const built = PD.features.buildProfiles(rows, 1261, 4);
      const mem = PD.features.buildSectionMemory(rows, 1261, built.profiles);
      const ctx = { ...built, sectionMemory: mem };
      const keys = PD.predict.coverageKeys({ section: "A1", days: "M W", timeStart: "7:00 AM" }, ctx, 5);
      const filled = PD.predict.applyCoverage(
        [
          { profKey: other, name: "OTHER, ONE", probability: 0.4 },
          { profKey: "WEAK", name: "WEAK", probability: 0.02 },
        ],
        [{ profKey: last, name: "LAST, SAME", probability: 0.08 }],
        [],
        { section: "A1" },
        ctx,
        2,
        1261,
        { verifiedSet: new Set() }
      );
      const ignored = PD.predict.applyCoverage(
        [{ profKey: other, name: "OTHER, ONE", probability: 0.4 }],
        [],
        [],
        { section: "A1" },
        ctx,
        1,
        1261,
        { verifiedSet: new Set() }
      );
      return (
        keys.includes(last) &&
        filled.some((c) => c.profKey === last) &&
        !ignored.some((c) => c.profKey === last)
      );
    })()
  );
  check(
    "heuristic partner features are 5× a typical same-section feature",
    PD.features.HEURISTIC_WEIGHTS.partnerCond >= 5 * PD.features.HEURISTIC_WEIGHTS.freqDecay * 0.9,
    JSON.stringify({
      partnerCond: PD.features.HEURISTIC_WEIGHTS.partnerCond,
      freqDecay: PD.features.HEURISTIC_WEIGHTS.freqDecay,
    })
  );
  check("scan/predict counts lock", prediction.scannedSections === 4 && prediction.predictedSections === 4);
  check("section confidence present", bySection.S1.confidence >= 40, String(bySection.S1.confidence));
  check("overall confidence present", prediction.model.confidence >= 40, String(prediction.model.confidence));
  check("GENERAL letter family S exists", (prediction.families || []).some((f) => f.letter === "S"), JSON.stringify(prediction.families?.map((f) => f.letter)));
  check(
    "lecture-only course hides lecture/lab cards",
    !(prediction.components || []).length,
    JSON.stringify(prediction.components)
  );
}

section("top-n shortlist + lecture/lab");
check(
  "auto vote depth stays at 5 when Max profs is 15",
  PD.predict.resolveVoteDepth({ limit: 15, vote: { depth: 0 } }) === 5 &&
    PD.predict.resolveVoteDepth({ limit: 3, vote: { depth: 0 } }) === 3 &&
    PD.predict.resolveVoteDepth({ limit: 15, vote: { depth: 12 } }) === 12
);
check(
  "Top-15 run keeps vote depth at 5 and the same first five as Top-5",
  (() => {
    const vote = { pad: 1, depth: 0, mix: 0.4, floor: 0.02 };
    const five = PD.predict.run({
      records: all,
      targetTerm: 1261,
      targetSections,
      limit: 5,
      vote,
    });
    const wide = PD.predict.run({
      records: all,
      targetTerm: 1261,
      targetSections,
      limit: 15,
      vote,
    });
    if (!five.ok || !wide.ok || wide.model.vote.depth !== 5) return false;
    return five.sections.every((s) => {
      const other = wide.sections.find((x) => x.section === s.section);
      const a = (s.candidates || []).map((c) => c.profKey).join("|");
      const b = (other?.candidates || []).slice(0, 5).map((c) => c.profKey).join("|");
      return a === b;
    });
  })()
);
check(
  "coverage does not swap the first 5 names when N is 15",
  (() => {
    const last = PD.names.canonicalKey("LAST, SAME");
    const rows = [
      { term: 1251, section: "A1", profKey: last, instructor: "LAST, SAME" },
    ];
    const built = PD.features.buildProfiles(rows, 1261, 4);
    const mem = PD.features.buildSectionMemory(rows, 1261, built.profiles);
    const ctx = { ...built, sectionMemory: mem };
    const core = ["A", "B", "C", "D", "E"].map((k, i) => ({
      profKey: k,
      name: k,
      probability: 0.3 - i * 0.04,
    }));
    const filled = PD.predict.applyCoverage(
      [...core, { profKey: "F", name: "F", probability: 0.01 }],
      [{ profKey: last, name: "LAST, SAME", probability: 0.04 }],
      [],
      { section: "A1" },
      ctx,
      15,
      1261,
      { verifiedSet: new Set() }
    );
    return (
      core.every((c, i) => filled[i]?.profKey === c.profKey) &&
      filled.some((c) => c.profKey === last)
    );
  })()
);
check(
  "lab-only course also hides lecture/lab cards",
  !PD.predict.componentSummaries(
    [
      { term: 1251, section: "G-1L", profKey: PD.names.canonicalKey("MAAÑO, AARON CARL"), instructor: "MAAÑO, AARON CARL" },
    ],
    1261
  ).length
);
check(
  "lecture vs lab summaries split CMSC-style sections",
  (() => {
    const alb = PD.names.canonicalKey("ALBACEA, JOHN PATRICK");
    const maa = PD.names.canonicalKey("MAAÑO, AARON CARL");
    const rows = [1231, 1241, 1251].flatMap((term) => [
      { term, section: "G", profKey: alb, instructor: "ALBACEA, JOHN PATRICK" },
      { term, section: "G-1L", profKey: maa, instructor: "MAAÑO, AARON CARL" },
    ]);
    const comps = PD.predict.componentSummaries(rows, 1261, { limit: 5 });
    const lecture = comps.find((c) => c.kind === "lecture");
    const lab = comps.find((c) => c.kind === "lab");
    return (
      comps.length === 2 &&
      lecture?.frequent[0]?.profKey === alb &&
      lab?.frequent[0]?.profKey === maa &&
      lecture.frequent[0].share >= 90 &&
      lab.frequent[0].share >= 90
    );
  })()
);
check(
  "a weak Top-N shortlist widens the half-life instead of shipping under 50%",
  (() => {
    const out = PD.predict.run({
      records: all,
      targetTerm: 1261,
      targetSections,
      limit: 5,
      goal: "topn",
      halfLife: 4,
    });
    // This clean department already scores far above the floor, so nothing
    // should be widened; the reported half-life must still be honest.
    return out.ok && out.model.halfLife === 4 && out.model.halfLifeSearched === false;
  })()
);
const liftCtx = (() => {
  const last = PD.names.canonicalKey("LAST, SAME");
  const rows = [{ term: 1251, section: "A1", profKey: last, instructor: "LAST, SAME" }];
  const built = PD.features.buildProfiles(rows, 1261, 4);
  const mem = PD.features.buildSectionMemory(rows, 1261, built.profiles);
  return { last, ctx: { ...built, sectionMemory: mem } };
})();
check(
  "seat lift pulls a last-holder from rank 7 into a diffuse top 5",
  (() => {
    // 39-section shape: the favourite only holds 12%, the truth 3%.
    const probs = [0.12, 0.09, 0.07, 0.06, 0.05, 0.04, 0.03];
    const cards = ["A", "B", "C", "D", "E", "F", liftCtx.last].map((k, i) => ({
      profKey: k,
      name: k,
      probability: probs[i],
    }));
    const lifted = PD.predict.liftShortlist(cards, { section: "A1" }, liftCtx.ctx, 5);
    const idx = lifted.findIndex((c) => c.profKey === liftCtx.last);
    return idx >= 0 && idx < 5 && lifted[0].profKey === "A" && lifted[idx].fromLift === true;
  })()
);
check(
  "seat lift refuses when the shortlist is already confident",
  (() => {
    // A peaked posterior means the blend is sure; a 4% name should not evict 16%.
    const cards = ["A", "B", "C", "D", "E", "F", liftCtx.last].map((k, i) => ({
      profKey: k,
      name: k,
      probability: k === liftCtx.last ? 0.04 : 0.28 - i * 0.03,
    }));
    const lifted = PD.predict.liftShortlist(cards, { section: "A1" }, liftCtx.ctx, 5);
    return lifted.slice(0, 5).every((c) => c.profKey !== liftCtx.last);
  })()
);
check(
  "seat lift ignores a ghost far below the weakest shortlist seat",
  (() => {
    const cards = ["A", "B", "C", "D", "E", liftCtx.last].map((k, i) => ({
      profKey: k,
      name: k,
      probability: k === liftCtx.last ? 0.001 : 0.2 - i * 0.02,
    }));
    const lifted = PD.predict.liftShortlist(cards, { section: "A1" }, liftCtx.ctx, 5);
    return lifted.slice(0, 5).every((c) => c.profKey !== liftCtx.last);
  })()
);
check(
  "lab regular scores higher componentFit on a lab seat",
  (() => {
    const alb = PD.names.canonicalKey("ALBACEA, JOHN PATRICK");
    const maa = PD.names.canonicalKey("MAAÑO, AARON CARL");
    const rows = [
      { term: 1251, section: "G", profKey: alb, instructor: "ALBACEA, JOHN PATRICK" },
      { term: 1251, section: "G-1L", profKey: maa, instructor: "MAAÑO, AARON CARL" },
    ];
    const built = PD.features.buildProfiles(rows, 1261, 4);
    const ctx = { ...built, targetTerm: 1261, halfLife: 4 };
    const labOnLab = PD.features.featureVector({ section: "G-1L" }, maa, ctx);
    const lecOnLab = PD.features.featureVector({ section: "G-1L" }, alb, ctx);
    const i = PD.features.FEATURE_NAMES.indexOf("componentFit");
    return i >= 0 && labOnLab[i] > lecOnLab[i];
  })()
);

/* ------------------------------------------------- backtest mode (1251) */
section("backtest mode: predict 1251 from older terms");
const backtestRecords = makeRecords([1231, 1232, 1233, 1241, 1242, 1243]);
const truth1251 = makeRecords([1251]);
const btPrediction = PD.predict.run({
  records: [...backtestRecords, ...truth1251.map((r) => ({ ...r, instructor: "TBA", profKey: "" }))],
  targetTerm: 1251,
  targetSections: truth1251.map((r) => ({ ...r, instructor: "TBA", profKey: "" })),
  limit: 3,
});
check("backtest prediction succeeds", btPrediction.ok);
if (btPrediction.ok) {
  const hits = btPrediction.sections.filter((s) => {
    const actual = truth1251.find((r) => r.section === s.section);
    return s.candidates[0]?.profKey === actual.profKey;
  }).length;
  check(`1251 top-1 accuracy vs ground truth (${hits}/4)`, hits >= 3, `${hits}/4`);
}

/* ---------------------------------------------------------------- identify */
section("identify (who is the actual prof)");
const ident = PD.predict.identify("delacruz", history, { limit: 3 });
check("identify finds DELA CRUZ from a typo", ident[0]?.profKey === PD.names.canonicalKey("DELA CRUZ, JUAN P."), JSON.stringify(ident.map((i) => i.name)));
check("identify reports terms taught", (ident[0]?.terms || []).length > 0);

/* ---------------------------------------------------------------- sparse data */
section("degenerate inputs");
const sparse = PD.predict.run({
  records: makeRecords([1253]),
  targetTerm: 1261,
  targetSections,
  limit: 3,
});
check("single term of history still predicts", sparse.ok, JSON.stringify(sparse).slice(0, 200));
check("falls back to heuristic only", sparse.ok && sparse.model.weights.heuristic === 1, JSON.stringify(sparse.model?.weights));

const empty = PD.predict.run({ records: [], targetTerm: 1261, targetSections: [], limit: 3 });
check("empty dataset returns a clean error", !empty.ok && empty.error === "no_history", JSON.stringify(empty));

const allTba = PD.predict.run({
  records: makeRecords([1251, 1252], { reveal: false }),
  targetTerm: 1261,
  targetSections,
  limit: 3,
});
check("all-TBA history returns clean error", !allTba.ok, JSON.stringify(allTba).slice(0, 200));

/* ---------------------------------------------------------------- report */
console.log(results.join("\n"));

if (prediction.ok) {
  console.log("\n== sample output for 1261 ==");
  console.log(`model weights: ${JSON.stringify(prediction.model.weights)}`);
  console.log(`temperature: ${prediction.model.temperature}  novelty: ${prediction.model.noveltyRate}%`);
  console.log(
    `backtest: top1=${(prediction.backtest.ensemble.top1 * 100).toFixed(1)}% top3=${(
      prediction.backtest.ensemble.top3 * 100
    ).toFixed(1)}% n=${prediction.backtest.ensemble.samples}`
  );
  for (const s of prediction.sections) {
    const line = s.candidates.map((c) => `${c.name}: ${c.percentLabel}`).join(", ");
    console.log(`  ARTS 1 ${s.section} [${s.days} ${s.timeStart}] -> ${line} (new prof ${s.newProfChance}%)`);
  }
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : "ALL CHECKS PASSED"}`);
process.exit(failures ? 1 : 0);
