/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — score-engine.js
   Takes parsed { candidateInfo, sections[] } + a marking
   scheme (correct/wrong marks) and produces a calculated
   result object, renders it into #resultsSection, and saves
   it to RSMCache via RSMFetchRouter.saveCalculatedResult so
   future fetches of the same URL skip straight to this result.
═══════════════════════════════════════════════════ */

const RSMScoreEngine = (() => {

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
      correctMark, wrongMark
    };
  }

  function renderInto(containerEl, result) {
    const r = result;

    const scoreGridHtml = `
      <div class="score-grid">
        <div class="score-box score-box--total">
          <div class="score-box__num">${r.totalScore}</div>
          <div class="score-box__label">Score / ${r.maxScore}</div>
        </div>
        <div class="score-box"><div class="score-box__num">${r.pct}%</div><div class="score-box__label">Percentage</div></div>
        <div class="score-box"><div class="score-box__num score-pass">${r.totalCorrect}</div><div class="score-box__label">Correct</div></div>
        <div class="score-box"><div class="score-box__num score-fail">${r.totalWrong}</div><div class="score-box__label">Wrong</div></div>
        <div class="score-box"><div class="score-box__num score-skip">${r.totalSkipped}</div><div class="score-box__label">Skipped</div></div>
        <div class="score-box"><div class="score-box__num score-bonus">${r.totalBonus}</div><div class="score-box__label">Bonus</div></div>
        <div class="score-box"><div class="score-box__num">${r.totalQ}</div><div class="score-box__label">Total Qs</div></div>
        <div class="score-box"><div class="score-box__num" style="font-size:1.1rem">+${r.correctMark}/−${r.wrongMark}</div><div class="score-box__label">Marking</div></div>
      </div>`;

    const sectionsTableHtml = `
      <table style="width:100%; border-collapse:collapse; margin-top:var(--sp-4); font-size:0.78rem;">
        <thead>
          <tr style="text-align:left; border-bottom:1px solid var(--border);">
            <th style="padding:6px 4px; color:var(--text-muted); font-weight:600;">Section</th>
            <th style="padding:6px 4px; color:var(--text-muted); font-weight:600;">Qs</th>
            <th style="padding:6px 4px; color:var(--pass); font-weight:600;">✓</th>
            <th style="padding:6px 4px; color:var(--fail); font-weight:600;">✗</th>
            <th style="padding:6px 4px; color:var(--skip); font-weight:600;">–</th>
            <th style="padding:6px 4px; color:var(--text-muted); font-weight:600;">Score</th>
          </tr>
        </thead>
        <tbody>
          ${r.sections.map(s => `
            <tr style="border-bottom:1px solid var(--rule);">
              <td style="padding:7px 4px;">${s.name}</td>
              <td style="padding:7px 4px;">${s.total}</td>
              <td style="padding:7px 4px; color:var(--pass);">${s.correct}</td>
              <td style="padding:7px 4px; color:var(--fail);">${s.wrong}</td>
              <td style="padding:7px 4px; color:var(--skip);">${s.skipped}</td>
              <td style="padding:7px 4px; font-weight:600;">${s.score.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    const candidateHtml = Object.keys(r.candidateInfo || {}).length ? `
      <div class="form-grid-2 mt-4">
        ${Object.entries(r.candidateInfo).map(([k, v]) => `
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" style="text-transform:capitalize;">${k.replace(/([A-Z])/g, ' $1')}</label>
            <div style="font-size:0.82rem; font-weight:600; color:var(--text-primary);">${v}</div>
          </div>`).join('')}
      </div>` : '';

    containerEl.innerHTML = `
      <div class="card fade-up">
        <div class="section-label">Your Result</div>
        ${scoreGridHtml}
        ${candidateHtml}
        <div class="divider"></div>
        ${sectionsTableHtml}
      </div>`;
    containerEl.classList.remove('hidden');
  }

  /**
   * Full pipeline: parse → calculate → render → cache.
   * @param {string} family - 'ssc' | 'rrb'
   * @param {Object} parts - raw fetched HTML parts
   * @param {number} correctMark
   * @param {number} wrongMark
   * @param {HTMLElement} containerEl - where to render the result card
   * @param {string} sourceUrl - original URL, used as the cache key
   */
  function run(family, parts, correctMark, wrongMark, containerEl, sourceUrl) {
    const parser = family === 'rrb' ? RSMParserRRB : RSMParserSSC;
    const parsed = parser.parse(parts);

    if (!parsed.sections.length || parsed.sections.every(s => s.questions.length === 0)) {
      throw new Error('Answer key parse nahi ho payi. Page format pehchana nahi gaya.');
    }

    const result = calculate(parsed, correctMark, wrongMark);
    renderInto(containerEl, result);

    // Cache only now — fetch + successful calculation both happened.
    RSMFetchRouter.saveCalculatedResult(sourceUrl, family, parts, Object.keys(parts).length, result);

    return result;
  }

  return { calculate, renderInto, run };
})();
