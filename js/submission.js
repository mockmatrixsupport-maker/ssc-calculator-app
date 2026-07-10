/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — submission.js (Triple Production Pipeline)
   Silent, non-blocking background submission to ALL THREE:
     1. AWS (API Gateway -> Lambda A) - Full Tracking Payload Warehouse
     2. Supabase (Direct REST API HTTP) - Lightweight Live Rank Master Row
     3. Cloudflare Worker + KV + GitHub - Raw source-HTML archive
        (check-source gate first, only uploads HTML from the phone if
        that exam's date+shift+lang combo isn't archived yet)

   UPDATED:
   - on_conflict=exam_id,shift_id,roll_number added so merge-duplicates
     actually upserts against the real UNIQUE constraint (previously
     defaulted to the primary key, causing duplicate resubmits to error).
   - NOT NULL columns (shift_id, category, gender) now get a safe 'NA'
     fallback instead of null, since the DB schema rejects null there.
   - Temporary console.error added on failed inserts so real Supabase
     errors (RLS/policy/constraint) are visible instead of silently
     swallowed. Remove this once confirmed working end-to-end.
═══════════════════════════════════════════════════ */

const RSMSubmission = (() => {

  // ── BACKEND CORE ENDPOINTS CONFIGURATION
  const BACKEND_URL = 'https://hfpjk5onba.execute-api.ap-south-1.amazonaws.com/submit';
  const SUPABASE_REST_URL = 'https://onqzgzngjteqopnzyscc.supabase.co/rest/v1/rank_master';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ucXpnem5nanRlcW9wbnp5c2NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MjA0NjAsImV4cCI6MjA5OTA5NjQ2MH0.Pq74MzPgzS9VYiyUanjfj4D2A6OTfgGzqzdqbZ0SMiQ';

  // on_conflict must match the real UNIQUE constraint on rank_master —
  // without it, PostgREST's merge-duplicates defaults to the primary
  // key (id), which is never sent, so duplicate roll numbers hit the
  // real constraint as a raw error instead of being upserted.
  const SUPABASE_UPSERT_URL = `${SUPABASE_REST_URL}?on_conflict=exam_id,shift_id,roll_number`;

  // Pipeline C: source-HTML archiver worker (Cloudflare Worker + KV + GitHub)
  const ARCHIVER_BASE_URL = 'https://rsm-souce-archiever.chaudharysr01.workers.dev';

  const QUEUE_KEY = 'rsm_submission_queue_v1';
  const MAX_QUEUE_SIZE = 200;       // oldest items dropped first past this
  const MAX_RETRIES_PER_ITEM = 8;   // after this many failed attempts, drop silently

  // Separate retry queue for Pipeline C (source-html archive). SSC's
  // merged parts run ~1MB — far too big for a keepalive fetch (browsers
  // hard-cap keepalive request bodies at 64KB combined, silently
  // failing above that), so the commit call below is a normal awaited
  // fetch instead. This queue is what actually guarantees eventual
  // delivery: any failed commit (network blip, worker cold-start, etc)
  // gets persisted and retried on next app open, same as Pipeline B.
  const ARCHIVE_QUEUE_KEY = 'rsm_archive_queue_v1';
  const MAX_ARCHIVE_QUEUE_SIZE = 50;
  const MAX_ARCHIVE_RETRIES = 8;

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

  function readArchiveQueue() {
    try {
      const raw = localStorage.getItem(ARCHIVE_QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeArchiveQueue(items) {
    try {
      localStorage.setItem(ARCHIVE_QUEUE_KEY, JSON.stringify(items.slice(-MAX_ARCHIVE_QUEUE_SIZE)));
    } catch (e) {
      // storage full/disabled — nothing actionable, fail silently
    }
  }

  function enqueueArchive(payload) {
    const items = readArchiveQueue();
    items.push({ payload, attempts: 0, queuedAt: Date.now() });
    writeArchiveQueue(items);
  }

  /**
   * Direct Browser to Supabase Database Table Upsert Layer
   * Sends strictly required parameters over the optimized composite indexes.
   */
  async function directSupabaseSubmit(formFields, info, result) {
    // exam_id is NOT NULL and is the partition key for every rank query —
    // unlike shift/category/gender, there's no safe placeholder for it.
    // If it's missing, skip this write rather than corrupt cross-exam counts.
    if (!formFields.examId) {
      console.error('Supabase rank_master insert skipped: examId missing from formFields');
      return false;
    }

    try {
      const payload = {
        exam_id: formFields.examId,
        // shift_id / category / gender are NOT NULL in the schema — 'NA'
        // fallback prevents a silent 400 when a value is genuinely missing
        // (e.g. parser couldn't find a shift for a single-shift exam).
        //
        // shift_id is date+time combined, NOT just the raw time — a bare
        // time range (e.g. "9:00 AM - 10:30 AM") collides across different
        // dates within the same multi-day exam_id, merging unrelated
        // shifts into one. Must match score-engine.js's buildRankCtx()
        // exactly, since that's what builds the shift key rank.js later
        // reads back with — a mismatch here means shift rank silently
        // reads 0 total even though rows exist.
        shift_id: (info.date && info.shift) ? `${info.date}_${info.shift}` : (info.shift || 'NA'),
        roll_number: info.rollNo || null,
        score: result.totalScore,
        category: formFields.category || 'NA',
        gender: formFields.gender || 'NA',
        zone: formFields.zone || null,  // genuinely optional (non-RRB exams) — stays NULL
        // q_s_t = qualifying section total marks. Only present for exams
        // with a qualifying section (score-engine's calculate() omits
        // qualifyingTotal entirely otherwise) — column stays NULL for
        // every other exam, exactly like zone above.
        q_s_t: result.qualifyingTotal != null ? result.qualifyingTotal : null
      };

      const res = await fetch(SUPABASE_UPSERT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'resolution=merge-duplicates' // Native PostgreSQL Upsert on conflict handler
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        // TEMP DEBUG — remove once you've confirmed inserts are working.
        // 401/403 = RLS/policy issue. 400 = NOT NULL or bad payload.
        // 409 = conflict target mismatch.
        console.error('Supabase rank_master insert failed:', res.status, await res.text());
      }

      return res.ok;
    } catch (e) {
      console.error('Supabase rank_master insert error:', e);
      return false; // Silently falls back if network spikes
    }
  }

  /**
   * Pipeline C: background archive of the raw source HTML to GitHub via
   * the Cloudflare Worker + KV dedupe gate. Cheap existence check first —
   * only uploads HTML from this phone if nobody has archived this exam's
   * date+shift+lang combo yet. Never awaited by the caller, never throws.
   */
  async function archiveSourceHtml(family, parts, info, formFields, sourceUrl) {
    if (!ARCHIVER_BASE_URL || !parts || !formFields.examId) return;

    const partsArr = Object.keys(parts)
      .map(name => ({ name, html: parts[name] }))
      .filter(p => typeof p.html === 'string' && p.html.length);
    if (!partsArr.length) return;

    const examId = formFields.examId;
    const lang = formFields.language || 'default';
    const shift = info.shift || 'NA';
    const date = info.date || 'na';
    const commitPayload = { family, examId, date, shift, lang, sourceUrl, parts: partsArr };

    try {
      const q = new URLSearchParams({ family, examId, date, shift, lang });
      const checkRes = await fetch(`${ARCHIVER_BASE_URL}/check-source?${q}`);
      const { exists } = await checkRes.json();
      if (exists) return; // already archived — nothing uploaded from this phone

      // NOTE: no keepalive here on purpose. Browsers hard-cap keepalive
      // request bodies at 64KB combined — SSC's merged parts run ~1MB,
      // well over that, so keepalive would silently fail every time for
      // exactly the payloads that matter most. This is a normal awaited
      // fetch instead; the page stays open after scoring so it doesn't
      // need to survive unload.
      const res = await fetch(`${ARCHIVER_BASE_URL}/commit-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commitPayload)
      });

      if (!res.ok) {
        enqueueArchive(commitPayload);
      }
    } catch (e) {
      // Network error, worker down, etc — queue for retry rather than
      // dropping it. This is what actually makes the commit "happen
      // eventually" instead of best-effort-once.
      enqueueArchive(commitPayload);
    }
  }

  async function sendArchiveItem(item) {
    const { family, examId, date, shift, lang } = item.payload;
    try {
      // Re-check first: another device may have committed this exact
      // exam+shift+lang since this item was queued, or a previous retry
      // may have actually succeeded server-side even though the response
      // was lost client-side. Either way, skip the re-upload if so.
      const q = new URLSearchParams({ family, examId, date, shift, lang });
      const checkRes = await fetch(`${ARCHIVER_BASE_URL}/check-source?${q}`);
      const { exists } = await checkRes.json();
      if (exists) return true;

      const res = await fetch(`${ARCHIVER_BASE_URL}/commit-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  let archiveFlushInFlight = false;

  async function flushArchiveQueue() {
    if (!ARCHIVER_BASE_URL || archiveFlushInFlight) return;
    let items = readArchiveQueue();
    if (!items.length) return;

    archiveFlushInFlight = true;
    const remaining = [];

    for (const item of items) {
      if (item.attempts >= MAX_ARCHIVE_RETRIES) continue;

      const ok = await sendArchiveItem(item);
      if (!ok) {
        item.attempts += 1;
        remaining.push(item);
      }
    }

    writeArchiveQueue(remaining);
    archiveFlushInFlight = false;
  }

  /**
   * Builds the backend payload from a score-engine result + context.
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
      isQualifying: !!s.isQualifying,
      questions: s.questions || {}
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
        pct: result.pct,
        // Present only for exams with a qualifying section — undefined
        // (and dropped by JSON.stringify) for every other exam.
        qualifyingCorrect: result.qualifyingCorrect,
        qualifyingWrong: result.qualifyingWrong,
        qualifyingSkipped: result.qualifyingSkipped,
        qualifyingBonus: result.qualifyingBonus,
        qualifyingQ: result.qualifyingQ,
        qualifyingTotal: result.qualifyingTotal,
        qualifyingMax: result.qualifyingMax
      },
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
      if (item.attempts >= MAX_RETRIES_PER_ITEM) continue;

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
   * Unified Entry Point - Fired right after local score calculations are rendered
   *
   * @returns {Promise<boolean>} resolves once the Supabase (Pipeline A)
   *   write has settled — true if it succeeded or was already submitted
   *   earlier, false if it failed. Callers (score-engine.js) use this to
   *   sequence the rank-count fetch AFTER this candidate's own row has
   *   actually committed, instead of firing both at once — that race is
   *   what caused rank to occasionally read back "1/0" on a fresh check.
   *   Pipeline B (AWS queue) is untouched — still fully fire-and-forget,
   *   never awaited, never blocks anything.
   */
  function submit(result, meta) {
    if (!isEnabled()) return Promise.resolve(false);

    if (typeof RSMCache !== 'undefined' && typeof RSMCache.isSubmitted === 'function' && meta.url) {
      // Already submitted in an earlier run — that row already exists,
      // so it's safe for the caller to fetch rank right away.
      if (RSMCache.isSubmitted(meta.url)) return Promise.resolve(true);
    }

    const info = result.candidateInfo || {};
    let formFields = {};
    if (typeof RSMCache !== 'undefined' && typeof RSMCache.getFormFields === 'function' && meta.url) {
      formFields = RSMCache.getFormFields(meta.url) || {};
    }

    // 0. Pipeline C: background source-HTML archive (fire-and-forget).
    archiveSourceHtml(meta.family, meta.parts, info, formFields, meta.url);

    // 1. Pipeline A: Direct lightweight upsert execution to Supabase Table.
    //    Still async and non-blocking for the score card — but now the
    //    caller gets this promise back so IT can decide to wait before
    //    fetching rank, instead of this file silently racing it.
    const supabasePromise = directSupabaseSubmit(formFields, info, result).then((supabaseOk) => {
      // If Supabase transaction completes 200, trigger duplicate prevention flag lock locally
      if (supabaseOk && typeof RSMCache !== 'undefined' && typeof RSMCache.markSubmitted === 'function' && meta.url) {
        RSMCache.markSubmitted(meta.url);
      }
      return supabaseOk;
    });

    // 2. Pipeline B: Standard full payload tracking bundle processed through local AWS cache queue
    const awsPayload = buildPayload(result, meta);
    enqueue(awsPayload);
    flushQueue();

    return supabasePromise;
  }

  // ── Automated invisible background synchronizers
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        flushQueue();
        flushArchiveQueue();
      }
    });
    setTimeout(flushQueue, 3000);
    setTimeout(flushArchiveQueue, 3000);
  }

  return { submit };
})();

   
