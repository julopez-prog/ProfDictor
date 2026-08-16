/**
 * Profdictor - prediction engine.
 *
 * Design notes, because the modelling choices here are deliberate:
 *
 * 1. WALK-FORWARD TRAINING. With only ~9 historical terms, a naive random
 *    train/test split leaks the future into the past. Every model is trained on
 *    terms strictly older than the term being scored, which is also exactly how
 *    it will be used in production.
 *
 * 2. THREE MODELS, NOT ONE. A hand-weighted heuristic works when a course has
 *    two terms of history; logistic regression and the random forest only earn
 *    their keep once there is enough data. Ensemble weights are derived from
 *    each model's measured backtest accuracy, so a useless model gets ~0 weight
 *    automatically instead of dragging the prediction down.
 *
 * 3. CALIBRATED PROBABILITIES. Scores are turned into per-section posteriors
 *    with a softmax whose temperature is grid-searched to minimise backtest log
 *    loss. Without that step a "99%" would be meaningless.
 *
 * 4. NOVELTY MASS. Departments hire. A synthetic "someone not in history"
 *    candidate absorbs probability at the rate new names historically appeared,
 *    so the model can say "honestly, probably nobody I've seen".
 *
 * 5. TIMESLOT CONFLICT RESOLUTION. A professor cannot teach two sections that
 *    meet at the same time. Sections are grouped by overlapping schedule and
 *    solved with the Hungarian algorithm to produce a globally consistent
 *    lineup, shown alongside the independent marginals.
 *
 * 6. CROSS-SECTION COHORTS. Faculty often travel in packs: ONG on B/C in the
 *    same term GARCIA has G/H. A first independent pass produces soft guesses;
 *    a second pass lifts candidates who historically sat next to those guesses.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.predict) return;

  const { terms, names, features, forest } = PD;
  const NOVEL = "__NEW_OR_UNKNOWN__";

  /* ------------------------------------------------------------------ *
   * Logistic regression
   * ------------------------------------------------------------------ */

  function standardizer(X) {
    const n = X.length;
    const d = X[0].length;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const row of X) for (let j = 0; j < d; j += 1) mean[j] += row[j] / n;
    for (const row of X) for (let j = 0; j < d; j += 1) std[j] += (row[j] - mean[j]) ** 2 / n;
    for (let j = 0; j < d; j += 1) std[j] = Math.sqrt(std[j]) || 1;
    return { mean, std };
  }

  function applyStd(x, s) {
    return x.map((v, j) => (v - s.mean[j]) / s.std[j]);
  }

  const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

  function trainLogistic(X, y, options = {}) {
    if (!X.length || !X[0]?.length) return null;
    const posCount = y.reduce((a, b) => a + (b === 1 ? 1 : 0), 0);
    if (!posCount || posCount === y.length) return null;

    const iterations = options.iterations ?? 600;
    const lr = options.lr ?? 0.25;
    const l2 = options.l2 ?? 0.02;
    const posWeight = options.positiveWeight || (y.length - posCount) / posCount;

    const std = standardizer(X);
    const Z = X.map((row) => applyStd(row, std));
    const d = Z[0].length;
    const w = new Array(d).fill(0);
    let b = 0;

    for (let it = 0; it < iterations; it += 1) {
      const gradW = new Array(d).fill(0);
      let gradB = 0;
      let totalWeight = 0;
      for (let i = 0; i < Z.length; i += 1) {
        const sampleWeight = y[i] === 1 ? posWeight : 1;
        totalWeight += sampleWeight;
        let z = b;
        for (let j = 0; j < d; j += 1) z += w[j] * Z[i][j];
        const err = (sigmoid(z) - y[i]) * sampleWeight;
        for (let j = 0; j < d; j += 1) gradW[j] += err * Z[i][j];
        gradB += err;
      }
      const scale = lr / (totalWeight || 1);
      for (let j = 0; j < d; j += 1) w[j] -= scale * gradW[j] + lr * l2 * w[j];
      b -= scale * gradB;
    }

    return { kind: "logistic", w, b, std };
  }

  function logisticProba(model, x) {
    if (!model) return 0.5;
    const z = applyStd(x, model.std);
    let sum = model.b;
    for (let j = 0; j < model.w.length; j += 1) sum += model.w[j] * z[j];
    return sigmoid(sum);
  }

  function trainNaiveBayes(X, y) {
    if (!X.length || !X[0]?.length) return null;
    const d = X[0].length;
    const pos = [];
    const neg = [];
    for (let i = 0; i < X.length; i += 1) (y[i] === 1 ? pos : neg).push(X[i]);
    if (!pos.length || !neg.length) return null;
    const stats = (rows) => {
      const mean = new Array(d).fill(0);
      const vari = new Array(d).fill(0);
      rows.forEach((r) => r.forEach((v, j) => {
        mean[j] += v / rows.length;
      }));
      rows.forEach((r) => r.forEach((v, j) => {
        vari[j] += ((v - mean[j]) ** 2) / rows.length;
      }));
      return { mean, vari: vari.map((v) => Math.max(v, 1e-4)) };
    };
    return { kind: "naiveBayes", pos: stats(pos), neg: stats(neg), prior: pos.length / X.length };
  }

  function naiveBayesProba(model, x) {
    if (!model) return 0.5;
    const logG = (s) => {
      let ll = 0;
      for (let j = 0; j < x.length; j += 1) {
        const v = s.vari[j];
        ll += -0.5 * (Math.log(2 * Math.PI * v) + ((x[j] - s.mean[j]) ** 2) / v);
      }
      return ll;
    };
    const lp = Math.log(Math.max(1e-6, model.prior)) + logG(model.pos);
    const ln = Math.log(Math.max(1e-6, 1 - model.prior)) + logG(model.neg);
    const m = Math.max(lp, ln);
    const ep = Math.exp(lp - m);
    const en = Math.exp(ln - m);
    return ep / (ep + en);
  }

  function specialistScores(vector) {
    const freq = vector[0] || 0;
    const sameSem = vector[1] || 0;
    const sectionExact = vector[2] || 0;
    const sectionFamily = vector[3] || 0;
    const slot = vector[4] || 0;
    const day = vector[5] || 0;
    const time = vector[6] || 0;
    const room = vector[7] || 0;
    const recency = vector[8] || 0;
    const streak = vector[9] || 0;
    return {
      knn: (sectionExact + sectionFamily + slot + room + time) / 5,
      sectionExact,
      sectionFamily,
      slot: slot * 0.6 + day * 0.2 + time * 0.2,
      recency: recency * (0.55 + 0.45 * freq),
      sameSemester: sameSem * (0.5 + 0.5 * recency),
      dayAffinity: day,
      timeAffinity: time,
      roomAffinity: room,
      freqDecay: freq,
      streak,
      lastExact: sectionExact * (0.4 + 0.6 * recency),
      cooccur: (vector[13] || 0) * 0.65 + (vector[14] || 0) * 0.35,
      bundle: vector[15] || 0,
      lastSameSem: vector[16] || 0,
      newcomer: vector[17] || 0,
      successor: vector[18] || 0,
    };
  }

  function trainPerceptron(X, y, options = {}) {
    if (!X.length || !X[0]?.length) return null;
    const posCount = y.reduce((a, b) => a + (b === 1 ? 1 : 0), 0);
    if (!posCount || posCount === y.length) return null;
    const d = X[0].length;
    const w = new Array(d).fill(0);
    let b = 0;
    const lr = options.lr ?? 0.12;
    const iterations = options.iterations ?? 70;
    for (let it = 0; it < iterations; it += 1) {
      for (let i = 0; i < X.length; i += 1) {
        let z = b;
        for (let j = 0; j < d; j += 1) z += w[j] * X[i][j];
        const pred = z > 0 ? 1 : 0;
        const err = y[i] - pred;
        if (!err) continue;
        for (let j = 0; j < d; j += 1) w[j] += lr * err * X[i][j];
        b += lr * err;
      }
    }
    return { kind: "perceptron", w, b };
  }

  function perceptronProba(model, x) {
    if (!model) return 0.5;
    let z = model.b;
    for (let j = 0; j < model.w.length; j += 1) z += model.w[j] * (x[j] || 0);
    return sigmoid(z);
  }

  function trainPrototype(X, y) {
    const pos = [];
    for (let i = 0; i < X.length; i += 1) if (y[i] === 1) pos.push(X[i]);
    if (!pos.length || !pos[0]?.length) return null;
    const d = pos[0].length;
    const mean = new Array(d).fill(0);
    pos.forEach((r) => r.forEach((v, j) => {
      mean[j] += v / pos.length;
    }));
    return { kind: "prototype", mean };
  }

  function cosineProba(model, x) {
    if (!model?.mean) return 0.5;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let j = 0; j < x.length; j += 1) {
      const a = x[j] || 0;
      const b = model.mean[j] || 0;
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (!denom) return 0.5;
    return Math.max(0, Math.min(1, (dot / denom + 1) / 2));
  }

  function trainStumps(X, y) {
    if (!X.length || !X[0]?.length) return null;
    const d = X[0].length;
    const w = new Array(d).fill(0);
    for (let j = 0; j < d; j += 1) {
      let pos = 0;
      let neg = 0;
      let nPos = 0;
      let nNeg = 0;
      for (let i = 0; i < X.length; i += 1) {
        if (y[i] === 1) {
          pos += X[i][j];
          nPos += 1;
        } else {
          neg += X[i][j];
          nNeg += 1;
        }
      }
      w[j] = (nPos ? pos / nPos : 0) - (nNeg ? neg / nNeg : 0);
    }
    return { kind: "stumps", w };
  }

  function stumpProba(model, x) {
    if (!model?.w) return 0.5;
    let z = 0;
    for (let j = 0; j < model.w.length; j += 1) z += model.w[j] * (x[j] || 0);
    return sigmoid(z);
  }

  const MODEL_KEYS = [
    "heuristic",
    "logistic",
    "forest",
    "extraTrees",
    "naiveBayes",
    "perceptron",
    "cosine",
    "stumps",
    "knn",
    "sectionExact",
    "sectionFamily",
    "slot",
    "recency",
    "sameSemester",
    "dayAffinity",
    "timeAffinity",
    "roomAffinity",
    "freqDecay",
    "streak",
    "lastExact",
    "cooccur",
    "bundle",
    "lastSameSem",
    "newcomer",
    "successor",
  ];
  const PROBA_KEYS = MODEL_KEYS.filter((k) => k !== "heuristic");

  /**
   * Cross-section models. If every other model is 1 point, this group is 5:
   * who this professor historically sat next to, and which letters they take
   * as a bundle, should outweigh any single same-section specialist.
   */
  const CROSS_KEYS = ["cooccur", "bundle"];
  const CROSS_PRIOR = 5;

  /** Names kept per section as reserves for the timetable solver. */
  const LINEUP_POOL = 8;

  /* ------------------------------------------------------------------ *
   * Hungarian assignment (O(n^3), rectangular, minimises total cost)
   * ------------------------------------------------------------------ */

  function hungarian(cost) {
    const n = cost.length;
    if (!n) return [];
    const m = cost[0].length;
    if (m < n) throw new Error("hungarian: needs columns >= rows");
    const INF = Infinity;
    const u = new Array(n + 1).fill(0);
    const v = new Array(m + 1).fill(0);
    const p = new Array(m + 1).fill(0);
    const way = new Array(m + 1).fill(0);

    for (let i = 1; i <= n; i += 1) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(m + 1).fill(INF);
      const used = new Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = INF;
        let j1 = -1;
        for (let j = 1; j <= m; j += 1) {
          if (used[j]) continue;
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
        if (j1 === -1) break;
        for (let j = 0; j <= m; j += 1) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else {
            minv[j] -= delta;
          }
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }

    const result = new Array(n).fill(-1);
    for (let j = 1; j <= m; j += 1) if (p[j]) result[p[j] - 1] = j - 1;
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Dataset shaping
   * ------------------------------------------------------------------ */

  function revealedRecords(records) {
    return records.filter((r) => r.profKey && !names.isTba(r.instructor));
  }

  function termsPresent(records) {
    return [...new Set(records.map((r) => r.term))].sort((a, b) => a - b);
  }

  function sectionsOfTerm(records, term) {
    const seen = new Map();
    for (const r of records) {
      if (r.term !== term) continue;
      if (!seen.has(r.section)) seen.set(r.section, r);
    }
    return [...seen.values()];
  }

  /** Share of assignments whose professor had never appeared before. */
  function noveltyRate(records) {
    const revealed = revealedRecords(records);
    const byTerm = termsPresent(revealed);
    if (byTerm.length < 2) return 0.15;
    const seen = new Set();
    let novel = 0;
    let total = 0;
    for (const term of byTerm) {
      const rows = revealed.filter((r) => r.term === term);
      if (seen.size) {
        for (const r of rows) {
          total += 1;
          if (!seen.has(r.profKey)) novel += 1;
        }
      }
      for (const r of rows) seen.add(r.profKey);
    }
    return total ? Math.min(0.6, Math.max(0.02, novel / total)) : 0.15;
  }

  function makeContext(records, targetTerm, opts) {
    const history = revealedRecords(records).filter((r) => r.term < targetTerm);
    const built = features.buildProfiles(history, targetTerm, opts.halfLife);
    return {
      ...built,
      cohorts: features.buildCohorts(history, targetTerm, opts.halfLife),
      sectionMemory: features.buildSectionMemory(history, targetTerm, built.profiles),
      guesses: opts.guesses || [],
      targetTerm,
      halfLife: opts.halfLife,
      verifiedSet: opts.verifiedSet || new Set(),
    };
  }


  /**
   * Soft lineup used as cross-section context.
   *
   * Deliberately model-free: the heuristic prior only, with cohort features
   * switched off, so the exact same context is available while training and
   * while predicting. Feeding the *true* partners in during training (and mere
   * guesses at prediction time) taught the models to trust `partnerCond` as
   * gospel, which is what made a wrong neighbour drag its whole cohort down.
   */
  function firstPassGuesses(sections, ctx, { perSection = 5, temperature = 1.5 } = {}) {
    const base = { ...ctx, guesses: [] };
    const out = [];
    for (const section of sections) {
      const scored = [];
      for (const profKey of ctx.profiles.keys()) {
        scored.push({
          profKey,
          score: features.heuristicScore(features.featureVector(section, profKey, base)),
        });
      }
      if (!scored.length) continue;
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, perSection);
      const max = top[0].score;
      const exps = top.map((t) => Math.exp((t.score - max) / temperature));
      const z = exps.reduce((a, b) => a + b, 0) || 1;
      top.forEach((t, i) => {
        out.push({
          section: section.section,
          family: features.sectionFamily(section.section),
          profKey: t.profKey,
          probability: exps[i] / z,
        });
      });
    }
    return out;
  }

  /** Refresh neighbour guesses from a scored pass so the 5× signal sees the blend. */
  function guessesFromScores(entries, weights, temperature, novelty, { perSection = 5, vote } = {}) {
    const out = [];
    for (const { section, scores } of entries) {
      if (!section?.section || !scores?.length) continue;
      const dist = posterior(combine(scores, weights, vote), temperature, novelty).filter(
        (d) => d.profKey !== NOVEL
      );
      dist.slice(0, perSection).forEach((d) => {
        out.push({
          section: section.section,
          family: features.sectionFamily(section.section),
          profKey: d.profKey,
          probability: d.probability,
        });
      });
    }
    return out;
  }

  /**
   * Walk-forward training rows. For each term with revealed instructors we emit
   * one row per (section, candidate) pair, using only older terms as evidence.
   */
  function buildExamples(records, uptoTerm, opts) {
    const revealed = revealedRecords(records);
    const X = [];
    const y = [];
    const allTerms = termsPresent(revealed).filter((t) => t < uptoTerm);

    for (let k = 1; k < allTerms.length; k += 1) {
      const term = allTerms[k];
      const ctx = makeContext(records, term, opts);
      if (!ctx.profiles.size) continue;
      const actualBySection = new Map();
      for (const r of revealed) if (r.term === term) actualBySection.set(r.section, r);

      ctx.guesses = firstPassGuesses([...actualBySection.values()], ctx);
      for (const [, actual] of actualBySection) {
        for (const profKey of ctx.profiles.keys()) {
          X.push(features.featureVector(actual, profKey, ctx));
          y.push(profKey === actual.profKey ? 1 : 0);
        }
      }
    }
    return { X, y };
  }

  /* ------------------------------------------------------------------ *
   * Scoring
   * ------------------------------------------------------------------ */

  function trainModels(X, y, opts) {
    const ready = X.length >= (opts.minTrainRows ?? 24);
    return {
      logistic: ready ? trainLogistic(X, y, opts.logistic) : null,
      forest: ready ? forest.train(X, y, opts.forest) : null,
      extraTrees: ready
        ? forest.train(X, y, { nTrees: 24, maxDepth: 4, sampleRatio: 0.65, seed: 2026, ...(opts.extraTrees || {}) })
        : null,
      naiveBayes: ready ? trainNaiveBayes(X, y) : null,
      perceptron: ready ? trainPerceptron(X, y, opts.perceptron) : null,
      prototype: ready ? trainPrototype(X, y) : null,
      stumps: ready ? trainStumps(X, y) : null,
    };
  }

  function rawScores(section, ctx, models) {
    const out = [];
    for (const profKey of ctx.profiles.keys()) {
      const vector = features.featureVector(section, profKey, ctx);
      const spec = specialistScores(vector);
      out.push({
        profKey,
        vector,
        heuristic: features.heuristicScore(vector),
        logistic: models.logistic ? logisticProba(models.logistic, vector) : null,
        forest: models.forest ? forest.predictProba(models.forest, vector) : null,
        extraTrees: models.extraTrees ? forest.predictProba(models.extraTrees, vector) : null,
        naiveBayes: models.naiveBayes ? naiveBayesProba(models.naiveBayes, vector) : null,
        perceptron: models.perceptron ? perceptronProba(models.perceptron, vector) : null,
        cosine: models.prototype ? cosineProba(models.prototype, vector) : null,
        stumps: models.stumps ? stumpProba(models.stumps, vector) : null,
        knn: spec.knn,
        sectionExact: spec.sectionExact,
        sectionFamily: spec.sectionFamily,
        slot: spec.slot,
        recency: spec.recency,
        sameSemester: spec.sameSemester,
        dayAffinity: spec.dayAffinity,
        timeAffinity: spec.timeAffinity,
        roomAffinity: spec.roomAffinity,
        freqDecay: spec.freqDecay,
        streak: spec.streak,
        lastExact: spec.lastExact,
        cooccur: spec.cooccur,
        bundle: spec.bundle,
        lastSameSem: spec.lastSameSem,
        newcomer: spec.newcomer,
        successor: spec.successor,
      });
    }
    return out;
  }

  /** Map each model's score onto a common log-odds-ish scale before blending. */
  function toLogit(p) {
    const clamped = Math.max(1e-6, Math.min(1 - 1e-6, p));
    return Math.log(clamped / (1 - clamped));
  }

  /**
   * How each model casts a ballot.
   *
   * `floor` — a model below this weight does not vote (no more 8/25 from
   *           specialists that the tuner already silenced).
   * `depth` — only the model's top-N names get points. Auto (0) stays at
   *           the 5-name shortlist so a long Top-N card does not dilute #1–#5.
   * `pad`   — points on the last of those N. #1 gets depth+pad, #2 gets
   *           depth+pad-1, … so a name sitting at #4/#5 on many ballots can
   *           still outrank a #1 that only a few models like.
   * `mix`   — how hard the ballots pull the logit blend (0 = ignore votes).
   */
  const DEFAULT_VOTE = { pad: 1, depth: 5, floor: 0.02, mix: 0.4 };
  const SHORTLIST_N = 5;

  /**
   * Depth 0 / missing = keep ballots on the first five names, even when the
   * card shows 15. Expanding depth to Max profs is what made Top-15 scramble
   * the shortlist (top-3 dropped from 31% to 26% on the same 39 sections).
   */
  function resolveVoteDepth(input = {}) {
    const limit = Math.max(1, Number(input.limit) || DEFAULT_VOTE.depth);
    const raw = input.vote != null ? input.vote.depth : input.voteDepth;
    if (raw == null || raw === "" || !Number.isFinite(Number(raw)) || Number(raw) === 0) {
      return Math.min(SHORTLIST_N, limit);
    }
    return Math.max(1, Math.round(Number(raw)));
  }

  function voteOptions(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      pad: Math.max(0, Number(src.pad ?? DEFAULT_VOTE.pad)),
      depth: Math.max(1, Math.round(Number(src.depth ?? DEFAULT_VOTE.depth))),
      floor: Math.max(0, Number(src.floor ?? DEFAULT_VOTE.floor)),
      mix: Math.max(0, Math.min(1, Number(src.mix ?? DEFAULT_VOTE.mix))),
    };
  }

  function liveModelKeys(weights, vote) {
    return MODEL_KEYS.filter((k) => (weights[k] || 0) > vote.floor);
  }

  function combine(scores, weights, vote = DEFAULT_VOTE) {
    const blended = scores.map((s) => {
      let total = 0;
      let used = 0;
      if ((weights.heuristic || 0) > 0 && s.heuristic != null) {
        total += weights.heuristic * s.heuristic;
        used += weights.heuristic;
      }
      PROBA_KEYS.forEach((key) => {
        if ((weights[key] || 0) > 0 && s[key] != null) {
          total += weights[key] * toLogit(s[key]);
          used += weights[key];
        }
      });
      return { ...s, score: used ? total / used : s.heuristic };
    });
    return applyVotePadding(blended, weights, vote);
  }

  /**
   * Weighted Borda with a pad on the tail. Each live model is one ballot;
   * a 5× neighbour model is five ballots. Padding keeps #3–#5 names in play
   * instead of letting a single first-place vote lock the section.
   */
  function applyVotePadding(blended, weights, vote = DEFAULT_VOTE) {
    const opts = voteOptions(vote);
    if (!opts.mix || blended.length < 2) return blended;
    const live = liveModelKeys(weights, opts);
    if (!live.length) return blended;

    const points = new Map(blended.map((s) => [s.profKey, 0]));
    for (const key of live) {
      const ranked = [...blended].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
      const w = weights[key] || 0;
      ranked.slice(0, opts.depth).forEach((s, i) => {
        points.set(s.profKey, (points.get(s.profKey) || 0) + w * (opts.depth - i + opts.pad));
      });
    }
    const maxP = Math.max(1e-9, ...points.values());
    const logit = blended.map((s) => (Number.isFinite(s.score) ? s.score : 0));
    const span = Math.max(0.2, Math.max(...logit) - Math.min(...logit));
    return blended.map((s, i) => ({
      ...s,
      borda: points.get(s.profKey) || 0,
      score: (1 - opts.mix) * logit[i] + opts.mix * span * ((points.get(s.profKey) || 0) / maxP),
    }));
  }

  function modelTopPicks(scores, weights, vote = DEFAULT_VOTE) {
    const opts = voteOptions(vote);
    const live = liveModelKeys(weights || {}, opts);
    const keys = live.length ? live : MODEL_KEYS;
    const tops = {};
    keys.forEach((key) => {
      const usable = scores.filter((s) => s[key] != null);
      if (!usable.length) return;
      const best = usable.reduce((a, b) => ((b[key] ?? -Infinity) > (a[key] ?? -Infinity) ? b : a));
      tops[key] = best.profKey;
    });
    return tops;
  }

  function sectionConfidence(dist, votes, backtestTop1) {
    const ranked = (dist || []).filter((d) => d.profKey !== NOVEL);
    const top = ranked[0];
    const second = ranked[1];
    const p1 = top?.probability ?? 0;
    const margin = Math.max(0, p1 - (second?.probability ?? 0));
    const voteValues = Object.values(votes || {});
    const agree = top
      ? voteValues.filter((k) => k === top.profKey).length / Math.max(1, voteValues.length)
      : 0;
    const raw = 0.42 * p1 + 0.32 * agree + 0.16 * margin + 0.1 * (backtestTop1 || 0);
    return Math.round(Math.max(0.05, Math.min(0.99, raw)) * 1000) / 10;
  }

  /**
   * Softmax posterior over candidates for one section, plus reserved novelty
   * mass. Returns entries sorted by probability, descending.
   */
  function posterior(scored, temperature, novelty) {
    if (!scored.length) return [{ profKey: NOVEL, probability: 1 }];
    const max = Math.max(...scored.map((s) => s.score));
    const exps = scored.map((s) => Math.exp((s.score - max) / Math.max(0.05, temperature)));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    const keep = 1 - novelty;
    const out = scored.map((s, i) => ({ ...s, probability: (exps[i] / sum) * keep }));
    out.push({ profKey: NOVEL, probability: novelty, score: -Infinity, vector: null });
    return out.sort((a, b) => b.probability - a.probability);
  }

  /** Avoids rendering a real-but-tiny probability as a flat "0%". */
  function formatPercent(p) {
    const pct = p * 100;
    if (pct >= 99.95) return ">99.9%";
    if (pct >= 10) return `${pct.toFixed(0)}%`;
    if (pct >= 1) return `${pct.toFixed(1)}%`;
    if (pct >= 0.1) return `${pct.toFixed(1)}%`;
    if (pct > 0) return "<0.1%";
    return "0%";
  }

  /* ------------------------------------------------------------------ *
   * Backtest
   * ------------------------------------------------------------------ */

  function evaluateTerm(records, term, opts) {
    const revealed = revealedRecords(records);
    const actual = revealed.filter((r) => r.term === term);
    if (!actual.length) return null;

    const ctx = makeContext(records, term, opts);
    if (!ctx.profiles.size) return null;

    const { X, y } = buildExamples(records, term, opts);
    const models = trainModels(X, y, opts);

    const perModel = {};
    MODEL_KEYS.forEach((k) => {
      perModel[k] = { top1: 0, top3: 0, mrr: 0, n: 0, inPool: 0 };
    });
    const ensembleRows = [];

    ctx.guesses = firstPassGuesses(actual, ctx);
    const peekWeights = pinCrossWeights(
      Object.fromEntries(MODEL_KEYS.map((k) => [k, CROSS_KEYS.includes(k) ? CROSS_PRIOR : 1]))
    );
    const peek = actual.map((row) => ({ section: row, scores: rawScores(row, ctx, models) }));
    const refreshed = guessesFromScores(peek, peekWeights, 1, 0.05);
    if (refreshed.length) ctx.guesses = refreshed;

    for (const row of actual) {
      const scores = rawScores(row, ctx, models);
      if (!scores.length) continue;
      const inPool = ctx.profiles.has(row.profKey);

      MODEL_KEYS.forEach((key) => {
        const usable = scores.filter((s) => (key === "heuristic" ? true : s[key] != null));
        if (!usable.length) return;
        const ranked = [...usable].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
        const m = perModel[key];
        m.n += 1;
        if (inPool) m.inPool += 1;
        const idx = ranked.findIndex((s) => s.profKey === row.profKey);
        if (idx === 0) m.top1 += 1;
        if (idx >= 0 && idx < 3) m.top3 += 1;
        if (idx >= 0) m.mrr += 1 / (idx + 1);
      });

      ensembleRows.push({ scores, truth: row.profKey, inPool, section: row });
    }

    MODEL_KEYS.forEach((key) => {
      const m = perModel[key];
      if (!m.n) return;
      m.top1Rate = m.top1 / m.n;
      m.top3Rate = m.top3 / m.n;
      m.mrrRate = m.mrr / m.n;
      m.coverage = m.inPool / m.n;
    });

    return { term, perModel, ensembleRows, models, ctx, candidateCount: ctx.profiles.size };
  }

  function deriveWeights(folds) {
    const acc = {};
    MODEL_KEYS.forEach((k) => {
      let hit = 0;
      let n = 0;
      folds.forEach((f) => {
        const m = f.perModel[k];
        if (m?.n) {
          hit += m.top1;
          n += m.n;
        }
      });
      acc[k] = n ? hit / n : 0;
    });

    // Square the accuracies to sharpen, and keep a floor on the heuristic so a
    // course with almost no history still produces a usable ranking.
    const raw = {};
    MODEL_KEYS.forEach((k) => {
      raw[k] = (acc[k] || 0) ** 2;
    });
    raw.heuristic = Math.max(0.1, raw.heuristic || 0);
    const total = MODEL_KEYS.reduce((a, k) => a + (raw[k] || 0), 0) || 1;
    const weights = {};
    MODEL_KEYS.forEach((k) => {
      weights[k] = (raw[k] || 0) / total;
    });
    return { weights: pinCrossWeights(weights), accuracy: acc };
  }

  /**
   * Force the cross-section group to 5× one typical other model.
   *
   * The tuner is free to split that mass between `cooccur` and `bundle`, or
   * to zero a specialist that never fired, but it is not allowed to let the
   * whole neighbour signal fall below the 5-to-1 prior.
   */
  function pinCrossWeights(input, prior = CROSS_PRIOR) {
    const weights = { ...input };
    const others = MODEL_KEYS.filter((k) => !CROSS_KEYS.includes(k));
    const liveOthers = others.filter((k) => (weights[k] || 0) > 1e-6);
    // One midyear of history has no neighbour table to lean on. Leave the
    // blend as heuristic-only rather than inventing a 5× vote for silence.
    if (liveOthers.length <= 1 && CROSS_KEYS.every((k) => (weights[k] || 0) < 1e-9)) {
      return weights;
    }
    const otherMass = others.reduce((a, k) => a + (weights[k] || 0), 0);
    const otherCount = liveOthers.length || others.length;
    const unit = otherMass / otherCount;
    const scalePrior = Math.max(0, Number(prior) || 0);
    const target = scalePrior * (unit || 1 / MODEL_KEYS.length);
    const current = CROSS_KEYS.reduce((a, k) => a + (weights[k] || 0), 0);
    if (current < 1e-9) {
      CROSS_KEYS.forEach((k) => {
        weights[k] = target / CROSS_KEYS.length;
      });
    } else {
      const scale = target / current;
      CROSS_KEYS.forEach((k) => {
        weights[k] = (weights[k] || 0) * scale;
      });
    }
    const total = MODEL_KEYS.reduce((a, k) => a + (weights[k] || 0), 0) || 1;
    MODEL_KEYS.forEach((k) => {
      weights[k] = (weights[k] || 0) / total;
    });
    return weights;
  }

  /**
   * Flatten every backtest row into a plain number matrix so weight search is a
   * dot product per candidate rather than a full re-score. One entry per fold,
   * because the search scores folds separately and averages: a weight that only
   * helps one semester should not win.
   */
  function foldMatrix(folds) {
    const K = MODEL_KEYS.length;
    return folds
      .map((fold) =>
        fold.ensembleRows
          .map((row) => {
            const n = row.scores.length;
            if (!n) return null;
            const vals = new Float64Array(n * K);
            let truth = -1;
            row.scores.forEach((s, i) => {
              if (s.profKey === row.truth) truth = i;
              for (let j = 0; j < K; j += 1) {
                const key = MODEL_KEYS[j];
                const v = key === "heuristic" ? s.heuristic : s[key];
                // A missing model is neutral, not a vote against the candidate.
                vals[i * K + j] = v == null ? 0 : key === "heuristic" ? v : toLogit(v);
              }
            });
            return { vals, count: n, truth };
          })
          .filter(Boolean)
      )
      .filter((rows) => rows.length);
  }

  /**
   * Macro-averaged accuracy over the folds. `combine` divides by the used weight
   * mass, which is the same for every candidate in a row, so the ranking here
   * matches the real one without the normalisation.
   *
   * The rank counts strictly-better candidates plus equal ones that sort ahead,
   * which mirrors the real ordering. Counting ties as wins would let the search
   * zero every weight and call a 25-way tie a perfect score.
   */
  function resolveGoal(input = {}) {
    const raw = String(input.goal || input.focus || "top1").toLowerCase();
    const limit = Math.max(1, Number(input.limit) || 3);
    if (raw === "top3") return { goal: "top3", atN: 3, coverage: true };
    if (raw === "topn" || raw === "top5") return { goal: "topn", atN: limit, coverage: true };
    return { goal: "top1", atN: 1, coverage: false };
  }

  function matrixScore(matrix, weightVec, active, goal = "top1", atN = 1) {
    const K = MODEL_KEYS.length;
    const k = Math.max(1, Number(atN) || 1);
    let sum1 = 0;
    let sum3 = 0;
    let sumN = 0;
    for (const rows of matrix) {
      let hit1 = 0;
      let hit3 = 0;
      let hitN = 0;
      for (const row of rows) {
        if (row.truth < 0) continue;
        const scores = new Float64Array(row.count);
        for (let i = 0; i < row.count; i += 1) {
          const off = i * K;
          let total = 0;
          for (const j of active) total += weightVec[j] * row.vals[off + j];
          scores[i] = total;
        }
        const mine = scores[row.truth];
        let rank = 0;
        for (let i = 0; i < row.count; i += 1) {
          if (scores[i] > mine || (scores[i] === mine && i < row.truth)) rank += 1;
        }
        if (rank === 0) hit1 += 1;
        if (rank < 3) hit3 += 1;
        if (rank < k) hitN += 1;
      }
      sum1 += hit1 / rows.length;
      sum3 += hit3 / rows.length;
      sumN += hitN / rows.length;
    }
    const n = matrix.length || 1;
    const top1 = sum1 / n;
    const top3 = sum3 / n;
    const topN = sumN / n;
    const objective =
      goal === "topn"
        ? topN + 0.4 * top3 + 0.2 * top1
        : goal === "top3"
          ? top3 + 0.1 * top1
          : top1 + 0.25 * top3;
    return { top1, top3, topN, atN: k, objective };
  }

  const WEIGHT_GRID = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.6, 1];

  /**
   * Coordinate ascent on backtest top-1.
   *
   * Weights taken from squared per-model accuracy give every one of the 25
   * models a say, so a dozen mediocre models can outvote the two that actually
   * know this course. This searches one model's weight at a time and keeps a
   * change only when it lifts the average across folds, which usually drives
   * the weak models to zero.
   */
  function optimiseWeights(folds, start, { passes = 3, goal = "top1", atN = 1 } = {}) {
    const matrix = foldMatrix(folds);
    const weights = { ...start };
    if (!matrix.length) return { weights, top1: 0, tuned: false };

    const K = MODEL_KEYS.length;
    const activeOf = (vec) => {
      const out = [];
      for (let j = 0; j < K; j += 1) if (vec[j] !== 0) out.push(j);
      return out;
    };
    const vecOf = (obj) => {
      const v = new Float64Array(K);
      MODEL_KEYS.forEach((k, j) => {
        v[j] = obj[k] || 0;
      });
      return v;
    };

    const climb = (from) => {
      const vec = Float64Array.from(from);
      let best = matrixScore(matrix, vec, activeOf(vec), goal, atN).objective;
      for (let pass = 0; pass < passes; pass += 1) {
        let improved = false;
        for (let j = 0; j < K; j += 1) {
          let bestVal = vec[j];
          for (const candidate of WEIGHT_GRID) {
            if (candidate === vec[j]) continue;
            const original = vec[j];
            vec[j] = candidate;
            const score = matrixScore(matrix, vec, activeOf(vec), goal, atN).objective;
            if (score > best + 1e-9) {
              best = score;
              bestVal = candidate;
              improved = true;
            }
            vec[j] = original;
          }
          vec[j] = bestVal;
        }
        if (!improved) break;
      }
      return { vec, objective: best };
    };

    const baseVec = vecOf(start);
    const baseline = matrixScore(matrix, baseVec, activeOf(baseVec), goal, atN);

    // Coordinate ascent only ever finds the nearest peak, so try a few honest
    // starting points: the accuracy-derived blend, the bare heuristic, and an
    // equal say for every model.
    const starts = [
      baseVec,
      vecOf(Object.fromEntries(MODEL_KEYS.map((k) => [k, k === "heuristic" ? 1 : 0]))),
      vecOf(Object.fromEntries(MODEL_KEYS.map((k) => [k, 0.1]))),
      // The requested 5-to-1 prior: every model is 1, the neighbour pair is 5.
      vecOf(
        Object.fromEntries(
          MODEL_KEYS.map((k) => [k, CROSS_KEYS.includes(k) ? CROSS_PRIOR / CROSS_KEYS.length : 1])
        )
      ),
    ];
    let champion = null;
    for (const from of starts) {
      const got = climb(from);
      if (!champion || got.objective > champion.objective + 1e-9) champion = got;
    }

    let total = 0;
    for (let j = 0; j < K; j += 1) total += champion.vec[j];
    // An all-zero blend has no ranking at all, so keep the starting weights.
    if (!total || champion.objective <= baseline.objective + 1e-9) {
      return { weights, top1: baseline.top1, tuned: false };
    }
    const tunedScore = matrixScore(matrix, champion.vec, activeOf(champion.vec), goal, atN);
    MODEL_KEYS.forEach((k, j) => {
      weights[k] = champion.vec[j] / total;
    });
    return { weights: pinCrossWeights(weights), top1: tunedScore.top1, tuned: true, baseline: baseline.top1 };
  }

  /** Grid-search the softmax temperature that minimises backtest log loss. */
  function calibrateTemperature(folds, weights, novelty, vote, { goal = "top1", atN = 5 } = {}) {
    const grid = [0.15, 0.25, 0.4, 0.6, 0.8, 1, 1.3, 1.7, 2.2, 3, 4, 6];
    if (goal === "top3" || goal === "topn" || goal === "top5") {
      let best = { temperature: 2.2, logLoss: null, topN: -1 };
      for (const temperature of grid) {
        const acc = ensembleAccuracy(folds, weights, temperature, novelty, atN, vote);
        if (acc.topN > best.topN + 1e-9) best = { temperature, logLoss: null, topN: acc.topN };
      }
      return best;
    }
    let best = { temperature: 1, logLoss: Infinity };
    for (const temperature of grid) {
      let loss = 0;
      let n = 0;
      for (const fold of folds) {
        for (const row of fold.ensembleRows) {
          const combined = combine(row.scores, weights, vote);
          const dist = posterior(combined, temperature, novelty);
          const hit = dist.find((d) => d.profKey === (row.inPool ? row.truth : NOVEL));
          const p = Math.max(1e-6, hit?.probability ?? 1e-6);
          loss += -Math.log(p);
          n += 1;
        }
      }
      if (!n) continue;
      const avg = loss / n;
      if (avg < best.logLoss) best = { temperature, logLoss: avg };
    }
    return best;
  }

  /**
   * How strongly this professor "owns" the seat — last same-semester holder,
   * last holder, or someone who actually taught this exact section. Returned in
   * abstract "units" (roughly 0–0.4) because the caller scales them to the
   * section's own probability spread.
   */
  function seatBonus(profKey, section, ctx) {
    if (!profKey || !section || !ctx) return 0;
    let bonus = 0;
    const mem = ctx.sectionMemory?.get(section.section);
    if (mem?.lastSameSemProf === profKey) bonus += 0.18;
    else if (mem?.lastProf === profKey) bonus += 0.1;
    else if (mem?.prevProf === profKey) bonus += 0.06;
    const profile = ctx.profiles?.get(profKey);
    const sw = profile?.sections?.get(section.section) || 0;
    if (sw && profile?.weight) bonus += 0.12 * Math.min(1, sw / profile.weight);
    return bonus;
  }

  /**
   * Reorder an already-scored pool so historically grounded names in ranks
   * 6–15 can take a shortlist seat. #1 stays put.
   *
   * Thresholds are relative, not absolute. A 39-section course spreads its
   * posterior thin — the favourite may only hold 12% and the truth 3% — so a
   * fixed "must be over 2%" gate would never fire on exactly the courses that
   * need help. Everything scales to the favourite's own probability instead.
   */
  function liftShortlist(cards, section, ctx, shortlistN = SHORTLIST_N) {
    if (!Array.isArray(cards) || cards.length <= 2) return cards;
    const n = Math.min(shortlistN, cards.length);
    const top = cards[0]?.probability || 0;
    const scale = Math.max(0.01, top);
    const edge = cards[n - 1]?.probability || 0;
    // Anything under a sixth of the weakest shortlist seat is a ghost here,
    // however well it once owned the section.
    const ghost = Math.max(1e-4, edge / 6);
    const scored = cards.map((c, i) => ({
      c,
      i,
      p: c.probability || 0,
      lift: (c.probability || 0) + seatBonus(c.profKey, section, ctx) * scale,
    }));
    const head = scored.slice(0, n);
    const tail = scored.slice(n).sort((a, b) => b.lift - a.lift || a.i - b.i);
    for (const t of tail) {
      if (t.p < ghost) continue;
      if (t.lift - t.p < 0.03 * scale) continue;
      let swap = -1;
      let worst = Infinity;
      for (let i = 1; i < head.length; i += 1) {
        if (head[i].lift < worst) {
          worst = head[i].lift;
          swap = i;
        }
      }
      if (swap < 0 || t.lift <= worst + 0.01 * scale) continue;
      const evicted = head[swap];
      head[swap] = t;
      const ti = tail.indexOf(t);
      if (ti >= 0) tail[ti] = evicted;
    }
    const used = new Set(head.map((x) => x.c.profKey));
    const rest = scored.filter((x) => !used.has(x.c.profKey)).sort((a, b) => a.i - b.i);
    return head.concat(rest).map((x, idx) => {
      if (!(idx < n && x.i >= n)) return x.c;
      return {
        ...x.c,
        fromLift: true,
        reasons: (x.c.reasons || []).concat({
          name: "lift",
          label: "pulled up — taught this seat",
          contribution: 0.3,
        }),
      };
    });
  }

  function ensembleAccuracy(folds, weights, temperature, novelty, atN = 3, vote, opts = {}) {
    const k = Math.max(1, Number(atN) || 3);
    const lift = !!opts.lift;
    let top1 = 0;
    let top3 = 0;
    let top5 = 0;
    let topN = 0;
    let n = 0;
    let brier = 0;
    for (const fold of folds) {
      for (const row of fold.ensembleRows) {
        let dist = posterior(combine(row.scores, weights, vote), temperature, novelty).filter(
          (d) => d.profKey !== NOVEL
        );
        if (!dist.length) continue;
        if (lift) dist = liftShortlist(dist, row.section, fold.ctx);
        n += 1;
        const idx = dist.findIndex((d) => d.profKey === row.truth);
        if (idx === 0) top1 += 1;
        if (idx >= 0 && idx < 3) top3 += 1;
        if (idx >= 0 && idx < SHORTLIST_N) top5 += 1;
        if (idx >= 0 && idx < k) topN += 1;
        const p = idx >= 0 ? dist[idx].probability : 0;
        brier += (1 - p) ** 2;
      }
    }
    return n
      ? {
          top1: top1 / n,
          top3: top3 / n,
          top5: top5 / n,
          topN: topN / n,
          atN: k,
          brier: brier / n,
          samples: n,
        }
      : { top1: 0, top3: 0, top5: 0, topN: 0, atN: k, brier: 1, samples: 0 };
  }

  const SHORTLIST_FLOOR = 0.5;
  const SHORTLIST_POOL = 15;
  // Slower decay remembers more semesters. On the 39-section bench this was the
  // biggest single lever on top-5; 8 overfits a high-churn department, so stop there.
  const HALF_LIFE_CANDIDATES = [6, 8];
  const TOPN_VOTE_RECIPES = [
    { pad: 1, depth: 5, mix: 0.4, floor: 0.02 },
    { pad: 2, depth: 5, mix: 0.55, floor: 0.02 },
    { pad: 1, depth: 7, mix: 0.5, floor: 0.02 },
    { pad: 2, depth: 8, mix: 0.6, floor: 0.02 },
    { pad: 3, depth: 5, mix: 0.7, floor: 0.02 },
  ];

  /**
   * When Focus is Top-N, the card is only useful if the real name is in the
   * first five. If walk-forward top-5 is below 50%, try a top-5 weight search,
   * wider vote recipes, and a seat lift — and keep a change only when it
   * actually raises that shortlist score.
   */
  function pickTopnRecipe(folds, startWeights, temperature, novelty, startVote, { tuneWeights = true } = {}) {
    const scoreOf = (w, v, lift) =>
      ensembleAccuracy(folds, w, temperature, novelty, SHORTLIST_N, v, { lift });
    let best = {
      weights: startWeights,
      vote: startVote,
      lift: false,
      acc: scoreOf(startWeights, startVote, false),
      retuned: false,
    };
    const consider = (next) => {
      if (next.acc.topN > best.acc.topN + 0.008) best = next;
    };

    if (tuneWeights) {
      const tuned = optimiseWeights(folds, startWeights, { goal: "topn", atN: SHORTLIST_N });
      if (tuned.tuned) {
        const w = pinCrossWeights(tuned.weights);
        consider({
          weights: w,
          vote: startVote,
          lift: false,
          acc: scoreOf(w, startVote, false),
          retuned: true,
        });
      }
    }

    if (best.acc.topN < 0.6) {
      for (const raw of TOPN_VOTE_RECIPES) {
        const v = voteOptions({ ...startVote, ...raw });
        consider({
          weights: best.weights,
          vote: v,
          lift: false,
          acc: scoreOf(best.weights, v, false),
          retuned: true,
        });
      }
    }

    const lifted = scoreOf(best.weights, best.vote, true);
    if (lifted.topN > best.acc.topN + 0.005) {
      best = { ...best, lift: true, acc: lifted, retuned: true };
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Timeslot conflict resolution
   * ------------------------------------------------------------------ */

  function schedulesOverlap(a, b) {
    const daysA = features.parseDays(a.days);
    const daysB = features.parseDays(b.days);
    if (!daysA.length || !daysB.length) return false;
    if (!daysA.some((d) => daysB.includes(d))) return false;
    const aStart = features.parseTime(a.timeStart);
    const aEnd = features.parseTime(a.timeEnd) ?? (aStart != null ? aStart + 60 : null);
    const bStart = features.parseTime(b.timeStart);
    const bEnd = features.parseTime(b.timeEnd) ?? (bStart != null ? bStart + 60 : null);
    if (aStart == null || bStart == null) return false;
    return aStart < bEnd && bStart < aEnd;
  }

  /** Connected components of the "cannot share a professor" graph. */
  function conflictGroups(sections) {
    const parent = sections.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < sections.length; i += 1) {
      for (let j = i + 1; j < sections.length; j += 1) {
        if (schedulesOverlap(sections[i], sections[j])) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    sections.forEach((_, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    });
    return [...groups.values()];
  }

  /** How many sections of this course one professor plausibly carries at once. */
  function profCapacity(profKey, ctx) {
    const p = ctx.profiles.get(profKey);
    if (!p) return 1;
    const peak = Math.max(1, ...p.perTermCount.values());
    return Math.max(1, Math.min(4, Math.round(Math.max(p.avgLoad || 1, peak))));
  }

  /** No professor may hold two sections that meet at the same time. */
  function repairOverlaps(rows, allowed, assignment) {
    const groups = conflictGroups(rows.map((r) => r.meta || {}));
    for (const group of groups) {
      if (group.length < 2) continue;
      const probOf = (i) =>
        allowed[i].find((c) => c.profKey === assignment.get(rows[i].code))?.probability || 0;
      const taken = new Set();
      // Settle the confident sections first; the doubtful ones give way.
      for (const i of [...group].sort((a, b) => probOf(b) - probOf(a))) {
        const pick = assignment.get(rows[i].code);
        if (pick && !taken.has(pick)) {
          taken.add(pick);
          continue;
        }
        const alt = allowed[i].find((c) => !taken.has(c.profKey));
        if (alt) {
          assignment.set(rows[i].code, alt.profKey);
          taken.add(alt.profKey);
        } else {
          assignment.delete(rows[i].code);
        }
      }
    }
    return assignment;
  }

  /**
   * One coherent timetable instead of 39 independent favourites.
   *
   * Each section is a row and each professor becomes as many columns as the
   * sections they historically carried in a single term, so the Hungarian
   * solver minimises total -log probability under that load. Scoring sections
   * independently lets the department's busiest name sit at #1 on a dozen
   * letters, which can only ever be right once.
   */
  function globalLineup(entries, ctx, { topK = 8, maxColumns = 600 } = {}) {
    const assignment = new Map();
    const rows = entries.filter((e) => e.code && e.ranked?.length);
    if (!rows.length) return assignment;

    const allowed = rows.map((e) =>
      e.ranked.filter((c) => c.profKey && c.profKey !== NOVEL && !c.isNew).slice(0, topK)
    );
    const pool = [...new Set(allowed.flat().map((c) => c.profKey))];
    if (!pool.length) return assignment;

    const slots = [];
    for (const profKey of pool) {
      const cap = profCapacity(profKey, ctx);
      for (let i = 0; i < cap && slots.length < maxColumns; i += 1) slots.push(profKey);
    }
    // Hungarian needs at least as many columns as rows; spare seats stay empty.
    while (slots.length < rows.length) slots.push(null);

    const MISS = 40;
    const cost = allowed.map((list) => {
      const probOf = new Map(list.map((c) => [c.profKey, c.probability || 0]));
      return slots.map((profKey) => {
        if (!profKey) return MISS + 10;
        const p = probOf.get(profKey);
        return p == null ? MISS : -Math.log(Math.max(1e-9, p));
      });
    });

    hungarian(cost).forEach((col, row) => {
      if (col < 0) return;
      const profKey = slots[col];
      if (profKey && cost[row][col] < MISS) assignment.set(rows[row].code, profKey);
    });
    return repairOverlaps(rows, allowed, assignment);
  }

  function lineupEntries(sectionResults) {
    return sectionResults.map((s) => ({
      code: s.section,
      meta: s,
      ranked: [...s.candidates, ...(s.overflow || [])],
    }));
  }

  /**
   * Put the assigned professor at #1, pulling them in from the reserve list when
   * the timetable landed on someone who missed the shortlist.
   */
  /**
   * Names that belong on the card even if the blend buried them: last holder,
   * last same-semester holder, people who actually taught this letter / slot.
   * This is what the padder cannot do — it only reorders whoever already made
   * the shortlist.
   */
  function coverageKeys(section, ctx, want) {
    const out = [];
    const seen = new Set();
    const add = (k) => {
      if (!k || seen.has(k) || !ctx.profiles?.has(k)) return;
      seen.add(k);
      out.push(k);
    };
    const mem = ctx.sectionMemory?.get(section.section);
    add(mem?.lastSameSemProf);
    add(mem?.lastProf);
    add(mem?.prevProf);

    const fam = features.sectionFamily(section.section);
    const days = features.parseDays(section.days);
    const start = features.parseTime(section.timeStart);
    const exact = [];
    const family = [];
    const slot = [];
    for (const [pk, p] of ctx.profiles || []) {
      const sw = p.sections?.get(section.section) || 0;
      if (sw) exact.push({ pk, sw, last: p.sectionLast?.get(section.section) || 0 });
      const fw = p.families?.get(fam) || 0;
      if (fw) family.push({ pk, fw });
      let slotW = 0;
      for (const s of p.slots || []) {
        if (start == null || s.start == null) continue;
        if (Math.abs(s.start - start) > 30) continue;
        if (days.length && s.days?.length && !days.some((d) => s.days.includes(d))) continue;
        slotW += s.weight || 0;
      }
      if (slotW) slot.push({ pk, slotW });
    }
    exact.sort((a, b) => b.sw - a.sw || b.last - a.last);
    family.sort((a, b) => b.fw - a.fw);
    slot.sort((a, b) => b.slotW - a.slotW);
    exact.forEach((x) => add(x.pk));
    slot.slice(0, 3).forEach((x) => add(x.pk));
    family.slice(0, 3).forEach((x) => add(x.pk));
    return out.slice(0, Math.max(1, want));
  }

  function applyCoverage(candidates, overflow, ranked, section, ctx, limit, targetTerm, opts) {
    const keys = coverageKeys(section, ctx, limit);
    const have = new Set(candidates.map((c) => c.profKey));
    const pull = (key) => {
      const hit = overflow.find((c) => c.profKey === key);
      if (hit) return { ...hit, fromCoverage: true };
      const raw = (ranked || []).find((d) => d.profKey === key);
      if (!raw || !(raw.probability > 0)) return null;
      const profile = ctx.profiles.get(key);
      return {
        profKey: key,
        name: profile?.displayName || key,
        probability: raw.probability,
        percent: Math.round(raw.probability * 1000) / 10,
        percentLabel: formatPercent(raw.probability),
        termsTaught: profile ? [...profile.terms].sort((a, b) => a - b) : [],
        sectionsTaught: profile ? [...profile.sections.keys()] : [],
        lastSeen: profile?.lastTerm ?? null,
        verified: opts.verifiedSet.has(`${targetTerm}|${section.section}|${key}`),
        fromCoverage: true,
        reasons: explain(raw.vector).concat({
          name: "coverage",
          label: "promoted — taught this seat and was already close",
          contribution: 0.4,
        }),
      };
    };

    for (const key of keys) {
      if (have.has(key)) continue;
      const card = pull(key);
      if (!card) continue;
      if (candidates.length < limit) {
        candidates.push(card);
        have.add(key);
        continue;
      }
      // Only take the weakest tail seat, and only if this name already outscored it.
      // Inventing a 1% "last holder" card here is what made Top-5 focus *worse*
      // than Top-1 focus on the same 39 sections. When N > 5, the first five
      // names stay locked — coverage may only replace ranks 6–N.
      let swap = -1;
      let weakest = Infinity;
      const protect = limit > SHORTLIST_N ? Math.min(SHORTLIST_N, candidates.length) : 1;
      for (let i = protect; i < candidates.length; i += 1) {
        const p = candidates[i].probability || 0;
        if (p < weakest) {
          weakest = p;
          swap = i;
        }
      }
      if (swap < 0 || (card.probability || 0) <= weakest) continue;
      candidates[swap] = card;
      have.add(key);
    }
    return candidates.slice(0, limit);
  }

  function applyLineup(sectionResults, lineup, limit) {
    for (const s of sectionResults) {
      if (s.confirmed) continue;
      const pick = lineup.get(s.section);
      if (!pick) continue;
      const i = s.candidates.findIndex((c) => c.profKey === pick);
      if (i === 0) continue;
      if (i > 0) {
        const [hit] = s.candidates.splice(i, 1);
        s.candidates.unshift(hit);
        continue;
      }
      const reserve = (s.overflow || []).find((c) => c.profKey === pick);
      if (reserve) {
        s.candidates.unshift(reserve);
        s.candidates.splice(Math.max(1, limit));
      }
    }
  }

  /**
   * Backtest top-1 for both orderings on the same folds, so the caller can pick
   * the assignment only where it genuinely beats each section's own favourite.
   */
  function lineupVsMarginal(folds, weights, temperature, novelty, vote) {
    let assignSum = 0;
    let marginalSum = 0;
    let terms = 0;
    for (const fold of folds) {
      const entries = fold.ensembleRows.map((row) => ({
        code: row.section?.section,
        meta: row.section,
        ranked: posterior(combine(row.scores, weights, vote), temperature, novelty).filter(
          (d) => d.profKey !== NOVEL
        ),
      }));
      const lineup = globalLineup(entries, fold.ctx);
      let assignHit = 0;
      let marginalHit = 0;
      let n = 0;
      entries.forEach((entry, i) => {
        if (!entry.code) return;
        n += 1;
        const truth = fold.ensembleRows[i].truth;
        if (lineup.get(entry.code) === truth) assignHit += 1;
        if (entry.ranked[0]?.profKey === truth) marginalHit += 1;
      });
      if (!n) continue;
      assignSum += assignHit / n;
      marginalSum += marginalHit / n;
      terms += 1;
    }
    return terms
      ? { assignment: assignSum / terms, marginal: marginalSum / terms, terms }
      : { assignment: 0, marginal: 0, terms: 0 };
  }

  /** Rank of the actual named professor in the shortlist, or -1. */
  function truthRank(candidates, actualProfKey) {
    if (!actualProfKey) return -1;
    return (candidates || []).findIndex((c) => c.profKey === actualProfKey);
  }

  /**
   * Who usually teaches a letter family (B → B, B1, B2…), independent of the
   * exact numbered section being predicted this term.
   */
  function familySummaries(records, targetTerm, opts = {}) {
    const filter = opts.filter;
    const limit = Math.max(1, opts.limit ?? 5);
    const history = revealedRecords(records).filter((r) => r.term < targetTerm);
    const letters = new Map();
    for (const r of history) {
      const fam = features.sectionFamily(r.section);
      if (filter && !filter.all && !features.sectionAllowed(r.section, filter)) continue;
      if (!letters.has(fam)) {
        letters.set(fam, { letter: fam, sections: new Set(), profs: new Map(), total: 0 });
      }
      const g = letters.get(fam);
      g.sections.add(r.section);
      g.total += 1;
      let prev = g.profs.get(r.profKey);
      if (!prev) {
        prev = {
          profKey: r.profKey,
          name: names.displayName(r.instructor || r.profKey),
          count: 0,
          terms: new Set(),
        };
        g.profs.set(r.profKey, prev);
      }
      prev.count += 1;
      prev.terms.add(r.term);
    }
    return [...letters.values()]
      .sort((a, b) => a.letter.localeCompare(b.letter))
      .map((g) => ({
        letter: g.letter,
        sections: [...g.sections].sort(features.compareSections),
        offerings: g.total,
        frequent: [...g.profs.values()]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, limit)
          .map((p) => ({
            profKey: p.profKey,
            name: p.name,
            count: p.count,
            terms: [...p.terms].sort((a, b) => a - b),
            share: g.total ? Math.round((p.count / g.total) * 1000) / 10 : 0,
          })),
      }));
  }

  /**
   * Course-wide lecture vs lab faculty, not a specific letter or numbered
   * section. "G" and "B" feed Lecture; "G-1L" / "E-3L" feed Lab / Recit.
   */
  function componentSummaries(records, targetTerm, opts = {}) {
    const filter = opts.filter;
    const limit = Math.max(SHORTLIST_N, opts.limit ?? SHORTLIST_N);
    const halfLife = opts.halfLife ?? features.DEFAULT_HALF_LIFE;
    const history = revealedRecords(records).filter((r) => r.term < targetTerm);
    const buckets = {
      lecture: { kind: "lecture", label: "Lecture", profs: new Map(), total: 0, count: 0, sections: new Set() },
      lab: { kind: "lab", label: "Lab / Recit", profs: new Map(), total: 0, count: 0, sections: new Set() },
    };
    for (const r of history) {
      if (!r.profKey) continue;
      if (filter && !filter.all && !features.sectionAllowed(r.section, filter)) continue;
      const kind = features.sectionKind(r.section);
      const g = buckets[kind];
      if (!g) continue;
      const w = features.decayWeight(r.term, targetTerm, halfLife);
      g.total += w;
      g.count += 1;
      g.sections.add(r.section);
      let prev = g.profs.get(r.profKey);
      if (!prev) {
        prev = {
          profKey: r.profKey,
          name: names.displayName(r.instructor || r.profKey),
          weight: 0,
          count: 0,
          terms: new Set(),
        };
        g.profs.set(r.profKey, prev);
      }
      prev.weight += w;
      prev.count += 1;
      prev.terms.add(r.term);
    }
    const both = ["lecture", "lab"]
      .map((k) => buckets[k])
      .filter((g) => g.count > 0)
      .map((g) => ({
        kind: g.kind,
        label: g.label,
        sections: [...g.sections].sort(features.compareSections),
        offerings: g.count,
        frequent: [...g.profs.values()]
          .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
          .slice(0, limit)
          .map((p) => ({
            profKey: p.profKey,
            name: p.name,
            count: p.count,
            terms: [...p.terms].sort((a, b) => a - b),
            share: g.total ? Math.round((p.weight / g.total) * 1000) / 10 : 0,
          })),
      }));
    // Only useful when the course actually splits lecture and lab. A
    // lecture-only (or lab-only) subject should not grow a second card.
    const kinds = new Set(both.map((c) => c.kind));
    return kinds.has("lecture") && kinds.has("lab") ? both : [];
  }

  /* ------------------------------------------------------------------ *
   * Entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {object} input
   * @param {Array} input.records  every scanned record across all terms
   * @param {number} input.targetTerm  term being predicted, e.g. 1261
   * @param {Array} [input.targetSections]  sections of the target term
   * @param {Array} [input.verified]  mod-confirmed `{term, section, profKey}`
   * @param {number} [input.limit]  max professors listed per section
   */
  function run(input) {
    const opts = {
      halfLife: input.halfLife ?? features.DEFAULT_HALF_LIFE,
      minTrainRows: input.minTrainRows ?? 24,
      verifiedSet: new Set((input.verified || []).map((v) => `${v.term}|${v.section}|${v.profKey}`)),
      logistic: input.logisticOptions || {},
      forest: input.forestOptions || {},
    };
    const limit = Math.max(1, input.limit ?? 3);
    const minProbability = input.minProbability ?? 0.005;
    let vote = voteOptions({
      ...DEFAULT_VOTE,
      ...input.vote,
      depth: resolveVoteDepth(input),
    });
    const { goal, atN, coverage } = resolveGoal({ ...input, limit });
    const crossPrior = Number.isFinite(Number(input.crossPrior))
      ? Math.max(0, Number(input.crossPrior))
      : CROSS_PRIOR;
    const records = input.records || [];
    const targetTerm = Number(input.targetTerm);

    const revealed = revealedRecords(records);
    const historyTerms = termsPresent(revealed).filter((t) => t < targetTerm);

    if (!historyTerms.length) {
      return {
        ok: false,
        error: "no_history",
        message:
          "No past term in the scan had a revealed instructor for this course. Widen the term floor or check the course code.",
        targetTerm,
      };
    }

    const novelty = noveltyRate(records);
    const emptyWeights = Object.fromEntries(MODEL_KEYS.map((k) => [k, k === "heuristic" ? 1 : 0]));
    const foldTerms = historyTerms.slice(1).slice(-4);

    /** Everything that depends on how fast old semesters are discounted. */
    const fitFor = (halfLife) => {
      const scoped = { ...opts, halfLife };
      const built = foldTerms.map((t) => evaluateTerm(records, t, scoped)).filter(Boolean);
      const derived = built.length ? deriveWeights(built) : { weights: emptyWeights, accuracy: {} };
      const tuning =
        built.length && input.tuneWeights !== false
          ? optimiseWeights(built, derived.weights, { goal: "top1", atN: 1 })
          : { weights: derived.weights || emptyWeights, tuned: false };
      const w = pinCrossWeights(tuning.weights, crossPrior);
      const calibration = built.length
        ? calibrateTemperature(built, w, novelty, vote, { goal: "top1", atN: 1 })
        : { temperature: 1, logLoss: null };
      const fit = {
        halfLife,
        folds: built,
        accuracy: derived.accuracy,
        tuning,
        weights: w,
        calibration,
        vote,
        lift: false,
        shortlist: null,
        retuned: false,
      };
      if (goal === "topn" && built.length) {
        const picked = pickTopnRecipe(built, w, calibration.temperature, novelty, vote, {
          tuneWeights: input.tuneWeights !== false,
        });
        fit.weights = picked.weights;
        fit.vote = picked.vote;
        fit.lift = picked.lift;
        fit.shortlist = picked.acc;
        fit.retuned = !!picked.retuned;
      }
      return fit;
    };

    let fit = fitFor(opts.halfLife);
    // A shortlist under 50% is not worth showing. Remembering more semesters is
    // the single biggest lever on top-5, so try slower decay before giving up.
    if (goal === "topn" && fit.folds.length && (fit.shortlist?.top5 ?? 0) < SHORTLIST_FLOOR) {
      for (const halfLife of HALF_LIFE_CANDIDATES) {
        if (halfLife === opts.halfLife) continue;
        const alt = fitFor(halfLife);
        if ((alt.shortlist?.top5 ?? 0) > (fit.shortlist?.top5 ?? 0) + 0.01) fit = alt;
        if ((fit.shortlist?.top5 ?? 0) >= SHORTLIST_FLOOR) break;
      }
    }

    opts.halfLife = fit.halfLife;
    const folds = fit.folds;
    const accuracy = fit.accuracy;
    const tuning = fit.tuning;
    const calibration = fit.calibration;
    let weights = fit.weights;
    vote = fit.vote;
    const shortlistLift = fit.lift;
    const shortlistBacktest = fit.shortlist;
    const shortlistRetuned = fit.retuned;
    const halfLifeSearched = fit.halfLife !== (input.halfLife ?? features.DEFAULT_HALF_LIFE);
    const ensemble = folds.length
      ? ensembleAccuracy(folds, weights, calibration.temperature, novelty, limit, vote, {
          lift: shortlistLift,
        })
      : { top1: 0, top3: 0, top5: 0, topN: 0, atN: limit, brier: null, samples: 0 };
    const lineupTest = folds.length
      ? lineupVsMarginal(folds, weights, calibration.temperature, novelty, vote)
      : { assignment: 0, marginal: 0, terms: 0 };
    // Only reorder by the timetable when past semesters say so clearly. A
    // one-point edge on four folds is noise, and acting on it costs real
    // accuracy on the term being predicted.
    const lineupMode = input.lineup || "auto";
    const useAssignment =
      lineupMode === "off" || (coverage && lineupMode !== "always")
        ? false
        : lineupMode === "always" ||
          (lineupTest.terms >= 2 && lineupTest.assignment > lineupTest.marginal + 0.03);

    // Final models see all history before the target term.
    const ctx = makeContext(records, targetTerm, opts);
    const { X, y } = buildExamples(records, targetTerm, opts);
    const models = trainModels(X, y, opts);
    if (!models.logistic) weights.logistic = 0;
    if (!models.forest) weights.forest = 0;
    if (!models.extraTrees) weights.extraTrees = 0;
    if (!models.naiveBayes) weights.naiveBayes = 0;
    if (!models.perceptron) weights.perceptron = 0;
    if (!models.prototype) weights.cosine = 0;
    if (!models.stumps) weights.stumps = 0;
    const wTotal = MODEL_KEYS.reduce((a, k) => a + (weights[k] || 0), 0) || 1;
    MODEL_KEYS.forEach((k) => {
      weights[k] = (weights[k] || 0) / wTotal;
    });
    Object.assign(weights, pinCrossWeights(weights, crossPrior));

    // Predict exactly the sections that were scanned for this term. Do not
    // invent extra cards from older layouts — that made the bot count drift.
    const targetSections = input.targetSections?.length
      ? input.targetSections
      : sectionsOfTerm(records, targetTerm);
    if (!targetSections.length) {
      return {
        ok: false,
        error: "no_target_sections",
        message: "No sections were scanned for this term, so there is nothing to predict yet.",
        targetTerm,
      };
    }

    const importance = {};
    if (models.forest?.importance) {
      Object.entries(models.forest.importance).forEach(([idx, v]) => {
        importance[features.FEATURE_NAMES[Number(idx)]] = v;
      });
    }

    // A moderator confirmation for the target term is ground truth, not a
    // guess. It also may name someone with no teaching history at all, who
    // could therefore never appear in the candidate pool.
    const confirmedBySection = new Map(
      (input.verified || [])
        .filter((v) => Number(v.term) === targetTerm && v.profKey)
        .map((v) => [String(v.section).trim().toUpperCase(), v])
    );

    ctx.guesses = firstPassGuesses(targetSections, ctx);
    const peek = targetSections.map((section) => ({
      section,
      scores: rawScores(section, ctx, models),
    }));
    const refreshed = guessesFromScores(peek, weights, calibration.temperature, novelty, { vote });
    if (refreshed.length) ctx.guesses = refreshed;

    const sectionResults = targetSections.map((section) => {
      const raw = rawScores(section, ctx, models);
      const votes = modelTopPicks(raw, weights, vote);
      const combined = combine(raw, weights, vote);
      const dist = posterior(combined, calibration.temperature, novelty);
      const ranked = dist.filter((d) => d.profKey !== NOVEL);
      const confidence = sectionConfidence(dist, votes, ensemble.top1);
      const agreeCount = ranked[0]
        ? Object.values(votes).filter((k) => k === ranked[0].profKey).length
        : 0;
      const cards = ranked
        // Listing a professor at 0.0% is noise; always keep the top pick though,
        // so a section is never rendered with an empty candidate list.
        .filter((d, i) => i === 0 || d.probability >= minProbability)
        // A few names past the shortlist stay available: the timetable solver
        // may need one of them when a stronger section claims the favourite.
        .slice(0, Math.max(limit, LINEUP_POOL, goal === "topn" ? SHORTLIST_POOL : 0))
        .map((d) => {
          const profile = ctx.profiles.get(d.profKey);
          return {
            profKey: d.profKey,
            name: profile?.displayName || d.profKey,
            probability: d.probability,
            percent: Math.round(d.probability * 1000) / 10,
            percentLabel: formatPercent(d.probability),
            termsTaught: profile ? [...profile.terms].sort((a, b) => a - b) : [],
            sectionsTaught: profile ? [...profile.sections.keys()] : [],
            lastSeen: profile?.lastTerm ?? null,
            verified: opts.verifiedSet.has(`${targetTerm}|${section.section}|${d.profKey}`),
            reasons: explain(d.vector),
          };
        });
      const poolLimit = Math.max(limit, goal === "topn" ? SHORTLIST_POOL : LINEUP_POOL);
      let pool = cards.slice(0, poolLimit);
      const leftover = cards.slice(poolLimit);
      if (coverage) {
        pool = applyCoverage(pool, leftover, ranked, section, ctx, poolLimit, targetTerm, opts);
      }
      if (shortlistLift) pool = liftShortlist(pool, section, ctx);
      let candidates = pool.slice(0, limit);
      const overflow = pool.slice(limit);
      const novelEntry = dist.find((d) => d.profKey === NOVEL);
      let newProfChance = Math.round((novelEntry?.probability ?? 0) * 1000) / 10;

      const confirmed = confirmedBySection.get(section.section);
      if (confirmed) {
        const profile = ctx.profiles.get(confirmed.profKey);
        const entry = {
          profKey: confirmed.profKey,
          name: names.displayName(confirmed.instructor),
          probability: 1,
          percent: 100,
          percentLabel: "confirmed",
          termsTaught: profile ? [...profile.terms].sort((a, b) => a - b) : [],
          sectionsTaught: profile ? [...profile.sections.keys()] : [],
          lastSeen: profile?.lastTerm ?? null,
          verified: true,
          confirmed: true,
          confirmedBy: confirmed.by || "",
          isNewToCourse: !profile,
          reasons: [{ name: "verified", label: "confirmed by a moderator", contribution: Infinity }],
        };
        candidates = [entry, ...candidates.filter((c) => c.profKey !== confirmed.profKey)].slice(
          0,
          Math.max(1, limit)
        );
        newProfChance = 0;
      }

      return {
        section: section.section,
        days: section.days || "",
        timeStart: section.timeStart || "",
        timeEnd: section.timeEnd || "",
        room: section.room || "",
        currentInstructor: section.instructor || "",
        isTba: !section.profKey || names.isTba(section.instructor),
        confirmed: !!confirmed,
        inheritedFrom: section.inheritedFrom || null,
        kind: features.sectionKind(section.section),
        candidates,
        overflow,
        newProfChance,
        confidence,
        modelsAgree: agreeCount,
        modelsTotal: Object.keys(votes).length,
        modelVotes: votes,
      };
    });

    const lineup = globalLineup(lineupEntries(sectionResults), ctx);
    if (useAssignment) applyLineup(sectionResults, lineup, limit);
    sectionResults.forEach((s) => {
      s.lineupPick = lineup.get(s.section) || null;
      s.candidates.forEach((c) => {
        c.isLineupPick = c.profKey === s.lineupPick;
      });
      delete s.overflow;
    });

    const families = familySummaries(records, targetTerm, {
      filter: input.sectionFilter,
      limit,
      halfLife: opts.halfLife,
    });
    const components = componentSummaries(records, targetTerm, {
      filter: input.sectionFilter,
      limit,
      halfLife: opts.halfLife,
    });
    const confidences = sectionResults
      .map((s) => Number(s.confidence))
      .filter((n) => Number.isFinite(n));
    const overallConfidence = confidences.length
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10) / 10
      : Math.round((ensemble.top1 || 0) * 1000) / 10;

    return {
      ok: true,
      targetTerm,
      targetTermLabel: terms.label(targetTerm),
      sections: sectionResults,
      families,
      components,
      scannedSections: targetSections.length,
      predictedSections: sectionResults.length,
      model: {
        weights,
        temperature: calibration.temperature,
        noveltyRate: Math.round(novelty * 1000) / 10,
        candidatePool: ctx.profiles.size,
        trainRows: X.length,
        trainPositives: y.reduce((a, b) => a + b, 0),
        forestTrained: !!models.forest,
        logisticTrained: !!models.logistic,
        extraTreesTrained: !!models.extraTrees,
        naiveBayesTrained: !!models.naiveBayes,
        modelCount: MODEL_KEYS.length,
        modelsUsed: MODEL_KEYS.filter((k) => (weights[k] || 0) > 0.001).length,
        confidence: overallConfidence,
        featureImportance: importance,
        weightsTuned: !!tuning.tuned,
        lineupApplied: useAssignment,
        crossPrior,
        crossKeys: CROSS_KEYS,
        vote,
        goal,
        goalAt: atN,
        shortlistLift,
        shortlistBacktest,
        shortlistRetuned,
        halfLife: opts.halfLife,
        halfLifeSearched,
      },
      backtest: {
        folds: folds.map((f) => ({
          term: f.term,
          termLabel: terms.label(f.term),
          candidateCount: f.candidateCount,
          perModel: Object.fromEntries(
            MODEL_KEYS.map((k) => [
              k,
              {
                top1: f.perModel[k].top1Rate ?? null,
                top3: f.perModel[k].top3Rate ?? null,
                mrr: f.perModel[k].mrrRate ?? null,
                samples: f.perModel[k].n,
              },
            ])
          ),
        })),
        perModelAccuracy: accuracy,
        ensemble,
        lineup: lineupTest,
        logLoss: calibration.logLoss,
      },
      historyTerms,
    };
  }

  /** Top contributing features for one candidate, for the "why" tooltip. */
  function explain(vector, top = 3) {
    if (!vector) return [];
    const LABELS = {
      freqDecay: "teaches this course often",
      sameSemShare: "usually this semester",
      sectionExact: "taught this exact section before",
      sectionFamily: "taught sibling sections",
      slotAffinity: "same day + time slot",
      dayAffinity: "same days",
      timeAffinity: "same time of day",
      roomAffinity: "same room",
      recencyLastSeen: "active recently",
      streakRatio: "teaches nearly every term",
      loadShare: "carries several sections",
      tenureSpan: "long tenure in this course",
      verified: "confirmed by a moderator",
      partnerCond: "paired with other sections this term",
      partnerPair: "teaches in the same term as likely colleagues",
      bundleFit: "usually takes this letter with another section",
      lastSameSem: "taught this section last same semester",
      newcomerFit: "recent one-term or new name on a changing seat",
      successorFit: "replaced the last person on this section",
      componentFit: "usually teaches this lecture or lab component",
    };
    return features.FEATURE_NAMES.map((name, i) => ({
      name,
      label: LABELS[name] || name,
      contribution: (features.HEURISTIC_WEIGHTS[name] || 0) * (vector[i] || 0),
    }))
      .filter((f) => f.contribution > 0.05)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, top);
  }

  /**
   * "Who is the actual prof of this section?" - fuzzy-match a typed name
   * against every professor seen in the scanned history.
   */
  function identify(query, records, { limit = 5 } = {}) {
    const pool = new Map();
    for (const r of revealedRecords(records)) {
      if (!pool.has(r.profKey)) {
        pool.set(r.profKey, {
          profKey: r.profKey,
          name: names.displayName(r.instructor),
          raw: new Set([r.instructor]),
          terms: new Set([r.term]),
          sections: new Set([r.section]),
        });
      } else {
        const e = pool.get(r.profKey);
        e.raw.add(r.instructor);
        e.terms.add(r.term);
        e.sections.add(r.section);
      }
    }
    const candidates = [...pool.values()];
    const matches = names.bestMatches(query, candidates, { limit, minScore: 0.4 });
    return matches.map((m) => ({
      profKey: m.entry.profKey,
      name: m.entry.name,
      score: Math.round(m.score * 1000) / 10,
      variants: [...m.entry.raw],
      terms: [...m.entry.terms].sort((a, b) => a - b),
      sections: [...m.entry.sections],
    }));
  }

  PD.predict = {
    NOVEL,
    MODEL_KEYS,
    run,
    identify,
    truthRank,
    familySummaries,
    componentSummaries,
    formatPercent,
    explain,
    trainLogistic,
    logisticProba,
    hungarian,
    globalLineup,
    profCapacity,
    optimiseWeights,
    firstPassGuesses,
    pinCrossWeights,
    applyVotePadding,
    applyCoverage,
    liftShortlist,
    seatBonus,
    pickTopnRecipe,
    coverageKeys,
    resolveGoal,
    resolveVoteDepth,
    voteOptions,
    DEFAULT_VOTE,
    SHORTLIST_N,
    CROSS_KEYS,
    CROSS_PRIOR,
    buildExamples,
    evaluateTerm,
    noveltyRate,
    schedulesOverlap,
    conflictGroups,
    revealedRecords,
  };
})();
