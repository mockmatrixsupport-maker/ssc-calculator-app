/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — test.js
   Drives test.html ("Attempt as Mock Test"). Reads the blank
   question-paper JSON handed off from the calculator page
   (built on the fly by RSMReviewBuilder.buildBlank — see
   ui-common.js's openAttemptMock()), runs a real CBT-style
   attempt (welcome screen → timed questions → local score),
   then hands the person's OWN attempt off to review.html
   using the exact same unified schema RSMReviewBuilder
   already produces, so "solution mode" is just review.html
   itself — zero changes needed there.

   ── Handoff in ──
   sessionStorage['rsm-test-handoff'] = {
     blank: { meta:{family,examName}, sections:[{name, questions:[
       { qno, qId, question:{text,images}, options:[{label,text,images,isCorrect}] }
     ]}] },
     family: 'rrb' | 'ssc',
     examId: 'rrb-ntpc-ug-cbt1' | null
   }
   Deleted the instant it's read, same as review.js's handoff.

   ── Handoff out (on "View Detailed Solutions") ──
   sessionStorage['rsm-review-handoff'] = unified review JSON
   (meta.family/examName/rollNo/candidateName, sections[].questions[]
   with status/isChosen filled in from this attempt) — then navigates
   to review.html, which renders it completely unmodified.
═══════════════════════════════════════════════════ */

(function () {
  const TEST_HANDOFF_KEY = 'rsm-test-handoff';
  const REVIEW_HANDOFF_KEY = 'rsm-review-handoff';

  const els = {
    loading: document.getElementById('testLoading'),
    error: document.getElementById('testError'),

    welcome: document.getElementById('testWelcome'),
    welcomeTitle: document.getElementById('welcomeTitle'),
    welcomeMeta: document.getElementById('welcomeMeta'),
    nameInput: document.getElementById('candidateNameInput'),
    rollInput: document.getElementById('candidateRollInput'),
    startBtn: document.getElementById('startTestBtn'),

    root: document.getElementById('testRoot'),
    topTitle: document.getElementById('testTopTitle'),
    topSub: document.getElementById('testTopSub'),
    timerBox: document.getElementById('testTimer'),
    sectionbar: document.getElementById('testSectionbar'),

    qCounter: document.getElementById('testQCounter'),
    qBadge: document.getElementById('testQStatusBadge'),
    qText: document.getElementById('testQText'),
    options: document.getElementById('testOptions'),

    clearBtn: document.getElementById('testClearBtn'),
    markBtn: document.getElementById('testMarkBtn'),
    prevBtn: document.getElementById('testPrevBtn'),
    nextBtn: document.getElementById('testNextBtn'),
    submitSectionBtn: document.getElementById('testSubmitSectionBtn'),

    paletteBtn: document.getElementById('testPaletteBtn'),
    palette: document.getElementById('testPalette'),
    paletteBackdrop: document.getElementById('testPaletteBackdrop'),
    paletteClose: document.getElementById('testPaletteClose'),
    paletteGrid: document.getElementById('testPaletteGrid'),
    paletteSubmit: document.getElementById('testPaletteSubmitBtn'),

    exitBtn: document.getElementById('testExitBtn'),

    summary: document.getElementById('testSummary'),
    summaryBody: document.getElementById('testSummaryBody'),
    viewSolutionsBtn: document.getElementById('testViewSolutionsBtn'),
    backHomeBtn: document.getElementById('testBackHomeBtn')
  };

  let DATA = null;          // consumed handoff: { blank, family, examId }
  let MARKING = { correct: 1, wrong: 0.33 };
  let MARKING_IS_DEFAULT = true; // flips false only once a real exams-{family}.json row is matched
  let EXAM_TITLE = '';
  let FLAT = [];             // [{ gIdx, sIdx, sectionName, qno, qId, question, options }]
  let GROUPS = [];           // [{ label, minutes, secondsLeft, qIdxs:[gIdx,...], status }]
  let currentGroup = 0;
  let currentQ = 0;          // gIdx into FLAT, always within GROUPS[currentGroup].qIdxs
  let ANSWERS = {};          // gIdx -> { selected: 'A'|null, marked: bool, visited: bool }
  let timerHandle = null;
  let candidateName = '', rollNo = '';
  let submitted = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Same rule as review.js's renderContent(): esc() the whole text (safe
  // for math \( \) delimiters, which contain no HTML-special characters),
  // then restore the one deliberate structural marker — a literal "<br>"
  // that RSMReviewBuilder inserts for real line breaks — back into a real
  // line break. {{img:N}} placeholders splice real <img> tags back in.
  function renderContent(content) {
    if (!content) return '';
    let text = esc(content.text || '');
    text = text.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    const images = content.images || [];
    if (!images.length) return text;
    if (/\{\{img:\d+\}\}/.test(text)) {
      return text.replace(/\{\{img:(\d+)\}\}/g, (full, idx) => {
        const url = images[parseInt(idx, 10)];
        return url ? `<img class="rq-img-inline" src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : '';
      });
    }
    return text + images.map(u => `<img class="rq-img-inline" src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer" alt="">`).join('');
  }

  function consumeHandoff() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(TEST_HANDOFF_KEY);
      sessionStorage.removeItem(TEST_HANDOFF_KEY);
    } catch (e) { /* fall through to error state */ }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function wipeHandoff() {
    try { sessionStorage.removeItem(TEST_HANDOFF_KEY); } catch (e) {}
  }
  window.addEventListener('pagehide', wipeHandoff);
  window.addEventListener('beforeunload', wipeHandoff);

  function loadJSON(path) {
    if (typeof RSMLoader !== 'undefined' && RSMLoader.loadJSON) {
      return RSMLoader.loadJSON(path, path);
    }
    return fetch(path).then(r => r.json());
  }

  // Exam config (exams-*.json, exams-*-test-config.json) conventionally
  // lives in data/ alongside this app's other exam-definition JSON —
  // tried first, with a same-name root fetch as a fallback so this
  // still works if a particular deployment keeps them flat instead.
  function loadExamJSON(name) {
    return loadJSON(`data/${name}`).catch(() => loadJSON(name));
  }

  // ── Flatten sections into one linear question list, keeping the
  // section boundary each question belongs to (for the section pill
  // bar + palette grouping). ──
  function flatten(blank) {
    const out = [];
    (blank.sections || []).forEach((sec, sIdx) => {
      (sec.questions || []).forEach(q => {
        out.push({
          gIdx: out.length,
          sIdx,
          sectionName: sec.name,
          qno: q.qno,
          qId: q.qId,
          question: q.question,
          options: q.options || []
        });
      });
    });
    return out;
  }

  // ── Sort sections into timed groups per the test-config, matching by
  // keyword against each section's own name (same technique
  // score-engine.js's shortSectionName already uses). Sections that
  // don't match any configured group each become their own one-section
  // fallback group at defaultGroupMinutes, so nothing is ever silently
  // dropped from the timer even if a paper's section names don't line
  // up with the config's keyword list. ──
  function buildGroups(config) {
    const sectionIdxs = [...new Set(FLAT.map(q => q.sIdx))];
    const sectionNameLower = idx => (
      (FLAT.find(q => q.sIdx === idx) || {}).sectionName || ''
    ).toLowerCase();

    if (!config || config.timerMode !== 'sectional' || !config.groups || !config.groups.length) {
      const minutes = (config && config.totalMinutes) || 90;
      return [{
        label: 'Full Test',
        minutes,
        secondsLeft: minutes * 60,
        qIdxs: FLAT.map(q => q.gIdx),
        status: 'pending'
      }];
    }

    const used = new Set();
    const groups = config.groups.map(g => {
      const matchedSections = sectionIdxs.filter(sIdx => {
        if (used.has(sIdx)) return false;
        const name = sectionNameLower(sIdx);
        return (g.matchSections || []).some(k => name.includes(k));
      });
      matchedSections.forEach(sIdx => used.add(sIdx));
      const qIdxs = FLAT.filter(q => matchedSections.includes(q.sIdx)).map(q => q.gIdx);
      return { label: g.label, minutes: g.minutes, secondsLeft: g.minutes * 60, qIdxs, status: 'pending' };
    }).filter(g => g.qIdxs.length > 0);

    // Any section the config's keyword lists didn't cover still gets a
    // timed slot of its own, appended after the configured groups.
    const leftover = sectionIdxs.filter(sIdx => !used.has(sIdx));
    leftover.forEach(sIdx => {
      const minutes = (config.defaultGroupMinutes) || 15;
      const qIdxs = FLAT.filter(q => q.sIdx === sIdx).map(q => q.gIdx);
      groups.push({ label: sectionNameLower(sIdx) || 'Section', minutes, secondsLeft: minutes * 60, qIdxs, status: 'pending' });
    });

    return groups.length ? groups : buildGroups(null);
  }

  function fmtTime(totalSeconds) {
    const s = Math.max(0, totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  // ── Welcome screen ──
  function renderWelcome() {
    els.welcomeTitle.textContent = EXAM_TITLE || DATA.blank.meta.examName || 'Mock Test';
    const totalQ = FLAT.length;
    const timeLabel = GROUPS.length > 1
      ? `Sectional timer — ${GROUPS.map(g => `${g.label} (${g.minutes}m)`).join(', ')}`
      : `${GROUPS[0].minutes} minutes, composite (move between questions freely)`;
    els.welcomeMeta.innerHTML = `
      ${MARKING_IS_DEFAULT ? `<div class="test-marking-warn">⚠ Couldn't detect this exam's real marking scheme — showing a default (+1 / −0.33). Section/total marks below will use this default unless you started from the exam dropdown on the calculator page.</div>` : ''}
      <div class="test-welcome-row"><b>${esc(String(totalQ))}</b> Questions</div>
      <div class="test-welcome-row">${esc(timeLabel)}</div>
      <div class="test-welcome-row">Marking: <span class="test-mark-pos">+${MARKING.correct}</span> / <span class="test-mark-neg">-${MARKING.wrong}</span></div>
    `;
  }

  // ── Section pill bar ──
  function renderSectionbar() {
    const seen = [];
    FLAT.forEach(q => { if (!seen.includes(q.sIdx)) seen.push(q.sIdx); });
    els.sectionbar.innerHTML = seen.map(sIdx => {
      const name = FLAT.find(q => q.sIdx === sIdx).sectionName;
      const isCurrentSection = FLAT[currentQ].sIdx === sIdx;
      return `<span class="test-sec-pill${isCurrentSection ? ' active' : ''}">${esc(name)}</span>`;
    }).join('');
  }

  // ── Timer ──
  function startGroupTimer() {
    GROUPS[currentGroup].status = 'active';
    updateTimerDisplay();
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const g = GROUPS[currentGroup];
      g.secondsLeft--;
      updateTimerDisplay();
      if (g.secondsLeft <= 0) {
        clearInterval(timerHandle);
        advanceGroupOnTimeout();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const g = GROUPS[currentGroup];
    els.timerBox.textContent = fmtTime(g.secondsLeft);
    els.timerBox.classList.toggle('test-timer--low', g.secondsLeft <= 120);
  }

  function advanceGroupOnTimeout() {
    GROUPS[currentGroup].status = 'closed';
    if (currentGroup >= GROUPS.length - 1) {
      submitTest(true);
      return;
    }
    currentGroup++;
    currentQ = GROUPS[currentGroup].qIdxs[0];
    renderQuestion();
    startGroupTimer();
    if (typeof RSMUI !== 'undefined') RSMUI.toast(`Time up — moved to ${GROUPS[currentGroup].label}`);
  }

  // ── Question render ──
  function statusOf(gIdx) {
    const a = ANSWERS[gIdx];
    if (!a || !a.visited) return 'not-visited';
    if (a.selected && a.marked) return 'answered-marked';
    if (a.selected) return 'answered';
    if (a.marked) return 'marked';
    return 'not-answered';
  }

  function renderQuestion() {
    const q = FLAT[currentQ];
    if (!ANSWERS[currentQ]) ANSWERS[currentQ] = { selected: null, marked: false, visited: false };
    ANSWERS[currentQ].visited = true;

    const posInGroup = GROUPS[currentGroup].qIdxs.indexOf(currentQ) + 1;
    els.qCounter.textContent = `Q${q.qno} · ${posInGroup} / ${GROUPS[currentGroup].qIdxs.length} — ${q.sectionName}`;

    const st = statusOf(currentQ);
    const badgeLabel = { 'answered': 'Answered', 'answered-marked': 'Answered & Marked', 'marked': 'Marked for Review', 'not-answered': 'Not Answered' }[st] || '';
    els.qBadge.textContent = badgeLabel;
    els.qBadge.className = 'test-q-status-badge ' + st;
    els.qBadge.style.display = badgeLabel ? '' : 'none';

    els.qText.innerHTML = renderContent(q.question);

    els.options.innerHTML = q.options.map(o => `
      <button type="button" class="test-option${ANSWERS[currentQ].selected === o.label ? ' selected' : ''}" data-label="${esc(o.label)}">
        <span class="test-option__label">${esc(o.label)}</span>
        <span class="test-option__text">${renderContent({ text: o.text, images: o.images })}</span>
      </button>
    `).join('');

    els.options.querySelectorAll('.test-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const label = btn.getAttribute('data-label');
        if (ANSWERS[currentQ].selected !== label) {
          ANSWERS[currentQ].selected = label;
          renderQuestion();
        }
      });
    });

    els.prevBtn.disabled = posInGroup <= 1;
    els.nextBtn.textContent = posInGroup >= GROUPS[currentGroup].qIdxs.length ? 'Save' : 'Save & Next';
    els.submitSectionBtn.style.display = (GROUPS.length > 1 && currentGroup < GROUPS.length - 1) ? '' : 'none';

    renderSectionbar();
    if (window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([els.qText, els.options]).catch(() => {});
    }
  }

  function moveWithinGroup(delta) {
    const idxs = GROUPS[currentGroup].qIdxs;
    const pos = idxs.indexOf(currentQ);
    const next = pos + delta;
    if (next < 0 || next >= idxs.length) return;
    currentQ = idxs[next];
    renderQuestion();
  }

  els.clearBtn.addEventListener('click', () => {
    ANSWERS[currentQ].selected = null;
    renderQuestion();
  });
  els.markBtn.addEventListener('click', () => {
    ANSWERS[currentQ].marked = !ANSWERS[currentQ].marked;
    renderQuestion();
  });
  els.prevBtn.addEventListener('click', () => moveWithinGroup(-1));
  els.nextBtn.addEventListener('click', () => {
    const idxs = GROUPS[currentGroup].qIdxs;
    const pos = idxs.indexOf(currentQ);
    if (pos < idxs.length - 1) moveWithinGroup(1);
  });

  els.submitSectionBtn.addEventListener('click', () => {
    if (!confirm(`Submit ${GROUPS[currentGroup].label} now and move to the next section? You can't come back to it.`)) return;
    clearInterval(timerHandle);
    GROUPS[currentGroup].status = 'closed';
    currentGroup++;
    currentQ = GROUPS[currentGroup].qIdxs[0];
    renderQuestion();
    startGroupTimer();
  });

  // ── Palette ──
  function renderPalette() {
    els.paletteGrid.innerHTML = GROUPS.map((g, gi) => `
      <div class="test-palette__group-label">${esc(g.label)}${gi === currentGroup ? ' (current)' : gi < currentGroup ? ' (closed)' : ' (locked)'}</div>
      <div class="test-palette__grid">
        ${g.qIdxs.map(gIdx => {
          const st = statusOf(gIdx);
          const disabled = gi > currentGroup ? 'disabled' : '';
          const isCurrent = gIdx === currentQ ? ' current' : '';
          return `<button type="button" class="test-palette__btn ${st}${isCurrent}" data-gidx="${gIdx}" ${disabled}>${FLAT[gIdx].qno}</button>`;
        }).join('')}
      </div>
    `).join('');

    els.paletteGrid.querySelectorAll('.test-palette__btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        currentQ = parseInt(btn.getAttribute('data-gidx'), 10);
        renderQuestion();
        closePalette();
      });
    });
  }

  function openPalette() { renderPalette(); els.palette.classList.add('open'); els.paletteBackdrop.classList.add('open'); }
  function closePalette() { els.palette.classList.remove('open'); els.paletteBackdrop.classList.remove('open'); }
  els.paletteBtn.addEventListener('click', openPalette);
  els.paletteClose.addEventListener('click', closePalette);
  els.paletteBackdrop.addEventListener('click', closePalette);
  els.paletteSubmit.addEventListener('click', () => { closePalette(); confirmSubmit(); });

  els.exitBtn.addEventListener('click', () => {
    if (confirm('Exit this mock test? Your progress will be lost.')) {
      wipeHandoff();
      window.location.href = 'calculator.html' + window.location.search;
    }
  });

  // ── Submit + local scoring (no rank/percentile) ──
  function confirmSubmit() {
    const answered = Object.values(ANSWERS).filter(a => a.selected).length;
    const notAnswered = FLAT.length - answered;
    if (!confirm(`Submit test?\n\nAnswered: ${answered}\nNot answered: ${notAnswered}\n\nThis can't be undone.`)) return;
    submitTest(false);
  }

  function computeResult() {
    let correct = 0, wrong = 0, skipped = 0;
    const sectionMap = new Map();

    FLAT.forEach(q => {
      const a = ANSWERS[q.gIdx] || {};
      const correctOpt = q.options.find(o => o.isCorrect);
      let status;
      if (!a.selected) { status = 'skipped'; skipped++; }
      else if (correctOpt && a.selected === correctOpt.label) { status = 'correct'; correct++; }
      else { status = 'wrong'; wrong++; }

      if (!sectionMap.has(q.sIdx)) sectionMap.set(q.sIdx, { name: q.sectionName, c: 0, w: 0, s: 0 });
      const sm = sectionMap.get(q.sIdx);
      if (status === 'correct') sm.c++; else if (status === 'wrong') sm.w++; else sm.s++;

      q._status = status;
      q._chosen = a.selected || null;
    });

    const score = (correct * MARKING.correct) - (wrong * MARKING.wrong);
    const max = FLAT.length * MARKING.correct;
    const pct = max > 0 ? ((score / max) * 100).toFixed(2) : '0.00';

    return { correct, wrong, skipped, total: FLAT.length, score: Number(score.toFixed(2)), max, pct, sectionMap };
  }

  function renderSummary(result, autoSubmitted) {
    els.root.classList.add('hidden');
    els.summary.classList.remove('hidden');

    const rows = [...result.sectionMap.values()].map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${s.c}</td><td>${s.w}</td><td>${s.s}</td>
        <td>${((s.c * MARKING.correct) - (s.w * MARKING.wrong)).toFixed(2)}</td>
      </tr>`).join('');

    els.summaryBody.innerHTML = `
      ${autoSubmitted ? '<div class="test-summary-note">⏱ Time ran out — your test was submitted automatically.</div>' : ''}
      ${MARKING_IS_DEFAULT ? `<div class="test-summary-note test-summary-note--warn">⚠ Marks below use a default scheme (+${MARKING.correct} / −${MARKING.wrong}), not this exam's real one — its marking couldn't be detected. Re-open this via the exam dropdown on the calculator page for an accurate score.</div>` : ''}
      <div class="test-summary-score">
        <div class="test-summary-score__num">${result.score} <span>/ ${result.max}</span></div>
        <div class="test-summary-score__pct">${result.pct}%</div>
      </div>
      <div class="test-summary-stats">
        <div><b class="pass">${result.correct}</b><span>Correct</span></div>
        <div><b class="fail">${result.wrong}</b><span>Wrong</span></div>
        <div><b class="skip">${result.skipped}</b><span>Skipped</span></div>
      </div>
      <table class="test-summary-table">
        <thead><tr><th>Section</th><th>Right</th><th>Wrong</th><th>Skip</th><th>Marks</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="test-summary-disclaimer">This is a local practice attempt on a past paper — no rank or percentile is calculated.</p>
    `;
  }

  function buildReviewHandoff() {
    const sections = [];
    const bySIdx = new Map();
    FLAT.forEach(q => {
      if (!bySIdx.has(q.sIdx)) { bySIdx.set(q.sIdx, { name: q.sectionName, questions: [] }); sections.push(bySIdx.get(q.sIdx)); }
      bySIdx.get(q.sIdx).questions.push({
        qno: q.qno,
        qId: q.qId,
        status: q._status,
        question: q.question,
        options: q.options.map(o => ({
          label: o.label, text: o.text, images: o.images,
          isCorrect: !!o.isCorrect,
          isChosen: o.label === q._chosen
        }))
      });
    });
    return {
      meta: {
        family: DATA.family,
        examName: EXAM_TITLE || DATA.blank.meta.examName || '',
        candidateName: candidateName || undefined,
        rollNo: rollNo || undefined
      },
      sections
    };
  }

  function submitTest(autoSubmitted) {
    if (submitted) return;
    submitted = true;
    clearInterval(timerHandle);
    const result = computeResult();
    renderSummary(result, autoSubmitted);

    els.viewSolutionsBtn.onclick = () => {
      try {
        sessionStorage.setItem(REVIEW_HANDOFF_KEY, JSON.stringify(buildReviewHandoff()));
        window.location.href = 'review.html';
      } catch (e) {
        if (typeof RSMUI !== 'undefined') RSMUI.toast('Could not open solutions — try again');
      }
    };
  }

  els.backHomeBtn.addEventListener('click', () => {
    window.location.href = 'calculator.html' + window.location.search;
  });

  // ── Start ──
  els.startBtn.addEventListener('click', () => {
    candidateName = (els.nameInput.value || '').trim();
    rollNo = (els.rollInput.value || '').trim();
    els.welcome.classList.add('hidden');
    els.root.classList.remove('hidden');
    els.topTitle.textContent = EXAM_TITLE || DATA.blank.meta.examName || 'Mock Test';
    els.topSub.textContent = [candidateName, rollNo].filter(Boolean).join(' · ');
    currentGroup = 0;
    currentQ = GROUPS[0].qIdxs[0];
    renderQuestion();
    startGroupTimer();
  });

  async function init() {
    DATA = consumeHandoff();
    if (!DATA || !DATA.blank || !DATA.blank.sections || !DATA.blank.sections.length) {
      els.loading.classList.add('hidden');
      els.error.classList.remove('hidden');
      return;
    }

    FLAT = flatten(DATA.blank);
    if (!FLAT.length) {
      els.loading.classList.add('hidden');
      els.error.classList.remove('hidden');
      return;
    }

    const family = DATA.family === 'ssc' ? 'ssc' : 'rrb';
    let examList = [], testConfigMap = {};
    try { examList = await loadExamJSON(`exams-${family}.json`); } catch (e) { examList = []; }
    try { testConfigMap = await loadExamJSON(`exams-${family}-test-config.json`); } catch (e) { testConfigMap = {}; }

    const examObj = examList.find(e => e.id === DATA.examId) || null;
    if (examObj) {
      MARKING = { correct: examObj.correct, wrong: examObj.wrong };
      MARKING_IS_DEFAULT = false;
      EXAM_TITLE = examObj.title;
    }
    const config = (DATA.examId && testConfigMap[DATA.examId]) || testConfigMap._default || null;
    if (config && !EXAM_TITLE) EXAM_TITLE = config.title || '';

    GROUPS = buildGroups(config);

    renderWelcome();
    els.loading.classList.add('hidden');
    els.welcome.classList.remove('hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
