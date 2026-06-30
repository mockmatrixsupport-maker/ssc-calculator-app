/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — cache.js
   Caches a FETCHED + CALCULATED result against its source URL.
   Purpose: if the same answer-key URL is submitted again, skip
   re-fetching (and re-hitting SSC/RRB servers) and instantly
   restore the previously calculated score.

   IMPORTANT: this only caches once a result has been fetched
   AND calculated successfully. A failed/partial fetch is never
   cached, so the user can always retry.
═══════════════════════════════════════════════════ */

const RSMCache = (() => {
  const PREFIX = 'rsm-cache:';
  const VERSION = 1; // bump this if cached schema shape changes — invalidates old entries
  const MAX_ENTRIES = 40; // keep storage bounded on low-end phones

  function keyFor(url) {
    // Normalise the URL a bit so trivial differences (trailing slash, case
    // in scheme) don't create duplicate cache entries for the same exam.
    let norm = (url || '').trim();
    return PREFIX + norm;
  }

  function get(url) {
    try {
      const raw = localStorage.getItem(keyFor(url));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return null;
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

  return { get, set, has, remove, clearAll };
})();
