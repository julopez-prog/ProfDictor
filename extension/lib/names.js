/**
 * Profdictor - professor name normalisation and fuzzy matching.
 *
 * AMIS is inconsistent about instructor formatting. The same person can appear
 * as "DELA CRUZ, JUAN P.", "Juan P. Dela Cruz", "J.P. DELA CRUZ" or
 * "Dr. Juan Dela Cruz Jr.". Everything here funnels those variants into one
 * canonical key so the dataset does not split one prof into several.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.names) return;

  /** Dropped before comparison - they carry no identity information. */
  const TITLES = new Set([
    "DR", "DRA", "PROF", "PROFESSOR", "ASSOC", "ASSOCIATE", "ASST", "ASSISTANT",
    "ENGR", "ATTY", "ARCH", "MR", "MRS", "MS", "SIR", "MAAM", "MA'AM",
    "INSTR", "INSTRUCTOR", "LECTURER", "PHD", "MD", "DVM", "CPA", "RN", "MSC", "MS.",
  ]);

  const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "VI"]);

  /** Multi-word surname particles that must stay glued to the next token. */
  const PARTICLES = new Set([
    "DE", "DELA", "DELOS", "DELAS", "DEL", "DES", "DI", "DA", "DOS", "DUS",
    "LA", "LAS", "LOS", "SAN", "SANTA", "STA", "STO", "VAN", "VON", "MAC", "MC",
  ]);

  /** Values that mean "no professor assigned yet". */
  const TBA_PATTERNS = [
    /^$/, /^T\.?B\.?A\.?$/, /^TO\s*BE\s*A(NNOUNCED|SSIGNED)$/, /^N\/?A$/,
    /^NONE$/, /^-+$/, /^STAFF$/, /^FACULTY$/, /^TBD$/, /^UNASSIGNED$/, /^NULL$/,
  ];

  function stripDiacritics(s) {
    return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function isTba(value) {
    const s = stripDiacritics(String(value ?? ""))
      .toUpperCase()
      .replace(/[^A-Z0-9/\s.-]/g, "")
      .trim()
      .replace(/\s+/g, " ");
    return TBA_PATTERNS.some((re) => re.test(s));
  }

  /** Uppercase, de-accented, punctuation-free, single-spaced. */
  function normalize(value) {
    return stripDiacritics(String(value ?? ""))
      .toUpperCase()
      .replace(/[.,_/\\|;:()\[\]{}<>"'`*]+/g, " ")
      .replace(/[^A-Z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function meaningfulTokens(value) {
    return normalize(value)
      .split(" ")
      .filter((t) => t && !TITLES.has(t) && !SUFFIXES.has(t));
  }

  /**
   * Split a raw instructor string into surname + given tokens.
   * Handles both "SURNAME, GIVEN M." and "Given M. Surname" orders.
   */
  function parse(raw) {
    const original = String(raw ?? "").trim();
    const hasComma = original.includes(",");
    let surnameTokens = [];
    let givenTokens = [];

    if (hasComma) {
      const [left, ...rest] = original.split(",");
      surnameTokens = meaningfulTokens(left);
      givenTokens = meaningfulTokens(rest.join(" "));
    } else {
      const tokens = meaningfulTokens(original);
      if (tokens.length <= 1) {
        surnameTokens = tokens;
      } else {
        // Walk back from the end, absorbing particles like DELA / VAN.
        let cut = tokens.length - 1;
        while (cut > 0 && PARTICLES.has(tokens[cut - 1])) cut -= 1;
        surnameTokens = tokens.slice(cut);
        givenTokens = tokens.slice(0, cut);
      }
    }

    const initials = givenTokens.map((t) => t[0]).filter(Boolean);
    return {
      original,
      surname: surnameTokens.join(" "),
      surnameTokens,
      givenTokens,
      initials,
      allTokens: [...surnameTokens, ...givenTokens],
    };
  }

  /**
   * Canonical dataset key. Surname carries almost all the signal, so the key is
   * surname + first given initial, which survives "JUAN P." vs "J." vs "JUAN".
   */
  function canonicalKey(raw) {
    const p = parse(raw);
    if (!p.surname) return normalize(raw);
    const initial = p.initials[0] || "";
    return initial ? `${p.surname}|${initial}` : p.surname;
  }

  /** Human-friendly rendering of a canonical key or raw name. */
  function displayName(raw) {
    const p = parse(raw);
    if (!p.surname) return p.original || String(raw ?? "");
    // Restore the period on middle initials that normalisation stripped.
    const given = p.givenTokens.map((t) => (t.length === 1 ? `${t}.` : t)).join(" ");
    return given ? `${p.surname}, ${given}` : p.surname;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  function levenshteinRatio(a, b) {
    const max = Math.max(a.length, b.length);
    if (!max) return 1;
    return 1 - levenshtein(a, b) / max;
  }

  /** Jaro-Winkler: strong on short strings with transposed/typo'd letters. */
  function jaroWinkler(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aFlags = new Array(a.length).fill(false);
    const bFlags = new Array(b.length).fill(false);
    let matches = 0;
    for (let i = 0; i < a.length; i += 1) {
      const start = Math.max(0, i - window);
      const end = Math.min(i + window + 1, b.length);
      for (let j = start; j < end; j += 1) {
        if (bFlags[j] || a[i] !== b[j]) continue;
        aFlags[i] = true;
        bFlags[j] = true;
        matches += 1;
        break;
      }
    }
    if (!matches) return 0;
    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (!aFlags[i]) continue;
      while (!bFlags[k]) k += 1;
      if (a[i] !== b[k]) transpositions += 1;
      k += 1;
    }
    transpositions /= 2;
    const jaro =
      (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
    let prefix = 0;
    while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
      prefix += 1;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /** Soundex catches phonetic typos: "Rekalde" vs "Recalde". */
  function soundex(word) {
    const s = normalize(word).replace(/[^A-Z]/g, "");
    if (!s) return "";
    const codes = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
    let out = s[0];
    let last = codes[s[0]] || 0;
    for (let i = 1; i < s.length && out.length < 4; i += 1) {
      const code = codes[s[i]] || 0;
      if (code && code !== last) out += String(code);
      if (!"HW".includes(s[i])) last = code;
    }
    return (out + "000").slice(0, 4);
  }

  /** Order-independent token overlap, so "Juan Cruz" == "Cruz Juan". */
  function tokenSetRatio(a, b) {
    const A = new Set(meaningfulTokens(a));
    const B = new Set(meaningfulTokens(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared += 1;
    return (2 * shared) / (A.size + B.size);
  }

  /**
   * Every substring a user might have meant as the surname: each token, each
   * adjacent pair (for split surnames like "DELA CRUZ"), and the parsed surname.
   * Needed because a typed name has no reliable word order -- "Dela Cruz Juan"
   * and "Juan Dela Cruz" are both common with no comma to disambiguate.
   */
  function surnameVariants(parsed) {
    const out = new Set();
    const add = (v) => {
      const clean = String(v || "").replace(/\s/g, "");
      if (clean.length >= 2) out.add(clean);
    };
    add(parsed.surname);
    const toks = parsed.allTokens;
    for (let i = 0; i < toks.length; i += 1) {
      add(toks[i]);
      if (i + 1 < toks.length) add(toks[i] + toks[i + 1]);
      if (i + 2 < toks.length) add(toks[i] + toks[i + 1] + toks[i + 2]);
    }
    return [...out];
  }

  /**
   * Blended similarity in [0,1] between a user-typed name and a known one.
   * Surname agreement dominates; given names and phonetics break ties.
   * Word order in the query is ignored.
   */
  function similarity(queryRaw, candidateRaw) {
    const q = parse(queryRaw);
    const c = parse(candidateRaw);
    const qFlat = q.allTokens.join("");
    const cFlat = c.allTokens.join("");
    if (!qFlat || !cFlat) return 0;

    if (canonicalKey(queryRaw) === canonicalKey(candidateRaw)) return 1;

    const cSurname = c.surname.replace(/\s/g, "");
    const variants = surnameVariants(q);
    let surnameScore = 0;
    let phonetic = 0;
    for (const v of variants) {
      surnameScore = Math.max(surnameScore, jaroWinkler(v, cSurname), levenshteinRatio(v, cSurname));
      if (cSurname && soundex(v) === soundex(cSurname)) phonetic = 1;
    }

    // Compare full strings both ways so "Cruz Juan" still lines up with
    // "Juan Cruz" once the tokens are sorted.
    const qSorted = [...q.allTokens].sort().join("");
    const cSorted = [...c.allTokens].sort().join("");
    const wholeScore = Math.max(
      jaroWinkler(qFlat, cFlat),
      levenshteinRatio(qFlat, cFlat),
      jaroWinkler(qSorted, cSorted),
      levenshteinRatio(qSorted, cSorted)
    );
    const tokens = tokenSetRatio(queryRaw, candidateRaw);

    // Any query token whose initial matches a known given-name initial counts;
    // a query with no given name at all stays neutral rather than penalised.
    const cInitials = new Set(c.initials);
    const qInitialPool = q.allTokens.map((t) => t[0]);
    const initialsAgree = !cInitials.size
      ? 0.5
      : qInitialPool.some((i) => cInitials.has(i))
        ? 1
        : 0.35;

    const score =
      0.5 * surnameScore + 0.15 * wholeScore + 0.15 * tokens + 0.1 * phonetic + 0.1 * initialsAgree;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Rank known names against a typed query.
   * `candidates` may be strings or `{ name, ... }` objects.
   */
  function bestMatches(query, candidates, { limit = 5, minScore = 0.45 } = {}) {
    const scored = candidates
      .map((entry) => {
        const name = typeof entry === "string" ? entry : entry?.name || entry?.instructor || "";
        return { entry, name, score: similarity(query, name) };
      })
      .filter((r) => r.name && r.score >= minScore)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  PD.names = {
    TITLES,
    SUFFIXES,
    isTba,
    normalize,
    meaningfulTokens,
    parse,
    canonicalKey,
    displayName,
    levenshtein,
    levenshteinRatio,
    jaroWinkler,
    soundex,
    tokenSetRatio,
    surnameVariants,
    similarity,
    bestMatches,
  };
})();
