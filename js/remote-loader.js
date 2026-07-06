/* js/remote-loader.js
   Loads bundled JS/data first (instant, offline-safe), then ALWAYS
   kicks off a background fetch — from your Cloudflare Pages deploy,
   cache-busted with a timestamp — to refresh the cache for the NEXT
   time the app opens. No manifest.json, no jsDelivr, no purge
   workflow: Cloudflare Pages is a fast global CDN serving your own
   deploy, so a timestamp-busted URL gets the latest build with no
   extra step.

   Timing: this reflects whatever Cloudflare Pages has finished
   building, not the instant you `git push` — allow the usual ~30-60s
   Pages build/deploy time before expecting the new file to show up.

   Scripts already running this session are never hot-swapped (that
   risks double-binding event listeners etc.) — an update you push now
   is picked up on the NEXT app open, not the current one. JSON data
   loaded via loadJSONLive still updates in the SAME session, exactly
   as before, as long as the fetch finishes inside the timeout.

   HOW TO PUSH AN UPDATE:
   1. Edit the file in your GitHub repo (e.g. js/parser-ssc.js).
   2. Commit + push. Wait for the Cloudflare Pages build to finish.
   3. Every app instance picks up the new file the next time it opens.
*/
(function () {
  'use strict';

  // ── EDIT THIS to your Cloudflare Pages URL ────────────────────
  var PAGES_BASE = 'https://ssc-calculator-app.pages.dev/';
  // ───────────────────────────────────────────────────────────────

  // Cloudflare Pages is a real global CDN serving YOUR deploy — fast
  // everywhere (including India), and since every request here carries
  // a changing ?t= timestamp, each one is effectively a fresh URL that
  // bypasses any edge/browser caching. No purge step needed: as soon as
  // Cloudflare finishes building a push (usually ~30-60s after commit),
  // this starts returning the new file. Timeout kept short since this
  // is expected to be fast; if it's ever slow, cache/bundled is used.
  var FETCH_TIMEOUT_MS = 4000;
  var LS_PREFIX = 'rsm-remote:';

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                    function (e) { clearTimeout(t); reject(e); });
    });
  }

  function getCached(path) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + path);
      return raw ? JSON.parse(raw) : null; // { body: string }
    } catch (e) { return null; }
  }

  function setCached(path, body) {
    try { localStorage.setItem(LS_PREFIX + path, JSON.stringify({ body: body })); }
    catch (e) { /* storage full/unavailable — just skip caching, no crash */ }
  }

  function toBlobUrl(code, path) {
    var type = /\.json$/.test(path) ? 'application/json' : 'text/javascript';
    var blob = new Blob([code], { type: type });
    return URL.createObjectURL(blob);
  }

  function loadScriptTag(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Background-only cache refresh — never touches the currently running
  // page. Fire-and-forget: if it fails (offline/blocked/404) whatever
  // is already cached (or bundled) just keeps being used, no error shown.
  function refreshCacheInBackground(path) {
    withTimeout(
      fetch(PAGES_BASE + path + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        return r.text();
      }),
      FETCH_TIMEOUT_MS
    )
      .then(function (body) { setCached(path, body); })
      .catch(function () { /* keep whatever is already cached */ });
  }

  window.RSMLoader = {
    // list: [{ path: 'js/score-engine.js', local: 'js/score-engine.js?v=3' }, ...]
    // Loaded strictly in order so dependencies between files stay
    // intact. Each file uses its cached copy if one exists, otherwise
    // the bundled local copy — either way this is instant, zero network
    // wait, zero manifest round-trip. A background fetch then refreshes
    // every file's cache in parallel for the NEXT app open.
    loadScripts: async function (list) {
      list.forEach(function (item) { refreshCacheInBackground(item.path); });
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var cached = getCached(item.path);
        var src = cached ? toBlobUrl(cached.body, item.path) : item.local;
        await loadScriptTag(src);
      }
    },

    // For JSON data files that are needed once at page-init (not a
    // "live" list). Most callers should prefer loadJSONLive below.
    loadJSON: async function (path, localFallbackUrl) {
      var cached = getCached(path);
      refreshCacheInBackground(path);
      if (cached) {
        try { return JSON.parse(cached.body); } catch (e) { /* fall through */ }
      }
      var r = await fetch(localFallbackUrl);
      return r.json();
    },

    /**
     * For fast-changing JSON data (answer keys, exam lists). No
     * manifest involved — fetches directly from jsDelivr's GitHub CDN
     * mirror (faster edge delivery than raw.githubusercontent.com,
     * especially from India), every single time this is called.
     *
     * Pattern ("stale-while-revalidate"), in priority order:
     *   1. If a cached copy exists, onData(cached, true) fires
     *      IMMEDIATELY — the screen shows something with zero wait.
     *   2. If NOTHING is cached yet (first-ever open, or cache was
     *      cleared), the BUNDLED local copy (shipped inside the APK)
     *      is shown instead of a blank screen — onData(bundled, true).
     *   3. A fresh fetch always starts in the background regardless.
     *   4. If it succeeds, onData(fresh, false) fires and the cache
     *      is updated — the UI silently refreshes in place, same session.
     *   5. If it fails (offline, 404, etc.), whatever was already
     *      shown in step 1/2 just stays as-is — no error shown.
     *
     * @param {string} path - e.g. 'data/exams-ssc.json'
     * @param {string} cacheKey - localStorage key for this file's cache
     * @param {string} localFallbackUrl - bundled copy shipped in the APK
     * @param {function(data, fromCache)} onData - called once per stage
     */
    loadJSONLive: function (path, cacheKey, localFallbackUrl, onData) {
      var shownSomething = false;

      try {
        var cachedRaw = localStorage.getItem(LS_PREFIX + cacheKey);
        if (cachedRaw) {
          onData(JSON.parse(cachedRaw), true);
          shownSomething = true;
        }
      } catch (e) { /* corrupt cache entry — fall through to bundled/live below */ }

      var freshPromise = withTimeout(
        fetch(PAGES_BASE + path + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('bad status ' + r.status);
          return r.json();
        }),
        FETCH_TIMEOUT_MS
      )
        .then(function (fresh) {
          try { localStorage.setItem(LS_PREFIX + cacheKey, JSON.stringify(fresh)); } catch (e) {}
          onData(fresh, false);
          shownSomething = true;
        })
        .catch(function () {
          // Live fetch failed — if nothing was shown yet (no cache,
          // this is a first-ever open), fall back to the bundled copy
          // shipped inside the APK rather than leaving the screen blank.
          if (!shownSomething && localFallbackUrl) {
            fetch(localFallbackUrl).then(function (r) { return r.json(); }).then(function (bundled) {
              onData(bundled, true);
            }).catch(function () { /* even the bundled file failed to load — nothing more to try */ });
          }
        });

      return freshPromise;
    }
  };
})();

/* NOTE ON YOUR "Purge jsDelivr Cache" GITHUB ACTION:
   Not needed anymore — nothing here talks to jsDelivr or GitHub raw
   URLs, only your Cloudflare Pages deploy. You can delete purge-cache.yml.
   Cloudflare Pages rebuilds automatically on every push to the branch
   it's connected to, and the ?t= timestamp on every request here
   ensures you always get whatever that latest build actually serves. */
