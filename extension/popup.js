/**
 * Profdictor popup.
 *
 * The semester field doubles as the moderator entrance: four digits is a term
 * code, anything longer is treated as a candidate admin hash. That keeps the
 * moderator door invisible to normal users without adding a second UI.
 */

const { PD } = self;
const $ = (id) => document.getElementById(id);

function bg(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false, error: "no_response" });
      });
    } catch (err) {
      resolve({ ok: false, error: "runtime_unavailable", detail: String(err?.message || err) });
    }
  });
}

const toTab = (payload) => bg({ type: "FORWARD_TO_TAB", payload });

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

/* ------------------------------------------------------------------ *
 * Semester field: term code vs moderator hash
 * ------------------------------------------------------------------ */

function termFieldMode() {
  const raw = $("term").value.trim();
  if (PD.terms.isTermCode(raw)) return { mode: "term", term: Number(raw) };
  if (raw.length >= 8) return { mode: "admin", code: raw };
  return { mode: "invalid", raw };
}

function refreshTermField() {
  const state = termFieldMode();
  const term = $("term");
  const hint = $("term-hint");
  const modBtn = $("modlogin");

  term.classList.toggle("admin", state.mode === "admin");
  modBtn.hidden = state.mode !== "admin";
  $("predict").hidden = state.mode === "admin";

  if (state.mode === "term") {
    const parsed = PD.terms.parse(state.term);
    const history = PD.terms.historyFor(state.term, Number($("floor").value));
    hint.innerHTML = parsed
      ? `<b>${parsed.semesterLabel} ${parsed.academicYear}</b> &middot; will scan ${history.length} past term${
          history.length === 1 ? "" : "s"
        }: ${history.join(", ")}`
      : "Unrecognised term code.";
  } else if (state.mode === "admin") {
    hint.innerHTML = "<b>Moderator hash detected.</b> Press the button below to sign in.";
  } else {
    hint.innerHTML =
      '<code>12<b>Y</b><b>S</b></code> &mdash; Y: 3=&rsquo;23-24, 4=&rsquo;24-25, 5=&rsquo;25-26, 6=&rsquo;26-27 &nbsp;&middot;&nbsp; S: 1=First, 2=Second, 3=Midyear';
  }
}

/* ------------------------------------------------------------------ *
 * Config persistence
 * ------------------------------------------------------------------ */

const FOCUS_PRESETS = {
  top1: { votePad: 1, voteDepth: 0, voteMix: 0.4, voteFloor: 0.02, crossPrior: 5, tuneWeights: true, lineup: "auto" },
  top3: { votePad: 1, voteDepth: 0, voteMix: 0.4, voteFloor: 0.02, crossPrior: 5, tuneWeights: true, lineup: "auto" },
  topn: { votePad: 1, voteDepth: 0, voteMix: 0.4, voteFloor: 0.02, crossPrior: 5, tuneWeights: true, lineup: "auto" },
};

function normalizeFocus(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "top3") return "top3";
  if (raw === "topn" || raw === "top5") return "topn";
  return "top1";
}

function refreshFocusHint() {
  const focus = normalizeFocus($("focus").value);
  const n = Math.max(1, Number($("limit").value) || 5);
  const hint = $("focus-hint");
  if (focus === "top1") {
    hint.innerHTML = "Same ranking as always. The big number on the strip is top-1.";
  } else if (focus === "top3") {
    hint.innerHTML = "Same ranking as Top 1. Shows at least 3 names and highlights top-3 on the strip.";
  } else {
    hint.innerHTML =
      n > 5
        ? `The first <b>5</b> names are the shortlist (target 50%+, ideally 60–80%). If past terms score below 50%, the blend is retuned. Names 6–${n} are extras. Lecture/lab lists appear only when the course has both.`
        : `Shows <b>${n}</b> names. On Top N, a shortlist below 50% on past terms gets retuned. Lecture/lab lists appear only when the course has both.`;
  }
}

function applyFocusPreset(focus, { fillPadderFields = true } = {}) {
  const key = normalizeFocus(focus);
  $("focus").value = key;
  if (key === "top3" && Number($("limit").value) < 3) $("limit").value = 3;
  if (key === "topn" && Number($("limit").value) < 1) $("limit").value = 5;
  if (fillPadderFields) fillPadder({ ...PD.db.DEFAULT_CONFIG, ...FOCUS_PRESETS[key], goal: key });
  refreshFocusHint();
}

function readPadder() {
  const mixPct = Number($("voteMix").value);
  return {
    votePad: Math.max(0, Number($("votePad").value) || 0),
    voteDepth: Math.max(0, Math.round(Number($("voteDepth").value) || 0)),
    voteMix: Math.max(0, Math.min(1, (Number.isFinite(mixPct) ? mixPct : 40) / 100)),
    voteFloor: Math.max(0, Math.min(1, Number($("voteFloor").value) || 0)),
    crossPrior: Math.max(0, Number($("crossPrior").value) || 0),
    tuneWeights: $("tuneWeights").checked,
    lineup: ["auto", "off", "always"].includes($("lineup").value) ? $("lineup").value : "auto",
    goal: normalizeFocus($("focus").value),
  };
}

function fillPadder(cfg) {
  const d = PD.db.DEFAULT_CONFIG;
  $("votePad").value = cfg.votePad ?? d.votePad;
  $("voteDepth").value = cfg.voteDepth ?? d.voteDepth;
  $("voteMix").value = Math.round(((cfg.voteMix ?? d.voteMix) * 100));
  $("voteFloor").value = cfg.voteFloor ?? d.voteFloor;
  $("crossPrior").value = cfg.crossPrior ?? d.crossPrior;
  $("tuneWeights").checked = cfg.tuneWeights !== false;
  $("lineup").value = ["auto", "off", "always"].includes(cfg.lineup) ? cfg.lineup : "auto";
  $("focus").value = normalizeFocus(cfg.goal);
  refreshFocusHint();
}

function readConfig() {
  return {
    courseCode: $("course").value.trim(),
    targetTerm: Number($("term").value.trim()) || 0,
    floorTerm: Number($("floor").value),
    limit: Math.max(1, Number($("limit").value) || 3),
    halfLife: Math.max(1, Number($("halfLife").value) || 4),
    throttleMs: Math.max(0, Number($("throttle").value) || 0),
    scanMode: $("mode").value,
    sectionFilter: PD.features.sanitizeSectionInput($("sectionFilter").value),
    ...readPadder(),
  };
}

async function loadConfig() {
  const cfg = await PD.db.loadConfig();
  $("course").value = cfg.courseCode || "";
  $("term").value = cfg.targetTerm || "";
  $("limit").value = cfg.limit;
  $("halfLife").value = cfg.halfLife;
  $("throttle").value = cfg.throttleMs;
  $("mode").value = cfg.scanMode === "api" ? "api" : "dom";
  $("sectionFilter").value = PD.features.sanitizeSectionInput(cfg.sectionFilter);
  if ([...$("floor").options].some((o) => Number(o.value) === cfg.floorTerm)) {
    $("floor").value = String(cfg.floorTerm);
  }
  fillPadder(cfg);
  refreshTermField();
}

async function refreshDataset() {
  try {
    const stats = await PD.db.stats();
    const courses = await PD.db.listCourses();
    const list = courses
      .map((c) => `${c.courseCode} (${c.termCount} terms, ${c.revealed}/${c.records} revealed)`)
      .join(" · ");
    $("dataset").textContent = `Dataset: ${stats.courses} course(s), ${stats.terms} terms, ${
      stats.records
    } rows, ${stats.verified} verified, ${(stats.bytes / 1024).toFixed(1)} KB${list ? `\n${list}` : ""}`;
  } catch (err) {
    $("dataset").textContent = `Dataset unavailable: ${err.message}`;
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function runPrediction(force) {
  const state = termFieldMode();
  if (state.mode !== "term") {
    setStatus("Enter a 4-digit semester code first, e.g. 1261.", "err");
    return;
  }
  const cfg = readConfig();
  if (!cfg.courseCode) {
    setStatus("Enter the subject you want to predict, e.g. ARTS 1.", "err");
    return;
  }
  await PD.db.saveConfig(cfg);

  const history = PD.terms.historyFor(cfg.targetTerm, cfg.floorTerm);
  setStatus(
    `Scanning ${history.length} past semesters for ${cfg.courseCode}…\n${history.join(", ")}\n\nProgress shows in the panel on the AMIS page.`,
    "busy"
  );
  $("predict").disabled = true;
  $("rescan").disabled = true;

  const res = await toTab({ type: "RUN_PREDICTION", config: { ...cfg, force } });

  $("predict").disabled = false;
  $("rescan").disabled = false;

  if (!res?.ok) {
    setStatus(describeError(res), "err");
    return;
  }

  const s = res.summary || {};
  setStatus(
    [
      `Done — ${PD.terms.label(cfg.targetTerm)}`,
      `${s.sections ?? 0} sections predicted from ${s.candidatePool ?? 0} known profs`,
      `Scanned ${s.scanned ?? 0} term(s), ${s.cached ?? 0} from cache`,
      s.backtestTop1 != null
        ? `Backtest accuracy: top-1 ${(s.backtestTop1 * 100).toFixed(0)}%, top-3 ${(
            s.backtestTop3 * 100
          ).toFixed(0)}%${
            s.backtestAtN && s.backtestAtN !== 3
              ? `, top-${s.backtestAtN} ${((s.backtestTopN || 0) * 100).toFixed(0)}%`
              : ""
          } over ${s.backtestSamples ?? 0} past sections`
        : "Not enough history for a backtest.",
      s.groundTruth
        ? `Against the real term: ${s.groundTruth.correct}/${s.groundTruth.total} correct. ` +
          `Only ${s.groundTruth.reachable} of those professors appear in an older scanned term, ` +
          `so ${((s.groundTruth.ceiling || 0) * 100).toFixed(0)}% is the most any model could score.`
        : "",
      s.vote
        ? `Vote pad ${s.vote.pad}, depth ${s.vote.depth}, mix ${(s.vote.mix * 100).toFixed(0)}% (floor ${s.vote.floor}).`
        : "",
      "",
      "Results are on the AMIS page.",
    ].join("\n"),
    "ok"
  );
  await refreshDataset();
}

function describeError(res) {
  const map = {
    access_locked: "Locked. Redeem an access hash first.",
    bridge_unavailable:
      "Could not reach the AMIS app. Reload the enrollment page, make sure you are logged in, then retry. Or switch scan mode to DOM under Advanced.",
    no_response_from_tab: "The AMIS tab did not respond. Reload it and try again.",
    no_history:
      "No past semester had a revealed instructor for this subject. Check the exact course code, or scan back further.",
  };
  const key = String(res?.error || "unknown");
  return map[key] || `Failed: ${res?.message || key}`;
}

async function identify() {
  const query = $("id-name").value.trim();
  const section = $("id-section").value.trim();
  const cfg = readConfig();
  const box = $("identify-results");
  box.innerHTML = "";

  if (!query) {
    box.innerHTML = '<div class="hint">Type a professor name to match.</div>';
    return;
  }
  if (!cfg.courseCode) {
    box.innerHTML = '<div class="hint">Set the subject first — matching uses that scan.</div>';
    return;
  }

  const res = await toTab({
    type: "IDENTIFY_PROF",
    config: cfg,
    query,
    section,
  });
  if (!res?.ok) {
    box.innerHTML = `<div class="hint">${describeError(res)}</div>`;
    return;
  }
  if (!res.matches?.length) {
    box.innerHTML =
      '<div class="hint">No close match among the professors scanned for this subject. They may be new, or the subject has not been scanned yet.</div>';
    return;
  }

  box.innerHTML = res.matches
    .map((m) => {
      const taught = m.sections?.length ? `sections ${m.sections.slice(0, 6).join(", ")}` : "";
      const seen = m.terms?.length ? `${m.terms.length} term(s), last ${Math.max(...m.terms)}` : "";
      const inSection = section && m.sections?.includes(section.toUpperCase());
      return `<div class="match">
        <b>${escapeHtml(m.name)}</b> <span class="badge">${m.score}% match</span>
        ${inSection ? ' <span class="badge" style="background:#0f8a4b">taught this section</span>' : ""}
        <div class="meta">${escapeHtml([seen, taught].filter(Boolean).join(" · "))}</div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function modLogin() {
  const state = termFieldMode();
  if (state.mode !== "admin") return;
  setStatus("Checking moderator hash…", "busy");
  const res = await bg({ type: "VERIFY_ADMIN_HASH", code: state.code });
  if (!res?.ok) {
    const map = {
      not_admin: "That hash is not a moderator hash.",
      hash_too_short: "Hash looks too short.",
      registry_not_configured:
        "No registry configured. Add local admin hashes in access-codes.js, or deploy the Worker.",
      registry_unreachable: "Cannot reach the registry. Check your connection.",
    };
    setStatus(map[res?.error] || `Moderator login failed: ${res?.error}`, "err");
    return;
  }
  setStatus(`Signed in as ${res.session?.name || "moderator"}. Opening moderator page…`, "ok");
  await bg({ type: "OPEN_MODERATOR" });
  $("term").value = "";
  refreshTermField();
}

async function wipeCourse() {
  const cfg = readConfig();
  if (!cfg.courseCode) {
    setStatus("Enter a subject to clear.", "err");
    return;
  }
  await PD.db.clearCourse(cfg.courseCode);
  setStatus(`Cleared cached scans for ${cfg.courseCode}. The next predict will rescan.`, "ok");
  await refreshDataset();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  const info = await bg({ type: "PING_BG" });
  $("version").textContent = `v${info?.version || "1.6.0"} · predict TBA professors`;

  // If the service worker never answered, show the app rather than an unlock
  // screen the user has no way to pass.
  const reachable = !!info?.ok;
  const unlocked = reachable ? !!info.access?.unlocked : true;
  $("gate").hidden = unlocked;
  $("app").hidden = !unlocked;
  if (!unlocked) return;

  await loadConfig();
  await refreshDataset();

  if (!reachable) {
    setStatus(
      "Could not reach the extension background worker. Reload Profdictor at chrome://extensions if actions fail.",
      "err"
    );
  }

  if (info?.admin?.isAdmin) {
    $("modlogin").hidden = false;
    $("modlogin").textContent = `Open moderator page (${info.admin.name})`;
  }

  // Prefill the term from whatever the AMIS page is showing.
  if (!$("term").value) {
    const ping = await toTab({ type: "PING_CONTENT" });
    if (ping?.ok && ping.currentTerm) {
      $("term").value = String(ping.currentTerm);
      refreshTermField();
    }
  }
}

async function unlock() {
  const msg = $("gate-msg");
  msg.textContent = "Checking…";
  const res = await bg({
    type: "REDEEM_ACCESS_CODE",
    username: $("gate-user").value,
    code: $("gate-code").value,
  });
  if (res?.ok) {
    $("gate").hidden = true;
    $("app").hidden = false;
    await loadConfig();
    await refreshDataset();
    return;
  }
  const map = {
    username_required: "Enter a username (2+ characters).",
    code_required: "Paste your full one-time hash.",
    code_already_used: "That hash was already used.",
    invalid_code: "Invalid hash — check for typos.",
    registry_not_configured: "No registry configured yet. Deploy the Worker and set its URL.",
    registry_unreachable: "Cannot reach the hash registry.",
  };
  msg.textContent = map[res?.error] || `Unlock failed: ${res?.error}`;
}

$("predict").addEventListener("click", () => runPrediction(false).catch((e) => setStatus(String(e), "err")));
$("rescan").addEventListener("click", () => runPrediction(true).catch((e) => setStatus(String(e), "err")));
$("wipe").addEventListener("click", () => wipeCourse().catch((e) => setStatus(String(e), "err")));
$("identify").addEventListener("click", () => identify().catch((e) => setStatus(String(e), "err")));
$("modlogin").addEventListener("click", () => modLogin().catch((e) => setStatus(String(e), "err")));
$("gate-unlock").addEventListener("click", () => unlock().catch((e) => ($("gate-msg").textContent = String(e))));
$("gate-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void unlock();
});
$("term").addEventListener("input", refreshTermField);
$("floor").addEventListener("change", refreshTermField);
$("focus").addEventListener("change", () => applyFocusPreset($("focus").value));
$("limit").addEventListener("input", refreshFocusHint);
$("sectionFilter").addEventListener("input", () => {
  const el = $("sectionFilter");
  const next = PD.features.sanitizeSectionInput(el.value);
  if (el.value.toUpperCase().replace(/[^A-Z]/g, "") === "ALL") {
    if (el.value !== "ALL") el.value = "ALL";
    return;
  }
  if (el.value !== next && next !== "ALL") el.value = next;
});
$("sectionFilter").addEventListener("blur", () => {
  $("sectionFilter").value = PD.features.sanitizeSectionInput($("sectionFilter").value);
});
$("id-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") void identify();
});
$("reset-padder").addEventListener("click", () => {
  applyFocusPreset($("focus").value);
  void PD.db.saveConfig(readConfig());
  setStatus(
    "Padder reset to the preset for the current Focus. Change Focus on the main screen instead of editing these by hand.",
    "ok"
  );
});

boot().catch((err) => setStatus(String(err), "err"));
