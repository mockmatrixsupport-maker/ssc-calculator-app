/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — fetcher-ssc.js
   Fetches all parts (subjects) of an SSC response sheet
   from sscexams.cbexams.com style URLs.

   SSC splits a candidate's response sheet across multiple
   .aspx pages (ViewCandResponse.aspx, ViewCandResponse2.aspx, ...)
   that all share the same EncKey. This walks parts 1..10 and
   stops as soon as a part fails or returns no question content.
═══════════════════════════════════════════════════ */

const RSMFetcherSSC = (() => {

  const MAX_PARTS = 10;
  const PART_DELAY_MS = 900; // small pacing delay between parts — avoids tripping bot protection

  function matchesSSC(url) {
    return /sscexams\.cbexams\.com/i.test(url);
  }

  function splitBaseAndKey(url) {
    const m = url.match(/(https?:\/\/.+\/)ViewCandResponse\d*\.aspx/i);
    if (!m) return null;
    const base = m[1];
    const km = url.match(/(?:enckey|EncKey)=([^&]+)/i);
    if (!km) return null;
    return { base, enckey: km[1] };
  }

  function partUrl(base, enckey, partNum) {
    return partNum === 1
      ? `${base}ViewCandResponse.aspx?enckey=${enckey}`
      : `${base}ViewCandResponse${partNum}.aspx?EncKey=${enckey}`;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * @param {string} url - the pasted SSC answer key URL (any part)
   * @param {function} onLog - (message, level) called for live progress logging
   * @returns {Promise<{parts: Object<string,string>, count: number}>}
   */
  async function fetchAll(url, onLog = () => {}) {
    const split = splitBaseAndKey(url);
    if (!split) {
      throw new Error('Invalid SSC URL format. Could not find ViewCandResponse.aspx / EncKey in the link.');
    }
    const { base, enckey } = split;
    const parts = {};

    for (let i = 1; i <= MAX_PARTS; i++) {
      const partLink = partUrl(base, enckey, i);
      onLog(`Part ${i} fetch ho raha hai...`, 'info');

      let response;
      try {
        if (i > 1) await sleep(PART_DELAY_MS);
        response = await RSMHttp.get(partLink, { 'Referer': 'https://sscexams.cbexams.com/' });
      } catch (e) {
        onLog(`Part ${i}: Error — ${e.message || e}`, 'err');
        break;
      }

      if (response.status !== 200) {
        onLog(`Part ${i}: HTTP ${response.status} — ruk gaye`, 'warn');
        break;
      }

      const htmlText = response.data || '';

      if (!htmlText.includes('Q.No') && !htmlText.includes('ViewCandResponse')) {
        onLog(`Part ${i}: Data nahi mila — fetch complete`, 'info');
        break;
      }

      parts[`p${i}`] = htmlText;
      onLog(`Part ${i}: OK (${htmlText.length.toLocaleString()} chars)`, 'ok');
    }

    if (Object.keys(parts).length === 0) {
      throw new Error('Koi part fetch nahi hua. URL galat ho sakta hai ya answer key expire ho chuki hai.');
    }

    return { parts, count: Object.keys(parts).length };
  }

  return { matchesSSC, fetchAll };
})();
