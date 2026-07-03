/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — fetcher-rrb.js
   Fetches the single-page RRB / DigiAlm response sheet.

   Unlike SSC, RRB (digialm.com) puts the ENTIRE response sheet —
   every section, every question — on one large HTML page. No
   parts/EncKey walking needed, just one fetch. The page can be
   large (1-3MB) so we allow one retry if it times out.
═══════════════════════════════════════════════════ */

const RSMFetcherRRB = (() => {

  function matchesRRB(url) {
    return /rrb\.digialm\.com/i.test(url) || /digialm\.com/i.test(url);
  }

  /**
   * @param {string} url - the pasted RRB response sheet URL
   * @param {function} onLog - (message, level) called for live progress logging
   * @returns {Promise<{parts: Object<string,string>, count: number}>}
   *
   * Returns the SAME shape as the SSC fetcher ({parts, count}) with a
   * single key "p1" so the rest of the pipeline (cache, score engine)
   * doesn't need to know which exam type it came from.
   */
  async function fetchAll(url, onLog = () => {}) {
    if (!url || !url.startsWith('http')) {
      throw new Error('Invalid RRB URL. Link must start with http(s)://');
    }

    onLog('RRB response sheet fetch ho raha hai...', 'info');
    onLog('Yeh single page hai, thoda bada ho sakta hai...', 'info');

    let response;
    try {
      response = await RSMHttp.get(url, { 'Referer': 'https://rrb.digialm.com/' });
    } catch (firstErr) {
      // One retry — large pages occasionally need a second attempt
      onLog('Pehli koshish fail — retry kar rahe hain...', 'warn');
      try {
        response = await RSMHttp.get(url, { 'Referer': 'https://rrb.digialm.com/' });
      } catch (secondErr) {
        throw new Error(`Fetch failed — ${secondErr.message || secondErr}`);
      }
    }

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} — response sheet load nahi hui. Link expire ho sakta hai.`);
    }

    const htmlText = response.data || '';

    // Sanity check: a real RRB response sheet contains these markers
    const looksValid = htmlText.includes('Question ID') ||
                        htmlText.includes('rightAns') ||
                        htmlText.includes('Chosen Option');

    if (!looksValid) {
      throw new Error('Page fetch ho gaya par response sheet jaisa nahi lagta. Link check karo.');
    }

    onLog(`OK — page fetched (${htmlText.length.toLocaleString()} chars)`, 'ok');

    return { parts: { p1: htmlText }, count: 1 };
  }

  return { matchesRRB, fetchAll };
})();
