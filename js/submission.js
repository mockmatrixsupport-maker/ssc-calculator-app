/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — submission.js
   Silent, non-blocking background submission of a calculated
   result to the backend (API Gateway → Lambda A).

   DESIGN RULES (per spec):
   • NEVER delays or blocks the on-screen result. score-engine.js
     calls submit() strictly AFTER renderInto() has already run.
   • If no backend URL is configured  → fully silent no-op.
     No error, no console noise, nothing shown to the user.
   • If a backend URL IS configured but the request fails
     (offline, cold Lambda, throttled, whatever) → the payload is
     queued locally (localStorage) and retried automatically:
       - immediately after queuing (in case it was a one-off blip)
       - every time the app becomes visible again (covers "app is
         open in background" and "user reopens the app later")
       - once on next script load (covers app cold-start with a
         stale queue from a previous session)
   • Family-agnostic — one file for both SSC and RRB, since
     score-engine.js's calculate() output is already a unified
     shape across both parsers. No per-exam-type submission files.
   • Includes sourceUrl (the pasted answer-key link) for
     traceability, de-duplication, and future re-fetch/re-verify.
═══════════════════════════════════════════════════ */

const RSMSubmission = (() => {

  // ── Set this once your API Gateway endpoint exists.
  // Leave it empty to fully disable submission — silent no-op,
  // zero behavior change anywhere else in the app.
  const BACKEND_URL = ''; // e.g. 'https://xxxxxxxxxx.execute-api.ap-south-1.amazonaws.com/submit'

  const QUEUE_KEY = 'rsm_submission_queue_v1';
  const MAX_QUEUE_SIZE = 200;       // oldest items dropped first past this
  const MAX_RETRIES_PER_ITEM = 8;   // after this many failed attempts, drop silently

  function isEnabled() {
    return typeof BACKEND_URL === 'string' && BACKEND_URL.trim().length > 0;
  }

  function readQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeQueue(items) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE_SIZE)));
    } catch (e) {
      // storage full/disabled — nothing actionable, fail silently
    }
  }

  function enqueue(payload) {
    const items = readQueue();
    items.push({ payload, attempts: 0, queuedAt: Date.now() });
    writeQueue(items);
  }

  /**
   * Builds the backend payload from a score-engine result + context.
   * Pulls form fields (category/state/zone/language/examId) from
   * RSMCache since those are user-entered form values, not something
   * the parser extracts from the answer-key page itself.
   *
   * @param {Object} result - output of RSMScoreEngine.calculate()
   * @param {Object} meta - { url, family }
   */
  function buildPayload(result, meta) {
    const info = result.candidateInfo || {};

    let formFields = {};
    if (typeof RSMCache !== 'undefined' && typeof RSMCache.getFormFields === 'function' && meta.url) {
      formFields = RSMCache.getFormFields(meta.url) || {};
    }

    const sections = (result.sections || []).map(s => ({
      name: s.name,
      total: s.total,
      correct: s.correct,
      wrong: s.wrong,
      skipped: s.skipped,
      bonus: s.bonus,
      score: s.score,
      questions: s.questions || {} // { qId: status } — real IDs for RRB, placeholder keys for SSC until real IDs are found
    }));

    return {
      sourceUrl: meta.url || null,
      family: meta.family || null,
      examId: formFields.examId || null,
      candidateInfo: {
        rollNo: info.rollNo || null,
        name: info.name || null,
        registrationNo: info.registrationNo || null,
        community: info.community || null,
        centre: info.centre || null,
        date: info.date || null,
        shift: info.shift || null,
        exam: info.exam || null
      },
      formFields: {
        category: formFields.category || null,
        horizontalCategory: formFields.horizontalCategory || null,
        gender: formFields.gender || null,
        state: formFields.state || null,
        zone: formFields.zone || null,
        language: formFields.language || null
      },
      sections,
      totals: {
        totalCorrect: result.totalCorrect,
        totalWrong: result.totalWrong,
        totalSkipped: result.totalSkipped,
        totalBonus: result.totalBonus,
        totalQ: result.totalQ,
        totalScore: result.totalScore,
        maxScore: result.maxScore,
        pct: result.pct
      },
      marking: { correctMark: result.correctMark, wrongMark: result.wrongMark },
      submittedAt: new Date().toISOString()
    };
  }

  async function sendOne(item) {
    try {
      const res = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  let flushInFlight = false;

  async function flushQueue() {
    if (!isEnabled() || flushInFlight) return;
    let items = readQueue();
    if (!items.length) return;

    flushInFlight = true;
    const remaining = [];

    for (const item of items) {
      if (item.attempts >= MAX_RETRIES_PER_ITEM) continue; // too stale, drop silently

      const ok = await sendOne(item);
      if (!ok) {
        item.attempts += 1;
        remaining.push(item);
      }
    }

    writeQueue(remaining);
    flushInFlight = false;
  }

  /**
   * Entry point — called by score-engine.js's run(), strictly AFTER
   * the result has already been rendered to the screen. This function
   * itself never awaits the network call before returning, so it can
   * never delay anything the user sees.
   *
   * @param {Object} result - output of RSMScoreEngine.calculate()
   * @param {Object} meta - { url, family }
   */
  function submit(result, meta) {
    if (!isEnabled()) return; // fully silent no-op, by design

    const payload = buildPayload(result, meta);
    enqueue(payload);
    flushQueue(); // fire-and-forget; failures just stay queued for retry
  }

  // ── Background retry triggers — all silent, all non-blocking:
  //   1. visibilitychange → visible: covers the app being reopened
  //      from background (exactly the "if app is open in background,
  //      works to submitting" behavior requested).
  //   2. A one-time delayed flush on script load: covers a queue left
  //      over from a previous session (app was closed before it could
  //      retry). Delayed so it never competes with initial page render.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') flushQueue();
    });
    setTimeout(flushQueue, 3000);
  }

  return { submit };
})();

