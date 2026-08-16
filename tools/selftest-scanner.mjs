/**
 * Profdictor scanner self-test.
 *
 * The exact JSON shape AMIS returns for `students/classes` is not documented,
 * so `extractRecords` is written to search for fields rather than assume paths.
 * This file throws a spread of plausible shapes at it: flat fields, nested
 * faculty objects, instructor arrays, split first/last names, rendered schedule
 * strings, and TBA placeholders.
 *
 *   node tools/selftest-scanner.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(here, "..", "extension");

globalThis.self = globalThis;
globalThis.window = { addEventListener() {}, postMessage() {} };
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
globalThis.chrome = { runtime: { getURL: (p) => p } };

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
const S = PD.scanner;
let failures = 0;
const lines = [];

function check(name, cond, detail = "") {
  if (cond) lines.push(`  PASS  ${name}`);
  else {
    failures += 1;
    lines.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const heading = (t) => lines.push(`\n== ${t} ==`);

/* ------------------------------------------------ schedule text parsing */
heading("parseScheduleText");
const s1 = S.parseScheduleText("TTh 8:30 AM - 10:00 AM SMA LH");
check("days parsed", s1?.days === "TTH", JSON.stringify(s1));
check("start parsed", s1?.timeStart === "8:30 AM", JSON.stringify(s1));
check("end parsed", s1?.timeEnd === "10:00 AM", JSON.stringify(s1));
check("room parsed", s1?.room === "SMA LH", JSON.stringify(s1));

const s2 = S.parseScheduleText("M W F 1:00 PM - 2:00 PM | ICS PC3");
check("multi-day with separators", s2?.days === "M W F", JSON.stringify(s2));
check("room after pipe", s2?.room === "ICS PC3", JSON.stringify(s2));
check("garbage returns null", S.parseScheduleText("no schedule here") === null);
const compact = S.parseScheduleText("A2 - (07:00AM - 08:30AM)");
check("compact 07:00AM parsed", compact?.timeStart?.replace(/\s+/g, "") === "07:00AM", JSON.stringify(compact));
check("empty returns null", S.parseScheduleText("") === null);

/* ------------------------------------------------ name resolution */
heading("resolveName / composeName");
check("plain string", S.resolveName("DELA CRUZ, JUAN P.") === "DELA CRUZ, JUAN P.");
check(
  "split name fields",
  S.composeName({ last_name: "REYES", first_name: "ANA", middle_name: "M." }) === "REYES, ANA M.",
  S.composeName({ last_name: "REYES", first_name: "ANA", middle_name: "M." })
);
check("object with name key", S.resolveName({ name: "SANTOS, PEDRO" }) === "SANTOS, PEDRO");
check(
  "array of instructor objects",
  S.resolveName([{ name: "A, B" }, { name: "C, D" }]) === "A, B / C, D",
  S.resolveName([{ name: "A, B" }, { name: "C, D" }])
);
check("array drops TBA entries", S.resolveName([{ name: "TBA" }, { name: "X, Y" }]) === "X, Y");
check("null safe", S.resolveName(null) === "");

/* ------------------------------------------------ extractRecords shapes */
heading("extractRecords across payload shapes");

const shapes = [
  {
    label: "flat fields",
    obj: {
      id: 1,
      course_code: "ARTS 1",
      section: "S1",
      instructor: "DELA CRUZ, JUAN P.",
      days: "T TH",
      time_start: "7:00 AM",
      time_end: "8:00 AM",
      room: "SMA LH",
      class_status: "Open",
    },
    expect: { section: "S1", instructor: "DELA CRUZ, JUAN P.", days: "T TH", timeStart: "7:00 AM", room: "SMA LH" },
  },
  {
    label: "nested course + faculty object + schedules array",
    obj: {
      id: 2,
      course: { course_code: "ARTS 1", title: "Art Appreciation" },
      section: "S2",
      faculty: { last_name: "REYES", first_name: "ANA", middle_name: "M." },
      schedules: [{ day: "W F", start_time: "10:00 AM", end_time: "11:00 AM", room: { name: "CAS 104" } }],
    },
    expect: { section: "S2", instructor: "REYES, ANA M.", days: "W F", timeStart: "10:00 AM", room: "CAS 104" },
  },
  {
    label: "instructors array + rendered schedule string",
    obj: {
      id: 3,
      course_code: "ARTS 1",
      section: "S3",
      instructors: [{ name: "RECALDE, MARIA T." }],
      schedule: "TTh 1:00 PM - 2:00 PM EAA LH",
    },
    expect: { section: "S3", instructor: "RECALDE, MARIA T.", days: "TTH", timeStart: "1:00 PM", room: "EAA LH" },
  },
  {
    label: "lecture_details nesting + faculty_name",
    obj: {
      id: 4,
      course_code: "ARTS 1",
      lecture_details: { section: "S4", days: "M", time_start: "8:00 AM", time_end: "9:00 AM", room: "SMA LH" },
      faculty_name: "SANTOS, PEDRO L.",
    },
    expect: { section: "S4", instructor: "SANTOS, PEDRO L.", days: "M", timeStart: "8:00 AM" },
  },
  {
    label: "combined class label, section parsed from suffix",
    obj: {
      id: 5,
      course_code: "ARTS 1",
      class_name: "ARTS 1 - S5",
      instructor_name: "VILLANUEVA, JOSE R.",
      days: "T",
      time_start: "3:00 PM",
    },
    expect: { section: "S5", instructor: "VILLANUEVA, JOSE R." },
  },
  {
    label: "TBA instructor is preserved as text",
    obj: { id: 6, course_code: "ARTS 1", section: "S6", instructor: "TBA", days: "F", time_start: "9:00 AM" },
    expect: { section: "S6", instructor: "TBA" },
  },
];

for (const shape of shapes) {
  const { records, fieldReport } = S.extractRecords([shape.obj], "ARTS 1", 1251);
  const r = records[0];
  if (!r) {
    check(`${shape.label}: produced a record`, false, JSON.stringify(fieldReport));
    continue;
  }
  const mismatches = Object.entries(shape.expect).filter(([k, v]) => r[k] !== v);
  check(
    `${shape.label}`,
    mismatches.length === 0,
    mismatches.map(([k, v]) => `${k}: got "${r[k]}" want "${v}"`).join("; ")
  );
}

/* ------------------------------------------------ prefix collision guard */
heading("course code collision guard");
const mixed = S.extractRecords(
  [
    { course_code: "ARTS 1", section: "A", instructor: "RIGHT, ONE" },
    { course_code: "PHILARTS 1", section: "B", instructor: "WRONG, TWO" },
    { course: { course_code: "ARTS 1" }, section: "C", instructor: "RIGHT, THREE" },
  ],
  "ARTS 1",
  1251
);
check(
  "PHILARTS 1 excluded when asking for ARTS 1",
  mixed.records.length === 2 && mixed.records.every((r) => r.section !== "B"),
  JSON.stringify(mixed.records.map((r) => `${r.section}:${r.instructor}`))
);
check(
  "nested course_code still accepted",
  mixed.records.some((r) => r.section === "C"),
  JSON.stringify(mixed.records.map((r) => r.section))
);

/* ------------------------------------------------ field report */
heading("field report diagnostics");
const report = S.extractRecords(
  [
    { course_code: "ARTS 1", section: "A", instructor: "X, Y", days: "M", time_start: "8:00 AM" },
    { course_code: "ARTS 1", section: "B", days: "T", time_start: "9:00 AM" },
  ],
  "ARTS 1",
  1251
).fieldReport;
check("counts rows", report.count === 2, String(report.count));
check("records instructor key path", !!report.instructorPaths.instructor, JSON.stringify(report.instructorPaths));
check("flags rows with no instructor field", report.missingInstructor === 1, String(report.missingInstructor));
check("captures sample keys for debugging", report.sampleKeys.includes("course_code"), JSON.stringify(report.sampleKeys));

/* ------------------------------------------------ degenerate input */
heading("degenerate input");
check("empty array safe", S.extractRecords([], "ARTS 1", 1251).records.length === 0);
check("null safe", S.extractRecords(null, "ARTS 1", 1251).records.length === 0);
check(
  "rows without a section are dropped",
  S.extractRecords([{ course_code: "ARTS 1", instructor: "A, B" }], "ARTS 1", 1251).records.length === 0
);
check(
  "non-object entries ignored",
  S.extractRecords(["nonsense", 42, null, { course_code: "ARTS 1", section: "Z" }], "ARTS 1", 1251).records
    .length === 1
);

/* ------------------------------------------------ record normalisation */
heading("db.normalizeRecord");
const nrTba = PD.db.normalizeRecord({ section: "s1", instructor: "TBA" }, "arts 1", 1261);
check("TBA becomes empty instructor + empty profKey", nrTba.instructor === "" && nrTba.profKey === "", JSON.stringify(nrTba));
check("section uppercased", nrTba.section === "S1");
check("course key normalised", nrTba.courseCode === "ARTS 1", nrTba.courseCode);
const nrReal = PD.db.normalizeRecord({ section: "s2", instructor: "Dela Cruz, Juan P." }, "ARTS 1", 1261);
check("real instructor gets canonical key", nrReal.profKey === PD.names.canonicalKey("DELA CRUZ, JUAN P."), nrReal.profKey);

const deduped = PD.db.dedupe([
  { term: 1251, section: "S1", profKey: "" },
  { term: 1251, section: "S1", profKey: "X|Y" },
  { term: 1251, section: "S2", profKey: "A|B" },
]);
check("dedupe prefers the revealed row", deduped.length === 2 && deduped.find((r) => r.section === "S1").profKey === "X|Y", JSON.stringify(deduped));

/* ------------------------------------------------ term label matching */
heading("matchesTerm");
check("code in a labelled option", S.matchesTerm("1261 - First Semester (2026-2027)", 1261));
check("words only, no code", S.matchesTerm("First Semester AY 2026-2027", 1261));
check("short year form", S.matchesTerm("First Sem 26-27", 1261));
check("midyear wording", S.matchesTerm("Mid-Year 2025-2026", 1253));
check("midyear code label", S.matchesTerm("1233 - Midyear (2023-2024)", 1233));
check("midyear calendar year", S.matchesTerm("Midyear 2024", 1233));
check("second sem is not midyear", !S.matchesTerm("1232 - Second Semester (2023-2024)", 1233));
check("midterm is not midyear", !S.matchesTerm("Midterm 2023-2024", 1233));
check("second semester", S.matchesTerm("Second Semester 2024-2025", 1242));
check("wrong year rejected", !S.matchesTerm("First Semester 2026-2027", 1251));
check("wrong semester rejected", !S.matchesTerm("Second Semester 2026-2027", 1261));
check("longer code not a substring match", !S.matchesTerm("12612 - something", 1261));
check("blank is not a match", !S.matchesTerm("", 1261));

heading("codeMatches");
check("exact", S.codeMatches("PI 10", "PI 10"));
check("spacing differences", S.codeMatches("PI10", "PI 10"));
check("section suffix allowed", S.codeMatches("PI 10-1", "PI 10"));
check("longer number rejected", !S.codeMatches("PI 100", "PI 10"));
check("different subject rejected", !S.codeMatches("HUM 1", "PI 10"));
check("missing row code is not a veto", S.codeMatches("", "PI 10"));

heading("Search Class text extractors");
check("section from card line", S.extractSectionFromText("B - (08:30 AM - 10:00 AM)") === "B");
check("section from ARTS 1 - S1", S.extractSectionFromText("ARTS 1 - S1") === "S1");
check("instructor from label", S.extractInstructorFromText("Instructor: DELA CRUZ, JUAN P.") === "DELA CRUZ, JUAN P.");
check("Faculty: VELA, JUALIM", S.extractInstructorFromText("Faculty: VELA, JUALIM") === "VELA, JUALIM");
check("section A2 compact time", S.extractSectionFromText("A2 - (07:00AM - 08:30AM)") === "A2");
check("Location: CAS B05", S.extractRoomFromText("Location: CAS B05") === "CAS B05");
check("instructor from comma name", S.extractInstructorFromText("SMA LH\nREYES, ANA M.\nOPEN") === "REYES, ANA M.");
check("courseMatchesText accepts ARTS 1", S.courseMatchesText("ARTS 1  B - (08:30 AM - 10:00 AM)", "ARTS 1"));
check("courseMatchesText rejects PHILARTS 1", !S.courseMatchesText("PHILARTS 1  B - (08:30 AM)", "ARTS 1"));

/* ------------------------------------------------ term dropdown driving */
heading("selectTerm against fake dropdowns");

const rect = () => ({ width: 220, height: 28, top: 12, left: 0 });
globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
globalThis.HTMLSelectElement = { prototype: {} };
globalThis.Event = class {
  constructor(type) {
    this.type = type;
  }
};

/** Minimal stand-in for a native <select> holding term options. */
function fakeSelect(labels, selectedIndex = 0) {
  const options = labels.map((label, i) => ({
    textContent: label,
    value: String(label).match(/^\d{4}/)?.[0] || `v${i}`,
    selected: i === selectedIndex,
    getBoundingClientRect: rect,
  }));
  const sel = {
    name: "term",
    id: "term",
    options,
    selectedIndex,
    events: [],
    getBoundingClientRect: rect,
    get value() {
      return options[sel.selectedIndex]?.value ?? "";
    },
    set value(v) {
      const i = options.findIndex((o) => o.value === v);
      if (i >= 0) sel.selectedIndex = i;
    },
    get selectedOptions() {
      return [options[sel.selectedIndex]].filter(Boolean);
    },
    dispatchEvent(e) {
      sel.events.push(e.type);
      return true;
    },
  };
  return sel;
}

function useDom({ selects = [] }) {
  globalThis.document = {
    getElementById: () => null,
    body: { innerText: "" },
    querySelectorAll: (raw) => {
      const s = String(raw);
      if (s === "select") return selects;
      if (s === "option") return selects.flatMap((x) => x.options);
      if (s === "input" || s === "table") return [];
      return [];
    },
  };
}

// The shipped bug: labels carry no term code, so matching on the code alone
// failed every term - including the one already on screen.
useDom({ selects: [fakeSelect(["First Semester AY 2026-2027", "Second Semester AY 2026-2027"], 0)] });
const already = await S.selectTerm(1261, { settleMs: 40 });
check("already-selected term needs no interaction", already.ok && already.via === "already-selected", JSON.stringify(already));

const wordy = await S.selectTerm(1262, { settleMs: 40 });
check("word-only label is found", wordy.ok && wordy.via === "native-select", JSON.stringify(wordy));

const coded = fakeSelect(["1261 - First Semester (2026-2027)", "1251 - First Semester (2025-2026)"], 0);
useDom({ selects: [coded] });
const past = await S.selectTerm(1251, { settleMs: 40 });
check("code-labelled past term is found", past.ok && past.via === "native-select", JSON.stringify(past));
check("selection actually moved", coded.selectedIndex === 1, String(coded.selectedIndex));
check("change event fired", coded.events.includes("change"), JSON.stringify(coded.events));

useDom({ selects: [fakeSelect(["1261 - First Semester (2026-2027)"], 0)] });
const missing = await S.selectTerm(1233, { settleMs: 40 });
check("absent term fails", !missing.ok, JSON.stringify(missing));
check(
  "error names what the dropdown does offer",
  /not in the Term dropdown/.test(missing.error) && missing.error.includes("1261"),
  missing.error
);

useDom({ selects: [] });
const noDropdown = await S.selectTerm(1261, { settleMs: 40 });
check("missing dropdown is reported distinctly", /Term \*/.test(noDropdown.error || ""), JSON.stringify(noDropdown));

/* ------------------------------------------------ dom scraping guard */
heading("scrapeTable course guard");
const headerRow = {
  innerText: "Code Section Instructor Schedule",
  cells: [{ innerText: "Code" }, { innerText: "Section" }, { innerText: "Instructor" }, { innerText: "Schedule" }],
};
function fakeRow(code, section, instructor, schedule) {
  return {
    cells: [{ innerText: code }, { innerText: section }, { innerText: instructor }, { innerText: schedule }],
    getBoundingClientRect: rect,
  };
}
const bodyRows = [
  fakeRow("PI 10", "S1", "DELA CRUZ, JUAN P.", "TTh 8:30 AM - 10:00 AM SMA LH"),
  fakeRow("PI 100", "S1", "SOMEONE, ELSE A.", "MWF 9:00 AM - 10:00 AM X"),
  fakeRow("HUM 1", "S3", "OTHER, PERSON B.", "MWF 1:00 PM - 2:00 PM Y"),
];
const fakeTable = {
  getBoundingClientRect: rect,
  rows: [headerRow],
  querySelector: () => headerRow,
  querySelectorAll: (sel) => (String(sel).includes("tbody") ? bodyRows : []),
};
globalThis.document = {
  getElementById: () => null,
  body: { innerText: "" },
  querySelectorAll: (raw) => (String(raw) === "table" ? [fakeTable] : []),
};
const scraped = S.scrapeTable("PI 10", 1261);
check("keeps the requested course", scraped.records.length === 1, JSON.stringify(scraped.records));
check("keeps the instructor", scraped.records[0]?.instructor === "DELA CRUZ, JUAN P.", JSON.stringify(scraped.records[0]));
check("parses the schedule", scraped.records[0]?.days === "TTH", JSON.stringify(scraped.records[0]));
check("skips other subjects instead of mislabelling them", scraped.skipped === 2, String(scraped.skipped));

heading("AMIS Class Details + Faculty cards");
const detailsHead = {
  innerText: "Code Class Details Action",
  cells: [{ innerText: "Code" }, { innerText: "Class Details" }, { innerText: "Action" }],
};
const detailsBody = [
  {
    cells: [
      { innerText: "ARTS 1" },
      {
        innerText:
          "Lecture/Main 3 units\nA2 - (07:00AM - 08:30AM)\nFaculty: VELA, JUALIM\nLocation: CAS B05\nW F\nCo-Req: None",
      },
      { innerText: "-- No Associated Class -- Inactive Term" },
    ],
    getBoundingClientRect: rect,
  },
  {
    cells: [
      { innerText: "ARTS 1" },
      {
        innerText:
          "Lecture/Main 3 units\nA3 - (07:00AM - 08:30AM)\nFaculty: ONG, LEANDRO\nLocation: CAS B05",
      },
      { innerText: "Inactive Term" },
    ],
    getBoundingClientRect: rect,
  },
];
const detailsTable = {
  getBoundingClientRect: rect,
  rows: [detailsHead, ...detailsBody],
  querySelector: (sel) => (String(sel).includes("thead") ? detailsHead : detailsHead),
  querySelectorAll: (sel) => (String(sel).includes("tbody") ? detailsBody : []),
};
globalThis.document = {
  getElementById: () => null,
  body: { innerText: "Faculty: VELA, JUALIM Inactive Term" },
  querySelectorAll: (raw) => (String(raw) === "table" ? [detailsTable] : []),
};
const arts = S.scrapeTable("ARTS 1", 1241);
check("two ARTS 1 sections from Class Details", arts.records.length === 2, JSON.stringify(arts.records));
check("A2 faculty is VELA", arts.records[0]?.instructor === "VELA, JUALIM", JSON.stringify(arts.records[0]));
check("A3 faculty is ONG", arts.records[1]?.instructor === "ONG, LEANDRO", JSON.stringify(arts.records[1]));
check("room from Location", arts.records[0]?.room === "CAS B05", JSON.stringify(arts.records[0]));

console.log(lines.join("\n"));
console.log(`\n${failures ? `${failures} FAILURE(S)` : "ALL CHECKS PASSED"}`);
process.exit(failures ? 1 : 0);
