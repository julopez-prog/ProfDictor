/**
 * Profdictor - feature engineering.
 *
 * One row of the design matrix describes a (section, candidate professor) pair.
 * Every feature is scaled to roughly [0,1] so the linear model's weights stay
 * comparable and the forest's thresholds stay readable.
 *
 * The strongest real-world signal is the *schedule*: AMIS hides the instructor
 * on an unreleased term but still publishes days/time/room, and faculty tend to
 * keep the same teaching slot year over year. Semester alignment matters too --
 * a First Semester assignment predicts First Semester far better than Midyear.
 *
 * Sections also move together. If ONG has B/C in the same term that GARCIA has
 * G/H, a confident guess on B should lift GARCIA on G. That is what the
 * partner/bundle features measure.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.features) return;

  const { terms, names } = PD;

  /** Semesters of half-weight. 4 = two academic years back counts half. */
  const DEFAULT_HALF_LIFE = 4;

  const FEATURE_NAMES = [
    "freqDecay",
    "sameSemShare",
    "sectionExact",
    "sectionFamily",
    "slotAffinity",
    "dayAffinity",
    "timeAffinity",
    "roomAffinity",
    "recencyLastSeen",
    "streakRatio",
    "loadShare",
    "tenureSpan",
    "verified",
    "partnerCond",
    "partnerPair",
    "bundleFit",
    "lastSameSem",
    "newcomerFit",
    "successorFit",
    "componentFit",
  ];

  const DAY_TOKENS = ["TH", "SA", "SU", "M", "T", "W", "F", "S"];

  /** "T TH" / "TTh" / "M-W-F" -> ["T","TH"]. Longest tokens matched first. */
  function parseDays(value) {
    const s = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    const out = [];
    let i = 0;
    while (i < s.length) {
      const hit = DAY_TOKENS.find((tok) => s.startsWith(tok, i));
      if (hit) {
        if (!out.includes(hit)) out.push(hit);
        i += hit.length;
      } else {
        i += 1;
      }
    }
    return out;
  }

  /** "8:30 AM" / "0830" / "13:00" -> minutes past midnight, or null. */
  function parseTime(value) {
    const s = String(value ?? "").trim().toUpperCase();
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[:.]?(\d{2})?\s*(AM|PM)?/);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = Number(m[2] || 0);
    const meridiem = m[3];
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    // AMIS class times without AM/PM: 1-6 almost always means afternoon.
    if (!meridiem && hour >= 1 && hour <= 6) hour += 12;
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function dayJaccard(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let shared = 0;
    for (const d of a) if (setB.has(d)) shared += 1;
    const union = new Set([...a, ...b]).size;
    return union ? shared / union : 0;
  }

  /** 1.0 at the same start time, decaying to 0 three hours apart. */
  function timeSimilarity(a, b) {
    if (a == null || b == null) return 0;
    return Math.max(0, 1 - Math.abs(a - b) / 180);
  }

  /** Section "E-3L" -> family "E"; groups lab/lecture siblings together. */
  function sectionFamily(section) {
    const s = names.normalize(section).replace(/\s+/g, "");
    const m = s.match(/^([A-Z]+)/);
    return m ? m[1] : s.slice(0, 1);
  }

  /**
   * UPLB lecture vs lab/recit. "G" / "B1" are lecture; "G-1L" / "E-3L" / "B1L"
   * are laboratory or recitation. Used to split generalized faculty lists.
   */
  function sectionKind(section) {
    const s = names.normalize(section).replace(/\s+/g, "");
    if (!s) return "lecture";
    if (/(?:LAB|RECIT|RECI)$/.test(s)) return "lab";
    if (/-\d*L$/.test(s)) return "lab";
    if (/[A-Z]+\d+L$/.test(s)) return "lab";
    return "lecture";
  }

  /**
   * Popup "SPECIFIC SECTION" field: letters only, or ALL.
   * "B" matches B, B1, B2, B3…  "A,C" matches both families. Empty = ALL.
   */
  function parseSectionFilter(raw) {
    const letters = String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (!letters || letters === "ALL") {
      return { all: true, letters: [], label: "ALL" };
    }
    const unique = [...new Set(letters.replace(/ALL/g, "").split(""))].filter((c) => /[A-Z]/.test(c));
    if (!unique.length) return { all: true, letters: [], label: "ALL" };
    return { all: false, letters: unique, label: unique.join(", ") };
  }

  function sanitizeSectionInput(raw) {
    const parsed = parseSectionFilter(raw);
    return parsed.all ? "ALL" : parsed.letters.join("");
  }

  function sectionAllowed(section, filter) {
    if (!filter || filter.all) return true;
    return filter.letters.includes(sectionFamily(section));
  }

  function compareSections(a, b) {
    const sa = String(a || "").toUpperCase();
    const sb = String(b || "").toUpperCase();
    const fa = sectionFamily(sa);
    const fb = sectionFamily(sb);
    if (fa !== fb) return fa.localeCompare(fb);
    const ka = sectionKind(sa);
    const kb = sectionKind(sb);
    if (ka !== kb) return ka === "lecture" ? -1 : 1;
    const na = Number((sa.match(/\d+/) || ["0"])[0]);
    const nb = Number((sb.match(/\d+/) || ["0"])[0]);
    return na - nb || sa.localeCompare(sb);
  }

  /**
   * Predict every matching section the course has ever offered, not only the
   * rows AMIS currently lists for the target term (which is often just page 1).
   */
  function unionTargetSections(records, targetTerm, filter) {
    const bySection = new Map();
    const allowed = (r) => !r?.section || !filter || filter.all || sectionAllowed(r.section, filter);
    for (const r of records || []) {
      if (r.term !== targetTerm || !allowed(r) || !r.section) continue;
      bySection.set(r.section, { ...r, inheritedFrom: null });
    }
    const hist = (records || [])
      .filter((r) => r.term < targetTerm && r.section && allowed(r))
      .sort((a, b) => b.term - a.term);
    for (const r of hist) {
      if (bySection.has(r.section)) continue;
      bySection.set(r.section, {
        ...r,
        term: targetTerm,
        instructor: "",
        profKey: "",
        inheritedFrom: r.term,
      });
    }
    return [...bySection.values()].sort((a, b) => compareSections(a.section, b.section));
  }

  function decayWeight(termCode, targetCode, halfLife = DEFAULT_HALF_LIFE) {
    const gap = Math.abs(terms.distance(termCode, targetCode));
    return Math.pow(0.5, gap / halfLife);
  }

  /**
   * Aggregate per-professor history for one course.
   * `records` must already be filtered to the course and to terms < target.
   */
  function buildProfiles(records, targetTerm, halfLife = DEFAULT_HALF_LIFE) {
    const profiles = new Map();
    const termSet = new Set();
    let totalWeight = 0;

    for (const r of records) {
      if (!r.profKey) continue;
      termSet.add(r.term);
      const w = decayWeight(r.term, targetTerm, halfLife);
      totalWeight += w;

      let p = profiles.get(r.profKey);
      if (!p) {
        p = {
          profKey: r.profKey,
          displayName: names.displayName(r.instructor || r.profKey),
          rawNames: new Set(),
          weight: 0,
          count: 0,
          terms: new Set(),
          semesterWeight: { 1: 0, 2: 0, 3: 0 },
          sections: new Map(),
          families: new Map(),
          components: { lecture: 0, lab: 0 },
          slots: [],
          rooms: new Map(),
          perTermCount: new Map(),
          lastTerm: null,
          firstTerm: null,
          sectionFirst: new Map(),
          sectionLast: new Map(),
          familyFirst: new Map(),
        };
        profiles.set(r.profKey, p);
      }

      if (r.instructor) p.rawNames.add(r.instructor);
      p.weight += w;
      p.count += 1;
      p.terms.add(r.term);
      const sem = terms.parse(r.term)?.semester;
      if (sem) p.semesterWeight[sem] += w;
      p.sections.set(r.section, (p.sections.get(r.section) || 0) + w);
      const fam = sectionFamily(r.section);
      p.families.set(fam, (p.families.get(fam) || 0) + w);
      const kind = sectionKind(r.section);
      p.components[kind] = (p.components[kind] || 0) + w;
      if (r.room) p.rooms.set(names.normalize(r.room), (p.rooms.get(names.normalize(r.room)) || 0) + w);
      p.slots.push({ days: parseDays(r.days), start: parseTime(r.timeStart), weight: w });
      p.perTermCount.set(r.term, (p.perTermCount.get(r.term) || 0) + 1);
      p.lastTerm = p.lastTerm == null ? r.term : Math.max(p.lastTerm, r.term);
      p.firstTerm = p.firstTerm == null ? r.term : Math.min(p.firstTerm, r.term);
      if (!p.sectionFirst.has(r.section) || r.term < p.sectionFirst.get(r.section)) {
        p.sectionFirst.set(r.section, r.term);
      }
      if (!p.sectionLast.has(r.section) || r.term > p.sectionLast.get(r.section)) {
        p.sectionLast.set(r.section, r.term);
      }
      if (!p.familyFirst.has(fam) || r.term < p.familyFirst.get(fam)) p.familyFirst.set(fam, r.term);
    }

    const historyTerms = [...termSet].sort((a, b) => a - b);
    const spanSemesters = historyTerms.length
      ? Math.abs(terms.distance(historyTerms[0], targetTerm)) || 1
      : 1;

    for (const p of profiles.values()) {
      p.avgLoad =
        p.perTermCount.size ? [...p.perTermCount.values()].reduce((a, b) => a + b, 0) / p.perTermCount.size : 0;
      p.tenure = p.terms.size / Math.max(1, historyTerms.length);
      p.gapSinceLastSeen = p.lastTerm == null ? spanSemesters : Math.abs(terms.distance(p.lastTerm, targetTerm));
    }

    return { profiles, totalWeight, historyTerms, spanSemesters };
  }

  /**
   * Feature vector for "does `profKey` teach `section`?".
   * `section` is `{ section, days, timeStart, room }` from the target term.
   */
  function featureVector(section, profKey, ctx) {
    const { profiles, totalWeight, historyTerms, targetTerm, verifiedSet, halfLife } = ctx;
    const p = profiles.get(profKey);
    if (!p) return new Array(FEATURE_NAMES.length).fill(0);

    const targetSem = terms.parse(targetTerm)?.semester;
    const sectionKey = section.section;
    const fam = sectionFamily(sectionKey);
    const kind = sectionKind(sectionKey);
    const sectionWeight = p.sections.get(sectionKey) || 0;
    const familyWeight = p.families.get(fam) || 0;
    const componentWeight = p.components?.[kind] || 0;

    const freqDecay = totalWeight ? p.weight / totalWeight : 0;

    const semTotal = p.semesterWeight[1] + p.semesterWeight[2] + p.semesterWeight[3];
    const sameSemShare = semTotal && targetSem ? p.semesterWeight[targetSem] / semTotal : 0;

    const sectionExact = p.weight ? Math.min(1, sectionWeight / p.weight) : 0;
    const sectionFamilyScore = p.weight ? Math.min(1, familyWeight / p.weight) : 0;
    const componentFit = p.weight ? Math.min(1, componentWeight / p.weight) : 0;

    const targetDays = parseDays(section.days);
    const targetStart = parseTime(section.timeStart);
    let dayAffinity = 0;
    let timeAffinity = 0;
    let slotAffinity = 0;
    for (const slot of p.slots) {
      const d = dayJaccard(targetDays, slot.days);
      const t = timeSimilarity(targetStart, slot.start);
      dayAffinity = Math.max(dayAffinity, d);
      timeAffinity = Math.max(timeAffinity, t);
      // Both matching at once is the meaningful event, not either alone.
      slotAffinity = Math.max(slotAffinity, d * t);
    }

    const roomKey = names.normalize(section.room || "");
    const roomAffinity = roomKey && p.rooms.has(roomKey) ? Math.min(1, p.rooms.get(roomKey) / p.weight) : 0;

    // Attrition: a prof absent for several semesters has probably moved on.
    const recencyLastSeen = Math.pow(0.5, p.gapSinceLastSeen / halfLife);

    const recent = historyTerms.slice(-4);
    const streakRatio = recent.length
      ? recent.filter((t) => p.terms.has(t)).length / recent.length
      : 0;

    const loadShare = Math.min(1, p.avgLoad / 4);
    const tenureSpan = Math.min(1, p.tenure);

    const verified = verifiedSet && verifiedSet.has(`${targetTerm}|${sectionKey}|${profKey}`) ? 1 : 0;
    const cohort = cohortSignals(section, profKey, ctx);
    const seat = seatSignals(section, profKey, p, ctx);

    return [
      freqDecay,
      sameSemShare,
      sectionExact,
      sectionFamilyScore,
      slotAffinity,
      dayAffinity,
      timeAffinity,
      roomAffinity,
      recencyLastSeen,
      streakRatio,
      loadShare,
      tenureSpan,
      verified,
      cohort.partnerCond,
      cohort.partnerPair,
      cohort.bundleFit,
      seat.lastSameSem,
      seat.newcomerFit,
      seat.successorFit,
      componentFit,
    ];
  }

  /**
   * Who last sat in each section, and whether that seat looks vacated.
   * A first-sem-only regular is not "gone" just because 2nd/midyear elapsed.
   */
  function buildSectionMemory(records, targetTerm, profiles) {
    const bySec = new Map();
    const targetSem = terms.parse(targetTerm)?.semester;
    for (const r of records || []) {
      if (!r.section || !r.profKey) continue;
      if (!bySec.has(r.section)) bySec.set(r.section, []);
      bySec.get(r.section).push(r);
    }
    const memory = new Map();
    for (const [sec, rows] of bySec) {
      rows.sort((a, b) => a.term - b.term);
      const last = rows[rows.length - 1];
      const sameSem = targetSem ? rows.filter((r) => terms.parse(r.term)?.semester === targetSem) : [];
      const lastSame = sameSem[sameSem.length - 1] || null;
      const lastOcc = profiles?.get(last.profKey);
      const gap = lastOcc?.gapSinceLastSeen ?? 99;
      const profs = new Set(rows.map((r) => r.profKey));
      const termN = new Set(rows.map((r) => r.term)).size;
      memory.set(sec, {
        lastProf: last.profKey,
        lastTerm: last.term,
        lastSameSemProf: lastSame?.profKey || null,
        lastSameSemTerm: lastSame?.term || null,
        prevProf: rows.length >= 2 ? rows[rows.length - 2].profKey : null,
        turnover: termN ? profs.size / termN : 0,
        vacant: gap >= 4,
      });
    }
    return memory;
  }

  function seatSignals(section, profKey, profile, ctx) {
    const mem = ctx.sectionMemory?.get(section.section);
    if (!mem || !profile) return { lastSameSem: 0, newcomerFit: 0, successorFit: 0 };
    const stillAround = profile.gapSinceLastSeen < 4;
    const lastSameSem = mem.lastSameSemProf === profKey && stillAround ? 1 : 0;
    const oneOrTwoTerms = profile.terms.size <= 2;
    const recent = profile.gapSinceLastSeen <= 2;
    const newcomerFit =
      oneOrTwoTerms && recent ? (0.35 + (mem.vacant ? 0.45 : 0) + (mem.turnover >= 0.45 ? 0.2 : 0)) : 0;
    let successorFit = 0;
    if (mem.vacant && mem.lastProf && mem.lastProf !== profKey && oneOrTwoTerms && recent) {
      const myFirst = profile.sectionFirst.get(section.section) ?? profile.familyFirst.get(sectionFamily(section.section));
      if (myFirst != null && mem.lastTerm != null && myFirst > mem.lastTerm) successorFit = 0.9;
      else if (mem.vacant) successorFit = 0.45;
    }
    return {
      lastSameSem,
      newcomerFit: Math.min(1, newcomerFit),
      successorFit,
    };
  }

  function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /**
   * Same-term snapshots: who taught with whom, and who took a bundle of
   * sections in one semester. Used to lift a candidate when other sections'
   * first-pass guesses match a historical pairing.
   */
  function buildCohorts(records, targetTerm, halfLife = DEFAULT_HALF_LIFE) {
    const byTerm = new Map();
    for (const r of records || []) {
      if (!r.profKey || !r.section) continue;
      if (!byTerm.has(r.term)) byTerm.set(r.term, []);
      byTerm.get(r.term).push(r);
    }

    const condSec = new Map();
    const condFam = new Map();
    const pairW = new Map();
    const profW = new Map();
    const bundle = new Map();

    const entry = (store, key) => {
      let e = store.get(key);
      if (!e) {
        e = { denom: 0, hits: new Map() };
        store.set(key, e);
      }
      return e;
    };

    for (const [term, rows] of byTerm) {
      const w = decayWeight(term, targetTerm, halfLife);
      const uniqueProfs = [...new Set(rows.map((r) => r.profKey))];
      for (const p of uniqueProfs) profW.set(p, (profW.get(p) || 0) + w);
      for (let i = 0; i < uniqueProfs.length; i += 1) {
        for (let j = i + 1; j < uniqueProfs.length; j += 1) {
          const k = pairKey(uniqueProfs[i], uniqueProfs[j]);
          pairW.set(k, (pairW.get(k) || 0) + w);
        }
      }

      for (const b of rows) {
        const secE = entry(condSec, `${b.section}|${b.profKey}`);
        secE.denom += w;
        for (const a of rows) {
          if (a.section === b.section) continue;
          const hk = `${a.section}|${a.profKey}`;
          secE.hits.set(hk, (secE.hits.get(hk) || 0) + w);
        }
      }

      const famPairs = new Map();
      for (const r of rows) {
        const f = sectionFamily(r.section);
        const k = `${f}|${r.profKey}`;
        if (!famPairs.has(k)) famPairs.set(k, { fam: f, prof: r.profKey });
      }
      for (const [, b] of famPairs) {
        const famE = entry(condFam, `${b.fam}|${b.prof}`);
        famE.denom += w;
        for (const [, a] of famPairs) {
          if (a.fam === b.fam && a.prof === b.prof) continue;
          const hk = `${a.fam}|${a.prof}`;
          famE.hits.set(hk, (famE.hits.get(hk) || 0) + w);
        }
      }

      for (const b of rows) {
        const bf = sectionFamily(b.section);
        const bunE = entry(bundle, `${bf}|${b.profKey}`);
        bunE.denom += w;
        for (const a of rows) {
          if (a.section === b.section || a.profKey !== b.profKey) continue;
          const af = sectionFamily(a.section);
          bunE.hits.set(af, (bunE.hits.get(af) || 0) + w);
        }
      }
    }

    return { condSec, condFam, pairW, profW, bundle };
  }

  function condLookup(store, otherKey, otherProf, selfKey, selfProf) {
    const e = store?.get(`${otherKey}|${otherProf}`);
    if (!e || !e.denom) return 0;
    return (e.hits.get(`${selfKey}|${selfProf}`) || 0) / e.denom;
  }

  function pairProb(cohorts, a, b) {
    if (!a || !b || a === b || !cohorts) return 0;
    const together = cohorts.pairW.get(pairKey(a, b)) || 0;
    const denom = Math.min(cohorts.profW.get(a) || 0, cohorts.profW.get(b) || 0);
    return denom ? Math.min(1, together / denom) : 0;
  }

  function cohortSignals(section, profKey, ctx) {
    const guesses = ctx?.guesses || [];
    const cohorts = ctx?.cohorts;
    if (!cohorts || !guesses.length || !profKey) {
      return { partnerCond: 0, partnerPair: 0, bundleFit: 0 };
    }
    const sec = section.section;
    const fam = sectionFamily(sec);
    let cond = 0;
    let condW = 0;
    let pair = 0;
    let pairW = 0;
    let bun = 0;
    let bunW = 0;
    for (const g of guesses) {
      if (!g?.profKey || g.section === sec) continue;
      const p = Number(g.probability) || 0;
      if (p < 0.05) continue;
      const gf = g.family || sectionFamily(g.section);
      const exact = condLookup(cohorts.condSec, g.section, g.profKey, sec, profKey);
      const famish = condLookup(cohorts.condFam, gf, g.profKey, fam, profKey);
      const c = exact > 0 ? exact : famish;
      cond += p * c;
      condW += p;
      if (g.profKey === profKey) {
        const e = cohorts.bundle.get(`${gf}|${profKey}`);
        const b = e && e.denom ? (e.hits.get(fam) || 0) / e.denom : 0;
        bun += p * b;
        bunW += p;
      } else {
        pair += p * pairProb(cohorts, profKey, g.profKey);
        pairW += p;
      }
    }
    return {
      partnerCond: condW ? cond / condW : 0,
      partnerPair: pairW ? pair / pairW : 0,
      bundleFit: bunW ? bun / bunW : 0,
    };
  }

  /**
   * Interpretable prior used when there is too little data to train on, and as
   * one member of the ensemble otherwise. Weights are hand-set from the
   * domain reasoning described at the top of this file.
   */
  const HEURISTIC_WEIGHTS = {
    freqDecay: 1.6,
    sameSemShare: 1.1,
    sectionExact: 2.2,
    sectionFamily: 0.7,
    slotAffinity: 2.6,
    dayAffinity: 0.5,
    timeAffinity: 0.5,
    roomAffinity: 0.6,
    recencyLastSeen: 1.4,
    streakRatio: 0.9,
    loadShare: 0.3,
    tenureSpan: 0.4,
    verified: 6.0,
    // Cross-section signals are the headline prior: if a typical feature is
    // worth 1, these are worth 5. A confident neighbour should move the
    // ranking more than "taught this course often" or a matching room.
    partnerCond: 9.0,
    partnerPair: 6.0,
    bundleFit: 7.0,
    lastSameSem: 2.8,
    newcomerFit: 1.7,
    successorFit: 1.5,
    componentFit: 1.8,
  };

  function heuristicScore(vector) {
    let sum = 0;
    FEATURE_NAMES.forEach((name, i) => {
      sum += (HEURISTIC_WEIGHTS[name] || 0) * (vector[i] || 0);
    });
    return sum;
  }

  PD.features = {
    FEATURE_NAMES,
    DEFAULT_HALF_LIFE,
    HEURISTIC_WEIGHTS,
    parseDays,
    parseTime,
    dayJaccard,
    timeSimilarity,
    sectionFamily,
    sectionKind,
    parseSectionFilter,
    sanitizeSectionInput,
    sectionAllowed,
    compareSections,
    unionTargetSections,
    decayWeight,
    buildProfiles,
    buildSectionMemory,
    buildCohorts,
    cohortSignals,
    seatSignals,
    featureVector,
    heuristicScore,
  };
})();
