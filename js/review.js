/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — review.js
   Drives review.html. Reads the review JSON that was
   handed off from the calculator page, renders filterable
   question cards (Wrong / Correct / Skipped / Bonus / All),
   and cleans up the handoff data on unload so nothing about
   the review paper is left sitting in app storage.

   ── How the JSON gets here ──
   calculator.html's "Review Paper" button (wired in
   ui-common.js) builds the review JSON on the fly via
   RSMReviewBuilder.build(family, parts, url) using the SAME
   raw HTML `parts` already held in memory for the current
   result (score-engine.js stashes them on the result card as
   cardEl._rsmPdfData.parts). That JSON is handed to this page
   through sessionStorage under a single short-lived key —
   NOT the app's persistent RSMCache/localStorage. This page
   deletes that sessionStorage key itself the moment it has
   read it into memory, and again on pagehide/back-navigation,
   so nothing generated here survives the review session.
═══════════════════════════════════════════════════ */

(function () {
  const HANDOFF_KEY = 'rsm-review-handoff';

  const els = {
    loading: document.getElementById('reviewLoading'),
    error: document.getElementById('reviewError'),
    root: document.getElementById('reviewRoot'),
    title: document.getElementById('reviewTitle'),
    subtitle: document.getElementById('reviewSubtitle'),
    filterbar: document.getElementById('reviewFilterbar'),
    sectionbar: document.getElementById('reviewSectionbar'),
    body: document.getElementById('reviewBody'),
    backBtn: document.getElementById('reviewBackBtn'),
    paletteBtn: document.getElementById('reviewPaletteBtn'),
    palette: document.getElementById('reviewPalette'),
    paletteBackdrop: document.getElementById('reviewPaletteBackdrop'),
    paletteClose: document.getElementById('reviewPaletteClose'),
    paletteGrid: document.getElementById('reviewPaletteGrid'),
    paletteFilterLabel: document.getElementById('reviewPaletteFilterLabel'),
    bottomnav: document.getElementById('reviewBottomnav'),
    prevBtn: document.getElementById('reviewPrevBtn'),
    nextBtn: document.getElementById('reviewNextBtn'),
    navPosition: document.getElementById('reviewNavPosition')
  };

  let DATA = null;          // the unified review JSON
  let FLAT_QUESTIONS = [];  // [{ ...question, sectionName }]
  let currentFilter = 'wrong'; // default per spec: opens on Wrong filter
  let currentIndex = 0;        // position within the current filter's list, drives Prev/Next

  // ── One-time consume of the handoff payload — never re-read, never
  // written back, so a refresh of this page (no payload left) correctly
  // falls through to the "expired" error state rather than resurrecting
  // stale data from a previous review session. ──
  function consumeHandoff() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(HANDOFF_KEY);
      sessionStorage.removeItem(HANDOFF_KEY); // gone the instant we've read it
    } catch (e) { /* storage unavailable — fall through to error state */ }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // Belt-and-braces: also wipe on pagehide/back so nothing lingers even
  // if consumeHandoff() somehow ran twice (e.g. bfcache restore).
  function wipeHandoff() {
    try { sessionStorage.removeItem(HANDOFF_KEY); } catch (e) {}
  }
  window.addEventListener('pagehide', wipeHandoff);
  window.addEventListener('beforeunload', wipeHandoff);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Renders a question/option's {text, images} content, splicing image
  // urls back in at their {{img:N}} placeholder positions.
  //
  // Math formulas are NOT part of `images` — review-json-builder.js
  // already decoded them into literal inline LaTeX ("\( ... \)") text,
  // so they pass straight through esc() untouched (no HTML-special
  // chars in LaTeX delimiters) and get typeset by the MathJax call in
  // renderBody(), the exact same way test.html renders its questions.
  //
  // `<br>` line breaks are also preserved as real text (not stripped
  // by the builder), so esc() below turns them into "&lt;br&gt;" —
  // convert that back into an actual <br> right after, same fix
  // test.html's own getLangText() applies.
  function renderContent(content) {
    if (!content) return '';
    let text = esc(content.text || '');
    text = text.replace(/&lt;br\s*\/?&gt;/gi, '<br>')
               // drop any leading/trailing line breaks left over from
               // the source markup so cards don't start/end with a gap
               .replace(/^(\s*<br\s*\/?>\s*)+/i, '')
               .replace(/(\s*<br\s*\/?>\s*)+$/i, '');
    const images = content.images || [];
    if (!images.length) return text;

    const imgTag = (url) => url
      ? `<img class="rq-img-inline" src="${esc(url)}" loading="lazy" alt="" onerror="this.style.display='none'">`
      : '';

    let out;
    if (/\{\{img:\d+\}\}/.test(text)) {
      out = text.replace(/\{\{img:(\d+)\}\}/g, (full, idx) => imgTag(images[parseInt(idx, 10)]));
    } else {
      // SSC-style: no placeholders, images ARE the content (often
      // bilingual EN/HI stacked) — render text (if any) then every
      // image in order.
      out = text + images.map(imgTag).join('');
    }

    // Source markup separates a stacked EN/HI image pair with
    // "<br><br>" (a full blank line), meant for plain-text spacing.
    // Images are already block-level (each takes its own line via
    // CSS), so keeping those breaks too stacks a blank line ON TOP of
    // the image's own margin — the oversized gap between option rows.
    // Collapse any run of breaks to one, then drop it entirely right
    // next to an image, where it's pure redundant space either way.
    return out
      .replace(/(?:\s*<br\s*\/?>\s*){2,}/gi, '<br>')
      .replace(/<br\s*\/?>\s*(<img)/gi, '$1')
      .replace(/(<img[^>]*>)\s*<br\s*\/?>/gi, '$1');
  }

  const STATUS_LABEL = { correct: 'Correct', wrong: 'Wrong', skipped: 'Skipped', bonus: 'Bonus' };

  function buildOptionRow(opt) {
    const classes = ['review-option'];
    let tag = '';
    if (opt.isCorrect) {
      classes.push('is-correct');
      tag = '<span class="review-option__tag">Correct</span>';
    } else if (opt.isChosen) {
      classes.push('is-chosen-wrong');
      tag = '<span class="review-option__tag">Your pick</span>';
    }
    return `
      <div class="${classes.join(' ')}">
        <div class="review-option__label">${esc(opt.label)}</div>
        <div class="review-option__text">${renderContent({ text: opt.text, images: opt.images })}</div>
        ${tag}
      </div>`;
  }

  // Bottom "your selected option" strip — this is the at-a-glance summary
  // the person asked for: what you picked, colored red/green/neutral,
  // with zero need to re-scan every option row to find it.
  function buildFooter(q) {
    const chosen = (q.options || []).find(o => o.isChosen);
    const correct = (q.options || []).find(o => o.isCorrect);

    if (q.status === 'skipped') {
      return `<div class="review-card__footer">
        <div class="review-answer-box neutral">Not attempted</div>
        ${correct ? `<div class="review-answer-box correct">Correct: <b>${esc(correct.label)}</b></div>` : ''}
      </div>`;
    }
    if (q.status === 'bonus') {
      return `<div class="review-card__footer">
        <div class="review-answer-box neutral">Bonus — marks awarded to all</div>
      </div>`;
    }
    if (q.status === 'correct') {
      return `<div class="review-card__footer">
        <div class="review-answer-box correct">Your answer: <b>${esc(chosen ? chosen.label : (correct ? correct.label : '—'))}</b> ✓ Correct</div>
      </div>`;
    }
    // wrong
    return `<div class="review-card__footer">
      <div class="review-answer-box wrong">Your answer: <b>${esc(chosen ? chosen.label : '—')}</b> ✗</div>
      ${correct ? `<div class="review-answer-box correct">Correct: <b>${esc(correct.label)}</b></div>` : ''}
    </div>`;
  }

  function buildCard(q) {
    return `
      <div class="review-card" id="rq-card-${esc(q.qno)}" data-status="${esc(q.status)}" data-qno="${esc(q.qno)}">
        <div class="review-card__head">
          <span class="review-card__qno">Q${esc(q.qno)}</span>
          <span class="review-status-badge ${esc(q.status)}">${STATUS_LABEL[q.status] || q.status}</span>
        </div>
        <div class="review-card__question">${renderContent(q.question)}</div>
        <div class="review-options">${(q.options || []).map(buildOptionRow).join('')}</div>
        ${buildFooter(q)}
      </div>`;
  }

  function countByStatus(status) {
    if (status === 'all') return FLAT_QUESTIONS.length;
    return FLAT_QUESTIONS.filter(q => q.status === status).length;
  }

  const FILTER_LABEL = { wrong: 'Wrong', correct: 'Correct', skipped: 'Skipped', bonus: 'Bonus', all: 'All' };

  // ── Side palette (question navigator) ──
  // Same idea as a test-taking app's question palette: numbered buttons,
  // colored by status, scoped to whichever filter chip is currently
  // active. Numbers are the qno straight from the source HTML — the
  // same number the candidate saw while attempting the real paper.
  // Buttons carry their position in the CURRENT filter's list (not the
  // qno itself) — SSC papers restart numbering at Q1 in every Part, so
  // matching purely by qno could jump to the wrong section's question.
  function renderPalette() {
    const list = currentList();

    els.paletteFilterLabel.textContent = FILTER_LABEL[currentFilter] || currentFilter;

    if (!list.length) {
      els.paletteGrid.innerHTML = `<div class="review-empty" style="grid-column: 1 / -1;">No questions here.</div>`;
      return;
    }

    els.paletteGrid.innerHTML = list.map((q, idx) => `
      <button type="button" class="review-palette__btn ${esc(q.status)}${idx === currentIndex ? ' active-jump' : ''}" data-idx="${idx}">${esc(q.qno)}</button>
    `).join('');

    els.paletteGrid.querySelectorAll('.review-palette__btn').forEach(btn => {
      btn.addEventListener('click', () => jumpToIndex(parseInt(btn.getAttribute('data-idx'), 10)));
    });
  }

  // Jumps the single-question focus view straight to a given position
  // in the current filter's list — used by both the palette and the
  // section-indicator bar. No scrolling: this just swaps which one
  // question card is on screen, same as tapping Next/Previous.
  function jumpToIndex(idx) {
    closePalette();
    const list = currentList();
    if (idx < 0 || idx >= list.length) return;
    currentIndex = idx;
    renderCurrentQuestion();
  }

  function openPalette() {
    renderPalette();
    els.palette.classList.add('open');
    els.paletteBackdrop.classList.add('open');
  }
  function closePalette() {
    els.palette.classList.remove('open');
    els.paletteBackdrop.classList.remove('open');
  }

  els.paletteBtn.addEventListener('click', openPalette);
  els.paletteClose.addEventListener('click', closePalette);
  els.paletteBackdrop.addEventListener('click', closePalette);

  function renderFilterbar() {
    const filters = [
      { key: 'wrong', label: 'Wrong' },
      { key: 'correct', label: 'Correct' },
      { key: 'skipped', label: 'Skipped' },
      { key: 'bonus', label: 'Bonus' },
      { key: 'all', label: 'All' }
    ].filter(f => f.key === 'all' || countByStatus(f.key) > 0);

    els.filterbar.innerHTML = filters.map(f => `
      <button type="button" class="review-chip${f.key === currentFilter ? ' active' : ''}" data-filter="${f.key}">
        ${f.label} <span class="review-chip__count">${countByStatus(f.key)}</span>
      </button>`).join('');

    els.filterbar.querySelectorAll('.review-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        currentFilter = btn.getAttribute('data-filter');
        renderFilterbar();
        renderBody(); // filter changed — jumps back to question 1 of the new list
        renderPalette(); // keep the side palette in sync with whichever filter is active
      });
    });
  }

  function currentList() {
    return currentFilter === 'all'
      ? FLAT_QUESTIONS
      : FLAT_QUESTIONS.filter(q => q.status === currentFilter);
  }

  // ── Short-form section names (mobile-friendly chip bar) ──
  // Same keyword rules as RSMScoreEngine.shortSectionName() in
  // score-engine.js, kept in sync here since review.js runs on its own
  // page without that file loaded. Two extensions on top of the base
  // rule set, both needed for the section bar specifically:
  //   1. If the real name also carries a number ("Reasoning-2",
  //      "General Awareness 1"), keep it in the short label too
  //      ("Reasoning 2") — otherwise two differently-numbered sections
  //      would collapse into identical, indistinguishable chips.
  //   2. Names that match no keyword at all (score-engine.js's table
  //      just shows these full-width with scroll) don't have room for
  //      that here — the chip bar assigns them sequential fallback
  //      labels instead: PART-A, PART-B, PART-C, PART-D...
  const SECTION_KEYWORD_RULES = [
    { keys: ['quant', 'math', 'numerical'], label: 'Maths' },
    { keys: ['intelligence', 'reasoning', 'mental ability'], label: 'Reasoning' },
    { keys: ['general knowledge', 'general awareness', 'general science'], label: 'GK & GS' },
    { keys: ['computer'], label: 'Computer' },
    { keys: ['hindi'], label: 'Hindi' },
    { keys: ['english'], label: 'English' }
  ];
  const PART_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function shortSectionName(name) {
    const clean = (name || '').trim();
    const key = clean.toLowerCase();
    for (const rule of SECTION_KEYWORD_RULES) {
      if (rule.keys.some(k => key.includes(k))) {
        const numM = clean.match(/\d+/);
        return numM ? `${rule.label} ${numM[0]}` : rule.label;
      }
    }
    return null; // caller assigns the PART-A/B/C/D fallback
  }

  // Builds { fullName -> shortLabel } for every section up front, so
  // the fallback letters stay stable across re-renders (filter change,
  // Prev/Next, palette jumps) instead of shifting around.
  function buildSectionLabelMap(names) {
    const map = {};
    let fallbackIdx = 0;
    names.forEach(name => {
      const short = shortSectionName(name);
      if (short) {
        map[name] = short;
      } else {
        map[name] = 'PART-' + (PART_LETTERS[fallbackIdx] || (fallbackIdx + 1));
        fallbackIdx += 1;
      }
    });
    return map;
  }

  // ── Section indicator bar ──
  // Shows every section name from the paper (Part-A/B, Math/GK/
  // Reasoning, etc.) in its original order, shortened to fit as chips.
  // Whichever section the question currently on screen belongs to is
  // highlighted green. Sections with no questions in the active status
  // filter are shown dimmed and are not clickable. Tapping a section
  // jumps the focus view to that section's first question in the
  // current filter. The full original name is always still available
  // via the chip's title tooltip.
  function renderSectionbar() {
    const names = [];
    (DATA.sections || []).forEach(sec => {
      if (sec.questions && sec.questions.length && !names.includes(sec.name)) names.push(sec.name);
    });

    if (names.length <= 1) {
      els.sectionbar.innerHTML = '';
      return;
    }

    const labelMap = buildSectionLabelMap(names);
    const list = currentList();
    const activeQ = list[currentIndex];

    els.sectionbar.innerHTML = names.map(name => {
      const hasMatch = list.some(q => q.sectionName === name);
      const isActive = !!activeQ && activeQ.sectionName === name;
      const classes = ['review-section-chip'];
      if (isActive) classes.push('active');
      if (!hasMatch) classes.push('disabled');
      return `<button type="button" class="${classes.join(' ')}" data-section="${esc(name)}" title="${esc(name)}" ${hasMatch ? '' : 'disabled'}>${esc(labelMap[name])}</button>`;
    }).join('');

    els.sectionbar.querySelectorAll('.review-section-chip:not(.disabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-section');
        const idx = currentList().findIndex(q => q.sectionName === name);
        if (idx !== -1) jumpToIndex(idx);
      });
    });
  }

  // ── Single-question focus view ──
  // Only ONE question card is ever on screen at a time — no vertical
  // list, no scrolling through the paper. Prev/Next, the palette, and
  // the section bar all just change `currentIndex` and re-render this
  // one card, the same "focus view" test.html itself uses.
  function renderCurrentQuestion() {
    const list = currentList();
    updateBottomNav();
    renderSectionbar();

    if (!list.length) {
      els.body.innerHTML = `<div class="review-empty">No questions in this filter.</div>`;
      return;
    }

    const q = list[currentIndex];
    els.body.innerHTML = buildCard(q);

    // Re-typeset math on the freshly-injected card.
    if (window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([els.body]).catch(() => {});
    }
  }

  // Filter changed (or first load) — always start from the first
  // question of the new list.
  function renderBody() {
    currentIndex = 0;
    renderCurrentQuestion();
  }

  // ── Fixed bottom Previous/Next nav ──
  // Moves through whichever list the active filter chip currently shows —
  // this is the ONLY way through the paper now (no scrolling list): each
  // tap swaps the single card in view via renderCurrentQuestion().
  function updateBottomNav() {
    const list = currentList();
    const total = list.length;
    els.navPosition.textContent = total ? `${currentIndex + 1} / ${total}` : '0 / 0';
    els.prevBtn.disabled = total === 0 || currentIndex <= 0;
    els.nextBtn.disabled = total === 0 || currentIndex >= total - 1;
  }

  els.prevBtn.addEventListener('click', () => {
    if (currentIndex <= 0) return;
    currentIndex -= 1;
    renderCurrentQuestion();
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  els.nextBtn.addEventListener('click', () => {
    const total = currentList().length;
    if (currentIndex >= total - 1) return;
    currentIndex += 1;
    renderCurrentQuestion();
    window.scrollTo({ top: 0, behavior: 'auto' });
  });

  function flatten(data) {
    const out = [];
    (data.sections || []).forEach(sec => {
      (sec.questions || []).forEach(q => {
        out.push(Object.assign({ sectionName: sec.name }, q));
      });
    });
    return out;
  }

  function init() {
    DATA = consumeHandoff();

    if (!DATA || !DATA.sections || !DATA.sections.length) {
      els.loading.classList.add('hidden');
      els.error.classList.remove('hidden');
      return;
    }

    FLAT_QUESTIONS = flatten(DATA);

    const meta = DATA.meta || {};
    els.title.textContent = meta.examName || (meta.family ? meta.family.toUpperCase() + ' Answer Key' : 'Review Paper');
    const bits = [meta.candidateName, meta.rollNo].filter(Boolean);
    els.subtitle.textContent = bits.join(' · ');

    // Default to the Wrong filter if there are any wrong questions,
    // otherwise fall back sensibly so the page never opens empty.
    if (countByStatus('wrong') > 0) currentFilter = 'wrong';
    else if (countByStatus('correct') > 0) currentFilter = 'correct';
    else currentFilter = 'all';

    renderFilterbar();
    renderBody();
    renderPalette();

    els.loading.classList.add('hidden');
    els.root.classList.remove('hidden');
  }

  // Back button — returns to the calculator page. sessionStorage flag
  // set by calculator.html (see ui-common.js wiring) tells it to restore
  // the last-applied result rather than showing a blank form.
  els.backBtn.addEventListener('click', () => {
    wipeHandoff();
    if (window.history.length > 1) window.history.back();
    else window.location.href = 'calculator.html' + window.location.search;
  });

  // review.js is now loaded through RSMLoader.loadScripts (async, so it can
  // check/refresh a cached copy before running) instead of a plain
  // <script src> tag. That means real, non-trivial time passes — network/
  // disk read + parse — between the HTML document finishing parsing and
  // this line actually executing. DOMContentLoaded fires the MOMENT the
  // document is parsed, which happens long before an async script load
  // resolves — so by the time we get here, that event has almost always
  // already fired and is gone for good. Blindly attaching a listener for
  // it then means init() never runs and the page is stuck on its initial
  // spinner forever (confirmed: this was the actual cause of the infinite
  // "Preparing your review paper…" spinner). Guard against both cases:
  // if the DOM is already past loading, run init() immediately; otherwise
  // it's genuinely still safe to wait for the event.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
   


