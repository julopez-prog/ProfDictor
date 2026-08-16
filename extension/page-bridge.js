/**
 * Profdictor page bridge.
 *
 * Runs in the PAGE context (not the extension's isolated world) so it can borrow
 * the AMIS Nuxt app's own axios instance, and with it the session, base URL and
 * interceptors. Content scripts cannot reach `window.$nuxt`, hence this file.
 *
 * The endpoint that lists offerings is not documented and differs between AMIS
 * deployments, so this bridge does not hard-code one. It finds it three ways, in
 * order of trust:
 *
 *   1. LEARNED  - a passive recorder wraps fetch/XHR before the Nuxt app boots
 *      and remembers the request the app itself makes to list classes. Replaying
 *      that with a different term value is exact by construction.
 *   2. PROBED   - if nothing was recorded (the app cached its data, or the
 *      module is closed), try a small matrix of paths and parameter names and
 *      keep whichever actually returns rows.
 *   3. DEFAULT  - the shape we know from the current deployment.
 *
 * The winning recipe is handed back to the content script, which caches it, so
 * discovery happens once rather than once per term.
 *
 * This bridge only ever issues GETs. It cannot enlist, bookmark or modify
 * anything, by construction.
 */
(() => {
  if (window.__PROFDICTOR_BRIDGE__) return;
  window.__PROFDICTOR_BRIDGE__ = true;

  const REQ = "PROFDICTOR_REQ";
  const RES = "PROFDICTOR_RES";
  const DEFAULT_BASE = "https://api-amis.uplb.edu.ph/api";
  const MAX_PAGES = 25;
  const MAX_RECORDED = 80;

  /* ------------------------------------------------------------------ *
   * Passive request recorder
   *
   * Installed as early as the content script can inject us. Never throws into
   * the host app: every hook falls through to the original implementation.
   * ------------------------------------------------------------------ */

  const recorded = [];
  const CLASSY_URL = /class|offer|section|subject|course|enlist|schedule/i;

  function paramsOf(url) {
    try {
      const u = new URL(url, location.origin);
      return Object.fromEntries(u.searchParams.entries());
    } catch (_) {
      return {};
    }
  }

  function remember(entry) {
    recorded.push(entry);
    while (recorded.length > MAX_RECORDED) recorded.shift();
  }

  function noteResponse(entry, text) {
    if (!text) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return;
    }
    const list = findRecordArray(data);
    entry.count = list.length;
    entry.rowKeys = list.length && isObj(list[0]) ? Object.keys(list[0]).slice(0, 40) : [];
    entry.looksLikeClasses = list.length > 0 && !!(codeOf(list[0]) || sectionOf(list[0]));
    if (entry.looksLikeClasses) entry.sample = trimForTransport(list[0]);
  }

  function installRecorder() {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (...args) {
        const promise = origFetch.apply(this, args);
        try {
          const input = args[0];
          const url = typeof input === "string" ? input : input?.url || "";
          const method = (args[1]?.method || input?.method || "GET").toUpperCase();
          if (url && /\/api\//.test(url)) {
            const entry = { via: "fetch", method, url, params: paramsOf(url), at: Date.now() };
            remember(entry);
            promise
              .then((res) => {
                entry.status = res.status;
                if (!CLASSY_URL.test(url)) return null;
                return res
                  .clone()
                  .text()
                  .then((text) => noteResponse(entry, text))
                  .catch(() => null);
              })
              .catch(() => null);
          }
        } catch (_) {
          /* recording must never break the page */
        }
        return promise;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR?.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__pdMethod = String(method || "GET").toUpperCase();
          this.__pdUrl = String(url || "");
        } catch (_) {
          /* ignore */
        }
        return origOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.send = function (...args) {
        try {
          const url = this.__pdUrl || "";
          if (url && /\/api\//.test(url)) {
            const entry = {
              via: "xhr",
              method: this.__pdMethod || "GET",
              url,
              params: paramsOf(url),
              at: Date.now(),
            };
            remember(entry);
            this.addEventListener("load", () => {
              try {
                entry.status = this.status;
                if (CLASSY_URL.test(url) && typeof this.responseText === "string") {
                  noteResponse(entry, this.responseText);
                }
              } catch (_) {
                /* ignore */
              }
            });
          }
        } catch (_) {
          /* ignore */
        }
        return origSend.apply(this, args);
      };
    }
  }

  installRecorder();

  /* ------------------------------------------------------------------ *
   * Generic JSON shape handling
   * ------------------------------------------------------------------ */

  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

  const CODE_KEY = /^(course_code|subject_code|course_number|course_no|code|course)$/i;
  const SECTION_KEY = /^(section|section_name|section_code|class_section|class_code)$/i;
  const TERM_KEY = /^(term_id|term|termid|academic_term_id|semester_id|sem_id)$/i;

  function shallowValue(row, keyRe, depth = 0) {
    if (!isObj(row) || depth > 2) return "";
    for (const [k, v] of Object.entries(row)) {
      if (keyRe.test(k)) {
        if (typeof v === "string" || typeof v === "number") return String(v).trim();
        if (isObj(v)) {
          const nested = v.code ?? v.name ?? v.label ?? v.id;
          if (nested != null) return String(nested).trim();
        }
      }
    }
    for (const v of Object.values(row)) {
      if (isObj(v)) {
        const hit = shallowValue(v, keyRe, depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  }

  const codeOf = (row) => shallowValue(row, CODE_KEY);
  const sectionOf = (row) => shallowValue(row, SECTION_KEY);
  const termOf = (row) => shallowValue(row, TERM_KEY);

  /**
   * Breadth-first hunt for the array of offerings.
   *
   * Fixed paths like `data.classes.data` break the moment a deployment nests
   * things differently, and that is exactly the failure this bridge exists to
   * survive. Prefer an array whose first element looks like a class row; fall
   * back to the largest array of objects.
   */
  function findRecordArray(data) {
    if (Array.isArray(data) && (!data.length || isObj(data[0]))) {
      if (!data.length || codeOf(data[0]) || sectionOf(data[0])) return data;
    }
    const queue = [{ node: data, depth: 0 }];
    let fallback = [];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (depth > 5 || !node || typeof node !== "object") continue;
      for (const value of Array.isArray(node) ? node : Object.values(node)) {
        if (Array.isArray(value) && value.length && isObj(value[0])) {
          if (codeOf(value[0]) || sectionOf(value[0])) return value;
          if (value.length > fallback.length) fallback = value;
        }
        if (value && typeof value === "object") queue.push({ node: value, depth: depth + 1 });
      }
    }
    return fallback;
  }

  function pageInfo(data) {
    const found = { lastPage: 0, currentPage: 1, total: 0 };
    const queue = [{ node: data, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!isObj(node) || depth > 4) continue;
      for (const [k, v] of Object.entries(node)) {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          if (v && typeof v === "object") queue.push({ node: v, depth: depth + 1 });
          continue;
        }
        if (/^(last_page|lastPage|total_pages|totalPages|pageCount)$/.test(k) && !found.lastPage) {
          found.lastPage = n;
        }
        if (/^(current_page|currentPage|page)$/.test(k)) found.currentPage = n;
        if (/^(total|total_count|totalCount|totalRecords)$/.test(k) && !found.total) found.total = n;
      }
    }
    return found;
  }

  /** Keep diagnostics small enough to postMessage comfortably. */
  function trimForTransport(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    if (typeof value !== "object") return value;
    if (depth > 3) return "…";
    if (Array.isArray(value)) return value.slice(0, 3).map((v) => trimForTransport(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = trimForTransport(v, depth + 1);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */

  function getCookie(name) {
    const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1");
    const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function xsrfHeader() {
    const token = getCookie("XSRF-TOKEN");
    return token ? { "X-XSRF-TOKEN": token } : {};
  }

  function axiosBase() {
    try {
      const axios = window.$nuxt?.$axios;
      const base = axios?.defaults?.baseURL;
      return typeof base === "string" && base ? base.replace(/\/$/, "") : "";
    } catch (_) {
      return "";
    }
  }

  /**
   * GET a path, preferring the app's axios (correct base URL, auth headers and
   * interceptors) and falling back to a direct credentialed fetch.
   *
   * Returns `{ ok, status, data, error }` rather than throwing: probing needs to
   * read failures as data, not as exceptions.
   */
  async function apiGet(path, params, base) {
    const clean = String(path).replace(/^\//, "");
    const absolute = /^https?:\/\//i.test(clean);

    // Only borrow axios when its base URL is the one this recipe expects,
    // otherwise the relative path would resolve against the wrong host.
    const axiosUsable = !absolute && (!base || base.replace(/\/$/, "") === axiosBase());
    if (axiosUsable) {
      try {
        const axios = window.$nuxt?.$axios;
        if (axios?.$get) {
          const data = await axios.$get(clean, { params });
          return { ok: true, status: 200, data, via: "axios" };
        }
      } catch (err) {
        const status = Number(err?.response?.status || 0);
        if (status) {
          return {
            ok: false,
            status,
            error: `${status} ${err?.response?.statusText || "request failed"}`,
            data: err?.response?.data ?? null,
            via: "axios",
          };
        }
        // status 0 means the request never really happened - retry with fetch.
      }
    }

    const root = absolute ? clean : `${(base || axiosBase() || DEFAULT_BASE).replace(/\/$/, "")}/${clean}`;
    let url;
    try {
      url = new URL(root, location.origin);
    } catch (_) {
      return { ok: false, status: 0, error: `bad url: ${root}`, via: "fetch" };
    }
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });

    let res;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...xsrfHeader(),
        },
      });
    } catch (err) {
      return { ok: false, status: 0, error: `network: ${String(err?.message || err)}`, via: "fetch" };
    }

    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { raw: text.slice(0, 400) };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `${res.status} ${data?.message || res.statusText || "request failed"}`,
        data,
        via: "fetch",
      };
    }
    return { ok: true, status: res.status, data, via: "fetch", url: url.toString() };
  }

  /* ------------------------------------------------------------------ *
   * Recipes
   * ------------------------------------------------------------------ */

  const PATHS = [
    "students/classes",
    "classes",
    "student/classes",
    "students/class-offerings",
    "class-offerings",
    "enrollment/classes",
    "students/enlistment/classes",
    "offerings",
  ];
  const TERM_PARAMS = ["term_id", "term", "termId", "academic_term_id", "semester_id", "sem_id"];
  // A well-formed term code that no AMIS deployment can have offerings for: the
  // 9 in position two is outside the real 12XY range.
  const SENTINEL_TERM = 1991;
  const COURSE_PARAMS = ["course_code", "course", "subject_code", "code", "search", "keyword", "q"];

  const DEFAULT_RECIPE = {
    path: "students/classes",
    termParam: "term_id",
    courseParam: "course_code",
    pageParam: "page",
    perPageParam: "per_page",
    extra: {},
    via: "default",
  };

  /** Build the query for one request from a recipe. */
  function queryFor(recipe, { courseCode, termId, page, perPage }) {
    const params = { ...(recipe.extra || {}) };
    if (recipe.termParam && termId != null) params[recipe.termParam] = termId;
    if (recipe.courseParam && courseCode) params[recipe.courseParam] = courseCode;
    if (recipe.pageParam && page != null) params[recipe.pageParam] = page;
    if (recipe.perPageParam && perPage) params[recipe.perPageParam] = perPage;
    return params;
  }

  /**
   * Turn a recorded request into a recipe.
   *
   * We only trust an entry that actually returned class-shaped rows, and we
   * identify the term parameter by value (a 4-digit code) as well as by name,
   * because a deployment may call it something we have never seen.
   */
  const PAGE_KEY = /^(page|page_number|pageNumber|p)$/i;
  const PER_PAGE_KEY = /^(per_page|perPage|limit|page_size|pageSize|rows|size)$/i;
  const COURSE_VALUE = /^[A-Z]{2,12}\s*\d+[A-Z]*$/i;

  function learnRecipe(courseCode) {
    const hits = recorded.filter((e) => e.looksLikeClasses && (e.method || "GET") === "GET");
    if (!hits.length) return null;
    const entry = hits[hits.length - 1];

    let path = entry.url;
    let base = "";
    try {
      const u = new URL(entry.url, location.origin);
      const full = `${u.origin}${u.pathname}`;
      const axiosRoot = axiosBase();
      if (axiosRoot && full.startsWith(axiosRoot)) {
        base = axiosRoot;
        path = full.slice(axiosRoot.length).replace(/^\//, "");
      } else {
        // Split at the API root so the path stays relative. An absolute URL would
        // force a bare fetch and lose whatever Authorization header axios adds.
        const marker = full.indexOf("/api/");
        if (marker >= 0) {
          base = full.slice(0, marker + 4);
          path = full.slice(marker + 5);
        } else {
          path = full;
        }
      }
    } catch (_) {
      /* keep the raw url */
    }

    const params = Object.entries(entry.params || {});
    const wantCode = String(courseCode || "").toUpperCase().replace(/\s+/g, "");
    let termParam = "";
    let courseParam = "";
    let pageParam = "";
    let perPageParam = "";
    const unknown = [];

    // Names first. Matching on the value alone would happily mistake
    // `per_page=1000` for the term, since both are four digits.
    for (const [k, v] of params) {
      if (!pageParam && PAGE_KEY.test(k)) pageParam = k;
      else if (!perPageParam && PER_PAGE_KEY.test(k)) perPageParam = k;
      else if (!termParam && TERM_KEY.test(k)) termParam = k;
      else if (!courseParam && COURSE_PARAMS.includes(k)) courseParam = k;
      else unknown.push([k, v]);
    }

    // Then values, for parameters this deployment names in its own way.
    const extra = {};
    for (const [k, v] of unknown) {
      const value = String(v);
      const flat = value.toUpperCase().replace(/\s+/g, "");
      if (!termParam && /^\d{4}$/.test(value)) {
        termParam = k;
        continue;
      }
      if (!courseParam && ((wantCode && flat === wantCode) || COURSE_VALUE.test(value))) {
        courseParam = k;
        continue;
      }
      // Anything left is a genuine constant (status=Active and friends). A course
      // code left in here would be pinned into the cached recipe and silently
      // override every later search.
      extra[k] = v;
    }

    return {
      path,
      base,
      termParam: termParam || "term_id",
      courseParam,
      pageParam: pageParam || "page",
      perPageParam: perPageParam || "per_page",
      extra,
      via: "learned",
      learnedFrom: entry.url,
    };
  }

  /**
   * Verify a candidate recipe against one term.
   *
   * `honoursTerm` and `honoursCourse` matter: an API that silently ignores an
   * unknown parameter returns rows that look fine but belong to the wrong term,
   * which would poison the training set with future data. Better to know.
   */
  async function evaluate(recipe, { courseCode, termId }) {
    const params = queryFor(recipe, { courseCode, termId, page: 1, perPage: 50 });
    const res = await apiGet(recipe.path, params, recipe.base);
    if (!res.ok) return { recipe, ok: false, status: res.status, error: res.error, count: 0 };

    const list = findRecordArray(res.data);
    const rowTerms = [...new Set(list.map(termOf).filter(Boolean))];
    const rowCodes = list.map(codeOf).filter(Boolean);
    const wantCode = String(courseCode || "").toUpperCase().replace(/\s+/g, " ").trim();
    const matching = wantCode
      ? rowCodes.filter((c) => c.toUpperCase().replace(/\s+/g, " ").trim() === wantCode).length
      : 0;

    return {
      recipe,
      ok: true,
      status: res.status,
      count: list.length,
      classLike: !!list.length && !!(codeOf(list[0]) || sectionOf(list[0])),
      rowTerms,
      honoursTerm: !rowTerms.length || rowTerms.includes(String(termId)),
      honoursCourse: !wantCode || !rowCodes.length ? null : matching === rowCodes.length,
      matching,
      total: pageInfo(res.data).total,
      rowKeys: list.length && isObj(list[0]) ? Object.keys(list[0]) : [],
      sample: list.length ? trimForTransport(list[0]) : null,
    };
  }

  /**
   * Find a recipe that works, cheaply.
   *
   * Staged rather than a full cross product: first a path that answers at all,
   * then a term parameter it honours, then a course filter it honours. Roughly a
   * dozen requests worst case, once per browser session.
   */
  async function discover({ courseCode, termId }) {
    const attempts = [];
    const learned = learnRecipe(courseCode);

    if (learned) {
      const check = await evaluate(learned, { courseCode, termId });
      attempts.push({ stage: "learned", ...summarise(check) });
      if (check.ok && check.count) return { recipe: learned, attempts, evaluation: check };
      // Learned path is still the best guess for the path itself.
      if (check.ok) {
        const relaxed = { ...learned, courseParam: "", via: "learned-unfiltered" };
        const check2 = await evaluate(relaxed, { courseCode, termId });
        attempts.push({ stage: "learned-unfiltered", ...summarise(check2) });
        if (check2.ok && check2.count) return { recipe: relaxed, attempts, evaluation: check2 };
      }
    }

    // Stage 1: which path answers with class-shaped rows at all? Probed without
    // a term filter, because a path that needs a parameter name we have not
    // guessed yet would otherwise look dead.
    let basePath = "";
    for (const path of PATHS) {
      const bare = { ...DEFAULT_RECIPE, path, termParam: "", courseParam: "", via: "probe" };
      let check = await evaluate(bare, { courseCode: "", termId: null });
      attempts.push({ stage: "path", path, ...summarise(check) });
      // 200-but-empty or a validation complaint can both mean "needs a term".
      if ((check.ok && !check.count) || check.status === 422) {
        check = await evaluate({ ...DEFAULT_RECIPE, path, courseParam: "", via: "probe" }, { courseCode: "", termId });
        attempts.push({ stage: "path+term", path, ...summarise(check) });
      }
      if (check.ok && check.count && check.classLike) {
        basePath = path;
        break;
      }
    }
    if (!basePath) return { recipe: null, attempts, error: "no_endpoint" };

    // Stage 2: a term parameter the endpoint actually respects.
    let termParam = "";
    for (const param of TERM_PARAMS) {
      const candidate = { ...DEFAULT_RECIPE, path: basePath, termParam: param, courseParam: "", via: "probe" };

      // Ask for a term that cannot exist. Rows coming back anyway prove the
      // parameter was ignored - which is the failure that would quietly train
      // the model on the wrong semester.
      const sentinel = await evaluate(candidate, { courseCode: "", termId: SENTINEL_TERM });
      attempts.push({ stage: "term-sentinel", param, ...summarise(sentinel) });
      if (sentinel.ok && sentinel.count) continue;

      const real = await evaluate(candidate, { courseCode: "", termId });
      attempts.push({ stage: "term", param, ...summarise(real) });
      if (real.ok && real.count && real.honoursTerm) {
        termParam = param;
        break;
      }
    }
    // Nothing verifiable: trust the default name and let fetchTerm's
    // term-honoured guard refuse the rows if it turns out to be ignored.
    if (!termParam) termParam = DEFAULT_RECIPE.termParam;

    // Stage 3: a course filter, purely as an optimisation. Client-side filtering
    // is always correct, so an unfilterable endpoint is a slowdown, not a
    // failure.
    let courseParam = "";
    if (courseCode) {
      for (const param of COURSE_PARAMS) {
        const candidate = { ...DEFAULT_RECIPE, path: basePath, termParam, courseParam: param, via: "probe" };
        const check = await evaluate(candidate, { courseCode, termId });
        attempts.push({ stage: "course", param, ...summarise(check) });
        // Every row must match: a filter that is ignored still returns rows, some
        // of which happen to be the course we asked for.
        if (check.ok && check.count && check.honoursCourse === true) {
          courseParam = param;
          break;
        }
      }
    }

    const recipe = { ...DEFAULT_RECIPE, path: basePath, termParam, courseParam, via: "probe" };
    return { recipe, attempts };
  }

  function summarise(check) {
    return {
      ok: check.ok,
      status: check.status,
      count: check.count || 0,
      classLike: !!check.classLike,
      rowTerms: check.rowTerms || [],
      matching: check.matching || 0,
      honoursTerm: check.honoursTerm,
      honoursCourse: check.honoursCourse,
      error: check.error || "",
    };
  }

  /* ------------------------------------------------------------------ *
   * Term context
   * ------------------------------------------------------------------ */

  function currentTermId() {
    try {
      const store = window.$nuxt?.$store?.state;
      const candidates = [
        store?.enrollment?.term_id,
        store?.enrollment?.selectedTerm?.id,
        store?.enrollment?.selectedTerm,
        store?.enrollment?.term?.id,
        store?.auth?.user?.term_id,
      ];
      for (const c of candidates) {
        const n = Number(isObj(c) ? c.id ?? c.term_id : c);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (_) {
      /* fall through to DOM */
    }
    for (const el of document.querySelectorAll("select, .v-select, input")) {
      const t = (el.value || el.innerText || el.textContent || "").trim();
      const m = t.match(/\b(\d{4})\s*-\s*(First|Second|Mid)/i) || t.match(/^(\d{4})\b/);
      if (m) return Number(m[1]);
    }
    const m2 = (document.body?.innerText || "").match(/\b(\d{4})\s*-\s*(First|Second|Midyear|Mid-Year)/i);
    return m2 ? Number(m2[1]) : null;
  }

  function availableTerms() {
    const found = new Map();
    const push = (code, label) => {
      const n = Number(code);
      if (Number.isFinite(n) && n >= 1000 && n <= 9999 && !found.has(n)) found.set(n, label || String(n));
    };

    try {
      const store = window.$nuxt?.$store?.state;
      const lists = [
        store?.enrollment?.terms,
        store?.enrollment?.termList,
        store?.enrollment?.term_options,
        store?.reference?.terms,
      ];
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const t of list) push(t?.id ?? t?.term_id ?? t?.code ?? t?.value, t?.name ?? t?.label ?? t?.text);
      }
    } catch (_) {
      /* ignore */
    }

    for (const opt of document.querySelectorAll("option")) {
      const text = (opt.textContent || "").trim();
      const m = text.match(/\b(\d{4})\b/);
      if (m) push(m[1], text);
    }
    for (const m of (document.body?.innerText || "").matchAll(
      /\b(\d{4})\s*-\s*(First|Second|Midyear|Mid-Year)[^\n]*/gi
    )) {
      push(m[1], m[0].trim());
    }

    return [...found.entries()].map(([code, label]) => ({ code, label })).sort((a, b) => a.code - b.code);
  }

  /**
   * Drive Term * from the page's own Vue/Nuxt objects.
   *
   * Content-script clicks are not trusted events. Vuetify ignores them, the
   * dropdown never moves, and Profdictor used to skip the term — starving the
   * dataset. This runs in page context so it can call VSelect.selectItem and
   * commit the enrollment store the way the app itself does.
   */
  function termishText(value, wanted) {
    const raw = String(wanted);
    const upper = String(value || "")
      .toUpperCase()
      .replace(/\s+/g, " ");
    if (!upper) return false;
    if (new RegExp(`(^|[^0-9])${raw}([^0-9]|$)`).test(upper)) return true;
    return false;
  }

  function itemMatchesTerm(item, wanted) {
    if (item == null) return false;
    if (typeof item === "number" || typeof item === "string") {
      return String(item) === String(wanted) || termishText(item, wanted);
    }
    if (!isObj(item)) return false;
    const id = item.id ?? item.term_id ?? item.value ?? item.code ?? item.term;
    if (id != null && String(id) === String(wanted)) return true;
    return termishText(item.name ?? item.label ?? item.text ?? item.title ?? item.semester, wanted);
  }

  function itemValue(item, wanted) {
    if (item == null) return Number(wanted) || wanted;
    if (typeof item === "number" || typeof item === "string") return item;
    return item.id ?? item.term_id ?? item.value ?? item.code ?? item.term ?? item;
  }

  function walkVue(start) {
    const seen = new Set();
    const out = [];
    let el = start;
    for (let i = 0; i < 16 && el; i += 1) {
      const vm = el.__vue__;
      if (vm && !seen.has(vm)) {
        seen.add(vm);
        out.push(vm);
        let p = vm.$parent;
        while (p && !seen.has(p)) {
          seen.add(p);
          out.push(p);
          p = p.$parent;
        }
      }
      let c = el.__vueParentComponent;
      while (c && !seen.has(c)) {
        seen.add(c);
        if (c.proxy) out.push(c.proxy);
        if (c.ctx && c.ctx !== c.proxy) out.push(c.ctx);
        c = c.parent;
      }
      el = el.parentElement;
    }
    return out;
  }

  function collectSelectItems(vm) {
    const bags = [vm.items, vm.computedItems, vm.allItems, vm.cachedItems, vm.virtualizedItems, vm.$props?.items];
    const out = [];
    for (const bag of bags) {
      if (Array.isArray(bag)) out.push(...bag);
    }
    return out;
  }

  function applyVueSelect(vm, wanted) {
    const items = collectSelectItems(vm);
    const hit = items.find((it) => itemMatchesTerm(it, wanted));
    const value = itemValue(hit, wanted);
    let touched = false;
    try {
      if (hit && typeof vm.selectItem === "function") {
        vm.selectItem(hit);
        touched = true;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (typeof vm.setValue === "function") {
        vm.setValue(value);
        touched = true;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if ("internalValue" in vm) {
        vm.internalValue = value;
        touched = true;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if ("lazyValue" in vm) {
        vm.lazyValue = value;
        touched = true;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      vm.$emit?.("input", value);
      vm.$emit?.("change", value);
      vm.$emit?.("update:modelValue", value);
      touched = true;
    } catch (_) {
      /* ignore */
    }
    return touched;
  }

  function guessTermPayload(store, wanted) {
    const lists = [
      store?.state?.enrollment?.terms,
      store?.state?.enrollment?.termList,
      store?.state?.enrollment?.term_options,
      store?.state?.reference?.terms,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((t) => itemMatchesTerm(t, wanted));
      if (hit) return hit;
    }
    return Number(wanted) || wanted;
  }

  function applyStoreTerm(wanted) {
    const store = window.$nuxt?.$store;
    if (!store) return false;
    const payload = guessTermPayload(store, wanted);
    const mutations = [
      "enrollment/SET_TERM",
      "enrollment/SET_TERM_ID",
      "enrollment/SET_SELECTED_TERM",
      "enrollment/setTerm",
      "SET_TERM",
      "SET_TERM_ID",
    ];
    const actions = ["enrollment/setTerm", "enrollment/changeTerm", "enrollment/selectTerm", "setTerm"];
    let touched = false;
    for (const name of mutations) {
      try {
        if (store._mutations?.[name] || store._mutations?.[name.replace("/", "")]) {
          store.commit(name, payload);
          touched = true;
        }
      } catch (_) {
        /* ignore */
      }
    }
    for (const name of actions) {
      try {
        if (store._actions?.[name]) {
          store.dispatch(name, payload);
          touched = true;
        }
      } catch (_) {
        /* ignore */
      }
    }
    return touched;
  }

  function setPageTerm(termId) {
    const wanted = String(termId || "").trim();
    if (!wanted) return { ok: false, error: "no_term" };

    let vueTouched = false;
    const nodes = [
      ...document.querySelectorAll(
        ".v-select, .v-autocomplete, .v-input, [role='combobox'], .vs-select, .vs-con-select, select"
      ),
    ];
    for (const el of nodes) {
      for (const vm of walkVue(el)) {
        if (applyVueSelect(vm, wanted)) vueTouched = true;
      }
    }

    const storeTouched = applyStoreTerm(wanted);
    const current = currentTermId();
    return {
      ok: current != null && String(current) === wanted,
      current,
      vueTouched,
      storeTouched,
    };
  }

  /* ------------------------------------------------------------------ *
   * Fetching
   * ------------------------------------------------------------------ */

  function rowIdentity(row) {
    if (!isObj(row)) return "";
    return String(row.id ?? row.class_id ?? `${codeOf(row)}|${sectionOf(row)}`);
  }

  /**
   * Fetch every page of offerings for one course in one term.
   * Returns the raw objects untouched; parsing happens in the content script so
   * it can be unit-tested outside the browser.
   */
  async function fetchTerm({ courseCode, termId, recipe, perPage = 200 }) {
    const active = recipe && recipe.path ? recipe : DEFAULT_RECIPE;
    const out = [];
    let page = 1;
    let pages = 0;
    let firstSeen = "";
    let wrongTerm = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = queryFor(active, { courseCode, termId, page, perPage });
      const res = await apiGet(active.path, params, active.base);
      if (!res.ok) {
        if (page === 1) return { ok: false, error: res.error, status: res.status, recipe: active };
        break; // partial data beats none
      }

      const list = findRecordArray(res.data);
      pages = page;
      if (!list.length) break;

      // Some endpoints ignore `page` and keep returning page 1 forever.
      const identity = rowIdentity(list[0]);
      if (page > 1 && identity && identity === firstSeen) break;
      if (page === 1) firstSeen = identity;

      for (const row of list) {
        const t = termOf(row);
        if (t && String(t) !== String(termId)) wrongTerm += 1;
        out.push(row);
      }

      const info = pageInfo(res.data);
      const lastPage = info.lastPage || 1;
      if (page >= lastPage || page >= MAX_PAGES) break;
      page += 1;
    }

    return {
      ok: true,
      classes: out,
      endpoint: active.path,
      recipe: active,
      pages,
      wrongTerm,
      // A term filter that is silently ignored is worse than no data: flag it so
      // the scanner can refuse the rows instead of training on the wrong term.
      termHonoured: !(out.length && wrongTerm === out.length),
    };
  }

  /* ------------------------------------------------------------------ *
   * Message handling
   * ------------------------------------------------------------------ */

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== REQ) return;

    const reply = (payload) => window.postMessage({ source: RES, id: msg.id, ...payload }, "*");

    try {
      if (msg.type === "PING") {
        reply({
          ok: true,
          hasNuxt: !!window.$nuxt,
          hasAxios: !!window.$nuxt?.$axios,
          axiosBase: axiosBase(),
          currentTerm: currentTermId(),
          terms: availableTerms(),
          recordedApiCalls: recorded.length,
          learnedClassCalls: recorded.filter((e) => e.looksLikeClasses).length,
          href: location.href,
        });
        return;
      }

      if (msg.type === "TERMS") {
        reply({ ok: true, terms: availableTerms(), currentTerm: currentTermId() });
        return;
      }

      if (msg.type === "DISCOVER") {
        const found = await discover(msg.payload || {});
        reply({ ok: !!found.recipe, ...found });
        return;
      }

      if (msg.type === "FETCH_TERM") {
        const result = await fetchTerm(msg.payload || {});
        reply({ ...result, termId: msg.payload?.termId });
        return;
      }

      if (msg.type === "SET_TERM") {
        reply(setPageTerm(msg.payload?.termId));
        return;
      }

      if (msg.type === "DIAG") {
        reply({
          ok: true,
          href: location.href,
          hasNuxt: !!window.$nuxt,
          hasAxios: !!window.$nuxt?.$axios,
          axiosBase: axiosBase(),
          currentTerm: currentTermId(),
          terms: availableTerms(),
          recorded: recorded.map((e) => ({
            method: e.method,
            url: e.url,
            params: e.params,
            status: e.status,
            count: e.count,
            looksLikeClasses: !!e.looksLikeClasses,
            rowKeys: e.rowKeys || [],
          })),
          learnedRecipe: learnRecipe(msg.payload?.courseCode),
          sample: recorded.find((e) => e.sample)?.sample || null,
        });
        return;
      }

      reply({ ok: false, error: `unknown bridge request: ${msg.type}` });
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  });

  window.postMessage({ source: RES, id: "ready", ok: true, ready: true }, "*");
})();
