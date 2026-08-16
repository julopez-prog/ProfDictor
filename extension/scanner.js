/**
 * Profdictor scanner.
 *
 * Two ways to read a term:
 *
 *   API mode (default) - ask the bridge for `students/classes?term_id=NNNN`.
 *     Fast, complete, paginated, and it never touches the page the user is
 *     looking at. This is the only mode that can read nine semesters in a few
 *     seconds.
 *
 *   DOM mode (fallback) - drive the real term dropdown and filter form, then
 *     scrape the rendered table. Slower and more fragile, but it works if the
 *     API refuses historical terms for a student account.
 *
 * The AMIS JSON field names for the instructor are not documented and differ
 * between deployments, so `extractRecords` searches for them instead of
 * hard-coding a path, and reports what it found. If AMIS renames something, the
 * field report in the panel says exactly which keys were seen.
 */
(() => {
  const PD = (self.PD = self.PD || {});
  if (PD.scanner) return;

  const { names, db, terms } = PD;

  const REQ = "PROFDICTOR_REQ";
  const RES = "PROFDICTOR_RES";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   * Generic JSON spelunking
   * ------------------------------------------------------------------ */

  const INSTRUCTOR_KEY = /^(instructor|instructors|faculty|faculties|professor|prof|teacher|lecturer|assigned_faculty|faculty_name|instructor_name|handled_by|teaching_staff)s?$/i;
  const NAME_KEY = /^(name|full_name|fullname|complete_name|display_name|faculty_name|instructor_name|employee_name|text|label)$/i;
  const DAYS_KEY = /^(days?|day_code|day_codes|schedule_days|meeting_days)$/i;
  const START_KEY = /^(time_start|start_time|from_time|begin_time|time_from|start)$/i;
  const END_KEY = /^(time_end|end_time|to_time|finish_time|time_to|end)$/i;
  const ROOM_KEY = /^(room|room_name|room_code|venue|location|room_no)$/i;
  const SECTION_KEY = /^(section|section_name|class_section|section_code)$/i;
  const SCHEDULE_CONTAINER = /^(schedules?|class_schedules?|meeting_?times?|timeslots?|lecture_details|laboratory_details|details)$/i;

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Compose a person's name from separated first/middle/last fields. */
  function composeName(obj) {
    if (!isPlainObject(obj)) return "";
    const last = obj.last_name ?? obj.lastname ?? obj.surname ?? obj.family_name;
    const first = obj.first_name ?? obj.firstname ?? obj.given_name;
    const middle = obj.middle_name ?? obj.middlename ?? obj.middle_initial ?? obj.mi;
    if (!last && !first) return "";
    const mid = middle ? ` ${String(middle).trim()}` : "";
    if (last && first) return `${String(last).trim()}, ${String(first).trim()}${mid}`.trim();
    return String(last || first).trim();
  }

  /** Pull a human name out of whatever shape the instructor field holds. */
  function resolveName(value, depth = 0) {
    if (value == null || depth > 3) return "";
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (Array.isArray(value)) {
      const parts = value.map((v) => resolveName(v, depth + 1)).filter((s) => s && !names.isTba(s));
      return [...new Set(parts)].join(" / ");
    }
    if (!isPlainObject(value)) return "";

    for (const [k, v] of Object.entries(value)) {
      if (NAME_KEY.test(k) && typeof v === "string" && v.trim()) return v.trim();
    }
    const composed = composeName(value);
    if (composed) return composed;
    for (const [k, v] of Object.entries(value)) {
      if (INSTRUCTOR_KEY.test(k)) {
        const nested = resolveName(v, depth + 1);
        if (nested) return nested;
      }
    }
    return "";
  }

  /**
   * Breadth-first search for the first key matching `pattern`.
   * Returns `{ path, value }` so the field report can show where it came from.
   */
  function deepFind(root, pattern, { maxDepth = 4, accept } = {}) {
    const queue = [{ node: root, path: [], depth: 0 }];
    while (queue.length) {
      const { node, path, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > maxDepth) continue;
      for (const [k, v] of Object.entries(node)) {
        if (pattern.test(k)) {
          const ok = accept ? accept(v) : v != null && v !== "";
          if (ok) return { path: [...path, k].join("."), value: v };
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === "object") {
          if (Array.isArray(v)) {
            v.slice(0, 6).forEach((item, i) => {
              queue.push({ node: item, path: [...path, `${k}[${i}]`], depth: depth + 1 });
            });
          } else {
            queue.push({ node: v, path: [...path, k], depth: depth + 1 });
          }
        }
      }
    }
    return null;
  }

  const TIME_RE = /(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i;
  const DAYS_RE = /\b((?:M|T|W|F|S|TH|SA|SU)(?:\s*[,/-]?\s*(?:M|T|W|F|S|TH|SA|SU))*)\b/;

  /** Parse a free-text schedule blob like "TTh 8:30 AM - 10:00 AM SMA LH". */
  function parseScheduleText(text) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return null;
    const time = s.match(TIME_RE);
    const before = time ? s.slice(0, time.index) : s;
    const days = before.toUpperCase().match(DAYS_RE);
    let room = "";
    if (time) {
      room = s
        .slice(time.index + time[0].length)
        .replace(/^[\s,;|/-]+/, "")
        .trim();
    }
    if (!time && !days) return null;
    return {
      days: days ? days[1] : "",
      timeStart: time ? time[1] : "",
      timeEnd: time ? time[2] : "",
      room,
    };
  }

  function extractSchedule(cls) {
    // Preferred: a structured schedule array/object somewhere in the payload.
    const container = deepFind(cls, SCHEDULE_CONTAINER, { maxDepth: 2, accept: (v) => !!v });
    const candidates = [];
    if (container) {
      const v = container.value;
      if (Array.isArray(v)) candidates.push(...v.filter(isPlainObject));
      else if (isPlainObject(v)) candidates.push(v);
    }
    candidates.push(cls);

    for (const node of candidates) {
      const days = deepFind(node, DAYS_KEY, { maxDepth: 2 });
      const start = deepFind(node, START_KEY, { maxDepth: 2 });
      const end = deepFind(node, END_KEY, { maxDepth: 2 });
      const room = deepFind(node, ROOM_KEY, { maxDepth: 2 });
      const daysValue = Array.isArray(days?.value) ? days.value.join(" ") : days?.value;
      if (daysValue || start?.value) {
        return {
          days: String(daysValue ?? "").trim(),
          timeStart: String(start?.value ?? "").trim(),
          timeEnd: String(end?.value ?? "").trim(),
          room: String(resolveName(room?.value) || room?.value || "").trim(),
          paths: {
            days: days?.path || null,
            start: start?.path || null,
            end: end?.path || null,
            room: room?.path || null,
          },
        };
      }
    }

    // Fallback: some payloads only carry a rendered schedule string.
    const textual = deepFind(cls, /^(schedule|sched|time|class_schedule|meeting)$/i, {
      maxDepth: 3,
      accept: (v) => typeof v === "string" && v.trim().length > 3,
    });
    if (textual) {
      const parsed = parseScheduleText(textual.value);
      if (parsed) return { ...parsed, paths: { text: textual.path } };
    }
    return { days: "", timeStart: "", timeEnd: "", room: "", paths: {} };
  }

  function extractSection(cls) {
    const direct = deepFind(cls, SECTION_KEY, {
      maxDepth: 3,
      accept: (v) => typeof v === "string" || typeof v === "number",
    });
    if (direct) return { value: String(direct.value).trim(), path: direct.path };
    // "MATH 10 - B2" style combined label.
    const label = deepFind(cls, /^(class_name|name|title|label|code)$/i, {
      maxDepth: 2,
      accept: (v) => typeof v === "string" && /[-–]/.test(v),
    });
    if (label) {
      const m = String(label.value).match(/[-–]\s*([A-Z0-9][A-Z0-9-]*)\s*$/i);
      if (m) return { value: m[1].trim(), path: `${label.path} (parsed)` };
    }
    return { value: "", path: null };
  }

  function extractInstructor(cls) {
    const hit = deepFind(cls, INSTRUCTOR_KEY, {
      maxDepth: 4,
      accept: (v) => {
        const resolved = resolveName(v);
        return !!resolved;
      },
    });
    if (!hit) return { value: "", path: null };
    return { value: resolveName(hit.value), path: hit.path };
  }

  /**
   * Turn raw API objects into canonical records.
   * Pure function - unit-tested by tools/selftest-scanner.mjs.
   */
  function extractRecords(rawClasses, courseCode, term, source = "api") {
    const records = [];
    const report = {
      source,
      count: rawClasses?.length || 0,
      instructorPaths: {},
      sectionPaths: {},
      schedulePaths: {},
      sampleKeys: [],
      missingInstructor: 0,
      sample: null,
    };
    if (!Array.isArray(rawClasses) || !rawClasses.length) return { records, fieldReport: report };

    report.sampleKeys = Object.keys(rawClasses[0] || {});
    try {
      report.sample = JSON.parse(JSON.stringify(rawClasses[0])); // for diagnostics
    } catch (_) {
      report.sample = null;
    }

    const wanted = names.normalize(courseCode).replace(/\s+/g, " ");

    for (const cls of rawClasses) {
      if (!isPlainObject(cls)) continue;

      // Guard against the API doing a prefix match ("ARTS 1" returning "PHILARTS 1").
      // Only strings qualify, so a nested `course: { course_code }` resolves to
      // the inner string instead of stringifying the wrapper object.
      const codeHit = deepFind(cls, /^(course_code|subject_code|course_number|code|course)$/i, {
        maxDepth: 3,
        accept: (v) => typeof v === "string" && v.trim().length > 0,
      });
      const codeText = names.normalize(codeHit?.value || "").replace(/\s+/g, " ");
      if (codeText && wanted && !codeText.startsWith(wanted)) {
        const asWords = codeText.split(" ");
        const wantWords = wanted.split(" ");
        const matches = wantWords.every((w, i) => asWords[i] === w);
        if (!matches) continue;
      }

      const section = extractSection(cls);
      const instructor = extractInstructor(cls);
      const schedule = extractSchedule(cls);

      if (instructor.path) {
        report.instructorPaths[instructor.path] = (report.instructorPaths[instructor.path] || 0) + 1;
      } else {
        report.missingInstructor += 1;
      }
      if (section.path) report.sectionPaths[section.path] = (report.sectionPaths[section.path] || 0) + 1;
      Object.entries(schedule.paths || {}).forEach(([k, v]) => {
        if (v) report.schedulePaths[`${k}:${v}`] = (report.schedulePaths[`${k}:${v}`] || 0) + 1;
      });

      const statusHit = deepFind(cls, /^(class_status|status|availability)$/i, { maxDepth: 2 });
      records.push({
        term,
        courseCode,
        section: section.value,
        instructor: instructor.value,
        days: schedule.days,
        timeStart: schedule.timeStart,
        timeEnd: schedule.timeEnd,
        room: schedule.room,
        classId: cls.id ?? cls.class_id ?? cls.class_nbr ?? null,
        status: String(statusHit?.value ?? ""),
        source,
      });
    }

    return { records: records.filter((r) => r.section), fieldReport: report };
  }

  /* ------------------------------------------------------------------ *
   * Bridge plumbing
   * ------------------------------------------------------------------ */

  function injectBridge() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return;
      if (document.getElementById("profdictor-bridge")) return;
      const s = document.createElement("script");
      s.id = "profdictor-bridge";
      s.src = chrome.runtime.getURL("page-bridge.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {
      /* tests and non-extension hosts have no chrome.runtime */
    }
  }

  let seq = 0;
  function bridgeCall(type, payload, timeoutMs = 30000) {
    injectBridge();
    const id = `pd_${Date.now()}_${(seq += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          window.removeEventListener?.("message", onMessage);
        } catch (_) {
          /* tests stub window without removeEventListener */
        }
        resolve({ ok: false, error: "bridge_timeout" });
      }, timeoutMs);

      function onMessage(event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== RES) return;
        if (msg.id !== id) return; // ignores the bridge's initial "ready" ping
        clearTimeout(timer);
        try {
          window.removeEventListener?.("message", onMessage);
        } catch (_) {
          /* ignore */
        }
        resolve(msg);
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ source: REQ, id, type, payload }, "*");
    });
  }

  async function ping() {
    // The bridge script may still be loading on the first call.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await bridgeCall("PING", null, 4000);
      if (res.ok) return res;
      await sleep(300);
    }
    return { ok: false, error: "bridge_unavailable" };
  }

  /* ------------------------------------------------------------------ *
   * DOM scan — this is the real path
   *
   * AMIS Search Class is a Vue/Vuetify/Vuesax block on /student/enrollment.
   * The API for historical terms is unreliable, so we drive the same controls
   * a student uses: the top term field, Open Filter/Search, Apply Filter, then
   * scrape the Search Class table or Tailwind cards (never Active Enlistment).
   * ------------------------------------------------------------------ */

  const norm = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const textOf = (el) => (el ? el.innerText || el.textContent || "" : "");
  const DENY_CLICK = /\b(CANCEL|REMOVE|DELETE|DROP|WITHDRAW|ENLIST\s*ALL|LOG\s*OUT|UNENLIST)\b/;

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function setNativeValue(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickables() {
    return [
      ...document.querySelectorAll(
        "button, a, input[type='button'], input[type='submit'], .v-btn, .btn, [role='button']"
      ),
    ];
  }

  function clickLabel(el) {
    return norm(textOf(el) || el?.value || el?.getAttribute?.("aria-label") || el?.title || "");
  }

  function findButton(label) {
    const want = norm(label);
    let best = null;
    let bestLen = Infinity;
    for (const el of clickables()) {
      if (!visible(el)) continue;
      const t = clickLabel(el);
      if (!t || DENY_CLICK.test(t)) continue;
      if (t === want || t.includes(want)) {
        if (t.length < bestLen) {
          best = el;
          bestLen = t.length;
        }
      }
    }
    return best;
  }

  function findOpenFilterButton() {
    return (
      findButton("OPEN FILTER/SEARCH") ||
      findButton("OPEN FILTER / SEARCH") ||
      findButton("OPEN FILTER") ||
      findButton("FILTER/SEARCH")
    );
  }

  function pointerTarget(el) {
    if (!el) return null;
    try {
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
    } catch (_) {
      /* ignore */
    }
    const r = el.getBoundingClientRect?.();
    if (r && r.width > 0 && r.height > 0 && typeof document.elementFromPoint === "function") {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top) return top;
    }
    return el;
  }

  function realClick(el) {
    if (!el) return;
    const target = pointerTarget(el) || el;
    const r = target.getBoundingClientRect?.() || { left: 8, top: 8, width: 20, height: 20 };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      view: typeof window !== "undefined" ? window : undefined,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    const fire = (type, down) => {
      const opts = { ...base, buttons: down ? 1 : 0 };
      try {
        if (type.startsWith("pointer") && typeof PointerEvent === "function") {
          target.dispatchEvent(new PointerEvent(type, { ...opts, width: 1, height: 1 }));
          return;
        }
      } catch (_) {
        /* fall through */
      }
      try {
        target.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), opts));
      } catch (_) {
        /* tests may lack MouseEvent extras */
      }
    };
    fire("pointerover", false);
    fire("mouseover", false);
    fire("pointermove", false);
    fire("mousemove", false);
    fire("pointerdown", true);
    fire("mousedown", true);
    fire("pointerup", false);
    fire("mouseup", false);
    fire("click", false);
    try {
      target.click();
    } catch (_) {
      /* ignore */
    }
  }

  function dispatchKey(el, key) {
    if (!el) return;
    const isEnter = key === "Enter";
    const isBackspace = key === "Backspace";
    const opts = {
      key,
      code: isEnter ? "Enter" : isBackspace ? "Backspace" : `Digit${key}`,
      keyCode: isEnter ? 13 : isBackspace ? 8 : String(key).charCodeAt(0),
      which: isEnter ? 13 : isBackspace ? 8 : String(key).charCodeAt(0),
      bubbles: true,
      cancelable: true,
    };
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch (_) {
      /* KeyboardEvent may be missing in tests */
    }
  }

  function isTermLabel(text) {
    const t = norm(text).replace(/\*+$/, "").trim();
    return t === "TERM" || t === "SEMESTER" || t === "ACADEMIC TERM";
  }

  /** The Enrollment "Term *" control — the one circled on the AMIS page. */
  function findTermControl() {
    for (const label of document.querySelectorAll("label, .v-label, .v-field-label, span, div, p, strong")) {
      if (!visible(label) || !isTermLabel(textOf(label))) continue;
      const wrap =
        label.closest(
          ".v-input, .v-select, .v-autocomplete, .v-field, .vs-select, .vs-con-select, [role='combobox']"
        ) || label.parentElement;
      if (!wrap) continue;
      const hit =
        wrap.querySelector?.(
          ".v-input__slot, .v-field, .v-select__slot, [role='combobox'], .vs-select, select, input"
        ) || wrap;
      if (hit) return hit;
    }
    const byText = [
      ...document.querySelectorAll(
        ".v-select, .v-autocomplete, .v-field, .vs-select, .vs-con-select, [role='combobox']"
      ),
    ]
      .filter((el) => visible(el) && looksTermish(textOf(el)))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return byText[0] || null;
  }

  function termMenuItems() {
    return [
      ...document.querySelectorAll(
        ".v-menu__content .v-list-item, .menuable__content__active .v-list-item, .v-overlay--active .v-list-item, .v-select-list .v-list-item, .v-list-item, .v-list__tile, .v-list-item__title, .vs-select--item, [role='listbox'] [role='option'], [role='option']"
      ),
    ].filter((el) => {
      if (!visible(el)) return false;
      const t = textOf(el).trim();
      return t.length > 0 && t.length < 80 && looksTermish(t);
    });
  }

  function findInputNearLabel(labelText) {
    const want = norm(labelText);
    for (const label of document.querySelectorAll("label, span, div, th, td, p, strong, b, small")) {
      if (!visible(label)) continue;
      const t = norm(textOf(label));
      if (!t || t.length > 48) continue;
      if (!(t === want || t.startsWith(want) || t.includes(want))) continue;
      if (label.htmlFor) {
        const byId = document.getElementById(label.htmlFor);
        if (byId?.matches?.("input, select, textarea")) return byId;
      }
      const wrap =
        label.closest("div, tr, form, fieldset, li, td, label, .v-input, .v-text-field") ||
        label.parentElement;
      const input = wrap?.querySelector(
        "input:not([type='hidden']):not([type='checkbox']):not([type='radio']), select, textarea"
      );
      if (input && visible(input)) return input;
    }
    return null;
  }

  function looksLikeTermField(input) {
    if (!input || !visible(input)) return false;
    const type = String(input.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "hidden" || type === "password") return false;
    const meta = `${input.name || ""} ${input.id || ""} ${input.placeholder || ""} ${
      input.getAttribute?.("aria-label") || ""
    }`;
    if (/course|subject|section|instructor|faculty/i.test(meta)) return false;
    const val = String(input.value || "").trim();
    if (/term|semester|\bay\b/i.test(meta)) return true;
    if (/^\d{4}$/.test(val) && terms.isTermCode(val)) return true;
    return false;
  }

  const SEMESTER_WORDS = {
    1: ["FIRST", "1ST"],
    2: ["SECOND", "2ND"],
    3: ["MIDYEAR", "MID-YEAR", "MID YEAR", "SUMMER"],
  };

  function termYearMatches(upper, t) {
    if (upper.includes(String(t.startYear))) return true;
    if (upper.includes(`${t.startYear % 100}-${t.endYear % 100}`)) return true;
    if (upper.includes(`${t.startYear % 100}${t.endYear % 100}`)) return true;
    // Midyear is the summer of the end calendar year: "Midyear 2024" = 1233.
    if (t.semester === 3 && upper.includes(String(t.endYear))) return true;
    return false;
  }

  /**
   * Does this bit of text refer to the term we want?
   *
   * Deployments label the dropdown either with the raw code
   * (`1261 - First Semester (2026-2027)`) or with words only
   * (`First Semester AY 2026-2027`). Matching on the code alone was the original
   * bug: it failed every term, including the one already selected.
   */
  function matchesTerm(text, code) {
    const upper = norm(text);
    if (!upper) return false;
    const raw = String(code);
    if (new RegExp(`(^|[^0-9])${raw}([^0-9]|$)`).test(upper)) return true;

    const t = terms.parse(code);
    if (!t) return false;
    const words = SEMESTER_WORDS[t.semester] || [];
    if (!words.some((w) => upper.includes(w))) return false;
    return termYearMatches(upper, t);
  }

  /** Text that looks like it names *some* term, used to spot the term control. */
  function looksTermish(text) {
    const upper = norm(text);
    return (
      /\b\d{2}[3-9][123]\b\s*[-–]/.test(upper) ||
      /(FIRST|SECOND|MID|MIDYEAR|MID-YEAR)\s*(SEMESTER|SEM|YEAR)/.test(upper)
    );
  }

  /** Every label the page currently shows for a term, for error messages. */
  function observedTermLabels() {
    const out = new Set();
    for (const opt of document.querySelectorAll("option")) {
      const text = (opt.textContent || "").trim();
      if (text && looksTermish(text)) out.add(text);
    }
    for (const el of document.querySelectorAll(
      ".v-list-item, .v-list__tile, [role='option'], .v-select__selection, .v-select__selection-text, .vs-select--item"
    )) {
      const text = textOf(el).trim();
      if (text && text.length < 80 && looksTermish(text)) out.add(text);
    }
    return [...out];
  }

  /**
   * What the Term control is actually showing — not leftover .value on inputs.
   * Typing 1233 into the box used to make showingTerm(1233) true while Search
   * Class was still rendering Second Semester.
   */
  function singleTermBlob(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    const codes = [...t.matchAll(/\b(1[2-9]\d[123])\b/g)].map((m) => m[1]);
    return new Set(codes).size <= 1;
  }

  function displayedTermTexts() {
    const bits = [];
    for (const select of document.querySelectorAll("select")) {
      const opt = select.selectedOptions?.[0] || select.options?.[select.selectedIndex];
      if (opt) bits.push((opt.textContent || "").trim());
    }
    for (const el of document.querySelectorAll(
      ".v-select__selection, .v-select__selection-text, .vs__selected"
    )) {
      if (visible(el)) bits.push(textOf(el).trim());
    }
    const input = termFieldInput();
    if (input?.value) bits.push(String(input.value).trim());
    const control = findTermControl();
    if (control) {
      const chip = control.querySelector?.(
        ".v-select__selection, .v-select__selection-text, .vs__selected, input"
      );
      if (chip) bits.push((chip.value || textOf(chip)).trim());
      else {
        const own = textOf(control).trim();
        if (singleTermBlob(own)) bits.push(own);
      }
    }
    return bits.filter((t) => t && singleTermBlob(t));
  }

  function selectedTermTexts() {
    return displayedTermTexts();
  }

  function showingTerm(code) {
    return displayedTermTexts().some((t) => matchesTerm(t, code));
  }

  /**
   * Cheap signature of the offerings view, to detect a re-render.
   *
   * Includes the body text length so a card layout - AMIS does not always render
   * a table - still registers as changed, instead of burning the whole timeout.
   */
  function pageFingerprint() {
    const table = findSearchTable();
    const rows = table ? table.querySelectorAll("tbody tr").length : 0;
    const first = table ? textOf(table.querySelector("tbody tr")).trim().slice(0, 120) : "";
    const bulk = (document.body?.innerText || "").length;
    return `${rows}:${bulk}:${first}`;
  }

  async function waitUntil(check, timeoutMs = 1200, stepMs = 50) {
    const start = Date.now();
    if (check()) return true;
    while (Date.now() - start < timeoutMs) {
      await sleep(stepMs);
      if (check()) return true;
    }
    return false;
  }

  async function waitForRerender(before, timeoutMs = 1200) {
    return waitUntil(() => pageFingerprint() !== before, timeoutMs, 50);
  }

  function tableHasFacultyFor(courseCode) {
    const blob = `${textOf(findSearchTable())} ${textOf(searchClassScope())}`;
    if (!/FACULTY\s*:/i.test(blob)) return false;
    if (courseCode && !courseMatchesText(blob, courseCode)) return false;
    return true;
  }

  /** TBA terms never print Faculty: — section+time cards are enough to scrape. */
  function tableHasSectionCards(courseCode) {
    const blob = `${textOf(findSearchTable())} ${textOf(searchClassScope())}`;
    if (courseCode && !courseMatchesText(blob, courseCode)) return false;
    return /(?:^|\s)[A-Z0-9][A-Z0-9-]{0,11}\s*[-–]\s*\(\s*\d{1,2}:\d{2}/i.test(blob);
  }

  /** True only when the new term's catalogue has arrived — not a loading flicker. */
  function offeringsReady(courseCode) {
    return searchAreaShowsNoData() || tableHasFacultyFor(courseCode) || tableHasSectionCards(courseCode);
  }

  async function waitForOfferings(courseCode, timeoutMs = 2800) {
    return waitUntil(() => offeringsReady(courseCode), timeoutMs, 40);
  }

  function setSelectValue(select, option) {
    const proto = typeof HTMLSelectElement === "undefined" ? null : HTMLSelectElement.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    if (setter) setter.call(select, option.value);
    else select.value = option.value;
    option.selected = true;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Switch the term at the top of Enrollment.
   *
   * AMIS exposes this three ways depending on the build: a native <select>, a
   * Vuetify/Vuesax menu, or a text box you type `1231` into and apply. The last
   * one is what "apply different numbers to the top portion" actually means.
   */
  async function pickTermFromOpenMenu(wanted) {
    for (let i = 0; i < 24; i += 1) {
      const items = termMenuItems();
      const picked = items.find((el) => matchesTerm(textOf(el), wanted));
      if (picked) return picked;
      await sleep(30);
    }
    return null;
  }

  async function scrollMenuForTerm(wanted) {
    const lists = [
      ...document.querySelectorAll(
        ".v-overlay--active .v-list, .v-menu__content .v-list, .menuable__content__active .v-list, [role='listbox'], .vs-select--options"
      ),
    ].filter(visible);
    for (const list of lists) {
      list.scrollTop = 0;
      for (let i = 0; i < 30; i += 1) {
        const hit = termMenuItems().find((el) => matchesTerm(textOf(el), wanted));
        if (hit) return hit;
        list.scrollTop += Math.max(140, (list.clientHeight || 200) * 0.85);
        await sleep(35);
      }
    }
    return pickTermFromOpenMenu(wanted);
  }

  function termFieldInput() {
    const control = findTermControl();
    const inside = control?.querySelector?.("input, textarea");
    if (inside && visible(inside)) return inside;
    const inputs = [...document.querySelectorAll("input, textarea")].filter(looksLikeTermField);
    inputs.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return inputs[0] || null;
  }

  async function typeTermDigits(input, wanted) {
    if (!input) return;
    input.focus?.();
    realClick(input);
    setNativeValue(input, "");
    dispatchKey(input, "Backspace");
    await sleep(30);
    let acc = "";
    for (const ch of String(wanted)) {
      acc += ch;
      dispatchKey(input, ch);
      setNativeValue(input, acc);
      await sleep(35);
    }
    dispatchKey(input, "Enter");
    await sleep(60);
    dispatchKey(input, "ArrowDown");
    await sleep(40);
    dispatchKey(input, "Enter");
  }

  async function tryPageSetTerm(wanted) {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return { ok: false };
    try {
      return await bridgeCall("SET_TERM", { termId: wanted }, 2000);
    } catch (_) {
      return { ok: false };
    }
  }

  async function selectTerm(code, { settleMs = 2200 } = {}) {
    const wanted = String(code);

    if (showingTerm(wanted)) return { ok: true, via: "already-selected" };

    const viaVue = await tryPageSetTerm(wanted);
    if (viaVue.ok || viaVue.vueTouched || viaVue.storeTouched) {
      if (await waitUntil(() => showingTerm(wanted), 900, 40)) {
        return { ok: true, via: "vue-store", label: wanted };
      }
    }

    let menuLabels = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = pageFingerprint();

      for (const select of document.querySelectorAll("select")) {
        if (!visible(select)) continue;
        const options = [...select.options];
        const option = options.find(
          (o) => matchesTerm(o.textContent, wanted) || String(o.value).trim() === wanted
        );
        if (!option) continue;
        setSelectValue(select, option);
        await waitForRerender(before, settleMs);
        if (showingTerm(wanted)) {
          return { ok: true, via: "native-select", label: (option.textContent || "").trim() };
        }
      }

      const control = findTermControl();
      const input = termFieldInput();
      if (control) realClick(control);
      else if (input) realClick(input);
      await sleep(140);

      await typeTermDigits(input || control, wanted);
      await sleep(80);

      let picked = await scrollMenuForTerm(wanted);
      if (!picked) picked = await pickTermFromOpenMenu(wanted);
      menuLabels = termMenuItems().map((el) => textOf(el).trim());
      if (picked) {
        const title = picked.querySelector?.(".v-list-item__title, .v-list-item-title") || picked;
        realClick(picked);
        if (title && title !== picked) realClick(title);
      }

      const switched = await waitUntil(() => showingTerm(wanted), Math.max(settleMs, 2400), 40);
      if (switched) return { ok: true, via: picked ? "term-menu" : "term-typeahead", label: wanted };

      dispatchKey(document.body, "Escape");
      await sleep(120);
    }

    const seen = [...new Set([...menuLabels, ...observedTermLabels()])];
    const preview = seen.slice(0, 8).join(" | ");
    return {
      ok: false,
      error: seen.length
        ? `could not switch Term * to ${wanted} after 3 tries — not in the Term dropdown (offers: ${preview}${seen.length > 8 ? " …" : ""})`
        : `could not open the Term * dropdown on Enrollment`,
      observed: seen,
    };
  }

  async function typeTermCode(wanted, before, settleMs) {
    const input = termFieldInput();
    if (!input) return { ok: false };
    await typeTermDigits(input, wanted);
    await waitForRerender(before, Math.min(settleMs, 1500));
    if (showingTerm(wanted)) return { ok: true, via: "term-input", label: wanted };
    return { ok: false };
  }

  function headingExact(el, title) {
    const t = norm(textOf(el));
    const n = norm(title);
    return t === n || (t.startsWith(n) && t.length <= n.length + 24);
  }

  /**
   * The Search Class card — never Active Enlistment (Finalized / Status/Action).
   * Adapted from an earlier implementation's sectionRoot + searchClassScope.
   */
  function searchClassScope() {
    for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,legend,th,.v-toolbar__title,div,span")) {
      if (!visible(el) || !headingExact(el, "Search Class")) continue;
      let node = el.parentElement;
      for (let d = 0; d < 12 && node && node !== document.body; d += 1) {
        const hasPag = !!node.querySelector?.("nav[aria-label='Pagination Navigation'], ul.vs-pagination");
        const hasAdd = [...(node.querySelectorAll?.("button, a, [role='button']") || [])].some((b) => {
          if (!visible(b)) return false;
          const bt = clickLabel(b);
          return bt === "ADD" || (bt.startsWith("ADD") && bt.length < 8);
        });
        const hasNoData = /NO DATA AVAILABLE|NO CLASS RESULTS|USE THE FILTERS ABOVE/i.test(textOf(node));
        const cls = String(node.className || "");
        const looksCard =
          node.matches?.("section, main, .v-card, .card, .panel") || /card|panel|section|rounded/i.test(cls);
        if (hasPag || (hasAdd && (looksCard || hasNoData)) || (looksCard && hasNoData)) return node;
        node = node.parentElement;
      }
      return (
        el.closest("section, main, .v-card, .card, .panel, .box, .container") ||
        el.parentElement?.parentElement ||
        el.parentElement ||
        document.body
      );
    }
    return document.body;
  }

  function isActiveEnlistmentTable(table) {
    const blob = norm(textOf(table));
    return (
      blob.includes("FINALIZED") ||
      blob.includes("ENLISTMENT CAN'T") ||
      blob.includes("ENLISTMENT CANT") ||
      (blob.includes("STATUS/ACTION") && !blob.includes("INSTRUCTOR") && !blob.includes("FACULTY"))
    );
  }

  function findSearchTable() {
    const scope = searchClassScope();
    const scoped = [...(scope.querySelectorAll?.("table") || [])].filter(visible);
    const worldwide = [...document.querySelectorAll("table")].filter(visible);
    const tables = scoped.length ? scoped : worldwide;

    let best = null;
    let bestScore = 0;
    for (const t of tables) {
      if (isActiveEnlistmentTable(t)) continue;
      const head = headerRowText(t);
      const body = norm(textOf(t));
      const score =
        (head.includes("CODE") ? 3 : 0) +
        (head.includes("CLASS DETAILS") ? 4 : head.includes("CLASS") ? 2 : 0) +
        (head.includes("INSTRUCTOR") || head.includes("FACULTY") ? 4 : 0) +
        (head.includes("SECTION") ? 2 : 0) +
        (head.includes("SCHEDULE") ? 2 : 0) +
        (head.includes("DETAILS") ? 1 : 0) +
        (head.includes("ACTION") && !head.includes("STATUS/ACTION") ? 1 : 0) +
        (/FACULTY\s*:/i.test(body) ? 5 : 0) +
        (/INACTIVE TERM/i.test(body) ? 2 : 0);
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return bestScore >= 3 ? best : null;
  }

  function headerRowText(table) {
    const row = headerRow(table);
    return norm(textOf(row));
  }

  function headerRow(table) {
    const thead = table.querySelector("thead tr");
    if (thead && /CODE|CLASS|ACTION|DETAILS|SECTION|INSTRUCTOR/i.test(textOf(thead))) return thead;
    for (const row of table.rows || []) {
      const t = norm(textOf(row));
      if (/CODE|CLASS DETAILS|INSTRUCTOR|SECTION/.test(t) && !/FACULTY\s*:/.test(t)) return row;
    }
    return thead || table.rows?.[0] || null;
  }

  /** Map header text to column indexes so column order changes don't break us. */
  function headerMap(table) {
    const headRow = headerRow(table);
    const cells = [...(headRow?.cells || [])].map((c) => norm(textOf(c)));
    const find = (...keys) => cells.findIndex((c) => keys.some((k) => c.includes(k)));
    return {
      cells,
      section: find("SECTION"),
      details: find("CLASS DETAILS", "DETAILS"),
      code: find("CODE", "COURSE", "SUBJECT"),
      instructor: find("INSTRUCTOR", "FACULTY", "PROFESSOR", "TEACHER"),
      schedule: find("SCHEDULE", "TIME", "DAY"),
      room: find("ROOM", "VENUE", "LOCATION"),
    };
  }

  /**
   * Is this row's course code the one we asked for?
   *
   * Prefix matching allows `PI 10-1` to match `PI 10`, while the digit guard
   * keeps `PI 100` from matching it.
   */
  function codeMatches(rowCode, wantCode) {
    const a = norm(rowCode).replace(/\s+/g, "");
    const b = norm(wantCode).replace(/\s+/g, "");
    if (!a || !b) return true;
    if (a === b) return true;
    if (a.startsWith(b)) return !/[0-9]/.test(a[b.length] || "");
    return false;
  }

  function courseMatchesText(text, courseCode) {
    const flat = norm(text).replace(/\s+/g, "");
    const want = norm(courseCode).replace(/\s+/g, "");
    if (!want) return true;
    const idx = flat.indexOf(want);
    if (idx < 0) return false;
    const before = flat[idx - 1] || "";
    const after = flat[idx + want.length] || "";
    if (/[A-Z]/.test(before)) return false;
    if (/[0-9]/.test(after)) return false;
    return true;
  }

  /** Search Class cards print `B - (08:30 AM - 10:00 AM)`. */
  function extractSectionFromText(text) {
    const s = String(text || "");
    const patterns = [
      /(?:^|\n|\s)([A-Za-z0-9][A-Za-z0-9-]{0,11})\s*[-–]\s*\(\s*\d{1,2}:\d{2}/,
      /\bSection\s*[-:]?\s*([A-Z0-9-]{1,12})\b/i,
      /\b[A-Z]{2,}(?:\s+\d+[A-Z]*)?\s*[-–]\s*([A-Z0-9-]{1,12})\b/,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return norm(m[1]);
    }
    return "";
  }

  function extractInstructorFromText(text) {
    const raw = String(text || "");
    const labeled = raw.match(
      /(?:INSTRUCTORS?|FACULTY|PROFESSORS?|TEACHERS?|LECTURERS?)\s*[:\-]\s*([^\n|;]+)/i
    );
    if (labeled) {
      const name = labeled[1].replace(/\s+/g, " ").trim();
      if (name && !/^requires\b/i.test(name)) return name;
    }
    const comma = raw.match(
      /\b([A-Z][A-Z'`\-]+(?:\s+(?:DE|DEL|DELA|VAN|SAN|SANTA|DA|DI|DOS|DAS)\s+)?[A-Z][A-Z'`\-]*)\s*,\s*([A-Z][A-Za-z'`\-]+(?:\s+[A-Z]\.?(?![A-Za-z])){0,3})/
    );
    if (comma) {
      const surname = comma[1];
      const given = comma[2].replace(/\s+/g, " ").trim();
      if (!/^(MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/i.test(surname)) {
        if (!/^(OPEN|CLOSED|ADD|TBA)$/i.test(given)) return `${surname}, ${given}`;
      }
    }
    if (/\bTBA\b/i.test(raw) && /instructor|faculty|professor/i.test(raw)) return "TBA";
    return "";
  }

  function extractRoomFromText(text) {
    const m = String(text || "").match(/Location\s*:\s*([^\n|;]+)/i);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  }

  function scrapeTable(courseCode, term) {
    const table = findSearchTable();
    if (!table) return { records: [], error: "table_not_found" };
    const map = headerMap(table);
    const fromBodies = table.tBodies?.length
      ? [...table.tBodies].flatMap((tb) => [...tb.rows])
      : [...table.querySelectorAll("tbody tr")];
    const bodyRows = fromBodies.length
      ? fromBodies
      : [...(table.rows || [])].filter((r) => r !== headerRow(table));
    const records = [];
    let skipped = 0;

    for (const tr of bodyRows) {
      if (tr === headerRow(table)) continue;
      const cells = [...(tr.cells || [])].map((c) => textOf(c).trim());
      if (!cells.length) continue;
      const details = map.details >= 0 ? cells[map.details] : "";
      const rowText = [details, ...cells].filter(Boolean).join(" | ");
      if (/NO DATA|NO CLASS/.test(norm(rowText))) continue;

      // The filter form may have been ignored, in which case the table still
      // holds every subject. Trusting it would file other courses' sections
      // under this one.
      if (map.code >= 0 && !codeMatches(cells[map.code], courseCode)) {
        skipped += 1;
        continue;
      }
      if (map.code < 0 && courseCode && !courseMatchesText(rowText, courseCode)) {
        skipped += 1;
        continue;
      }

      let section =
        extractSectionFromText(details) ||
        extractSectionFromText(rowText) ||
        extractSectionFromText(map.section >= 0 ? cells[map.section] : "") ||
        (map.section >= 0 ? norm(cells[map.section]).split(" ").pop() : "");

      let instructor = map.instructor >= 0 ? cells[map.instructor].trim() : "";
      if (!instructor) instructor = extractInstructorFromText(details) || extractInstructorFromText(rowText);

      const scheduleText = details || (map.schedule >= 0 ? cells[map.schedule] : rowText);
      const parsed = parseScheduleText(scheduleText) || {};
      const room =
        (map.room >= 0 ? cells[map.room] : "") || extractRoomFromText(details || rowText) || parsed.room || "";

      if (!section) continue;
      records.push({
        term,
        courseCode,
        section,
        instructor,
        days: parsed.days || "",
        timeStart: parsed.timeStart || "",
        timeEnd: parsed.timeEnd || "",
        room,
        status: /CLOSED/i.test(rowText) ? "Closed" : /OPEN/i.test(rowText) ? "Open" : "",
        source: "dom",
      });
    }
    return { records, headerCells: map.cells, skipped, scannedRows: bodyRows.length };
  }

  async function applyCourseFilter(courseCode) {
    const open = findOpenFilterButton();
    if (open) {
      open.click();
      await waitUntil(() => !!findInputNearLabel("Course Code") || !!findButton("APPLY FILTER"), 2000, 40);
    }

    // Only the Course Code field. The old fallback typed into the first visible
    // input, which on Enrollment is the top term box — that wiped 1261 with
    // "ARTS 1" and produced a genuine empty catalogue.
    let input = findInputNearLabel("Course Code");
    if (!input) {
      const dialog = document.querySelector(
        ".v-dialog--active, .v-dialog__content--active, [role='dialog'], .modal.show"
      );
      const scope = dialog && visible(dialog) ? dialog : document;
      input = [...scope.querySelectorAll("input")].find((el) => {
        if (!visible(el)) return false;
        if (looksLikeTermField(el)) return false;
        const meta = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`;
        return /course|subject/i.test(meta);
      });
    }
    if (input) setNativeValue(input, courseCode);

    const apply = findButton("APPLY FILTER") || findButton("APPLY");
    if (apply && !/SEARCH CLASS/.test(clickLabel(apply))) {
      apply.click();
      await waitForOfferings(courseCode, 2800);
    }
    return { ok: !!input, filtered: !!apply, opened: !!open };
  }

  function searchAreaShowsNoData() {
    const t = norm(textOf(searchClassScope()));
    const short = t.length > 4000 ? t.slice(0, 4000) : t;
    return (
      short.includes("NO DATA AVAILABLE") ||
      short.includes("NO CLASS RESULTS") ||
      short.includes("USE THE FILTERS ABOVE TO SEARCH")
    );
  }

  function recordFromRowText(courseCode, term, rowText, extra = {}) {
    if (!courseMatchesText(rowText, courseCode) && extra.requireCourse !== false) return null;
    const section = extra.section || extractSectionFromText(rowText);
    if (!section) return null;
    const parsed = parseScheduleText(rowText) || {};
    return {
      term,
      courseCode,
      section,
      instructor: extra.instructor || extractInstructorFromText(rowText),
      days: parsed.days || "",
      timeStart: parsed.timeStart || "",
      timeEnd: parsed.timeEnd || "",
      room: extra.room || extractRoomFromText(rowText) || parsed.room || "",
      status: /CLOSED/i.test(rowText) ? "Closed" : /OPEN/i.test(rowText) ? "Open" : "",
      source: "dom",
    };
  }

  function scrapeCards(courseCode, term) {
    const scope = searchClassScope();
    const records = [];
    const seen = new Set();

    const pushFrom = (el) => {
      if (!el || seen.has(el) || !visible(el)) return;
      const rowText = textOf(el);
      if (!rowText || /NO DATA|NO CLASS/.test(norm(rowText))) return;
      const rec = recordFromRowText(courseCode, term, rowText);
      if (!rec) return;
      seen.add(el);
      records.push(rec);
    };

    for (const bold of scope.querySelectorAll?.("div.font-bold, .font-bold, strong") || []) {
      if (!visible(bold)) continue;
      if (!/[-–]\s*\(\s*\d{1,2}:\d{2}/.test(textOf(bold))) continue;
      let card = bold.parentElement;
      for (let d = 0; d < 8 && card; d += 1) {
        if (courseMatchesText(textOf(card), courseCode) || /ADD|CLASS DETAILS/i.test(textOf(card))) break;
        card = card.parentElement;
      }
      pushFrom(card || bold.parentElement);
    }

    for (const btn of scope.querySelectorAll?.("button, .v-btn, a, [role='button']") || []) {
      if (!visible(btn)) continue;
      const bt = clickLabel(btn);
      if (bt !== "ADD" && !(bt.startsWith("ADD") && bt.length < 8)) continue;
      if (bt.includes("ENLIST")) continue;
      let row = btn.closest("tr, li, .v-data-table__tr, div.rounded-md, div.border, div[class*='rounded']");
      let walk = btn.parentElement;
      for (let d = 0; d < 8 && walk; d += 1) {
        if (walk.querySelector?.("div.font-bold, .font-bold") && courseMatchesText(textOf(walk), courseCode)) {
          row = walk;
          break;
        }
        walk = walk.parentElement;
      }
      pushFrom(row);
    }

    return records;
  }

  async function expandClassDetails() {
    const scope = searchClassScope();
    const buttons = [...(scope.querySelectorAll?.("button, a, [role='button'], .v-btn") || [])].filter((el) => {
      if (!visible(el)) return false;
      const t = clickLabel(el);
      return t.includes("CLASS DETAILS") || t === "DETAILS" || t === "VIEW";
    });
    for (const btn of buttons.slice(0, 8)) {
      const row = btn.closest("tr, li, .v-data-table__tr") || btn.parentElement;
      if (row && /FACULTY\s*:/i.test(textOf(row))) continue;
      btn.click();
    }
  }

  function findSearchPaginationList() {
    const scope = searchClassScope();
    const candidates = [];
    const push = (el) => {
      if (el && visible(el) && !candidates.includes(el)) candidates.push(el);
    };
    const sels = [
      "ul.vs-pagination",
      "ul.v-pagination",
      ".v-pagination",
      "nav[aria-label='Pagination Navigation']",
    ];
    for (const sel of sels) {
      scope.querySelectorAll?.(sel).forEach(push);
      document.querySelectorAll(sel).forEach(push);
    }
    return (
      candidates.find((el) => /Goto Page|Next Page|v-pagination/i.test(el.className + (el.innerHTML || ""))) ||
      candidates[0] ||
      null
    );
  }

  function currentPageNumber(list) {
    if (!list) return 0;
    const active = list.querySelector(
      ".vs-pagination--active, .v-pagination__item--active, [aria-current='true'], [aria-current='page']"
    );
    const n = Number(textOf(active).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function paginationNumbers(list) {
    if (!list) return [];
    const nums = [];
    for (const a of list.querySelectorAll("a, button, [role='button'], li")) {
      const label = textOf(a).trim();
      const n = Number(label);
      if (Number.isFinite(n) && n > 0 && n < 80) nums.push(n);
      const aria = String(a.getAttribute("aria-label") || "");
      const goto = aria.match(/(?:goto\s*)?page\s*(\d+)/i);
      if (goto) nums.push(Number(goto[1]));
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  }

  function paginationNext(list) {
    if (!list) return null;
    const current = currentPageNumber(list);
    if (current) {
      const want = current + 1;
      for (const a of list.querySelectorAll("a, button, [role='button']")) {
        const aria = String(a.getAttribute("aria-label") || "");
        const goto = aria.match(/goto\s*page\s*(\d+)/i);
        const label = textOf(a).trim();
        if ((goto && Number(goto[1]) === want) || label === String(want)) {
          if (a.getAttribute("aria-disabled") === "true") return null;
          return a;
        }
      }
    }
    for (const a of list.querySelectorAll("a, button, [role='button']")) {
      const aria = norm(a.getAttribute("aria-label") || "");
      const disabled =
        a.getAttribute("aria-disabled") === "true" ||
        a.hasAttribute("disabled") ||
        /disabled/i.test(a.className || "");
      if (disabled) continue;
      if (aria === "NEXT PAGE" || aria.startsWith("NEXT PAGE") || aria === "NEXT") return a;
    }
    return null;
  }

  async function scrapeAllSearchPages(courseCode, term) {
    const merged = new Map();
    let pages = 0;
    let headerCells = [];
    let skipped = 0;
    let rowsSeen = 0;
    let exhausted = false;

    for (let page = 0; page < 24; page += 1) {
      await expandClassDetails();
      const tabled = scrapeTable(courseCode, term);
      if (!tabled.error) {
        headerCells = tabled.headerCells || headerCells;
        skipped += tabled.skipped || 0;
        rowsSeen += tabled.scannedRows || 0;
        for (const rec of tabled.records) merged.set(rec.section, rec);
      }
      for (const rec of scrapeCards(courseCode, term)) {
        const prior = merged.get(rec.section);
        if (!prior || (!prior.instructor && rec.instructor)) merged.set(rec.section, rec);
      }
      pages += 1;

      const list = findSearchPaginationList();
      const nums = paginationNumbers(list);
      const lastHint = nums.length ? nums[nums.length - 1] : 0;
      const current = currentPageNumber(list);
      const next = paginationNext(list);
      if (!next || (current && lastHint && current >= lastHint)) {
        exhausted = true;
        break;
      }
      const before = pageFingerprint();
      const pageBefore = current;
      next.click();
      let moved = await waitUntil(
        () => pageFingerprint() !== before || currentPageNumber(findSearchPaginationList()) !== pageBefore,
        1400,
        40
      );
      if (!moved) {
        next.click();
        moved = await waitUntil(
          () => pageFingerprint() !== before || currentPageNumber(findSearchPaginationList()) !== pageBefore,
          900,
          40
        );
      }
      if (!moved) break;
      await waitForOfferings(courseCode, 1600);
    }

    const records = [...merged.values()];
    return {
      records,
      headerCells,
      skipped,
      scannedRows: rowsSeen,
      pages,
      exhausted,
      noData: !records.length && searchAreaShowsNoData(),
    };
  }

  async function scanTermViaDom(courseCode, term) {
    let picked = { ok: false };
    for (let i = 0; i < 3 && !picked.ok; i += 1) {
      picked = await selectTerm(term, { settleMs: 2000 + i * 400 });
      if (!picked.ok) await sleep(200);
    }
    if (!picked.ok) return { ok: false, error: picked.error, records: [], observed: picked.observed };

    await waitUntil(() => showingTerm(String(term)), 2000, 40);
    if (!showingTerm(String(term))) {
      picked = await selectTerm(term, { settleMs: 2600 });
      if (!picked.ok) return { ok: false, error: picked.error, records: [], observed: picked.observed };
    }
    const filter = await applyCourseFilter(courseCode);
    if (!offeringsReady(courseCode)) await waitForOfferings(courseCode, 2800);

    let scraped = await scrapeAllSearchPages(courseCode, term);
    if ((!scraped.records.length || (!scraped.exhausted && scraped.records.length <= 5)) && !scraped.noData) {
      await waitForOfferings(courseCode, 1600);
      const again = await scrapeAllSearchPages(courseCode, term);
      if (again.records.length >= scraped.records.length) scraped = again;
    }

    if (!scraped.records.length && scraped.noData) {
      return {
        ok: true,
        records: [],
        fieldReport: {
          source: "dom",
          count: 0,
          pages: scraped.pages,
          exhausted: true,
          termVerified: true,
          termVia: picked.via,
          filtered: filter.filtered,
          note: "Search Class says no data for this filter",
        },
      };
    }

    if (!scraped.records.length && !findSearchTable() && !scraped.pages) {
      return {
        ok: false,
        error: filter.opened || filter.ok
          ? "Search Class rendered no offerings — stay on Student → Enrollment so both Active Enlistment and Search Class are visible"
          : "Open Filter/Search was not found. Open Student → Enrollment first.",
        records: [],
      };
    }

    return {
      ok: true,
      records: scraped.records,
      fieldReport: {
        source: "dom",
        headerCells: scraped.headerCells,
        count: scraped.records.length,
        rowsSeen: scraped.scannedRows,
        rowsSkipped: scraped.skipped,
        pages: scraped.pages,
        exhausted: !!scraped.exhausted,
        termVerified: true,
        termVia: picked.via,
        filtered: filter.filtered,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * API recipe (which endpoint and parameter names this deployment uses)
   * ------------------------------------------------------------------ */

  const RECIPE_KEY = "pd_api_recipe";

  async function loadRecipe() {
    try {
      const store = await chrome.storage.local.get(RECIPE_KEY);
      const saved = store?.[RECIPE_KEY];
      return saved?.path ? saved : null;
    } catch (_) {
      return null;
    }
  }

  async function saveRecipe(recipe) {
    try {
      await chrome.storage.local.set({ [RECIPE_KEY]: recipe });
    } catch (_) {
      /* caching is an optimisation, not a requirement */
    }
  }

  async function clearRecipe() {
    try {
      await chrome.storage.local.remove(RECIPE_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  /** Reuse the cached endpoint recipe, or ask the bridge to find one. */
  async function resolveRecipe({ courseCode, termId, force = false, onProgress = () => {} }) {
    if (!force) {
      const cached = await loadRecipe();
      if (cached) return { ok: true, recipe: cached, cached: true };
    }

    onProgress({ status: "discovering", term: termId });
    const res = await bridgeCall("DISCOVER", { courseCode, termId }, 180000);
    if (res.ok && res.recipe) {
      await saveRecipe(res.recipe);
      onProgress({ status: "discovered", recipe: res.recipe, attempts: res.attempts });
      return { ok: true, recipe: res.recipe, attempts: res.attempts };
    }

    await clearRecipe();
    const tried = (res.attempts || []).filter((a) => a.stage === "path").length;
    return {
      ok: false,
      error: res.error || "no_endpoint",
      attempts: res.attempts || [],
      message:
        res.error === "no_endpoint" || !res.error
          ? `Could not find the AMIS class-listing endpoint (tried ${tried || "several"} paths). Open the class offerings / Search Class view on AMIS so the page loads its own class list, then run this again — Profdictor copies whatever request the page makes. Use Diagnose for the details.`
          : `Endpoint discovery failed: ${res.error}`,
    };
  }

  async function fetchViaApi(courseCode, term, recipe) {
    const res = await bridgeCall("FETCH_TERM", { courseCode, termId: term, recipe });
    if (!res.ok) return { ok: false, error: res.error || "api_failed", records: [] };
    if (res.termHonoured === false) {
      return {
        ok: false,
        error: `AMIS ignored the term filter and returned other semesters — refusing these rows`,
        records: [],
      };
    }
    const { records, fieldReport } = extractRecords(res.classes, courseCode, term, "api");
    return { ok: true, records, fieldReport, endpoint: res.endpoint, pages: res.pages };
  }

  /* ------------------------------------------------------------------ *
   * Diagnostics
   * ------------------------------------------------------------------ */

  /**
   * Everything needed to work out why a scan found nothing, in one object.
   * Surfaced by the panel's Diagnose button because the failure modes live on the
   * user's authenticated AMIS session, where they cannot be reproduced.
   */
  async function diagnose({ courseCode = "", termId = null } = {}) {
    const out = { at: new Date().toISOString(), href: location.href, courseCode, termId };

    out.bridge = await bridgeCall("PING", null, 2500);
    out.cachedRecipe = await loadRecipe();

    const table = findSearchTable();
    const scope = searchClassScope();
    out.dom = {
      onEnrollment: /\/student\/enrollment/i.test(location.href),
      hasSearchClassHeading: headingExact
        ? [...document.querySelectorAll("h1,h2,h3,h4,h5,div,span")].some((el) => headingExact(el, "Search Class"))
        : false,
      openFilter: !!findOpenFilterButton(),
      termInputs: [...document.querySelectorAll("input")].filter(looksLikeTermField).map((el) => ({
        value: el.value,
        name: el.name || el.id || "",
        top: Math.round(el.getBoundingClientRect().top),
      })),
      selects: [...document.querySelectorAll("select")].map((s) => ({
        name: s.name || s.id || "",
        visible: visible(s),
        value: s.value,
        options: [...s.options].slice(0, 30).map((o) => `${o.value} :: ${(o.textContent || "").trim()}`),
      })),
      selectedTermTexts: selectedTermTexts().slice(0, 10),
      observedTermLabels: observedTermLabels().slice(0, 20),
      table: table
        ? { headerCells: headerMap(table).cells, bodyRows: table.querySelectorAll("tbody tr").length }
        : null,
      searchClassPreview: textOf(scope).replace(/\s+/g, " ").trim().slice(0, 240),
      noData: searchAreaShowsNoData(),
      buttons: [...document.querySelectorAll("button, .v-btn")]
        .filter(visible)
        .map((b) => textOf(b).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 25),
    };

    out.dom.termControl = textOf(findTermControl()).replace(/\s+/g, " ").trim().slice(0, 80);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Orchestration
   * ------------------------------------------------------------------ */

  /**
   * Scan a list of terms for one course, skipping anything already cached.
   * Requests are serialised and throttled - this is someone's university
   * server, and a burst of parallel requests would be both rude and suspicious.
   */
  async function scanTerms({
    courseCode,
    termList,
    mode = "dom",
    throttleMs = 80,
    force = false,
    forceTerms = [],
    onProgress = () => {},
  }) {
    const results = [];
    const todo = force
      ? [...termList]
      : await db.missingTerms(courseCode, termList, { forceTerms });
    const cached = termList.filter((t) => !todo.includes(t));

    const emitRows = (term, records, source) => {
      for (const rec of records || []) {
        onProgress({
          status: "row",
          term,
          section: rec.section,
          instructor: rec.instructor || rec.profKey || "TBA",
          source,
        });
      }
    };

    for (const term of cached) {
      results.push({ term, ok: true, cached: true });
      onProgress({ term, status: "cached", done: results.length, total: termList.length });
      const entry = await db.getTerm(courseCode, term);
      emitRows(term, entry?.records, "cache");
    }

    if (!todo.length) return { ok: true, results, scanned: 0, cached: cached.length };

    let bridgeOk = false;
    let recipe = null;
    if (mode === "api") {
      const p = await ping();
      bridgeOk = !!p.ok;
      if (!bridgeOk) {
        return {
          ok: false,
          error: "bridge_unavailable",
          message:
            "Could not reach the AMIS app context. Reload the AMIS enrollment page and try again, or switch scan mode to DOM.",
          results,
        };
      }

      if (bridgeOk) {
        // Probe against a term that certainly has data - the one the page is
        // already showing - so an empty past semester cannot be mistaken for a
        // wrong endpoint.
        const probeTerm = p.currentTerm || Math.max(...termList);
        const found = await resolveRecipe({ courseCode, termId: probeTerm, force, onProgress });
        if (!found.ok) {
          if (mode === "api") {
            return {
              ok: false,
              error: found.error,
              message: found.message,
              attempts: found.attempts,
              results,
            };
          }
          bridgeOk = false; // fall through to DOM in auto mode
          onProgress({ status: "fallback", reason: found.error });
        } else {
          recipe = found.recipe;
        }
      }
    }

    let apiReady = bridgeOk;
    let rediscovered = false;
    const ensureApi = async () => {
      if (apiReady) return true;
      const p = await ping();
      apiReady = !!p.ok;
      return apiReady;
    };

    const fetchTermApi = async (term) => {
      if (!(await ensureApi())) return { ok: false, error: "bridge_unavailable", records: [] };
      let outcome = await fetchViaApi(courseCode, term, recipe);
      if (!outcome.ok && !rediscovered) {
        rediscovered = true;
        const again = await resolveRecipe({
          courseCode,
          termId: term,
          force: !recipe,
          onProgress,
        });
        if (again.ok) {
          recipe = again.recipe;
          outcome = await fetchViaApi(courseCode, term, recipe);
        }
      }
      return outcome;
    };

    let scanned = 0;
    for (const term of todo) {
      onProgress({ term, status: "scanning", done: results.length, total: termList.length });

      let outcome;
      if (mode === "api" && bridgeOk) {
        outcome = await fetchTermApi(term);
      } else {
        outcome = await scanTermViaDom(courseCode, term);
        const emptyDom = outcome.ok && !outcome.records?.length;
        if (!outcome.ok || emptyDom) {
          onProgress({
            term,
            status: "fallback",
            via: "api",
            reason: outcome.error || "empty_dom",
          });
          const apiOutcome = await fetchTermApi(term);
          if (apiOutcome.ok && (apiOutcome.records?.length || !outcome.ok)) {
            outcome = apiOutcome;
          }
        }
      }

      if (outcome.ok && outcome.fieldReport?.skipped) {
        results.push({ term, ok: true, skipped: true, error: outcome.fieldReport.skipped });
        onProgress({
          term,
          status: "skipped",
          reason: outcome.fieldReport.note || outcome.fieldReport.skipped,
          done: results.length,
          total: termList.length,
        });
      } else if (outcome.ok) {
        if (terms.parse(term)?.semester === 3 && outcome.records?.length) {
          const prior = await db.getTerm(courseCode, Number(term) - 1);
          const asStored = (rows) => ({
            term,
            records: (rows || []).map((r) => db.normalizeRecord(r, courseCode, term)),
          });
          if (prior && db.looksCopiedFromPriorTerm(asStored(outcome.records), prior)) {
            await sleep(350);
            const retry = await scanTermViaDom(courseCode, term);
            if (
              retry.ok &&
              retry.records?.length &&
              !db.looksCopiedFromPriorTerm(asStored(retry.records), prior)
            ) {
              outcome = retry;
            }
          }
        }
        const source = outcome.fieldReport?.source || (mode === "api" ? "api" : "dom");
        emitRows(term, outcome.records, source);
        const saved = await db.putTerm(courseCode, term, outcome.records, {
          source,
          fieldReport: outcome.fieldReport,
        });
        scanned += 1;
        results.push({
          term,
          ok: true,
          total: saved.total,
          revealed: saved.revealed,
          fieldReport: outcome.fieldReport,
        });
        onProgress({
          term,
          status: "done",
          done: results.length,
          total: termList.length,
          revealed: saved.revealed,
          rows: saved.total,
        });
      } else {
        results.push({ term, ok: false, error: outcome.error });
        onProgress({ term, status: "error", error: outcome.error, done: results.length, total: termList.length });
      }

      if (throttleMs > 0) await sleep(throttleMs);
    }

    return { ok: true, results, scanned, cached: cached.length, recipe };
  }

  PD.scanner = {
    injectBridge,
    bridgeCall,
    ping,
    extractRecords,
    parseScheduleText,
    resolveName,
    composeName,
    deepFind,
    scanTerms,
    scanTermViaDom,
    selectTerm,
    matchesTerm,
    codeMatches,
    courseMatchesText,
    extractSectionFromText,
    extractInstructorFromText,
    extractRoomFromText,
    observedTermLabels,
    scrapeTable,
    offeringsReady,
    tableHasSectionCards,
    findSearchTable,
    headerMap,
    diagnose,
    resolveRecipe,
    clearRecipe,
  };
})();
