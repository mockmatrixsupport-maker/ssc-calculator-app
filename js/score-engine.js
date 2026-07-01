/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — score-engine.js
   Takes parsed { candidateInfo, sections[] } + a marking
   scheme (correct/wrong marks) and produces a calculated
   result object, renders it into #resultsSection as a
   compact RankMitra-style scorecard, and saves a
   cache-safe copy via RSMFetchRouter.saveCalculatedResult
   so future fetches of the same URL skip straight to it.

   Rendering is data-only here; all interactive wiring
   (New URL / Share / Image / PDF buttons, edit-bar,
   entering/exiting "result mode") is handled by ui-common.js
   (RSMUI), which this file calls into if present.
═══════════════════════════════════════════════════ */

const RSMScoreEngine = (() => {

  // ── Short-form section names (mobile-friendly table headers) ──
  // Keyword-based: checked as a substring ANYWHERE in the (lowercased)
  // section name, so real-world names like "PART-C (GENERAL INTELLIGENCE
  // AND REASONING)" resolve correctly instead of falling through to a
  // broken initials-acronym (the old word-splitting logic produced
  // garbage like "P(I" for exactly that kind of name).
  const SECTION_KEYWORD_RULES = [
    { keys: ['quant', 'math'], label: 'Maths' },
    { keys: ['intelligence', 'reasoning', 'mental ability'], label: 'Reasoning' },
    { keys: ['general knowledge', 'general awareness', 'general science'], label: 'GK & GS' },
    { keys: ['computer'], label: 'Computer' },
    { keys: ['hindi'], label: 'Hindi' },
    { keys: ['english'], label: 'English' }
  ];

  // Returns a short label if a known keyword matched, or null if the
  // section name didn't match anything — callers should then render
  // the FULL original name (with horizontal scroll) instead of
  // guessing at an acronym.
  function shortSectionName(name) {
    const clean = (name || '').trim();
    const key = clean.toLowerCase();
    for (const rule of SECTION_KEYWORD_RULES) {
      if (rule.keys.some(k => key.includes(k))) return rule.label;
    }
    return null;
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function calculate(parsed, correctMark, wrongMark) {
    let totalCorrect = 0, totalWrong = 0, totalSkipped = 0, totalBonus = 0, totalQ = 0;
    const sectionResults = [];

    parsed.sections.forEach(sec => {
      let c = 0, w = 0, s = 0, b = 0;
      sec.questions.forEach(q => {
        if (q.status === 'correct') c++;
        else if (q.status === 'wrong') w++;
        else if (q.status === 'bonus') b++;
        else s++;
      });
      const total = sec.questions.length;
      const score = (c * correctMark) - (w * wrongMark) + (b * correctMark);
      sectionResults.push({ name: sec.name, total, correct: c, wrong: w, skipped: s, bonus: b, score });

      totalCorrect += c; totalWrong += w; totalSkipped += s; totalBonus += b; totalQ += total;
    });

    const totalScore = (totalCorrect * correctMark) - (totalWrong * wrongMark) + (totalBonus * correctMark);
    const maxScore = totalQ * correctMark;
    const pct = maxScore > 0 ? ((totalScore / maxScore) * 100).toFixed(2) : '0.00';

    return {
      candidateInfo: parsed.candidateInfo,
      sections: sectionResults,
      totalCorrect, totalWrong, totalSkipped, totalBonus, totalQ,
      totalScore: Number(totalScore.toFixed(2)),
      maxScore: Number(maxScore.toFixed(2)),
      pct,
      correctMark, wrongMark,
      // ── Placeholders for a future backend. Structure is final;
      // values are null/N-A until rank/normalisation service exists.
      // These are ALWAYS excluded from cache — see run() below.
      ranks: {
        overallRank: null, overallTotal: null, overallPercentile: null,
        shiftRank: null, shiftTotal: null, shiftPercentile: null,
        categoryRank: null, categoryTotal: null, categoryPercentile: null,
        overallZoneRank: null, overallZoneTotal: null, overallZonePercentile: null,
        shiftZoneRank: null, shiftZoneTotal: null, shiftZonePercentile: null,
        categoryZoneRank: null, categoryZoneTotal: null, categoryZonePercentile: null,
        averageMarks: null, shiftAverageMarks: null, categoryAverageMarks: null
      },
      normalised: { new: null, old: null }
    };
  }

  function fmtRankPair(obj, rankKey, totalKey) {
    if (!obj || obj[rankKey] == null || obj[totalKey] == null) return 'N/A';
    return `${obj[rankKey]}/${obj[totalKey]}`;
  }
  function fmtVal(obj, key, suffix) {
    if (!obj || obj[key] == null) return 'N/A';
    return suffix ? `${obj[key]}${suffix}` : String(obj[key]);
  }

  // ── Candidate detail rows, in display order, only if present ──
  const DETAIL_FIELD_ORDER = [
    ['name', 'Candidate Name'],
    ['rollNo', 'Roll Number'],
    ['exam', 'Subject / Exam Name'],
    ['centre', 'Venue Name'],
    ['date', 'Exam Date'],
    ['shift', 'Exam Time']
  ];

  function buildDetailTable(candidateInfo) {
    const info = candidateInfo || {};
    const rows = DETAIL_FIELD_ORDER
      .filter(([key]) => info[key])
      .map(([key, label]) => `
        <tr>
          <td class="detail-table__label">${esc(label)}</td>
          <td class="detail-table__value">${esc(info[key])}</td>
        </tr>`).join('');
    if (!rows) return '';
    return `<table class="detail-table">${rows}</table>`;
  }

  function buildMarksTable(r) {
    const hasBonus = r.totalBonus > 0;
    const headerCells = [
      '<th class="mt-col-section">Section</th>',
      '<th>Total</th>',
      '<th class="mt-pass">Right</th>',
      '<th class="mt-fail">Wrong</th>',
      hasBonus ? '<th class="mt-bonus">Bonus</th>' : '',
      '<th>Marks</th>'
    ].join('');

    const bodyRows = r.sections.map(s => {
      const short = shortSectionName(s.name);
      const sectionCell = short
        ? `<td class="mt-col-section" title="${esc(s.name)}">${esc(short)}</td>`
        : `<td class="mt-col-section mt-col-section--scroll"><span class="mt-section-scroll" title="${esc(s.name)}">${esc(s.name)}</span></td>`;
      return `
      <tr>
        ${sectionCell}
        <td>${s.total}</td>
        <td class="mt-pass">${s.correct}</td>
        <td class="mt-fail">${s.wrong}</td>
        ${hasBonus ? `<td class="mt-bonus">${s.bonus}</td>` : ''}
        <td class="mt-score">${s.score.toFixed(2)}</td>
      </tr>`;
    }).join('');

    const overallRow = `
      <tr class="mt-overall">
        <td class="mt-col-section">Overall</td>
        <td>${r.totalQ}</td>
        <td class="mt-pass">${r.totalCorrect}</td>
        <td class="mt-fail">${r.totalWrong}</td>
        ${hasBonus ? `<td class="mt-bonus">${r.totalBonus}</td>` : ''}
        <td class="mt-score">${r.totalScore}</td>
      </tr>`;

    return `
      <div class="table-scroll">
        <table class="marks-table">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}${overallRow}</tbody>
        </table>
      </div>`;
  }

  // hasZone: true only for exams that actually have a zone concept
  // (e.g. RRB). SSC has no zone field on the form at all, so those
  // 3 extra cards are simply not shown there — not "N/A", just absent.
  // For zone-aware exams, the cards ARE shown but read "N/A" until a
  // backend ranking service supplies real zone data — that's expected
  // and not an error state.
  function buildRankGrid(ranks, hasZone) {
    const baseCards = [
      ['Overall Rank', fmtRankPair(ranks, 'overallRank', 'overallTotal'), fmtVal(ranks, 'overallPercentile')],
      ['Shift Rank', fmtRankPair(ranks, 'shiftRank', 'shiftTotal'), fmtVal(ranks, 'shiftPercentile')],
      ['Category Rank', fmtRankPair(ranks, 'categoryRank', 'categoryTotal'), fmtVal(ranks, 'categoryPercentile')]
    ];
    const zoneCards = [
      ['Overall Rank (Zone)', fmtRankPair(ranks, 'overallZoneRank', 'overallZoneTotal'), fmtVal(ranks, 'overallZonePercentile')],
      ['Shift Rank (Zone)', fmtRankPair(ranks, 'shiftZoneRank', 'shiftZoneTotal'), fmtVal(ranks, 'shiftZonePercentile')],
      ['Category Rank (Zone)', fmtRankPair(ranks, 'categoryZoneRank', 'categoryZoneTotal'), fmtVal(ranks, 'categoryZonePercentile')]
    ];
    const cards = hasZone ? baseCards.concat(zoneCards) : baseCards;
    return `
      <div class="rank-grid">
        ${cards.map(([label, val, pct]) => `
          <div class="rank-card">
            <div class="rank-card__label">${esc(label)}</div>
            <div class="rank-card__value">${esc(val)}</div>
            <div class="rank-card__pct">Percentile: ${esc(pct)}</div>
          </div>`).join('')}
      </div>`;
  }

  function buildAverageGrid(ranks) {
    const cards = [
      ['Average Marks', fmtVal(ranks, 'averageMarks')],
      ['Shift Average Marks', fmtVal(ranks, 'shiftAverageMarks')],
      ['Category Average Marks', fmtVal(ranks, 'categoryAverageMarks')]
    ];
    return `
      <div class="rank-grid rank-grid--avg">
        ${cards.map(([label, val]) => `
          <div class="rank-card">
            <div class="rank-card__label">${esc(label)}</div>
            <div class="rank-card__value">${esc(val)}</div>
          </div>`).join('')}
      </div>`;
  }

  function buildNormalisedRow(normalised) {
    const n = normalised || {};
    return `
      <div class="rank-grid rank-grid--norm">
        <div class="rank-card">
          <div class="rank-card__label">Normalised Score (New)</div>
          <div class="rank-card__value">${n.new == null ? 'N/A' : esc(n.new)}</div>
        </div>
        <div class="rank-card">
          <div class="rank-card__label">Normalised Score (Old)</div>
          <div class="rank-card__value">${n.old == null ? 'N/A' : esc(n.old)}</div>
        </div>
      </div>`;
  }

  const ICONS = {
    newUrl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="12" y2="11"/></svg>'
  };

  function buildActionRows() {
    return `
      <div class="action-row action-row--primary">
        <button type="button" class="btn-pill" data-action="review-paper">Review Paper</button>
        <button type="button" class="btn-pill" data-action="attempt-mock">Attempt as Mock</button>
      </div>
      <div class="action-row action-row--icons">
        <button type="button" class="icon-btn" data-action="new-url">${ICONS.newUrl}<span>New URL</span></button>
        <button type="button" class="icon-btn" data-action="share">${ICONS.share}<span>Share</span></button>
        <button type="button" class="icon-btn" data-action="image">${ICONS.image}<span>Image</span></button>
        <button type="button" class="icon-btn" data-action="pdf">${ICONS.pdf}<span>PDF</span></button>
      </div>`;
  }

  /**
   * @param {HTMLElement} containerEl - #resultsSection
   * @param {Object} result - output of calculate()
   * @param {Object} [meta] - { url, family, fromCache, uiCtx }
   *   uiCtx (optional) is forwarded to RSMUI so action buttons and
   *   "enter result mode" (hide form / show edit bar) can be wired.
   */
  function renderInto(containerEl, result, meta = {}) {
    const r = result;
    const info = r.candidateInfo || {};
    const headerLabel = info.exam ? info.exam : (meta.family ? meta.family.toUpperCase() + ' Result' : 'Your Result');
    // Zone rank cards only make sense for exams that have a zone concept
    // (currently: RRB). meta.hasZone can override this explicitly if a
    // caller ever needs to; otherwise it's derived from family.
    const hasZone = meta.hasZone != null ? !!meta.hasZone : meta.family === 'rrb';

    containerEl.innerHTML = `
      <div class="card fade-up result-card">
        <div class="result-card__header">${esc(headerLabel)}</div>
        ${meta.fromCache ? '<div class="result-card__cache-note">⚡ Loaded from saved result — no re-fetch needed</div>' : ''}

        ${buildDetailTable(info)}

        ${buildMarksTable(r)}

        ${buildActionRows()}

        <div class="rank-banner">Your Rank Among All Candidates</div>
        ${buildRankGrid(r.ranks, hasZone)}
        ${buildAverageGrid(r.ranks)}
        ${buildNormalisedRow(r.normalised)}
        <div class="result-card__footnote">Rank, percentile &amp; normalised score will appear here once backend ranking is connected.</div>
      </div>`;

    containerEl.classList.remove('hidden');

    if (typeof RSMUI !== 'undefined') {
      const cardEl = containerEl.querySelector('.result-card');
      RSMUI.attachResultActions(cardEl, meta.uiCtx || {}, { url: meta.url, family: meta.family });
      if (meta.uiCtx) RSMUI.enterResultMode(meta.uiCtx, meta.url);
    }
  }

  /**
   * Full pipeline: parse → calculate → render → cache.
   * @param {string} family - 'ssc' | 'rrb'
   * @param {Object} parts - raw fetched HTML parts
   * @param {number} correctMark
   * @param {number} wrongMark
   * @param {HTMLElement} containerEl - where to render the result card
   * @param {string} sourceUrl - original URL, used as the cache key
   * @param {Object} [uiCtx] - passed through to renderInto's meta.uiCtx
   */
  function run(family, parts, correctMark, wrongMark, containerEl, sourceUrl, uiCtx) {
    const parser = family === 'rrb' ? RSMParserRRB : RSMParserSSC;
    const parsed = parser.parse(parts);

    if (!parsed.sections.length || parsed.sections.every(s => s.questions.length === 0)) {
      throw new Error('Answer key parse nahi ho payi. Page format pehchana nahi gaya.');
    }

    const result = calculate(parsed, correctMark, wrongMark);
    renderInto(containerEl, result, { url: sourceUrl, family, uiCtx });

    // Cache only now — fetch + successful calculation both happened.
    // Dynamic fields (ranks, normalised score) are stripped before
    // saving: they must always be N/A-on-load, never stale-from-cache,
    // until a live ranking backend exists.
    const cacheSafeResult = Object.assign({}, result, {
      ranks: null,
      normalised: null
    });
    RSMFetchRouter.saveCalculatedResult(sourceUrl, family, parts, Object.keys(parts).length, cacheSafeResult);

    return result;
  }

  return { calculate, renderInto, run, shortSectionName };
})();

