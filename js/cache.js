/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — cache.js
   Caches a FETCHED + CALCULATED result against its source URL.
   Purpose: if the same answer-key URL is submitted again, skip
   re-fetching (and re-hitting SSC/RRB servers) and instantly
   restore the previously calculated score.

   IMPORTANT: this only caches once a result has been fetched
   AND calculated successfully. A failed/partial fetch is never
   cached, so the user can always retry.

   NOTE (v2): the calculatedResult saved here must have its
   dynamic fields (ranks, normalised score) already stripped by
   the caller (score-engine.js does this before calling
   RSMFetchRouter.saveCalculatedResult). Those fields are meant
   to reflect live/latest data and are never safe to persist —
   cache.js itself does not know their shape, it just stores
   whatever object it's given, so the strip MUST happen upstream.
═══════════════════════════════════════════════════ */

const RSMCache = (() => {
  const PREFIX = 'rsm-cache:';
  const FORM_PREFIX = 'rsm-formfields:'; // separate namespace: last-used form selections per URL
  const SUBMITTED_PREFIX = 'rsm-submitted:'; // separate namespace: "already sent to backend" flags per URL
  const VERSION = 4; // bump this if cached schema shape changes — invalidates old entries
  const MAX_ENTRIES = 40; // keep storage bounded on low-end phones
  const RECENT_DEFAULT = 3;
  const TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days — applies to all namespaces below

  function isExpired(savedAt) {
    return !savedAt || (Date.now() - savedAt) > TTL_MS;
  }

  function keyFor(url) {
    // Normalise the URL a bit so trivial differences (trailing slash, case
    // in scheme) don't create duplicate cache entries for the same exam.
    let norm = (url || '').trim();
    return PREFIX + norm;
  }

  function formKeyFor(url) {
    return FORM_PREFIX + (url || '').trim();
  }

  /**
   * Remembers the form selections (examId, category, horizontalCategory,
   * state, language, and — for RRB — zone) the user picked for a given
   * answer-key URL. Stored independently of the fetched/calculated
   * result cache above, so it survives even for a fresh fetch and can
   * be used to auto-fill the form the next time this URL (or a "recently
   * checked" chip for it) is used.
   * @param {string} url
   * @param {Object} fields
   */
  function saveFormFields(url, fields) {
    try {
      localStorage.setItem(formKeyFor(url), JSON.stringify({ savedAt: Date.now(), fields }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} url
   * @returns {Object|null} previously saved fields, or null
   */
  function getFormFields(url) {
    try {
      const k = formKeyFor(url);
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (isExpired(parsed && parsed.savedAt)) {
        localStorage.removeItem(k);
        return null;
      }
      return (parsed && parsed.fields) ? parsed.fields : null;
    } catch (e) {
      return null;
    }
  }

  function get(url) {
    try {
      const k = keyFor(url);
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return null;
      if (isExpired(parsed.savedAt)) {
        localStorage.removeItem(k); // auto-delete on the check that found it stale
        return null;
      }
      return parsed.data;
    } catch (e) {
      return null;
    }
  }

  function set(url, data) {
    try {
      const entry = { v: VERSION, savedAt: Date.now(), data };
      localStorage.setItem(keyFor(url), JSON.stringify(entry));
      enforceLimit();
      return true;
    } catch (e) {
      // Storage full or blocked — fail silently, fetching still works,
      // it just won't be cached this time.
      return false;
    }
  }

  function has(url) {
    return get(url) !== null;
  }

  function remove(url) {
    try { localStorage.removeItem(keyFor(url)); } catch (e) {}
  }

  function allKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) keys.push(k);
    }
    return keys;
  }

  // If too many cached results pile up, drop the oldest ones first.
  function enforceLimit() {
    const keys = allKeys();
    if (keys.length <= MAX_ENTRIES) return;

    const withTime = keys.map(k => {
      let savedAt = 0;
      try { savedAt = JSON.parse(localStorage.getItem(k)).savedAt || 0; } catch (e) {}
      return { k, savedAt };
    });

    withTime.sort((a, b) => a.savedAt - b.savedAt);
    const toRemove = withTime.slice(0, withTime.length - MAX_ENTRIES);
    toRemove.forEach(item => { try { localStorage.removeItem(item.k); } catch (e) {} });
  }

  function clearAll() {
    allKeys().forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  }

  /**
   * Last N successfully-checked results, most recent first. Used to show
   * the "recently checked" chips above the answer-key URL field. Only
   * ever returns lightweight display info (name/roll/score) — never the
   * raw fetched HTML parts and never rank/normalised fields, since those
   * are explicitly not persisted (see note at top of file).
   *
   * @param {number} n
   * @returns {Array<{url, savedAt, family, candidateInfo, totalScore, maxScore}>}
   */
  function recent(n = RECENT_DEFAULT, family = null) {
    const keys = allKeys();
    const withMeta = keys.map(k => {
      try {
        const parsed = JSON.parse(localStorage.getItem(k));
        if (!parsed || parsed.v !== VERSION || !parsed.data || !parsed.data.calculated) return null;
        // Filter to the requesting page's exam family (ssc/rrb) so the
        // SSC calculator never shows RRB "recently checked" chips and
        // vice versa. family=null keeps the old unfiltered behaviour.
        if (family && parsed.data.family !== family) return null;
        const cr = parsed.data.calculatedResult || {};
        const url = k.slice(PREFIX.length);
        return {
          url,
          savedAt: parsed.savedAt || 0,
          family: parsed.data.family || null,
          candidateInfo: cr.candidateInfo || {},
          totalScore: (cr.totalScore != null) ? cr.totalScore : null,
          maxScore: (cr.maxScore != null) ? cr.maxScore : null,
          // Last-used form selections for this URL (exam/category/state/
          // language/zone), if any were saved — lets a "recently checked"
          // chip auto-fill the whole form, not just the URL field.
          fields: getFormFields(url)
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    withMeta.sort((a, b) => b.savedAt - a.savedAt);
    return withMeta.slice(0, n);
  }

  /**
   * Marks a given answer-key URL as already submitted to the backend
   * (Lambda A). Called by submission.js right after a successful send.
   * Subject to the same 2-day TTL as everything else — after that, a
   * recalculation of the same URL is treated as fresh again.
   * @param {string} url
   */
  function markSubmitted(url) {
    try {
      localStorage.setItem(SUBMITTED_PREFIX + (url || '').trim(), JSON.stringify({ savedAt: Date.now() }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {string} url
   * @returns {boolean} true if this URL was already submitted to the
   * backend within the last 2 days — callers should skip resubmitting.
   */
  function isSubmitted(url) {
    try {
      const k = SUBMITTED_PREFIX + (url || '').trim();
      const raw = localStorage.getItem(k);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (isExpired(parsed && parsed.savedAt)) {
        localStorage.removeItem(k);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── Startup sweep: proactively remove anything past its 2-day TTL
  // across ALL namespaces (result cache, form fields, submitted flags),
  // not just the ones a user happens to re-check later. Runs once per
  // page load — cheap, since it's a handful of localStorage reads.
  function sweepExpired() {
    try {
      const allPrefixes = [PREFIX, FORM_PREFIX, SUBMITTED_PREFIX];
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !allPrefixes.some(p => k.indexOf(p) === 0)) continue;
        try {
          const parsed = JSON.parse(localStorage.getItem(k));
          if (isExpired(parsed && parsed.savedAt)) toRemove.push(k);
        } catch (e) {
          // Unparseable entry — safe to drop it too.
          toRemove.push(k);
        }
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    } catch (e) {
      // localStorage unavailable — nothing to sweep, fail silently.
    }
  }
  sweepExpired();

  return { get, set, has, remove, clearAll, recent, saveFormFields, getFormFields, markSubmitted, isSubmitted };
})();
         

