/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — submission.js (Dual Production Pipeline)
   Silent, non-blocking background submission to BOTH:
     1. AWS (API Gateway -> Lambda A) - Full Tracking Payload Warehouse
     2. Supabase (Direct REST API HTTP) - Lightweight Live Rank Master Row

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
   * Direct Browser to Supabase Database Table Upsert Layer
   * Sends strictly required parameters over the optimized composite indexes.
   */
  async function directSupabaseSubmit(formFields, info, result) {
    try {
      const payload = {
        exam_id: formFields.examId || null,
        // shift_id / category / gender are NOT NULL in the schema — 'NA'
        // fallback prevents a silent 400 when a value is genuinely missing
        // (e.g. parser couldn't find a shift for a single-shift exam).
        shift_id: info.shift || 'NA',
        roll_number: info.rollNo || null,
        score: result.totalScore,
        category: formFields.category || 'NA',
        gender: formFields.gender || 'NA',
        zone: formFields.zone || null  // genuinely optional (non-RRB exams) — stays NULL
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
        pct: result.pct
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
   */
  function submit(result, meta) {
    if (!isEnabled()) return;

    if (typeof RSMCache !== 'undefined' && typeof RSMCache.isSubmitted === 'function' && meta.url) {
      if (RSMCache.isSubmitted(meta.url)) return;
    }

    const info = result.candidateInfo || {};
    let formFields = {};
    if (typeof RSMCache !== 'undefined' && typeof RSMCache.getFormFields === 'function' && meta.url) {
      formFields = RSMCache.getFormFields(meta.url) || {};
    }

    // 1. Pipeline A: Direct lightweight upsert execution to Supabase Table (Async Fire-And-Forget)
    directSupabaseSubmit(formFields, info, result).then((supabaseOk) => {
      // If Supabase transaction completes 200, trigger duplicate prevention flag lock locally
      if (supabaseOk && typeof RSMCache !== 'undefined' && typeof RSMCache.markSubmitted === 'function' && meta.url) {
        RSMCache.markSubmitted(meta.url);
      }
    });

    // 2. Pipeline B: Standard full payload tracking bundle processed through local AWS cache queue
    const awsPayload = buildPayload(result, meta);
    enqueue(awsPayload);
    flushQueue();
  }

  // ── Automated invisible background synchronizers
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') flushQueue();
    });
    setTimeout(flushQueue, 3000);
  }

  return { submit };
})();

