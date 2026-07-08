/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — update-check.js
   Forced-update prompt: compares the ACTUALLY-INSTALLED app version
   (read natively via @capacitor/app — reflects the real APK, not any
   JS constant that could go stale) against version.json's
   "latestVersion" (hosted on Cloudflare Pages, manually bumped by you
   only when a new build is actually live on the Play Store).

   If the installed version is older, a modal appears that CANNOT be
   dismissed — no close button, tapping outside does nothing, and the
   Android hardware back button is intercepted and blocked while it's
   showing. The only way past it is tapping "Update Now", which opens
   the Play Store listing.

   FAILS SILENTLY AND OPENLY (never blocks the app) if:
   - Cloudflare Pages is unreachable (offline, blocked, etc.)
   - @capacitor/app isn't available (e.g. testing in a plain browser)
   In both cases, no modal is shown — the app just works normally,
   since we'd rather risk not nagging than risk locking someone out
   over a network hiccup.
═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── EDIT THIS to your Cloudflare Pages URL — same one remote-loader.js uses ──
  var PAGES_BASE = 'https://ssc-calculator-app.pages.dev/';
  var VERSION_CHECK_TIMEOUT_MS = 5000;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                    function (e) { clearTimeout(t); reject(e); });
    });
  }

  /**
   * Compares two "1.2.0"-style version strings.
   * @returns {number} negative if a<b, 0 if equal, positive if a>b
   */
  function compareVersions(a, b) {
    var pa = String(a).split('.').map(Number);
    var pb = String(b).split('.').map(Number);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function getInstalledVersion() {
    // @capacitor/app's App.getInfo() reads the REAL installed APK's
    // versionName — the source of truth, since it reflects what's
    // actually on the device right now, not any value that could be
    // stale in cached JS. Falls back to null if the plugin isn't
    // available (e.g. testing in a plain desktop browser).
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      return window.Capacitor.Plugins.App.getInfo().then(function (info) {
        return info.version; // e.g. "1.2.0"
      }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function fetchLatestVersionInfo() {
    return withTimeout(
      fetch(PAGES_BASE + 'version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('bad status ' + r.status);
        return r.json();
      }),
      VERSION_CHECK_TIMEOUT_MS
    );
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showForcedUpdateModal(versionInfo) {
    var whatsNewHtml = (versionInfo.whatsNew || [])
      .map(function (line) { return '<li>' + esc(line) + '</li>'; })
      .join('');

    var overlay = document.createElement('div');
    overlay.id = 'rsm-update-overlay';
    overlay.innerHTML =
      '<style>' +
      '#rsm-update-overlay { position: fixed; inset: 0; z-index: 999999; ' +
      'background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 20px; }' +
      '#rsm-update-card { background: #fff; border-radius: 16px; max-width: 380px; width: 100%; ' +
      'padding: 24px; text-align: center; font-family: inherit; }' +
      '#rsm-update-card h2 { margin: 0 0 8px; font-size: 1.2rem; }' +
      '#rsm-update-card p { color: #666; font-size: 0.85rem; margin: 0 0 16px; }' +
      '#rsm-update-card ul { text-align: left; font-size: 0.85rem; color: #444; ' +
      'margin: 0 0 20px; padding-left: 20px; }' +
      '#rsm-update-card li { margin-bottom: 6px; }' +
      '#rsm-update-btn { display: block; width: 100%; padding: 14px; border: none; ' +
      'border-radius: 999px; background: #2563eb; color: #fff; font-size: 1rem; ' +
      'font-weight: 700; }' +
      '</style>' +
      '<div id="rsm-update-card">' +
      '<h2>Update Available</h2>' +
      '<p>A new version of Rank Score Master is ready. Please update to continue.</p>' +
      (whatsNewHtml ? '<ul>' + whatsNewHtml + '</ul>' : '') +
      '<button id="rsm-update-btn" type="button">Update Now</button>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('rsm-update-btn').addEventListener('click', function () {
      var url = versionInfo.playStoreUrl;
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
        window.Capacitor.Plugins.Browser.open({ url: url });
      } else {
        window.open(url, '_blank');
      }
    });

    // ── Block every dismissal route ──
    // 1. No close button exists at all (see markup above).
    // 2. Tapping the dark overlay itself does nothing (no click
    //    handler removes it) — only the button above does anything.
    // 3. Android hardware back button — intercepted via @capacitor/app
    //    and swallowed while this overlay is showing.
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener('backButton', function () {
        // Consuming the event with no navigation call = back button
        // does nothing while the update overlay is on screen.
      });
    }
  }

  function runUpdateCheck() {
    Promise.all([getInstalledVersion(), fetchLatestVersionInfo()])
      .then(function (results) {
        var installedVersion = results[0];
        var versionInfo = results[1];

        // If we couldn't determine the installed version (plugin
        // unavailable, e.g. desktop browser testing), don't show a
        // modal — nothing reliable to compare against.
        if (!installedVersion) return;

        if (compareVersions(installedVersion, versionInfo.latestVersion) < 0) {
          showForcedUpdateModal(versionInfo);
        }
      })
      .catch(function () {
        // Offline, Cloudflare Pages unreachable, malformed version.json,
        // etc. — fail silently and openly. The app must never be
        // blocked BECAUSE the update check itself failed; only a
        // genuinely confirmed old version blocks the app.
      });
  }

  // Runs once per app open, after the page's own scripts have started
  // (not blocking anything else from loading/rendering first).
  runUpdateCheck();
})();
