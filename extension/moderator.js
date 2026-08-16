/**
 * Profdictor moderator page.
 *
 * Lets a signed-in moderator record the real professor for a given
 * subject + semester + section. Those rows become ground truth: the model
 * weights them heavily, and they override whatever AMIS displayed (or hid).
 *
 * As the moderator types, names are fuzzy-matched against professors already
 * seen in the scanned history, so the same person does not get entered three
 * different ways and split into three candidates.
 */

const { PD } = self;
const $ = (id) => document.getElementById(id);

let state = { course: "", term: 0, sections: [], verified: new Map(), knownProfs: [], tbaOnly: false };

function bg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: "no_response" });
    });
  });
}

function msg(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = kind;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function populateCourses() {
  const courses = await PD.db.listCourses();
  $("course-list").innerHTML = courses.map((c) => `<option value="${esc(c.courseCode)}"></option>`).join("");
  if (!$("course").value && courses.length) $("course").value = courses[0].courseCode;
}

async function populateTerms() {
  const course = $("course").value.trim();
  const select = $("term");
  select.innerHTML = "";
  if (!course) return;
  const summary = await PD.db.courseSummary(course);
  if (!summary?.terms?.length) {
    select.innerHTML = '<option value="">no scanned terms</option>';
    return;
  }
  select.innerHTML = summary.terms
    .slice()
    .reverse()
    .map(
      (t) =>
        `<option value="${t.term}">${esc(PD.terms.label(t.term))} — ${t.revealed}/${t.total} named</option>`
    )
    .join("");
}

async function loadSections() {
  const course = $("course").value.trim();
  const term = Number($("term").value);
  if (!course || !term) {
    msg("Pick a subject and a scanned semester first.", "err");
    return;
  }

  const entry = await PD.db.getTerm(course, term);
  if (!entry?.records?.length) {
    msg(`No scanned sections for ${course} in ${term}. Run a prediction for that subject first.`, "err");
    $("rows").innerHTML = '<tr><td colspan="5" class="hint">Nothing scanned for this term.</td></tr>';
    return;
  }

  const allRecords = await PD.db.allRecords(course);
  const verifiedList = await PD.db.getVerified(course);

  state = {
    course,
    term,
    sections: entry.records.slice().sort((a, b) => a.section.localeCompare(b.section)),
    verified: new Map(verifiedList.filter((v) => v.term === term).map((v) => [v.section, v])),
    knownProfs: [
      ...new Map(
        PD.predict
          .revealedRecords(allRecords)
          .map((r) => [r.profKey, { profKey: r.profKey, name: PD.names.displayName(r.instructor) }])
      ).values(),
    ],
    tbaOnly: state.tbaOnly,
  };

  renderRows();
  msg(
    `${state.sections.length} sections in ${PD.terms.label(term)} · ${state.verified.size} already verified · ${
      state.knownProfs.length
    } known professors for fuzzy matching.`,
    "ok"
  );
}

function renderRows() {
  const rows = state.sections.filter((r) => (state.tbaOnly ? !r.profKey : true));
  if (!rows.length) {
    $("rows").innerHTML = `<tr><td colspan="5" class="hint">${
      state.tbaOnly ? "No TBA sections in this term." : "Nothing to show."
    }</td></tr>`;
    return;
  }

  $("rows").innerHTML = rows
    .map((r) => {
      const v = state.verified.get(r.section);
      const schedule = [r.days, [r.timeStart, r.timeEnd].filter(Boolean).join("-"), r.room]
        .filter(Boolean)
        .join(" · ");
      return `
        <tr class="${v ? "verified" : ""} ${r.profKey ? "" : "tba"}" data-section="${esc(r.section)}">
          <td class="sec">${esc(r.section)}</td>
          <td class="sched">${esc(schedule || "—")}</td>
          <td class="cur">${esc(r.profKey ? PD.names.displayName(r.instructor) : "TBA")}</td>
          <td>
            <input class="name-input" type="text" value="${esc(v?.instructor || "")}"
                   placeholder="Surname, Firstname" autocomplete="off" />
            <div class="sugg"></div>
          </td>
          <td class="act">
            <button class="save" type="button">Save</button>
            ${v ? '<span class="tag">verified</span>' : ""}
          </td>
        </tr>`;
    })
    .join("");

  $("rows")
    .querySelectorAll("tr[data-section]")
    .forEach((tr) => {
      const input = tr.querySelector(".name-input");
      input.addEventListener("input", () => showSuggestion(tr, input));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveRow(tr).catch((err) => msg(String(err), "err"));
      });
      tr.querySelector(".save").addEventListener("click", () =>
        saveRow(tr).catch((err) => msg(String(err), "err"))
      );
    });
}

/**
 * Nudge the moderator toward an existing spelling instead of creating a
 * near-duplicate professor entry.
 */
function showSuggestion(tr, input) {
  const box = tr.querySelector(".sugg");
  const query = input.value.trim();
  if (query.length < 3 || !state.knownProfs.length) {
    box.innerHTML = "";
    return;
  }
  const [best] = PD.names.bestMatches(query, state.knownProfs, { limit: 1, minScore: 0.5 });
  if (!best || PD.names.canonicalKey(query) === best.entry.profKey) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `already in dataset as <b data-use="${esc(best.entry.name)}">${esc(
    best.entry.name
  )}</b> (${Math.round(best.score * 100)}% match) — click to use`;
  box.querySelector("b").addEventListener("click", () => {
    input.value = best.entry.name;
    box.innerHTML = "";
  });
}

async function saveRow(tr) {
  const section = tr.dataset.section;
  const input = tr.querySelector(".name-input");
  const value = input.value.trim();

  await PD.db.setVerified(state.course, state.term, section, value, "moderator");
  if (value) {
    state.verified.set(section, {
      term: state.term,
      section,
      instructor: value,
      profKey: PD.names.canonicalKey(value),
    });
    tr.classList.add("verified");
    if (!tr.querySelector(".tag")) {
      tr.querySelector(".act").insertAdjacentHTML("beforeend", ' <span class="tag">verified</span>');
    }
    msg(`Saved: ${state.course} ${state.term} section ${section} → ${value}`, "ok");
  } else {
    state.verified.delete(section);
    tr.classList.remove("verified");
    tr.querySelector(".tag")?.remove();
    msg(`Cleared verification for section ${section}.`, "ok");
  }
}

/* ------------------------------------------------------------------ *
 * Registry sync + portability
 * ------------------------------------------------------------------ */

async function pull() {
  msg("Pulling verified rows from the registry…");
  const res = await bg({ type: "PULL_VERIFIED", courseCode: $("course").value.trim() });
  if (!res?.ok) {
    msg(registryError(res), "err");
    return;
  }
  const added = await PD.db.mergeRemoteVerified(res.rows);
  msg(`Pulled ${res.rows.length} row(s); ${added} newer than what was stored.`, "ok");
  await loadSections();
}

async function push() {
  const entries = await PD.db.allVerified();
  if (!entries.length) {
    msg("Nothing verified locally to push.", "err");
    return;
  }
  msg(`Pushing ${entries.length} verified row(s)…`);
  const res = await bg({ type: "PUSH_VERIFIED", entries });
  msg(res?.ok ? `Pushed ${entries.length} row(s) to the registry.` : registryError(res), res?.ok ? "ok" : "err");
}

function registryError(res) {
  const map = {
    registry_not_configured:
      "No registry configured. Set PROFDICTOR_REGISTRY_URL in access-codes.js to share verifications; local saving still works.",
    registry_unreachable: "Cannot reach the registry.",
    not_admin: "Moderator session expired. Sign in again from the popup.",
  };
  return map[res?.error] || `Registry error: ${res?.error || "unknown"}`;
}

async function exportDataset() {
  const json = await PD.db.exportJson();
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `profdictor-dataset-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  msg("Dataset exported.", "ok");
}

async function importDataset(file) {
  try {
    await PD.db.importJson(await file.text());
    msg("Dataset imported.", "ok");
    await populateCourses();
    await populateTerms();
  } catch (err) {
    msg(`Import failed: ${err.message}`, "err");
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  const info = await bg({ type: "PING_BG" });
  const isAdmin = !!info?.admin?.isAdmin;
  $("locked").hidden = isAdmin;
  $("app").hidden = !isAdmin;
  $("who").textContent = isAdmin
    ? `signed in as ${info.admin.name || "moderator"}`
    : "not signed in";
  $("registry-state").textContent = info?.registryConfigured
    ? "Registry configured — pull/push are live."
    : "No registry configured. Verifications save locally only; use export/import to share them.";
  if (!isAdmin) return;

  await populateCourses();
  await populateTerms();

  const cfg = await PD.db.loadConfig();
  if (cfg.courseCode) {
    $("course").value = cfg.courseCode;
    await populateTerms();
  }
}

$("course").addEventListener("change", () => populateTerms().catch(() => {}));
$("load").addEventListener("click", () => loadSections().catch((e) => msg(String(e), "err")));
$("onlyTba").addEventListener("click", () => {
  state.tbaOnly = !state.tbaOnly;
  $("onlyTba").textContent = state.tbaOnly ? "Show all sections" : "Show TBA only";
  if (state.sections.length) renderRows();
});
$("pull").addEventListener("click", () => pull().catch((e) => msg(String(e), "err")));
$("push").addEventListener("click", () => push().catch((e) => msg(String(e), "err")));
$("export").addEventListener("click", () => exportDataset().catch((e) => msg(String(e), "err")));
$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importDataset(file).catch((err) => msg(String(err), "err"));
});
$("logout").addEventListener("click", async () => {
  await bg({ type: "ADMIN_LOGOUT" });
  location.reload();
});

boot().catch((err) => msg(String(err), "err"));
