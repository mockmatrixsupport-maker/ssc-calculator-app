/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — fetcher-ssc.js  (v5 — reordered stagger + retry pass + summary)
   Fetches all parts (sections) of an SSC response sheet from
   sscexams.cbexams.com style URLs.

   WHY THIS CHANGED FROM v1: the old version fetched parts 1..10
   strictly SEQUENTIALLY (await in a for-loop), plus a 100ms sleep
   before each one — for a 5-section exam, that's 5 full network
   round-trips stacked back-to-back, easily 6-12+ seconds even on a
   decent connection. Since parser-ssc.js treats 1 part = 1 section,
   and each exam's exact section count is now maintained directly in
   exams-ssc.json's "parts" field, all parts are fetched IN PARALLEL,
   trusting that configured count completely — no extra probing beyond
   it, aside from the retry pass added in v4.

   Small stagger (STAGGER_MS) between each request's START (not its
   completion) is kept — firing every request in the exact same
   millisecond can look like a synchronized bot burst to some exam
   portals' protection; a small stagger avoids that while still being
   dramatically faster than fully sequential.

   WHAT'S NEW IN v5:
   - Fetch ORDER changed. Requests no longer fire 1, 2, 3, ... N in
     numeric order. Part 2 now fires FIRST (at 60ms, not 0ms), then
     parts 3, 4, ... N follow in order, and part 1 fires LAST. This
     is purely about which request hits the server first — total
     wall-clock time is unaffected since it's still bounded by the
     slowest single request.
   - Each in-flight promise is tagged with its real part number
     (via the `order` array + `partPromises` pairing) instead of
     relying on array position to imply part number. This matters
     BECAUSE the fetch order is no longer 1..N — using array index
     as the part number after reordering would silently mislabel
     responses (e.g. part 2's HTML saved as `p1`). Tagging keeps
     every response mapped to its correct `parts.pN` key regardless
     of what order it was requested in.

   WHAT'S IN v4 (unchanged):
   - Retry pass: any part that comes back empty/failed in the first
     parallel burst gets ONE retry — run alone, sequentially, after
     everything else has already settled, rather than bundled back
     into another simultaneous burst. Only helps TRANSIENT failures
     (server hiccup, brief rate limit) — a structurally wrong URL will
     fail identically on retry too.
   - Summary log: fetchAll() now logs "X/Y sections captured" once
     everything (including retries) has settled, so it's visible how
     many of the exam's known sections actually came through.
═══════════════════════════════════════════════════ */

const RSMFetcherSSC = (() => {

  const STAGGER_MS = 60; // ms between each request's START, not completion
  const RETRY_GAP_MS = 300; // brief pause before each retry, gives the server room to recover
  const DEFAULT_PARTS_IF_UNKNOWN = 4; // fallback only if an exam's config is missing "parts"

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

  function looksLikeRealContent(htmlText) {
    return !!htmlText && (htmlText.includes('Q.No') || htmlText.includes('ViewCandResponse'));
  }

  async function fetchOnePart(base, enckey, partNum, onLog) {
    const partLink = partUrl(base, enckey, partNum);
    try {
      const response = await RSMHttp.get(partLink, { 'Referer': 'https://sscexams.cbexams.com/' });
      if (response.status !== 200) {
        onLog(`Part ${partNum}: HTTP ${response.status}`, 'warn');
        return null;
      }
      const htmlText = response.data || '';
      if (!looksLikeRealContent(htmlText)) {
        onLog(`Part ${partNum}: No data`, 'info');
        return null;
      }
      onLog(`Part ${partNum}: OK (${htmlText.length.toLocaleString()} chars)`, 'ok');
      return htmlText;
    } catch (e) {
      onLog(`Part ${partNum}: Error — ${e.message || e}`, 'err');
      return null;
    }
  }

  /**
   * Builds the fetch order: part 2 first, then 3..knownCount in order,
   * then part 1 last. If knownCount === 1, there's only part 1 anyway.
   */
  function buildFetchOrder(knownCount) {
    if (knownCount <= 1) return [1];
    const order = [];
    for (let i = 2; i <= knownCount; i++) order.push(i);
    order.push(1);
    return order;
  }

  /**
   * @param {string} url - the pasted SSC answer key URL (any part)
   * @param {function} onLog - (message, level) called for live progress logging
   * @param {number} [expectedParts] - known section count for this exam,
   *   from exams-ssc.json's "parts" field. Falls back to a conservative
   *   default only if that config is genuinely missing.
   * @returns {Promise<{parts: Object<string,string>, count: number}>}
   */
  async function fetchAll(url, onLog = () => {}, expectedParts) {
    const split = splitBaseAndKey(url);
    if (!split) {
      const err = new Error('Invalid SSC URL format. Could not find ViewCandResponse.aspx / EncKey in the link.');
      err.invalidUrl = true;
      throw err;
    }
    const { base, enckey } = split;
    const knownCount = expectedParts && expectedParts > 0 ? expectedParts : DEFAULT_PARTS_IF_UNKNOWN;

    onLog(`${knownCount} sections ek saath fetch ho rahe hain...`, 'info');

    // ── First pass: fire all known parts in parallel, with a tiny
    // stagger on each request's START (not a sequential wait for
    // completion). Fetch ORDER is part 2 first, then 3..N, then part 1
    // last — but each promise is tagged with its real part number, so
    // reordering never affects where a response ends up getting saved. ──
    const order = buildFetchOrder(knownCount);
    const partPromises = order.map((partNum, idx) => {
      const delay = (idx + 1) * STAGGER_MS; // first request still fires at 60ms, not 0ms
      const promise = (async (pn, d) => {
        await sleep(d);
        return fetchOnePart(base, enckey, pn, onLog);
      })(partNum, delay);
      return { partNum, promise };
    });

    const results = await Promise.all(partPromises.map(p => p.promise));
    const parts = {};
    const missingPartNums = [];
    results.forEach((htmlText, idx) => {
      const partNum = partPromises[idx].partNum; // tagged, not inferred from array position
      if (htmlText) {
        parts[`p${partNum}`] = htmlText;
      } else {
        missingPartNums.push(partNum);
      }
    });

    // ── Retry pass: anything missed above gets exactly ONE more try,
    // run sequentially and alone — not bundled back into another
    // simultaneous burst — after everything else has already settled.
    if (missingPartNums.length > 0) {
      onLog(`${missingPartNums.length} section(s) missed — retrying: ${missingPartNums.join(', ')}`, 'info');
      for (const partNum of missingPartNums) {
        await sleep(RETRY_GAP_MS);
        const retryResult = await fetchOnePart(base, enckey, partNum, onLog);
        if (retryResult) {
          parts[`p${partNum}`] = retryResult;
          onLog(`Part ${partNum}: recovered on retry`, 'ok');
        } else {
          onLog(`Part ${partNum}: still missing after retry`, 'warn');
        }
      }
    }

    const capturedCount = Object.keys(parts).length;

    // ── Summary: always logged, success or partial, so it's visible
    // exactly how many of the exam's known sections actually came
    // through — e.g. "4/5 sections captured" if one genuinely never
    // recovered even after the retry pass.
    onLog(`${capturedCount}/${knownCount} sections captured`, capturedCount === knownCount ? 'ok' : 'warn');

    if (capturedCount === 0) {
      const err = new Error('Koi part fetch nahi hua. URL galat ho sakta hai ya answer key expire ho chuki hai.');
      err.invalidUrl = true;
      throw err;
    }

    return { parts, count: capturedCount };
  }

  return { matchesSSC, fetchAll };
})();


