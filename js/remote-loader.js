/* js/remote-loader.js
   Loads app JS/data from the bundled APK copy by default. If the device
   is online and a newer version exists on GitHub, it swaps that in
   instead — silently, with no app update needed. If anything fails
   (offline, blocked, 404, slow network) it just uses the bundled file.

   HOW TO PUSH AN UPDATE:
   1. Edit the file in your GitHub repo (e.g. js/parser-ssc.js).
   2. Bump that file's number in manifest.json in the same repo.
   3. Commit. Every app instance picks it up next time it opens with internet.
*/
(function () {
  'use strict';

  // ── EDIT THESE to point at your repo ──────────────────────────
  var GH_USER   = 'YOUR_GITHUB_USERNAME';
  var GH_REPO   = 'YOUR_REPO_NAME';
  var GH_BRANCH = 'main';
  // ───────────────────────────────────────────────────────────────

  var BASE = 'https://raw.githubusercontent.com/' + GH_USER + '/' + GH_REPO + '/' + GH_BRANCH + '/';
  var MANIFEST_URL = BASE + 'manifest.json';
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
      return raw ? JSON.parse(raw) : null; // { v: number, body: string }
    } catch (e) { return null; }
  }

  function setCached(path, v, body) {
    try { localStorage.setItem(LS_PREFIX + path, JSON.stringify({ v: v, body: body })); }
    catch (e) { /* storage full/unavailable — just skip caching, no crash */ }
  }

  var manifestPromise = null;
  function getManifest() {
    if (!manifestPromise) {
      manifestPromise = withTimeout(
        fetch(MANIFEST_URL + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('manifest ' + r.status);
          return r.json();
        }),
        FETCH_TIMEOUT_MS
      ).catch(function () { return null; }); // offline / blocked / 404 → use bundled files
    }
    return manifestPromise;
  }

  function toBlobUrl(code, path) {
    var type = /\.json$/.test(path) ? 'application/json' : 'text/javascript';
    var blob = new Blob([code], { type: type });
    return URL.createObjectURL(blob);
  }

  // Resolves one tracked file to a usable src (blob URL if remote/cached
  // content applies, otherwise the local bundled path).
  async function resolveFile(path, localSrc) {
    var manifest = await getManifest();
    if (!manifest || !(path in manifest)) return { src: localSrc, remote: false };

    var remoteV = manifest[path];
    var cached = getCached(path);

    if (cached && cached.v >= remoteV) {
      return { src: toBlobUrl(cached.body, path), remote: true };
    }

    try {
      var res = await withTimeout(fetch(BASE + path + '?t=' + Date.now(), { cache: 'no-store' }), FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error('fetch ' + path + ' ' + res.status);
      var body = await res.text();
      setCached(path, remoteV, body);
      return { src: toBlobUrl(body, path), remote: true };
    } catch (e) {
      if (cached) return { src: toBlobUrl(cached.body, path), remote: true }; // stale-but-cached beats nothing
      return { src: localSrc, remote: false };
    }
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

  window.RSMLoader = {
    // list: [{ path: 'js/score-engine.js', local: 'js/score-engine.js?v=3' }, ...]
    // Loaded strictly in order so dependencies between files stay intact.
    loadScripts: async function (list) {
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var resolved = await resolveFile(item.path, item.local);
        await loadScriptTag(resolved.src);
      }
    },
    // For JSON data files, e.g. data/answerkeys.json.
    loadJSON: async function (path, localFallbackUrl) {
      var resolved = await resolveFile(path, null);
      if (resolved.remote) {
        var r = await fetch(resolved.src);
        return r.json();
      }
      var r2 = await fetch(localFallbackUrl);
      return r2.json();
    }
  };
})();
