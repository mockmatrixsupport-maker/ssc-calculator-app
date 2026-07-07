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
  // urls back in at their {{img:N}} placeholder positions (RRB path) or
  // just appending them after the text (SSC path, which is pure images
  // with no interleaved placeholder text).
  function renderContent(content) {
    if (!content) return '';
    const text = esc(content.text || '');
    const images = content.images || [];
    if (!images.length) return text;

    if (/\{\{img:\d+\}\}/.test(text)) {
      return text.replace(/\{\{img:(\d+)\}\}/g, (full, idx) => {
        const url = images[parseInt(idx, 10)];
        return url ? `<img class="rq-img-inline" src="${esc(url)}" loading="lazy" alt="">` : '';
      });
    }
    // SSC-style: no placeholders, images ARE the content (often bilingual
    // EN/HI stacked) — render text (if any) then every image in order.
    const imgTags = images.map(u => `<img class="rq-img-inline" src="${esc(u)}" loading="lazy" alt="">`).join('');
    return text + imgTags;
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
  function renderPalette() {
    const list = currentFilter === 'all'
      ? FLAT_QUESTIONS
      : FLAT_QUESTIONS.filter(q => q.status === currentFilter);

    els.paletteFilterLabel.textContent = FILTER_LABEL[currentFilter] || currentFilter;

    if (!list.length) {
      els.paletteGrid.innerHTML = `<div class="review-empty" style="grid-column: 1 / -1;">No questions here.</div>`;
      return;
    }

    els.paletteGrid.innerHTML = list.map(q => `
      <button type="button" class="review-palette__btn ${esc(q.status)}" data-qno="${esc(q.qno)}">${esc(q.qno)}</button>
    `).join('');

    els.paletteGrid.querySelectorAll('.review-palette__btn').forEach(btn => {
      btn.addEventListener('click', () => jumpToQuestion(btn.getAttribute('data-qno')));
    });
  }

  function jumpToQuestion(qno) {
    closePalette();
    const list = currentList();
    const idx = list.findIndex(q => String(q.qno) === String(qno));
    if (idx !== -1) {
      currentIndex = idx;
      updateBottomNav();
    }
    const target = document.getElementById('rq-card-' + qno);
    if (!target) return;
    setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('active-jump');
      setTimeout(() => target.classList.remove('active-jump'), 1400);
    }, 220); // let the panel's own slide-out transition finish first
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
        renderBody();
        renderPalette(); // keep the side palette in sync with whichever filter is active
        window.scrollTo({ top: els.filterbar.offsetTop - 1, behavior: 'smooth' });
      });
    });
  }

  function currentList() {
    return currentFilter === 'all'
      ? FLAT_QUESTIONS
      : FLAT_QUESTIONS.filter(q => q.status === currentFilter);
  }

  function renderBody() {
    const list = currentList();
    currentIndex = 0; // filter just changed (or first render) — reset to the first question in it
    updateBottomNav();

    if (!list.length) {
      els.body.innerHTML = `<div class="review-empty">No questions in this filter.</div><div class="review-scroll-spacer"></div>`;
      return;
    }

    // Group by section for readability, preserving original section order.
    const bySection = [];
    const seen = new Map();
    list.forEach(q => {
      if (!seen.has(q.sectionName)) {
        seen.set(q.sectionName, { name: q.sectionName, items: [] });
        bySection.push(seen.get(q.sectionName));
      }
      seen.get(q.sectionName).items.push(q);
    });

    els.body.innerHTML = bySection.map(sec => `
      <div class="review-section-heading">${esc(sec.name)}</div>
      ${sec.items.map(buildCard).join('')}
    `).join('') + '<div class="review-scroll-spacer"></div>';

    // Re-typeset any math on the freshly-injected cards.
    if (window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([els.body]).catch(() => {});
    }
  }

  // ── Fixed bottom Previous/Next nav ──
  // Moves through whichever list the active filter chip currently shows,
  // same list order the cards are rendered in (grouped by section, but
  // flattened here since only linear position matters for Prev/Next).
  function updateBottomNav() {
    const list = currentList();
    const total = list.length;
    els.navPosition.textContent = total ? `${currentIndex + 1} / ${total}` : '0 / 0';
    els.prevBtn.disabled = total === 0 || currentIndex <= 0;
    els.nextBtn.disabled = total === 0 || currentIndex >= total - 1;
  }

  function scrollToIndex(idx) {
    const list = currentList();
    const q = list[idx];
    if (!q) return;
    const target = document.getElementById('rq-card-' + q.qno);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('active-jump');
    setTimeout(() => target.classList.remove('active-jump'), 1400);
  }

  els.prevBtn.addEventListener('click', () => {
    if (currentIndex <= 0) return;
    currentIndex -= 1;
    updateBottomNav();
    scrollToIndex(currentIndex);
  });
  els.nextBtn.addEventListener('click', () => {
    const total = currentList().length;
    if (currentIndex >= total - 1) return;
    currentIndex += 1;
    updateBottomNav();
    scrollToIndex(currentIndex);
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
   
