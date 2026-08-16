/**
 * Profdictor content script.
 *
 * Lives on the AMIS enrollment page. Owns the floating progress panel, the
 * full-screen results overlay, and the orchestration of scan -> model ->
 * display. Runs here rather than in the service worker because the AMIS session
 * (cookies, Nuxt axios) only exists in this tab.
 */
(() => {
  const PD = self.PD;
  if (!PD?.scanner || !PD?.predict || !PD?.db) {
    console.warn("[Profdictor] libraries missing; content script idle");
    return;
  }
  if (self.__PROFDICTOR_CONTENT__) return;
  self.__PROFDICTOR_CONTENT__ = true;

  const { terms, names, db, scanner, predict, features } = PD;
  const LAST_KEY = "profdictor.lastResult";
  // Remembered so the panel's Diagnose button can probe the same course/term the
  // last run used, without the popup being open.
  let lastConfig = { courseCode: "", targetTerm: null };

  let lastResult = null;

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

  /* ------------------------------------------------------------------ *
   * Floating panel
   * ------------------------------------------------------------------ */

  let panel = null;
  let logBox = null;

  function buildPanel() {
    if (panel) return panel;
    const root = document.createElement("div");
    root.id = "pd-root";
    root.innerHTML = `
      <div id="pd-panel">
        <div id="pd-header">
          <div id="pd-brand"><span class="pd-accent">P</span>rof<span class="pd-accent">d</span>ictor</div>
          <div id="pd-header-actions">
            <button id="pd-show-last" class="pd-mini" type="button" title="Show the last prediction">Last result</button>
            <button id="pd-diagnose" class="pd-mini" type="button" title="Check what Profdictor can see on this page">Diagnose</button>
            <button id="pd-toggle" class="pd-mini" type="button">Hide</button>
          </div>
        </div>
        <div id="pd-body">
          <div id="pd-status">Idle. Open the extension popup to run a prediction.</div>
          <div id="pd-console">
            <div id="pd-console-head">SCAN CONSOLE</div>
            <div id="pd-log" aria-live="polite"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    panel = root;
    logBox = root.querySelector("#pd-log");

    root.querySelector("#pd-toggle").addEventListener("click", () => {
      const body = root.querySelector("#pd-body");
      const hidden = body.hasAttribute("hidden");
      if (hidden) body.removeAttribute("hidden");
      else body.setAttribute("hidden", "");
      root.querySelector("#pd-toggle").textContent = hidden ? "Hide" : "Show";
    });
    root.querySelector("#pd-show-last").addEventListener("click", () => {
      if (lastResult) showOverlay(lastResult);
      else setStatus("No prediction yet in this tab.");
    });
    root.querySelector("#pd-diagnose").addEventListener("click", () => {
      runDiagnostics().catch((err) => setStatus(String(err?.message || err), "err"));
    });

    makeDraggable(root.querySelector("#pd-header"), root);
    return root;
  }

  function makeDraggable(handle, target) {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let dragging = false;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = target.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      target.style.left = `${originX + (e.clientX - startX)}px`;
      target.style.top = `${originY + (e.clientY - startY)}px`;
      target.style.right = "auto";
      target.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function setStatus(text, kind = "") {
    buildPanel();
    const el = panel.querySelector("#pd-status");
    el.textContent = text;
    el.className = kind;
  }

  function log(text, kind = "") {
    buildPanel();
    const row = document.createElement("div");
    row.className = `pd-log-row ${kind}`;
    row.textContent = text;
    logBox.appendChild(row);
    while (logBox.childElementCount > 240) logBox.removeChild(logBox.firstChild);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clearLog() {
    buildPanel();
    logBox.innerHTML = "";
  }

  /* ------------------------------------------------------------------ *
   * Results overlay ("flash screen")
   * ------------------------------------------------------------------ */

  function candidateRow(c, isTop) {
    const pct = Math.max(0, Math.min(100, c.percent));
    const reasons = (c.reasons || []).map((r) => r.label).join(" · ");
    return `
      <div class="pd-cand ${isTop ? "pd-cand-top" : ""}">
        <div class="pd-cand-head">
          <span class="pd-cand-name">${esc(c.name)}</span>
          <span class="pd-cand-pct">${esc(c.percentLabel || `${c.percent}%`)}</span>
        </div>
        <div class="pd-bar"><i style="width:${pct}%"></i></div>
        <div class="pd-cand-meta">
          ${c.verified ? '<span class="pd-tag pd-tag-green">mod-verified</span>' : ""}
          ${c.isLineupPick ? '<span class="pd-tag">best lineup fit</span>' : ""}
          ${c.fromLift ? '<span class="pd-tag">pulled into top 5</span>' : ""}
          ${c.lastSeen ? `<span class="pd-dim">last taught ${esc(String(c.lastSeen))}</span>` : ""}
          ${reasons ? `<span class="pd-dim">${esc(reasons)}</span>` : ""}
        </div>
      </div>`;
  }

  function sectionCard(s, truth) {
    const schedule = [s.days, [s.timeStart, s.timeEnd].filter(Boolean).join("-"), s.room]
      .filter(Boolean)
      .join(" · ");
    const kind = s.kind || features.sectionKind(s.section);
    const kindLabel = kind === "lab" ? "Lab / Recit" : "Lecture";
    const core = (s.candidates || []).slice(0, 5);
    const extra = (s.candidates || []).slice(5);
    let verdict = "";
    if (truth) {
      const actual = truth.bySection.get(s.section);
      if (actual) {
        const rank = predict.truthRank(s.candidates, actual.profKey);
        const hit = rank === 0;
        verdict = `<div class="pd-verdict ${hit ? "pd-hit" : "pd-miss"}">
          ${hit ? "correct" : rank >= 0 ? `actual was ranked #${rank + 1}` : "actual not in candidates"}
          &mdash; actually <b>${esc(names.displayName(actual.instructor))}</b>
        </div>`;
      }
    }
    return `
      <div class="pd-section">
        <div class="pd-section-head">
          <div>
            <span class="pd-section-name">${esc(s.section)}</span>
            <span class="pd-kind pd-kind-${esc(kind)}">${esc(kindLabel)}</span>
            ${schedule ? `<span class="pd-section-sched">${esc(schedule)}</span>` : ""}
            ${
              `<span class="pd-conf">${esc(String(Number.isFinite(Number(s.confidence)) ? s.confidence : 0))}% confident · ${esc(
                String(s.modelsAgree || 0)
              )}/${esc(String(s.modelsTotal || 0))} agree</span>`
            }
          </div>
          <span class="pd-section-state${s.confirmed ? " pd-state-confirmed" : ""}">${
            s.confirmed
              ? "CONFIRMED BY MOD"
              : s.isTba
                ? "TBA"
                : `listed: ${esc(names.displayName(s.currentInstructor))}`
          }</span>
        </div>
        ${verdict}
        <div class="pd-cands">${core.map((c, i) => candidateRow(c, i === 0)).join("")}</div>
        ${
          extra.length
            ? `<div class="pd-shortlist-split">Also possible · ranks 6–${esc(String(s.candidates.length))}</div>
               <div class="pd-cands pd-cands-tail">${extra.map((c) => candidateRow(c, false)).join("")}</div>`
            : ""
        }
        ${
          s.confirmed
            ? '<div class="pd-newprof">Confirmed entry — the rest are what the model would have guessed.</div>'
            : `<div class="pd-newprof">chance it is someone not in the scanned history: <b>${s.newProfChance}%</b></div>`
        }
      </div>`;
  }

  function componentCard(comp) {
    const kids = (comp.sections || []).join(", ");
    const rows = (comp.frequent || [])
      .map(
        (p, i) => `
        <div class="pd-cand ${i === 0 ? "pd-cand-top" : ""}">
          <div class="pd-cand-head">
            <span class="pd-cand-name">${esc(p.name)}</span>
            <span class="pd-cand-pct">${esc(String(p.share))}%</span>
          </div>
          <div class="pd-bar"><i style="width:${Math.max(0, Math.min(100, p.share))}%"></i></div>
          <div class="pd-cand-meta">
            <span class="pd-dim">${esc(String(p.count))} offerings · terms ${esc((p.terms || []).join(", "))}</span>
          </div>
        </div>`
      )
      .join("");
    return `
      <div class="pd-section pd-general pd-component pd-component-${esc(comp.kind)}">
        <div class="pd-section-head">
          <div>
            <span class="pd-section-name">${esc(comp.label)} probability</span>
            <span class="pd-section-sched">course-wide · not a specific section${kids ? ` · seen on ${esc(kids)}` : ""}</span>
          </div>
          <span class="pd-section-state">${esc(String(comp.offerings))} past offerings</span>
        </div>
        <div class="pd-cands">${rows || '<div class="pd-dim">No named faculty for this component yet.</div>'}</div>
      </div>`;
  }

  function generalCard(fam) {
    const kids = (fam.sections || []).join(", ");
    const rows = (fam.frequent || [])
      .map(
        (p, i) => `
        <div class="pd-cand ${i === 0 ? "pd-cand-top" : ""}">
          <div class="pd-cand-head">
            <span class="pd-cand-name">${esc(p.name)}</span>
            <span class="pd-cand-pct">${esc(String(p.share))}%</span>
          </div>
          <div class="pd-bar"><i style="width:${Math.max(0, Math.min(100, p.share))}%"></i></div>
          <div class="pd-cand-meta">
            <span class="pd-dim">${esc(String(p.count))} offerings · terms ${esc((p.terms || []).join(", "))}</span>
          </div>
        </div>`
      )
      .join("");
    return `
      <div class="pd-section pd-general">
        <div class="pd-section-head">
          <div>
            <span class="pd-section-name">[GENERAL] ${esc(fam.letter)}</span>
            <span class="pd-section-sched">letter section only · ${esc(kids || fam.letter)}</span>
          </div>
          <span class="pd-section-state">${esc(String(fam.offerings))} past offerings</span>
        </div>
        <div class="pd-cands">${rows || '<div class="pd-dim">No named faculty in this letter family yet.</div>'}</div>
      </div>`;
  }

  function numericConfidence(prediction) {
    const direct = Number(prediction?.model?.confidence);
    if (Number.isFinite(direct)) return Math.round(direct * 10) / 10;
    const secs = (prediction?.sections || [])
      .map((s) => Number(s.confidence))
      .filter((n) => Number.isFinite(n));
    if (secs.length) return Math.round((secs.reduce((a, b) => a + b, 0) / secs.length) * 10) / 10;
    const bt = Number(prediction?.backtest?.ensemble?.top1);
    if (Number.isFinite(bt)) return Math.round(bt * 1000) / 10;
    return 0;
  }

  function overlayHtml(result) {
    const { prediction, courseCode, truth, scan } = result;
    const m = prediction.model;
    const bt = prediction.backtest;

    const weightBits = Object.entries(m.weights)
      .filter(([, v]) => v > 0.001)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
      .join(" + ");

    const focusAt = Math.max(1, Number(m.goalAt) || (m.goal === "top3" ? 3 : m.goal === "top1" ? 1 : truth?.atN || 5));
    const metricCard = (pct, label, { focus = false } = {}) =>
      `<div class="pd-metric${focus ? " pd-metric-focus" : ""}">
         <span class="pd-metric-val">${pct}</span>
         <span class="pd-metric-lbl">${label}</span>
       </div>`;
    const backtestCards = [];
    if (bt.ensemble.samples) {
      const cards = [
        { at: 1, pct: (bt.ensemble.top1 * 100).toFixed(0), label: "backtest top-1" },
        { at: 3, pct: (bt.ensemble.top3 * 100).toFixed(0), label: "backtest top-3" },
      ];
      if (bt.ensemble.top5 != null && bt.ensemble.atN !== 5) {
        cards.push({
          at: 5,
          pct: (bt.ensemble.top5 * 100).toFixed(0),
          label: "backtest top-5",
        });
      }
      if (bt.ensemble.atN && bt.ensemble.atN !== 1 && bt.ensemble.atN !== 3 && bt.ensemble.atN !== 5) {
        cards.push({
          at: bt.ensemble.atN,
          pct: ((bt.ensemble.topN || 0) * 100).toFixed(0),
          label: `backtest top-${bt.ensemble.atN}`,
        });
      }
      cards.sort((a, b) => (a.at === focusAt ? -1 : b.at === focusAt ? 1 : a.at - b.at));
      cards.forEach((c) => backtestCards.push(metricCard(`${c.pct}%`, c.label, { focus: c.at === focusAt })));
    } else {
      backtestCards.push(metricCard("n/a", "backtest (too little history)"));
    }
    const backtestStrip = backtestCards.join("");

    const truthFocusPct =
      !truth
        ? 0
        : focusAt <= 1
          ? truth.accuracy
          : focusAt <= 3
            ? truth.top3
            : focusAt > 5
              ? truth.top5 ?? truth.topN
              : truth.topN;
    const truthFocusReachable =
      !truth
        ? 0
        : focusAt <= 1
          ? truth.ofReachable
          : focusAt <= 3
            ? truth.ofReachableTop3
            : focusAt > 5
              ? truth.ofReachableTop5 ?? truth.ofReachableTopN
              : truth.ofReachableTopN;
    const noteAt = focusAt > 5 ? 5 : focusAt;
    const truthCeiling = truth
      ? `<div class="pd-truth-note">Of those ${truth.total}, only ${truth.reachable} professors appear in an
           older scanned term (${(truth.ceiling * 100).toFixed(0)}% ceiling) — the other
           ${truth.total - truth.reachable} could not be predicted from this dataset at all.
           Among the reachable ones, top-${noteAt} is <b>${(truthFocusReachable * 100).toFixed(0)}%</b>.</div>`
      : "";
    const truthStat = (pct, label, { focus = false, shortlist = false, sub = "" } = {}) =>
      `<div class="pd-truth-stat${focus ? " pd-truth-focus" : ""}${shortlist ? " pd-truth-shortlist" : ""}">
         <span class="pd-truth-val">${pct}</span>
         <span class="pd-truth-lbl">${label}</span>
         ${sub ? `<span class="pd-truth-sub">${sub}</span>` : ""}
       </div>`;
    const truthCards = truth
      ? [
          truth.atN > 3
            ? {
                at: truth.atN,
                html: truthStat(`${(truth.topN * 100).toFixed(0)}%`, `top-${truth.atN}`, {
                  focus: focusAt === truth.atN,
                  sub: focusAt === truth.atN ? "focus" : "",
                }),
              }
            : null,
          truth.atN > 5
            ? {
                at: 5,
                html: truthStat(`${((truth.top5 || 0) * 100).toFixed(0)}%`, "top-5", {
                  shortlist: true,
                  sub: "shortlist",
                }),
              }
            : null,
          {
            at: 3,
            html: truthStat(`${(truth.top3 * 100).toFixed(0)}%`, "top-3", {
              focus: focusAt === 3,
              sub: focusAt === 3 ? "focus" : "",
            }),
          },
          {
            at: 1,
            html: truthStat(`${(truth.accuracy * 100).toFixed(0)}%`, "top-1", {
              focus: focusAt <= 1,
              sub: `${truth.correct}/${truth.total} exact`,
            }),
          },
        ]
          .filter(Boolean)
          .sort((a, b) => (a.at === focusAt ? -1 : b.at === focusAt ? 1 : a.at - b.at))
          .map((c) => c.html)
          .join("")
      : "";
    const truthStrip = truth
      ? `<div class="pd-truth ${truthFocusPct >= 0.5 ? "pd-hit" : "pd-miss"}">
           <div class="pd-truth-head">Ground truth against the real ${esc(terms.label(prediction.targetTerm))}</div>
           <div class="pd-truth-row">${truthCards}</div>
           ${truthCeiling}
         </div>`
      : "";

    const importance = Object.entries(m.featureImportance || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
      .join(" · ");

    return `
      <div id="pd-overlay-card">
        <div id="pd-overlay-head">
          <div>
            <div id="pd-overlay-title">${esc(courseCode)}</div>
            <div id="pd-overlay-sub">${esc(prediction.targetTermLabel)}${
              result.sectionFilter && !result.sectionFilter.all
                ? ` · sections ${esc(result.sectionFilter.label)} (${esc(
                    result.sectionFilter.letters.map((l) => `${l}, ${l}1, ${l}2…`).join("; ")
                  )})`
                : ""
            }</div>
          </div>
          <button id="pd-overlay-close" type="button">Close</button>
        </div>

        <div id="pd-metrics">
          ${backtestStrip}
          <div class="pd-metric">
            <span class="pd-metric-val">${m.candidatePool}</span>
            <span class="pd-metric-lbl">known profs</span>
          </div>
          <div class="pd-metric">
            <span class="pd-metric-val">${prediction.historyTerms.length}</span>
            <span class="pd-metric-lbl">past terms used</span>
          </div>
          <div class="pd-metric">
            <span class="pd-metric-val">${esc(String(numericConfidence(prediction)))}%</span>
            <span class="pd-metric-lbl">confidence</span>
          </div>
          <div class="pd-metric">
            <span class="pd-metric-val">${prediction.scannedSections ?? prediction.sections.length}/${prediction.predictedSections ?? prediction.sections.length}</span>
            <span class="pd-metric-lbl">scanned / predicted</span>
          </div>
        </div>

        ${truthStrip}

        <div id="pd-sections">
          ${(prediction.components || []).length
            ? `<div class="pd-general-head">Lecture vs lab — who usually teaches each component (not a specific section)</div>${prediction.components.map(componentCard).join("")}`
            : ""}
          ${prediction.sections.map((s) => sectionCard(s, truth)).join("")}
          ${(prediction.families || []).length
            ? `<div class="pd-general-head">Letter section only [GENERAL] — who often teaches A, B, C…</div>${prediction.families.map(generalCard).join("")}`
            : ""}
        </div>

        <div id="pd-overlay-foot">
          <div>
            ${m.modelCount || 25}-model ensemble (${m.modelsUsed || 0} weighted): ${esc(weightBits || "heuristic only")} ·
            ${m.forestTrained ? `random forest on ${m.trainRows} rows` : "random forest skipped (too little data)"} ·
            softmax T=${m.temperature}
            ${m.weightsTuned ? " · weights tuned on past semesters" : ""}
            ${m.lineupApplied ? " · ranked as one timetable (load-capped)" : ""}
            ${m.crossPrior ? ` · cross-section models at ${m.crossPrior}×` : ""}
            ${
              m.vote
                ? ` · vote pad ${m.vote.pad} / depth ${m.vote.depth} / mix ${(m.vote.mix * 100).toFixed(0)}%`
                : ""
            }
            ${
              m.goal && m.goal !== "top1"
                ? ` · focusing on top-${m.goalAt || (m.goal === "top3" ? 3 : 5)}`
                : " · focusing on top-1"
            }
            ${
              m.shortlistBacktest
                ? ` · top-5 ${m.shortlistRetuned ? "retuned to" : "backtest"} ${Math.round(
                    (m.shortlistBacktest.top5 != null ? m.shortlistBacktest.top5 : m.shortlistBacktest.topN) * 100
                  )}% on past terms${m.shortlistLift ? " (seat lift on)" : ""}`
                : ""
            }
            ${m.halfLifeSearched ? ` · half-life widened to ${m.halfLife} semesters` : ""}
            ${importance ? `<br />Top forest features: ${esc(importance)}` : ""}
            ${scan ? `<br />Scanned ${scan.scanned} term(s), ${scan.cached} from cache.` : ""}
          </div>
          <button id="pd-export" type="button">Copy JSON</button>
        </div>
      </div>`;
  }

  function showOverlay(result) {
    document.getElementById("pd-overlay")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "pd-overlay";
    wrap.innerHTML = overlayHtml(result);
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector("#pd-overlay-close").addEventListener("click", close);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });
    wrap.querySelector("#pd-export").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(result.prediction, null, 2));
        wrap.querySelector("#pd-export").textContent = "Copied";
      } catch (_) {
        wrap.querySelector("#pd-export").textContent = "Copy failed";
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Orchestration
   * ------------------------------------------------------------------ */

  /**
   * When the predicted term already has published instructors (the user typed
   * an old term on purpose), score the prediction against reality. The model
   * never sees these rows as evidence -- `predict.run` only trains on terms
   * strictly older than the target.
   */
  function groundTruth(records, targetTerm, prediction, { topN = 3 } = {}) {
    const actual = records.filter((r) => r.term === targetTerm && r.profKey);
    if (!actual.length) return null;
    const bySection = new Map(actual.map((r) => [r.section, r]));
    const priorKeys = new Set(
      records.filter((r) => Number(r.term) < Number(targetTerm) && r.profKey).map((r) => r.profKey)
    );
    const atN = Math.max(1, Number(topN) || 3);
    let correct = 0;
    let top3 = 0;
    let top5 = 0;
    let topNHits = 0;
    let reachableHits = 0;
    let reachableTop3 = 0;
    let reachableTop5 = 0;
    let reachableTopN = 0;
    let total = 0;
    let reachable = 0;
    for (const s of prediction.sections) {
      const hit = bySection.get(s.section);
      if (!hit) continue;
      total += 1;
      // Nobody can be predicted out of thin air: if this professor never
      // appears in an older scanned term, the section was unwinnable.
      const canReach = priorKeys.has(hit.profKey);
      if (canReach) reachable += 1;
      const rank = predict.truthRank(s.candidates, hit.profKey);
      if (rank === 0) correct += 1;
      if (rank >= 0 && rank < 3) top3 += 1;
      if (rank >= 0 && rank < 5) top5 += 1;
      if (rank >= 0 && rank < atN) topNHits += 1;
      if (canReach && rank === 0) reachableHits += 1;
      if (canReach && rank >= 0 && rank < 3) reachableTop3 += 1;
      if (canReach && rank >= 0 && rank < 5) reachableTop5 += 1;
      if (canReach && rank >= 0 && rank < atN) reachableTopN += 1;
    }
    if (!total) return null;
    return {
      bySection,
      priorKeys,
      correct,
      total,
      atN,
      reachable,
      ceiling: reachable / total,
      ofReachable: reachable ? reachableHits / reachable : 0,
      ofReachableTop3: reachable ? reachableTop3 / reachable : 0,
      ofReachableTop5: reachable ? reachableTop5 / reachable : 0,
      ofReachableTopN: reachable ? reachableTopN / reachable : 0,
      top3: top3 / total,
      top5: top5 / total,
      topN: topNHits / total,
      accuracy: correct / total,
    };
  }

  async function runPrediction(config) {
    const courseCode = String(config.courseCode || "").trim();
    const targetTerm = Number(config.targetTerm);
    if (!courseCode || !terms.isTermCode(targetTerm)) {
      return { ok: false, error: "bad_config", message: "Subject and 4-digit term are required." };
    }

    const sectionFilter = features.parseSectionFilter(config.sectionFilter);
    lastConfig = { courseCode, targetTerm, sectionFilter: sectionFilter.label };
    clearLog();
    setStatus(`Scanning ${courseCode} …`, "busy");

    const history = terms.historyFor(targetTerm, config.floorTerm || terms.DEFAULT_FLOOR);
    // The target term is scanned too: it supplies the section list and schedules
    // we are predicting onto (and ground truth when it is already published).
    const termList = [...history, targetTerm];

    log(`Target ${terms.label(targetTerm)}`);
    log(`Scanning ${termList.length} terms: ${termList.join(", ")}`);
    if (sectionFilter.all) {
      log("Section filter: ALL — scan and predict every section");
    } else {
      log(
        `Section filter: ${sectionFilter.label} — predict ${sectionFilter.letters
          .map((l) => `${l}, ${l}1, ${l}2…`)
          .join("; ")}`
      );
    }

    const scan = await scanner.scanTerms({
      courseCode,
      termList,
      mode: config.scanMode || "dom",
      throttleMs: config.throttleMs ?? 80,
      force: !!config.force,
      forceTerms: [targetTerm],
      onProgress: (p) => {
        if (p.status === "row") {
          const prof = p.instructor && !/^TBA$/i.test(String(p.instructor).trim()) ? p.instructor : "TBA";
          const kind = /^TBA$/i.test(prof) ? "dim" : "ok";
          const mark = sectionFilter.all || features.sectionAllowed(p.section, sectionFilter) ? "" : "  (other)";
          log(`${p.term}  ${p.section}  ${prof}${mark}`, kind);
        } else if (p.status === "cached") log(`${p.term}  cached — listing stored sections`, "dim");
        else if (p.status === "scanning") setStatus(`Scanning ${p.term} … (${p.done}/${p.total})`, "busy");
        else if (p.status === "done") log(`${p.term}  ${p.rows} rows, ${p.revealed} with a named prof`, "ok");
        else if (p.status === "skipped") log(`${p.term}  skipped: ${p.reason}`, "err");
        else if (p.status === "error") log(`${p.term}  failed: ${p.error}`, "err");
        else if (p.status === "discovering") setStatus("Finding the AMIS class endpoint…", "busy");
        else if (p.status === "fallback" && p.via === "api") {
          log(
            `${p.term}  Term * did not switch — reading ${p.term} from the AMIS API so this semester is not skipped`,
            "dim"
          );
        } else if (p.status === "fallback") {
          log(`API unavailable (${p.reason}) — falling back to page scraping`, "err");
        }
        else if (p.status === "discovered") {
          log(
            `Endpoint: ${p.recipe.path} (term "${p.recipe.termParam}", ${
              p.recipe.courseParam ? `course "${p.recipe.courseParam}"` : "filtering locally"
            }, ${p.recipe.via})`,
            "ok"
          );
        }
      },
    });

    if (!scan.ok) {
      setStatus(scan.message || `Scan failed: ${scan.error}`, "err");
      return { ok: false, error: scan.error, message: scan.message };
    }

    const failed = scan.results.filter((r) => !r.ok);
    if (failed.length) log(`${failed.length} term(s) could not be read`, "err");

    const records = await db.allRecords(courseCode);
    if (!records.length) {
      setStatus(`No offerings found for "${courseCode}" in any scanned term.`, "err");
      log("Press Diagnose to see what Profdictor can read on this page.", "err");
      // Distinguish "wrong course code" from "could not read any term at all":
      // they need completely different fixes from the user.
      const allFailed = failed.length === scan.results.length;
      return {
        ok: false,
        error: "no_records",
        message: allFailed
          ? `None of the ${failed.length} terms could be read: ${failed[0]?.error || "unknown error"}. Press Diagnose in the panel for details.`
          : `AMIS returned rows but none for "${courseCode}". Check the exact course code as AMIS spells it (e.g. HUM 1, not HUMANITIES 1).`,
      };
    }

    const scannedTarget = records.filter(
      (r) => r.term === targetTerm && features.sectionAllowed(r.section, sectionFilter)
    );
    const bySection = new Map();
    for (const r of scannedTarget) {
      if (!bySection.has(r.section)) bySection.set(r.section, r);
    }
    const targetSections = [...bySection.values()].sort((a, b) =>
      features.compareSections(a.section, b.section)
    );
    log(
      `Scan/predict lock: ${targetSections.length} unique section(s) on ${targetTerm}`,
      targetSections.length ? "ok" : "err"
    );
    if (!targetSections.length && !sectionFilter.all) {
      const msg = `No ${sectionFilter.label} sections (including ${sectionFilter.letters
        .map((l) => `${l}1, ${l}2`)
        .join("; ")}) found for "${courseCode}". Try ALL, or another letter.`;
      setStatus(msg, "err");
      return { ok: false, error: "no_matching_sections", message: msg };
    }
    const verified = await db.getVerified(courseCode);

    setStatus("Training models…", "busy");
    const knownKeys = new Set(
      records.filter((r) => r.profKey && r.term < targetTerm).map((r) => r.profKey)
    );
    log(
      `${records.length} records across ${new Set(records.map((r) => r.term)).size} terms · ${knownKeys.size} known profs`
    );

    const prediction = predict.run({
      records,
      targetTerm,
      targetSections,
      verified,
      limit: config.limit || 3,
      halfLife: config.halfLife || 4,
      sectionFilter,
      tuneWeights: config.tuneWeights !== false,
      lineup: config.lineup || "auto",
      goal: config.goal === "top3" ? "top3" : config.goal === "top1" ? "top1" : "topn",
      crossPrior: config.crossPrior,
      vote: {
        pad: config.votePad,
        depth: Number(config.voteDepth) || 0,
        mix: config.voteMix,
        floor: config.voteFloor,
      },
    });

    if (!prediction.ok) {
      setStatus(prediction.message || prediction.error, "err");
      return { ok: false, error: prediction.error, message: prediction.message };
    }

    prediction.sections.sort((a, b) => features.compareSections(a.section, b.section));

    const truth = groundTruth(records, targetTerm, prediction, { topN: config.limit || 3 });
    lastResult = { prediction, courseCode, truth, scan, sectionFilter, at: Date.now() };
    try {
      await chrome.storage.local.set({ [LAST_KEY]: lastResult });
    } catch (_) {
      /* result is large; not fatal if it will not fit */
    }

    const match = prediction.sections.length === targetSections.length;
    log(
      `Predicted ${prediction.sections.length} sections from ${prediction.model.candidatePool} candidate profs · confidence ${numericConfidence(prediction)}%`,
      match ? "ok" : "err"
    );
    if (!match) {
      log(
        `Section count mismatch: scanned ${targetSections.length}, predicted ${prediction.sections.length}`,
        "err"
      );
    }
    if (truth) {
      const extra = truth.atN && truth.atN !== 3 ? ` · top-${truth.atN} ${(truth.topN * 100).toFixed(0)}%` : "";
      log(
        `Ground truth: ${truth.correct}/${truth.total} correct · top-3 ${(truth.top3 * 100).toFixed(0)}%${extra}`,
        truth.accuracy >= 0.5 ? "ok" : "err"
      );
    }
    setStatus(`Done — ${prediction.sections.length} sections predicted.`, "ok");

    showOverlay(lastResult);

    return {
      ok: true,
      summary: {
        sections: prediction.sections.length,
        candidatePool: prediction.model.candidatePool,
        scanned: scan.scanned,
        cached: scan.cached,
        backtestTop1: prediction.backtest.ensemble.samples ? prediction.backtest.ensemble.top1 : null,
        backtestTop3: prediction.backtest.ensemble.samples ? prediction.backtest.ensemble.top3 : null,
        backtestTopN: prediction.backtest.ensemble.samples ? prediction.backtest.ensemble.topN : null,
        backtestAtN: prediction.backtest.ensemble.atN || null,
        backtestSamples: prediction.backtest.ensemble.samples,
        vote: prediction.model.vote || null,
        groundTruth: truth
          ? {
              correct: truth.correct,
              total: truth.total,
              top3: truth.top3,
              topN: truth.topN,
              atN: truth.atN,
              reachable: truth.reachable,
              ceiling: truth.ceiling,
            }
          : null,
      },
    };
  }

  async function identifyProf({ config, query, section }) {
    const courseCode = String(config?.courseCode || "").trim();
    if (!courseCode) return { ok: false, error: "bad_config" };
    const records = await db.allRecords(courseCode);
    if (!records.length) {
      return {
        ok: false,
        error: "no_records",
        message: `Nothing scanned yet for ${courseCode}. Run a prediction first.`,
      };
    }
    const matches = predict.identify(query, records, { limit: 6 });
    const wanted = String(section || "").trim().toUpperCase();
    if (wanted) {
      // Surface professors who have actually held this section.
      matches.sort((a, b) => {
        const aHit = a.sections.includes(wanted) ? 1 : 0;
        const bHit = b.sections.includes(wanted) ? 1 : 0;
        return bHit - aHit || b.score - a.score;
      });
    }
    return { ok: true, matches, section: wanted };
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics
   * ------------------------------------------------------------------ */

  /**
   * Report what Profdictor can actually see on this page.
   *
   * Every interesting failure here happens inside someone's authenticated AMIS
   * session, which cannot be reproduced from outside it, so the extension has to
   * be able to explain itself.
   */
  async function runDiagnostics() {
    setStatus("Diagnosing…", "busy");
    clearLog();

    const report = await scanner.diagnose({
      courseCode: lastConfig.courseCode || "",
      termId: lastConfig.targetTerm || null,
    });

    const b = report.bridge || {};
    log(b.ok ? "Page bridge: reachable" : `Page bridge: unreachable (${b.error || "no reply"})`, b.ok ? "ok" : "err");
    if (b.ok) {
      log(`Current term on page: ${b.currentTerm || "unknown"}`);
      log(`Terms the page knows: ${(b.terms || []).map((t) => t.code).join(", ") || "none"}`);
    }

    const dom = report.dom || {};
    log(
      dom.hasSearchClassHeading
        ? "Search Class heading: found"
        : "Search Class heading: missing — open Student → Enrollment",
      dom.hasSearchClassHeading ? "ok" : "err"
    );
    log(dom.openFilter ? "Open Filter/Search: found" : "Open Filter/Search: not found", dom.openFilter ? "ok" : "err");
    log(`Dropdowns on page: ${(dom.selects || []).length}`);
    log(`Term labels visible: ${(dom.observedTermLabels || []).slice(0, 3).join(" | ") || "none"}`);
    log(
      dom.table
        ? `Offerings table: ${dom.table.bodyRows} rows, columns ${dom.table.headerCells.join(", ")}`
        : "Offerings table: not rendered on this page",
      dom.table ? "ok" : "err"
    );
    if (dom.termControl) log(`Term control: ${dom.termControl}`);

    setStatus("Diagnosis complete — copy the report if you need to share it.", "ok");
    showReport(report);
    return report;
  }

  function showReport(report) {
    document.getElementById("pd-overlay")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "pd-overlay";
    wrap.innerHTML = `
      <div id="pd-overlay-card">
        <div id="pd-overlay-head">
          <div>
            <div id="pd-overlay-title">Diagnostics</div>
            <div id="pd-overlay-sub">what Profdictor can see on this page</div>
          </div>
          <button id="pd-overlay-close" type="button">Close</button>
        </div>
        <pre id="pd-report"></pre>
        <div id="pd-overlay-foot">
          <div>Paste this into an issue report if a scan keeps coming back empty.</div>
          <button id="pd-export" type="button">Copy JSON</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector("#pd-report").textContent = JSON.stringify(report, null, 2);

    const close = () => wrap.remove();
    wrap.querySelector("#pd-overlay-close").addEventListener("click", close);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector("#pd-export").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        wrap.querySelector("#pd-export").textContent = "Copied";
      } catch (_) {
        wrap.querySelector("#pd-export").textContent = "Copy failed";
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Messaging
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "PING_CONTENT") {
          buildPanel();
          const ping = await scanner.ping();
          sendResponse({
            ok: true,
            href: location.href,
            currentTerm: ping?.currentTerm || null,
            bridge: !!ping?.ok,
            availableTerms: ping?.terms || [],
          });
          return;
        }
        if (msg?.type === "SHOW_PANEL") {
          buildPanel();
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === "RUN_PREDICTION") {
          sendResponse(await runPrediction(msg.config || {}));
          return;
        }
        if (msg?.type === "IDENTIFY_PROF") {
          sendResponse(await identifyProf(msg));
          return;
        }
        sendResponse({ ok: false, error: `unknown_message:${msg?.type}` });
      } catch (err) {
        setStatus(String(err?.message || err), "err");
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  });

  scanner.injectBridge();
  buildPanel();

  chrome.storage.local
    .get(LAST_KEY)
    .then((got) => {
      if (got?.[LAST_KEY]?.prediction) {
        lastResult = got[LAST_KEY];
        setStatus(
          `Ready. Last prediction: ${lastResult.courseCode} ${terms.shortLabel(
            lastResult.prediction.targetTerm
          )}.`
        );
      }
    })
    .catch(() => {});
})();
