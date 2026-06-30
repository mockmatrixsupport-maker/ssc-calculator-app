/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — native-http.js
   Single shared helper that makes the actual HTTP request,
   using Capacitor's native HTTP bridge when running inside
   the Android app (bypasses CORS entirely, uses the user's
   own phone IP), and falling back to normal fetch() when
   running in a plain browser (for local testing on desktop —
   will hit CORS there, which is expected/known).
═══════════════════════════════════════════════════ */

const RSMHttp = (() => {

  const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en-IN;q=0.9,en;q=0.8',
    'Connection': 'keep-alive'
  };

  function isCapacitorHttpAvailable() {
    return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp);
  }

  /**
   * GET a URL natively (no CORS) inside the app, or via normal fetch in browser.
   * @param {string} url
   * @param {object} extraHeaders - merged on top of DEFAULT_HEADERS
   * @returns {Promise<{status:number, data:string}>}
   */
  async function get(url, extraHeaders = {}) {
    const headers = Object.assign({}, DEFAULT_HEADERS, extraHeaders);

    if (isCapacitorHttpAvailable()) {
      const result = await window.Capacitor.Plugins.CapacitorHttp.request({
        method: 'GET',
        url,
        headers,
        // some response pages are large (RRB single-page papers can be 1-3MB) —
        // give it room and don't let Capacitor silently truncate
        readTimeout: 45000,
        connectTimeout: 20000
      });
      return { status: result.status, data: result.data };
    }

    // Browser fallback (desktop testing only — will likely hit CORS on
    // real SSC/RRB domains, this path exists mainly so the page doesn't
    // hard-crash while developing in a normal tab)
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    return { status: resp.status, data: text };
  }

  function runningNatively() {
    return isCapacitorHttpAvailable();
  }

  return { get, runningNatively };
})();
