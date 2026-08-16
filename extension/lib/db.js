/**
 * Profdictor - local dataset store.
 *
 * Caching rule that matters: a past term whose instructors were published never
 * changes again, so it is cached permanently. A term that came back all-TBA is
 * still in flux and gets a short TTL, because that is precisely the term whose
 * professors will be revealed later. This is what stops the extension from
 * re-scanning nine semesters every time a user retypes a course code.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.db) return;

  const { names, terms } = PD;

  const DB_KEY = "profdictor.db.v2";
  const CFG_KEY = "profdictor.config.v1";
  const UNRESOLVED_TTL_MS = 6 * 60 * 60 * 1000;

  function courseKey(courseCode) {
    return names.normalize(courseCode).replace(/\s+/g, " ").trim();
  }

  function emptyDb() {
    return { version: 2, courses: {}, verified: {}, updatedAt: 0 };
  }

  async function raw() {
    const got = await chrome.storage.local.get(DB_KEY);
    const db = got?.[DB_KEY];
    if (!db || db.version !== 2) return emptyDb();
    return db;
  }

  async function write(db) {
    db.updatedAt = Date.now();
    await chrome.storage.local.set({ [DB_KEY]: db });
    return db;
  }

  /* ------------------------------------------------------------------ *
   * Records
   * ------------------------------------------------------------------ */

  /** Normalise anything the scanner produced into the canonical record shape. */
  function normalizeRecord(rec, courseCode, term) {
    const instructor = String(rec.instructor ?? "").trim();
    const isTba = !instructor || names.isTba(instructor);
    return {
      term: Number(term),
      courseCode: courseKey(courseCode),
      section: String(rec.section ?? "").trim().toUpperCase(),
      instructor: isTba ? "" : instructor,
      profKey: isTba ? "" : names.canonicalKey(instructor),
      days: String(rec.days ?? "").trim(),
      timeStart: String(rec.timeStart ?? "").trim(),
      timeEnd: String(rec.timeEnd ?? "").trim(),
      room: String(rec.room ?? "").trim(),
      classId: rec.classId ?? null,
      status: rec.status ?? "",
      source: rec.source || "api",
    };
  }

  /** AMIS sometimes reports co-teachers as one string joined by "AND". */
  function splitInstructors(instructor) {
    const raw = String(instructor ?? "").trim();
    if (!raw) return [raw];
    const parts = raw
      .split(/\s+AND\s+/i)
      .map((part) => part.trim())
      .filter((part) => part && !names.isTba(part));
    return parts.length ? [...new Set(parts)] : [raw];
  }

  function dedupe(records) {
    const map = new Map();
    for (const r of records) {
      if (!r.section) continue;
      // Keep distinct co-teachers, but collapse duplicate copies of the same
      // instructor for a section. A named row also supersedes a TBA row.
      const key = `${r.term}|${r.section}|${r.profKey || "__TBA__"}`;
      const prior = map.get(key);
      if (!prior || (!prior.profKey && r.profKey)) map.set(key, r);
    }
    const values = [...map.values()];
    const namedSections = new Set(values.filter((r) => r.profKey).map((r) => `${r.term}|${r.section}`));
    return values.filter((r) => r.profKey || !namedSections.has(`${r.term}|${r.section}`));
  }

  async function putTerm(courseCode, term, records, meta = {}) {
    const db = await raw();
    const ck = courseKey(courseCode);
    if (!db.courses[ck]) db.courses[ck] = { courseCode: ck, terms: {} };
    const normalized = dedupe(
      records.flatMap((r) =>
        splitInstructors(r.instructor).map((instructor) => normalizeRecord({ ...r, instructor }, ck, term))
      )
    );
    const revealed = normalized.filter((r) => r.profKey).length;
    db.courses[ck].terms[String(term)] = {
      term: Number(term),
      scannedAt: Date.now(),
      records: normalized,
      revealed,
      total: normalized.length,
      source: meta.source || "api",
      fieldReport: meta.fieldReport || null,
    };
    await write(db);
    return db.courses[ck].terms[String(term)];
  }

  async function getTerm(courseCode, term) {
    const db = await raw();
    return db.courses[courseKey(courseCode)]?.terms?.[String(term)] || null;
  }

  /**
   * First-page-only DOM scrapes used to be cached forever once they had a
   * single named professor. Those entries look "revealed" but are missing
   * most sections. A finished walk sets fieldReport.exhausted.
   */
  function recordSignature(records) {
    return (records || [])
      .map((r) => `${String(r.section || "").toUpperCase()}|${r.profKey || ""}|${r.days || ""}|${r.timeStart || ""}`)
      .sort()
      .join("\n");
  }

  /** Midyear scrape that is a carbon copy of the preceding Second Sem. */
  function looksCopiedFromPriorTerm(entry, prior) {
    if (!entry?.records?.length || !prior?.records?.length) return false;
    if (terms.parse(entry.term)?.semester !== 3) return false;
    if (Number(prior.term) !== Number(entry.term) - 1) return false;
    if (entry.records.length !== prior.records.length) return false;
    return recordSignature(entry.records) === recordSignature(prior.records);
  }

  function looksIncomplete(entry) {
    if (!entry || !entry.total) return true;
    const fr = entry.fieldReport || {};
    if (fr.exhausted) return false;
    if (entry.source === "dom" && !fr.exhausted) {
      if (fr.pages == null) return true;
      if (fr.pages === 1 && entry.total <= 5) return true;
    }
    return false;
  }

  /**
   * A cached term is reusable when it exists, looks complete, and either
   * published at least one instructor (final) or was scanned recently (still
   * TBA, may change).
   */
  async function isFresh(courseCode, term) {
    const entry = await getTerm(courseCode, term);
    if (!entry) return false;
    // An empty scan is a miss, not a cacheable result. The API used to store
    // "0 rows" for every past term and then refuse to look at the page.
    if (!entry.total) return false;
    if (looksIncomplete(entry)) return false;
    if (terms.parse(term)?.semester === 3) {
      const prior = await getTerm(courseCode, Number(term) - 1);
      if (looksCopiedFromPriorTerm(entry, prior)) return false;
    }
    if (entry.revealed > 0) return true;
    return Date.now() - entry.scannedAt < UNRESOLVED_TTL_MS;
  }

  async function missingTerms(courseCode, termList, opts = {}) {
    const forceTerms = new Set((opts.forceTerms || []).map(Number));
    const out = [];
    for (const term of termList) {
      if (forceTerms.has(Number(term))) {
        out.push(term);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (!(await isFresh(courseCode, term))) out.push(term);
    }
    return out;
  }

  /** Every record for a course, with moderator-verified instructors merged in. */
  async function allRecords(courseCode) {
    const db = await raw();
    const ck = courseKey(courseCode);
    const course = db.courses[ck];
    if (!course) return [];
    const records = Object.values(course.terms).flatMap((t) => t.records || []);

    const verified = db.verified[ck] || {};
    return records.map((r) => {
      const hit = verified[`${r.term}|${r.section}`];
      if (!hit) return r;
      // Ground truth overrides whatever AMIS showed (or hid).
      return {
        ...r,
        instructor: hit.instructor,
        profKey: hit.profKey,
        source: "verified",
        verifiedBy: hit.by || "",
        verifiedAt: hit.at || 0,
      };
    });
  }

  async function courseSummary(courseCode) {
    const db = await raw();
    const course = db.courses[courseKey(courseCode)];
    if (!course) return null;
    const termEntries = Object.values(course.terms).sort((a, b) => a.term - b.term);
    return {
      courseCode: course.courseCode,
      terms: termEntries.map((t) => ({
        term: t.term,
        label: terms.label(t.term),
        revealed: t.revealed,
        total: t.total,
        scannedAt: t.scannedAt,
        source: t.source,
      })),
      totalRecords: termEntries.reduce((a, t) => a + (t.total || 0), 0),
      totalRevealed: termEntries.reduce((a, t) => a + (t.revealed || 0), 0),
    };
  }

  async function listCourses() {
    const db = await raw();
    return Object.values(db.courses).map((c) => ({
      courseCode: c.courseCode,
      termCount: Object.keys(c.terms).length,
      records: Object.values(c.terms).reduce((a, t) => a + (t.total || 0), 0),
      revealed: Object.values(c.terms).reduce((a, t) => a + (t.revealed || 0), 0),
    }));
  }

  async function clearCourse(courseCode) {
    const db = await raw();
    delete db.courses[courseKey(courseCode)];
    await write(db);
  }

  async function clearAll() {
    await chrome.storage.local.set({ [DB_KEY]: emptyDb() });
  }

  /* ------------------------------------------------------------------ *
   * Moderator-verified ground truth
   * ------------------------------------------------------------------ */

  async function setVerified(courseCode, term, section, instructor, by = "") {
    const db = await raw();
    const ck = courseKey(courseCode);
    if (!db.verified[ck]) db.verified[ck] = {};
    const sec = String(section).trim().toUpperCase();
    const clean = String(instructor).trim();
    if (!clean) {
      delete db.verified[ck][`${term}|${sec}`];
    } else {
      db.verified[ck][`${term}|${sec}`] = {
        term: Number(term),
        section: sec,
        instructor: clean,
        profKey: names.canonicalKey(clean),
        by,
        at: Date.now(),
      };
    }
    await write(db);
    return db.verified[ck];
  }

  async function getVerified(courseCode) {
    const db = await raw();
    return Object.values(db.verified[courseKey(courseCode)] || {});
  }

  async function allVerified() {
    const db = await raw();
    return Object.entries(db.verified).flatMap(([ck, entries]) =>
      Object.values(entries).map((e) => ({ ...e, courseCode: ck }))
    );
  }

  /** Merge records pulled from the shared Worker registry. */
  async function mergeRemoteVerified(rows) {
    const db = await raw();
    let added = 0;
    for (const row of rows || []) {
      const ck = courseKey(row.courseCode || row.course_code || "");
      const sec = String(row.section || "").trim().toUpperCase();
      const instructor = String(row.instructor || "").trim();
      if (!ck || !sec || !instructor || !row.term) continue;
      if (!db.verified[ck]) db.verified[ck] = {};
      const key = `${row.term}|${sec}`;
      const prior = db.verified[ck][key];
      const at = Number(row.at || row.updatedAt || Date.now());
      if (prior && prior.at >= at) continue;
      db.verified[ck][key] = {
        term: Number(row.term),
        section: sec,
        instructor,
        profKey: names.canonicalKey(instructor),
        by: row.by || "registry",
        at,
      };
      added += 1;
    }
    if (added) await write(db);
    return added;
  }

  /* ------------------------------------------------------------------ *
   * Config + portability
   * ------------------------------------------------------------------ */

  const DEFAULT_CONFIG = {
    courseCode: "",
    targetTerm: 1261,
    floorTerm: 1231,
    limit: 5,
    halfLife: 4,
    throttleMs: 80,
    // Auto tries the API first and drops to DOM scraping per term if the app's
    // class endpoint cannot be reached at all.
    scanMode: "dom",
    includeTargetTerm: true,
    // ALL = every section. A letter (B) predicts that family: B, B1, B2…
    sectionFilter: "ALL",
    // Padder — shipped experiment (v1.5.2). Editable in Advanced.
    votePad: 1,
    voteDepth: 0,
    voteMix: 0.4,
    voteFloor: 0.02,
    crossPrior: 5,
    tuneWeights: true,
    lineup: "auto",
    goal: "topn",
  };

  async function loadConfig() {
    const got = await chrome.storage.local.get(CFG_KEY);
    return { ...DEFAULT_CONFIG, ...(got?.[CFG_KEY] || {}) };
  }

  async function saveConfig(patch) {
    const next = { ...(await loadConfig()), ...patch };
    await chrome.storage.local.set({ [CFG_KEY]: next });
    return next;
  }

  async function exportJson() {
    return JSON.stringify(await raw(), null, 2);
  }

  async function importJson(text) {
    const parsed = JSON.parse(text);
    if (parsed?.version !== 2) throw new Error("Unsupported dataset version");
    await write(parsed);
    return true;
  }

  async function stats() {
    const db = await raw();
    const courses = Object.values(db.courses);
    return {
      courses: courses.length,
      terms: courses.reduce((a, c) => a + Object.keys(c.terms).length, 0),
      records: courses.reduce(
        (a, c) => a + Object.values(c.terms).reduce((b, t) => b + (t.total || 0), 0),
        0
      ),
      verified: Object.values(db.verified).reduce((a, v) => a + Object.keys(v).length, 0),
      bytes: JSON.stringify(db).length,
      updatedAt: db.updatedAt,
    };
  }

  PD.db = {
    DB_KEY,
    CFG_KEY,
    DEFAULT_CONFIG,
    UNRESOLVED_TTL_MS,
    courseKey,
    normalizeRecord,
    dedupe,
    putTerm,
    getTerm,
    isFresh,
    looksIncomplete,
    looksCopiedFromPriorTerm,
    missingTerms,
    allRecords,
    courseSummary,
    listCourses,
    clearCourse,
    clearAll,
    setVerified,
    getVerified,
    allVerified,
    mergeRemoteVerified,
    loadConfig,
    saveConfig,
    exportJson,
    importJson,
    stats,
  };
})();
