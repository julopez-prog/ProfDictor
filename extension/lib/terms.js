/**
 * Profdictor - term code helpers.
 *
 * AMIS term codes look like `1261 - First Semester (2026-2027)`.
 * Layout is PREFIX(2) + YEAR_DIGIT(1) + SEMESTER(1):
 *   12 | 6 | 1   ->  AY 2026-2027, First Semester
 * Semester digit: 1 = First, 2 = Second, 3 = Midyear.
 * Year digit maps 3 -> 2023-2024, 4 -> 2024-2025, 5 -> 2025-2026, 6 -> 2026-2027.
 *
 * Numeric order of the raw code is already chronological, so plain `a - b`
 * sorting gives calendar order and no custom comparator is needed.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.terms) return;

  const SEMESTERS = { 1: "First Semester", 2: "Second Semester", 3: "Midyear" };
  const DEFAULT_FLOOR = 1231;

  /** Year digit -> starting calendar year. Digits 0-2 are read as the 2030s. */
  function startYearFor(yearDigit) {
    return yearDigit >= 3 ? 2020 + yearDigit : 2030 + yearDigit;
  }

  function isTermCode(value) {
    return /^\d{4}$/.test(String(value ?? "").trim());
  }

  /** Split `1261` into its parts, or return null when the shape is unusable. */
  function parse(code) {
    const raw = String(code ?? "").trim();
    if (!isTermCode(raw)) return null;
    const prefix = Number(raw.slice(0, 2));
    const yearDigit = Number(raw[2]);
    const semester = Number(raw[3]);
    if (!SEMESTERS[semester]) return null;
    const startYear = startYearFor(yearDigit);
    return {
      code: Number(raw),
      raw,
      prefix,
      yearDigit,
      semester,
      startYear,
      endYear: startYear + 1,
      academicYear: `${startYear}-${startYear + 1}`,
      semesterLabel: SEMESTERS[semester],
    };
  }

  function label(code) {
    const t = parse(code);
    if (!t) return String(code);
    return `${t.raw} - ${t.semesterLabel} (${t.academicYear})`;
  }

  function shortLabel(code) {
    const t = parse(code);
    if (!t) return String(code);
    const tag = t.semester === 3 ? "MY" : `S${t.semester}`;
    return `${t.raw} ${tag} ${t.startYear % 100}-${t.endYear % 100}`;
  }

  /**
   * Distance in *semesters* between two terms. Used by the recency decay so a
   * gap of one semester counts as 1 regardless of the year rollover.
   */
  function distance(fromCode, toCode) {
    const a = parse(fromCode);
    const b = parse(toCode);
    if (!a || !b) return 0;
    const ai = (a.prefix * 10 + a.yearDigit) * 3 + (a.semester - 1);
    const bi = (b.prefix * 10 + b.yearDigit) * 3 + (b.semester - 1);
    return bi - ai;
  }

  /**
   * Every valid term code in `[floor, target)`, chronologically.
   * The target term itself is excluded because it is what we are predicting;
   * backtests add it back separately as ground truth.
   */
  function historyFor(targetCode, floorCode = DEFAULT_FLOOR) {
    const target = parse(targetCode);
    const floor = parse(floorCode) || parse(DEFAULT_FLOOR);
    if (!target) return [];
    const out = [];
    for (let prefix = floor.prefix; prefix <= target.prefix; prefix += 1) {
      for (let year = 0; year <= 9; year += 1) {
        for (let semester = 1; semester <= 3; semester += 1) {
          const code = prefix * 100 + year * 10 + semester;
          if (code < floor.code || code >= target.code) continue;
          out.push(code);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** Same semester slot in earlier years, e.g. 1261 -> [1231, 1241, 1251]. */
  function sameSemesterHistory(targetCode, floorCode = DEFAULT_FLOOR) {
    const target = parse(targetCode);
    if (!target) return [];
    return historyFor(targetCode, floorCode).filter((c) => parse(c)?.semester === target.semester);
  }

  PD.terms = {
    SEMESTERS,
    DEFAULT_FLOOR,
    isTermCode,
    parse,
    label,
    shortLabel,
    distance,
    historyFor,
    sameSemesterHistory,
  };
})();
