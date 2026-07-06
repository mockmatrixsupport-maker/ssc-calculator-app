/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — rank.js
   Fetches and renders rank/percentile/average data, fully
   separate from score-engine.js's instant score calculation.

   IMPORTANT DESIGN RULES:
   - Percentile is NEVER fetched from the backend — it's computed
     client-side from rank + total (see percentile() below), since
     it's pure arithmetic and storing it server-side would be
     redundant data.
   - This module is mounted AFTER the score is already rendered and
     visible (score-engine.js calls RSMRank.mount() right after
     renderInto()) — a slow or failed rank fetch can NEVER delay or
     block the score the user sees, same principle as submission.js.
   - Mounted on BOTH a fresh calculation AND a cache-loaded result,
     since renderInto() is the single shared render path for both —
     rank data has its own independent freshness lifecycle (10-min
     cache TTL, see cache.js) regardless of how old the cached SCORE
     itself is.
   - Three distinct outcomes, rendered differently:
       1. Found → real rank/total + percentile cards
       2. Not found, but this exam HAS been ranked before
          (examHasAnyData: true) → "Rank will be shown after 30 min"
       3. Not found, exam has NEVER been ranked
          (examHasAnyData: false) → "N/A"
═══════════════════════════════════════════════════ */

const RSMRank = (() => {

  // Set once your GET /rank endpoint exists (Lambda + API Gateway route).
  // Leave empty to make this module a silent no-op — shows "N/A" on
  // every card without ever attempting a network call.
  const RANK_API_URL = ''; // e.g. 'https://hfpjk5onba.execute-api.ap-south-1.amazonaws.com/rank'

  const FETCH_TIMEOUT_MS = 6000;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  /**
   * Pure arithmetic — never fetched, always derived client-side.
   * @returns {string} e.g. "91.20" or "N/A" if rank/total missing
   */
  function percentile(rank, total) {
    if (rank == null || total == null || total <= 0) return 'N/A';
    return (((total - rank) / total) * 100).toFixed(2);
  }

  function isEnabled() {
    return typeof RANK_API_URL === 'string' && RANK_API_URL.trim().length > 0;
  }

  /**
   * @param {Object} ctx - { examId, date, shift, rollNo }
   * @param {boolean} forceFresh - if true, skips the cache entirely
   * @returns {Promise<Object|null>} rank payload, or null on any failure
   */
  async function fetchRank(ctx, forceFresh) {
    if (!isEnabled()) return null;

    if (!forceFresh && typeof RSMCache !== 'undefined' && RSMCache.getRank) {
      const cached = RSMCache.getRank(ctx.examId, ctx.date, ctx.shift, ctx.rollNo);
      if (cached) return cached;
    }

    try {
      const url = `${RANK_API_URL}?examId=${encodeURIComponent(ctx.examId)}`
        + `&date=${encodeURIComponent(ctx.date)}`
        + `&shift=${encodeURIComponent(ctx.shift)}`
        + `&rollNo=${encodeURIComponent(ctx.rollNo)}`
        + `&category=${encodeURIComponent(ctx.category || '')}`
        + `&gender=${encodeURIComponent(ctx.gender || '')}`
        + `&zone=${encodeURIComponent(ctx.zone || '')}`;

      const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
      if (!res.ok) return null;
      const data = await res.json();

      if (typeof RSMCache !== 'undefined' && RSMCache.setRank) {
        RSMCache.setRank(ctx.examId, ctx.date, ctx.shift, ctx.rollNo, data);
      }
      return data;
    } catch (e) {
      return null; // offline / timeout / backend down — render() falls back to N/A
    }
  }

  // ── Card builders ──

  function rankCard(label, rank, total) {
    const value = (rank != null && total != null) ? `${rank}/${total}` : 'N/A';
    const pct = percentile(rank, total);
    return `
      <div class="rank-card">
        <div class="rank-card__label">${esc(label)}</div>
        <div class="rank-card__value">${esc(value)}</div>
        <div class="rank-card__divider"></div>
        <div class="rank-card__pct">Percentile: ${esc(pct)}${pct !== 'N/A' ? '%' : ''}</div>
      </div>`;
  }

  function avgCard(label, avg) {
    return `
      <div class="rank-card">
        <div class="rank-card__label">${esc(label)}</div>
        <div class="rank-card__value">${avg == null ? 'N/A' : esc(avg)}</div>
      </div>`;
  }

  function loadingSkeleton(hasZone) {
    const count = hasZone ? 5 : 4;
    const skeletons = Array.from({ length: count }).map(() => `
      <div class="rank-card rank-card--loading">
        <div class="skeleton-line skeleton-line--label"></div>
        <div class="skeleton-line skeleton-line--value"></div>
        <div class="rank-card__divider"></div>
        <div class="skeleton-line skeleton-line--pct"></div>
      </div>`).join('');
    return `<div class="rank-grid">${skeletons}</div>
      <div class="rank-status rank-status--loading">Fetching your rank…</div>`;
  }

  function notFoundBlock(examHasAnyData) {
    const msg = examHasAnyData
      ? 'Your submission is received. Rank will be shown after the next update (within 30 min).'
      : 'Rank not available for this exam yet.';
    return `<div class="rank-status rank-status--na">${esc(msg)}</div>`;
  }

  function renderFound(data, hasZone) {
    const cards = [
      rankCard('Overall Rank', data.overallRank, data.overallTotal),
      rankCard('Shift Rank', data.shiftRank, data.shiftTotal),
      rankCard('Category Rank', data.categoryRank, data.categoryTotal),
      rankCard('Gender Rank', data.genderRank, data.genderTotal)
    ];
    if (hasZone) cards.push(rankCard('Zone Rank', data.zoneRank, data.zoneTotal));

    const avgCards = [
      avgCard('Overall Average', data.overallAverage),
      avgCard('Shift Average', data.shiftAverage),
      avgCard('Category Average', data.categoryAverage)
    ];
    if (hasZone) avgCards.push(avgCard('Zone Average', data.zoneAverage));

    return `
      <div class="rank-grid">${cards.join('')}</div>
      <div class="rank-grid rank-grid--avg">${avgCards.join('')}</div>
      <button type="button" class="rank-refresh-btn" data-rsm-refresh-rank>↻ Refresh Rank</button>`;
  }

  /**
   * Mounts the rank section into a container element, showing a
   * blinking loading skeleton immediately, then replacing it with
   * real data (or an appropriate N/A / "after 30 min" message) once
   * the fetch resolves. Never awaited by the caller — fire-and-forget,
   * exactly like submission.js's pattern, so the score display above
   * it is never delayed.
   *
   * The exact same load() function runs on initial mount AND every
   * time the "Refresh Rank" button is tapped — one code path, no
   * separate "first load" vs "refresh" logic to keep in sync.
   *
   * @param {HTMLElement} containerEl - dedicated rank section element
   * @param {Object} ctx - { examId, date, shift, rollNo, hasZone }
   */
  function mount(containerEl, ctx) {
    if (!containerEl) return;

    if (!isEnabled()) {
      containerEl.innerHTML = notFoundBlock(false);
      return;
    }

    function load(forceFresh) {
      containerEl.innerHTML = loadingSkeleton(ctx.hasZone);

      fetchRank(ctx, forceFresh).then(data => {
        if (!data || data.found === false) {
          containerEl.innerHTML = notFoundBlock(!!(data && data.examHasAnyData)) + refreshButtonHtml();
        } else {
          containerEl.innerHTML = renderFound(data, ctx.hasZone);
        }
        wireRefreshButton();
      }).catch(() => {
        containerEl.innerHTML = notFoundBlock(false) + refreshButtonHtml();
        wireRefreshButton();
      });
    }

    function refreshButtonHtml() {
      return '<button type="button" class="rank-refresh-btn" data-rsm-refresh-rank>↻ Refresh Rank</button>';
    }

    function wireRefreshButton() {
      const btn = containerEl.querySelector('[data-rsm-refresh-rank]');
      // Refresh always forces a real network call, bypassing the
      // 30-min cache entirely — a deliberate manual override.
      if (btn) btn.addEventListener('click', () => load(true));
    }

    load(false); // initial mount — cache-first
  }

  return { mount, percentile };
})();

