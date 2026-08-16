/**
 * Profdictor - random forest classifier (CART + bagging), written from scratch
 * so the extension ships with no dependencies and no remote model calls.
 *
 * The dataset here is small and heavily imbalanced (one true professor per
 * section against many candidates), so two knobs matter more than depth:
 * `positiveWeight` to stop the trees predicting "nobody" everywhere, and
 * `maxDepth` kept shallow to limit overfitting on a handful of terms.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.forest) return;

  /** Deterministic PRNG so repeated runs on the same data agree. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function weightedGini(posWeight, negWeight) {
    const total = posWeight + negWeight;
    if (total <= 0) return 0;
    const p = posWeight / total;
    return 1 - (p * p + (1 - p) * (1 - p));
  }

  /**
   * Best (feature, threshold) split by weighted Gini gain.
   * Candidate thresholds are midpoints between distinct sorted values.
   */
  function findSplit(rows, X, y, w, featureIdx, minLeaf) {
    let best = null;
    let posAll = 0;
    let negAll = 0;
    for (const i of rows) {
      if (y[i] === 1) posAll += w[i];
      else negAll += w[i];
    }
    const parentImpurity = weightedGini(posAll, negAll);
    const totalWeight = posAll + negAll;
    if (totalWeight <= 0) return null;

    for (const f of featureIdx) {
      const sorted = [...rows].sort((a, b) => X[a][f] - X[b][f]);
      let leftPos = 0;
      let leftNeg = 0;
      for (let k = 0; k < sorted.length - 1; k += 1) {
        const i = sorted[k];
        if (y[i] === 1) leftPos += w[i];
        else leftNeg += w[i];
        const vCur = X[i][f];
        const vNext = X[sorted[k + 1]][f];
        if (vCur === vNext) continue;
        if (k + 1 < minLeaf || sorted.length - (k + 1) < minLeaf) continue;

        const leftWeight = leftPos + leftNeg;
        const rightPos = posAll - leftPos;
        const rightNeg = negAll - leftNeg;
        const rightWeight = rightPos + rightNeg;
        if (leftWeight <= 0 || rightWeight <= 0) continue;

        const gain =
          parentImpurity -
          (leftWeight / totalWeight) * weightedGini(leftPos, leftNeg) -
          (rightWeight / totalWeight) * weightedGini(rightPos, rightNeg);

        if (!best || gain > best.gain) {
          best = { feature: f, threshold: (vCur + vNext) / 2, gain };
        }
      }
    }
    return best && best.gain > 1e-9 ? best : null;
  }

  function leafValue(rows, y, w) {
    let pos = 0;
    let total = 0;
    for (const i of rows) {
      total += w[i];
      if (y[i] === 1) pos += w[i];
    }
    // Laplace smoothing keeps leaves away from hard 0/1.
    return total > 0 ? (pos + 0.5) / (total + 1) : 0.5;
  }

  function buildTree(rows, X, y, w, opts, rand, depth = 0) {
    if (depth >= opts.maxDepth || rows.length < opts.minSamplesSplit) {
      return { leaf: true, value: leafValue(rows, y, w) };
    }
    let pure = true;
    for (let k = 1; k < rows.length; k += 1) {
      if (y[rows[k]] !== y[rows[0]]) {
        pure = false;
        break;
      }
    }
    if (pure) return { leaf: true, value: leafValue(rows, y, w) };

    const nFeatures = X[0].length;
    const mtry = Math.max(1, Math.min(nFeatures, opts.mtry || Math.ceil(Math.sqrt(nFeatures))));
    const pool = [];
    for (let f = 0; f < nFeatures; f += 1) pool.push(f);
    for (let k = pool.length - 1; k > 0; k -= 1) {
      const j = Math.floor(rand() * (k + 1));
      [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    const featureIdx = pool.slice(0, mtry);

    const split = findSplit(rows, X, y, w, featureIdx, opts.minLeaf);
    if (!split) return { leaf: true, value: leafValue(rows, y, w) };

    const left = [];
    const right = [];
    for (const i of rows) {
      if (X[i][split.feature] <= split.threshold) left.push(i);
      else right.push(i);
    }
    if (!left.length || !right.length) return { leaf: true, value: leafValue(rows, y, w) };

    return {
      leaf: false,
      feature: split.feature,
      threshold: split.threshold,
      gain: split.gain,
      left: buildTree(left, X, y, w, opts, rand, depth + 1),
      right: buildTree(right, X, y, w, opts, rand, depth + 1),
    };
  }

  function treePredict(node, x) {
    let cur = node;
    while (cur && !cur.leaf) {
      cur = x[cur.feature] <= cur.threshold ? cur.left : cur.right;
    }
    return cur ? cur.value : 0.5;
  }

  /** Accumulated Gini gain per feature, normalised - used for the "why" panel. */
  function accumulateImportance(node, out) {
    if (!node || node.leaf) return;
    out[node.feature] = (out[node.feature] || 0) + (node.gain || 0);
    accumulateImportance(node.left, out);
    accumulateImportance(node.right, out);
  }

  /**
   * @param {number[][]} X design matrix
   * @param {number[]} y labels in {0,1}
   */
  function train(X, y, options = {}) {
    const opts = {
      nTrees: options.nTrees ?? 60,
      maxDepth: options.maxDepth ?? 5,
      minSamplesSplit: options.minSamplesSplit ?? 6,
      minLeaf: options.minLeaf ?? 2,
      mtry: options.mtry ?? 0,
      positiveWeight: options.positiveWeight ?? 0,
      sampleRatio: options.sampleRatio ?? 0.8,
      seed: options.seed ?? 1337,
    };
    if (!X.length || !X[0]?.length) return null;

    const posCount = y.reduce((a, b) => a + (b === 1 ? 1 : 0), 0);
    const negCount = y.length - posCount;
    if (!posCount || !negCount) return null;

    // Rebalance so the rare "this is the prof" class is not drowned out.
    const positiveWeight = opts.positiveWeight || negCount / posCount;
    const w = y.map((label) => (label === 1 ? positiveWeight : 1));

    const rand = mulberry32(opts.seed);
    const trees = [];
    const sampleSize = Math.max(4, Math.floor(X.length * opts.sampleRatio));

    for (let t = 0; t < opts.nTrees; t += 1) {
      const rows = [];
      for (let k = 0; k < sampleSize; k += 1) rows.push(Math.floor(rand() * X.length));
      trees.push(buildTree(rows, X, y, w, opts, rand));
    }

    const importanceRaw = {};
    trees.forEach((tree) => accumulateImportance(tree, importanceRaw));
    const importanceTotal = Object.values(importanceRaw).reduce((a, b) => a + b, 0) || 1;
    const importance = {};
    Object.entries(importanceRaw).forEach(([f, v]) => {
      importance[Number(f)] = v / importanceTotal;
    });

    return {
      kind: "randomForest",
      trees,
      nFeatures: X[0].length,
      opts,
      importance,
      trainSize: X.length,
      positives: posCount,
    };
  }

  function predictProba(model, x) {
    if (!model?.trees?.length) return 0.5;
    let sum = 0;
    for (const tree of model.trees) sum += treePredict(tree, x);
    return sum / model.trees.length;
  }

  PD.forest = { train, predictProba, mulberry32 };
})();
