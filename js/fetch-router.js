/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — fetch-router.js
   Single entry point the calculator pages call.

   Decides SSC vs RRB purely from the URL the user pasted
   (NOT from which calculator page they're on — a wrong-page
   paste is still routed correctly), applies the URL cache so
   a previously fetched+calculated link is restored instantly,
   and otherwise calls the matching fetcher.

   IMPORTANT (per requirement): caching only short-circuits
   fetching once a result has been fetched AND a score has
   been calculated and saved. A bare fetch with no calculation
   yet does not get cached — see saveCalculatedResult() below,
   which the score engine calls once it finishes scoring.
═══════════════════════════════════════════════════ */

const RSMFetchRouter = (() => {

  /**
   * @returns {'ssc' | 'rrb' | null}
   */
  function detectExamFamily(url) {
    if (!url) return null;
    const trimmed = url.trim();
    if (RSMFetcherSSC.matchesSSC(trimmed)) return 'ssc';
    if (RSMFetcherRRB.matchesRRB(trimmed)) return 'rrb';
    return null;
  }

  /**
   * Main entry point.
   * @param {string} url
   * @param {function} onLog - (message, level) for UI log box
   * @returns {Promise<{parts:Object, count:number, fromCache:boolean, family:string}>}
   */
  async function resolve(url, onLog = () => {}) {
    const trimmed = (url || '').trim();
    if (!trimmed) throw new Error('Answer key URL khali hai.');

    const family = detectExamFamily(trimmed);
    if (!family) {
      throw new Error('URL pehchana nahi gaya. Yeh SSC (sscexams.cbexams.com) ya RRB (rrb.digialm.com) link hona chahiye.');
    }

    // ── Cache check first ──
    const cached = RSMCache.get(trimmed);
    if (cached && cached.calculated) {
      onLog('Yeh answer key pehle se check ho chuki hai — saved result dikha rahe hain.', 'ok');
      return {
        parts: cached.parts,
        count: cached.count,
        fromCache: true,
        family: cached.family || family,
        calculatedResult: cached.calculatedResult || null
      };
    }

    // ── No usable cache — fetch fresh ──
    onLog(`Exam type detect hua: ${family.toUpperCase()}`, 'info');

    let result;
    if (family === 'ssc') {
      result = await RSMFetcherSSC.fetchAll(trimmed, onLog);
    } else {
      result = await RSMFetcherRRB.fetchAll(trimmed, onLog);
    }

    return {
      parts: result.parts,
      count: result.count,
      fromCache: false,
      family,
      calculatedResult: null
    };
  }

  /**
   * Called by the score engine ONCE it has successfully parsed +
   * calculated a score from the fetched parts. This is the only
   * place a cache entry is actually written, per requirement that
   * caching applies only to fetched-AND-calculated results.
   *
   * @param {string} url
   * @param {string} family - 'ssc' | 'rrb'
   * @param {Object} parts - the raw fetched HTML parts (so a cache hit
   *                          can still re-render full analysis later
   *                          without re-fetching)
   * @param {number} count
   * @param {Object} calculatedResult - whatever shape the score engine produces
   */
  function saveCalculatedResult(url, family, parts, count, calculatedResult) {
    const trimmed = (url || '').trim();
    if (!trimmed || !calculatedResult) return false;
    return RSMCache.set(trimmed, {
      family,
      parts,
      count,
      calculated: true,
      calculatedResult
    });
  }

  function clearCacheFor(url) {
    RSMCache.remove((url || '').trim());
  }

  return { detectExamFamily, resolve, saveCalculatedResult, clearCacheFor };
})();
