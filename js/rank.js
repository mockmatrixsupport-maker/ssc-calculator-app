/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — rank.js (Direct Realtime Multi-Tier Scan Engine)
   Fetches and renders live rank/percentile/average data directly from Supabase,
   completely bypassing serverless layers for maximum performance.

   DESIGN RULES (100% Realtime & Aligned):
   - Percentile is derived client-side from live rank + live total.
   - Rank & Total Candidate Counts are fetched live from database index pointers.
   - Averages are extracted in a single clean pull from the 10-minute cache view.
═══════════════════════════════════════════════════ */

const RSMRank = (() => {

  const SUPABASE_REST_URL = 'https://onqzgzngjteqopnzyscc.supabase.co/rest/v1/rank_master';
  const CACHE_MATRIX_URL = 'https://onqzgzngjteqopnzyscc.supabase.co/rest/v1/cached_analytics_matrix';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ucXpnem5nanRlcW9wbnp5c2NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MjA0NjAsImV4cCI6MjA5OTA5NjQ2MH0.Pq74MzPgzS9VYiyUanjfj4D2A6OTfgGzqzdqbZ0SMiQ';

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

  function percentile(rank, total) {
    if (rank == null || total == null || total <= 0) return 'N/A';
    return (((total - rank) / total) * 100).toFixed(2);
  }

  /**
   * Helper execution wrapper to scan pointers over public composite indexes.
   * Leverages `{ count: 'exact', head: true }` proxy layout.
   */
  async function getLiveCount(queryFilters) {
    try {
      const urlParams = new URLSearchParams(queryFilters);
      const url = `${SUPABASE_REST_URL}?${urlParams.toString()}`;
      
      const res = await withTimeout(fetch(url, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer': 'count=exact' // Instructs Postgres to return exact count from index tree
        }
      }), FETCH_TIMEOUT_MS);

      if (!res.ok) return null;
      
      // Parse Content-Range header (e.g. "0-0/12500") to grab the absolute live count
      const rangeHeader = res.headers.get('Content-Range');
      if (rangeHeader && rangeHeader.includes('/')) {
        return parseInt(rangeHeader.split('/')[1], 10);
      }
      return 0;
    } catch (e) {
      return null;
    }
  }

  /**
   * Main compilation pipeline. Intersects data over direct indices.
   */
  async function processRealtimeEngine(ctx, userScore) {
    const examId = ctx.examId;
    const shiftId = ctx.shift;
    const category = ctx.category;
    const gender = ctx.gender;
    const zone = ctx.zone || null;

    // Parallel execution blocks for Live Ranks and Live Totals (Index-Only Scans)
    const promises = [
      // 1. Overall Tier
      getLiveCount({ exam_id: `eq.${examId}`, score: `gt.${userScore}` }),
      getLiveCount({ exam_id: `eq.${examId}` }),

      // 2. Shift Tier (Shift Rank is the only entity built on shift parameters)
      getLiveCount({ exam_id: `eq.${examId}`, shift_id: `eq.${shiftId}`, score: `gt.${userScore}` }),
      getLiveCount({ exam_id: `eq.${examId}`, shift_id: `eq.${shiftId}` }),

      // 3. Category Tier (Exam level global aggregation)
      getLiveCount({ exam_id: `eq.${examId}`, category: `eq.${category}`, score: `gt.${userScore}` }),
      getLiveCount({ exam_id: `eq.${examId}`, category: `eq.${category}` }),

      // 4. Gender Tier (Exam level global aggregation)
      getLiveCount({ exam_id: `eq.${examId}`, gender: `eq.${gender}`, score: `gt.${userScore}` }),
      getLiveCount({ exam_id: `eq.${examId}`, gender: `eq.${gender}` })
    ];

    // 5. Zone Tier added dynamically only if exam matches RRB parameters
    if (ctx.hasZone && zone) {
      promises.push(getLiveCount({ exam_id: `eq.${examId}`, zone: `eq.${zone}`, score: `gt.${userScore}` }));
      promises.push(getLiveCount({ exam_id: `eq.${examId}`, zone: `eq.${zone}` }));
    }

    const counts = await Promise.all(promises);

    const dataPayload = {
      overallRank: counts[0] !== null ? counts[0] + 1 : null,
      overallTotal: counts[1],
      shiftRank: counts[2] !== null ? counts[2] + 1 : null,
      shiftTotal: counts[3],
      categoryRank: counts[4] !== null ? counts[4] + 1 : null,
      categoryTotal: counts[5],
      genderRank: counts[6] !== null ? counts[6] + 1 : null,
      genderTotal: counts[7],
      zoneRank: null,
      zoneTotal: null,
      
      // Defaults for Averages layer
      overallAverage: 'N/A',
      shiftAverage: 'N/A',
      categoryAverage: 'N/A',
      zoneAverage: 'N/A'
    };

    if (ctx.hasZone && zone) {
      dataPayload.zoneRank = counts[8] !== null ? counts[8] + 1 : null;
      dataPayload.zoneTotal = counts[9];
    }

    // 6. Direct single-row cache matrix pull for pre-calculated averages
    try {
      const matrixRes = await fetch(`${CACHE_MATRIX_URL}?exam_id=eq.${encodeURIComponent(examId)}`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });

      if (matrixRes.ok) {
        const matrixData = await matrixRes.json();
        
        // Map elements by tracking context signatures
        matrixData.forEach(row => {
          if (row.shift_id === 'GLOBAL' && row.category === 'ALL' && row.zone === 'ALL') {
            dataPayload.overallAverage = row.average_score;
          } else if (row.shift_id === shiftId) {
            dataPayload.shiftAverage = row.average_score;
          } else if (row.shift_id === 'GLOBAL' && row.category === category) {
            dataPayload.categoryAverage = row.average_score;
          } else if (row.zone === zone) {
            dataPayload.zoneAverage = row.average_score;
          }
        });
      }
    } catch (e) { /* Averages fallback gracefully to N/A if cron job sync is processing */ }

    return dataPayload;
  }

  // ── Card UI Render Templates

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
        <div class="rank-card__value">${avg == null || avg === 'N/A' ? 'N/A' : esc(avg)}</div>
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
      <div class="rank-status rank-status--loading">Processing real-time rankings…</div>`;
  }

  function notFoundBlock() {
    return `<div class="rank-status rank-status--na">Rank computation anomaly detected. Try refreshing below.</div>`;
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
   * Runtime Mounting Gateway called directly by score-engine.js
   */
  function mount(containerEl, ctx) {
    if (!containerEl) return;

    // Grab live user total score dynamically from the rendered document view context
    let userScore = 0;
    const scoreEl = document.querySelector('.mt-overall .mt-score');
    if (scoreEl) {
      userScore = parseFloat(scoreEl.textContent) || 0;
    }

    function load(forceFresh) {
      containerEl.innerHTML = loadingSkeleton(ctx.hasZone);

      // Bypasses any external cache TTL if manually requested by the student
      if (!forceFresh && typeof RSMCache !== 'undefined' && RSMCache.getRank) {
        const cached = RSMCache.getRank(ctx.examId, ctx.date, ctx.shift, ctx.rollNo);
        if (cached) {
          containerEl.innerHTML = renderFound(cached, ctx.hasZone);
          wireRefreshButton();
          return;
        }
      }

      processRealtimeEngine(ctx, userScore).then(data => {
        if (!data) {
          containerEl.innerHTML = notFoundBlock() + refreshButtonHtml();
        } else {
          containerEl.innerHTML = renderFound(data, ctx.hasZone);
          // Save valid data signature into the short-term storage pool
          if (typeof RSMCache !== 'undefined' && RSMCache.setRank) {
            RSMCache.setRank(ctx.examId, ctx.date, ctx.shift, ctx.rollNo, data);
          }
        }
        wireRefreshButton();
      }).catch(() => {
        containerEl.innerHTML = notFoundBlock() + refreshButtonHtml();
        wireRefreshButton();
      });
    }

    function refreshButtonHtml() {
      return '<button type="button" class="rank-refresh-btn" data-rsm-refresh-rank>↻ Refresh Rank</button>';
    }

    function wireRefreshButton() {
      const btn = containerEl.querySelector('[data-rsm-refresh-rank]');
      if (btn) btn.addEventListener('click', () => load(true));
    }

    load(false);
  }

  return { mount, percentile };
})();

