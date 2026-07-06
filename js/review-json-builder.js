/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — review-json-builder.js
   Builds a UNIFIED review JSON from raw source HTML for
   BOTH exam families:

     • SSC  (sscexams.cbexams.com ViewCandResponse*.aspx)
     • RRB / TCS-iON / digialm (rrb.digialm.com, g06.tcsion.com)

   This file does NOT touch score-engine.js's parser-ssc.js /
   parser-rrb.js (those stay focused on qno+status for scoring).
   This is a SEPARATE, richer extraction used only by the
   Review Paper page — it pulls full question text, option
   text, and image URLs so the review page can render the
   actual paper.

   ── Unified schema produced ──
   {
     meta: {
       family: 'ssc' | 'rrb',
       examName, rollNo, candidateName, date, shift, centre
     },
     sections: [
       {
         name: "Mathematics",
         questions: [
           {
             qno: 1,
             qId: "4410091631384" | null,
             status: "correct" | "wrong" | "skipped" | "bonus",
             question: { text: "...", images: ["url1", "url2"] },
             options: [
               { label: "A", text: "...", images: [], isCorrect: true, isChosen: false },
               ...
             ]
           }
         ]
       }
     ]
   }

   Image URLs are kept EXACTLY as found in the source HTML
   (SSC's qimg/... relative paths are resolved against the
   known SSC image host; RRB/TCS paths are resolved against
   the page's own origin). No re-upload / Cloudinary needed —
   the review page's <img> tags load them directly.
═══════════════════════════════════════════════════ */

const RSMReviewBuilder = (() => {

  function esc(s) { return (s == null) ? '' : String(s); }

  function decodeEntities(s) {
    return (s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripTags(html) {
    return decodeEntities((html || '').replace(/<[^>]+>/g, ' '));
  }

  // ═══════════════════════════════════════════════
  // SSC extraction
  // ═══════════════════════════════════════════════
  const SSC_IMG_BASE = 'https://sscexams.cbexams.com/'; // qimg/... is relative to this host

  function sscResolveImg(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/')) return SSC_IMG_BASE.replace(/\/$/, '') + src;
    return SSC_IMG_BASE + src.replace(/^\.?\//, '');
  }

  function sscExtractImages(block) {
    const imgs = [];
    const re = /<img[^>]*src=['"]([^'"]+)['"][^>]*>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
      imgs.push(sscResolveImg(m[1]));
    }
    return imgs;
  }

  function sscCandidateInfo(html) {
    const info = {};
    const rollM = html.match(/Roll\s*No[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<\s]+)/i);
    if (rollM) info.rollNo = decodeEntities(rollM[1]);
    const nameM = html.match(/Candidate\s*Name[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (nameM) info.candidateName = decodeEntities(nameM[1]);
    const examM = html.match(/<option[^>]*selected[^>]*>([^<]+)<\/option>/i);
    if (examM) info.examName = decodeEntities(examM[1]);
    const dateM = html.match(/Test\s*Date[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (dateM) info.date = decodeEntities(dateM[1]);
    const shiftM = html.match(/Test\s*Time[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (shiftM) info.shift = decodeEntities(shiftM[1]);
    const centreM = html.match(/Centre\s*Name[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (centreM) info.centre = decodeEntities(centreM[1]);
    return info;
  }

  // Parses each "<!-- Option N -->...<!-- Candidate Response -->" block,
  // pulling BOTH the color (for status) and the image/text content.
  function sscParseOptionBlocks(qBlock) {
    const options = [];
    const optRe = /<!--\s*Option\s+(\d+)\s*-->([\s\S]*?)(?=<!--\s*Option\s+\d+\s*-->|<!--\s*Candidate\s*Response|$)/gi;
    let m;
    while ((m = optRe.exec(qBlock)) !== null) {
      const num = parseInt(m[1], 10);
      const block = m[2];
      const bgM = block.match(/<td[^>]*width=['"]2%['"][^>]*bgcolor=['"]([^'"]+)['"][^>]*>/i);
      const color = bgM ? bgM[1].toLowerCase() : null;
      // Option text/images live in the SECOND <td> of the option row
      // (the first <td width='2%'> is just the color marker cell).
      const tdRe = /<td[^>]*width=['"]49%['"][^>]*>([\s\S]*?)<\/td>/i;
      const tdM = block.match(tdRe);
      const contentHtml = tdM ? tdM[1] : block;
      options.push({
        label: String.fromCharCode(64 + num), // 1->A, 2->B...
        text: stripTags(contentHtml),
        images: sscExtractImages(contentHtml),
        color
      });
    }
    return options;
  }

  // Candidate-response row: SSC has no separate "chosen option" text
  // field like RRB does — status + which option was picked is read
  // PURELY from bgcolor, following parser-ssc.js's own documented rule
  // exactly (this file must never re-derive its own reading of that
  // logic from a single sample — the rule below IS the rule):
  //   1. any option green              → CORRECT  (green = user's pick, and it's right)
  //   2. any option red                → WRONG    (red = user's pick, wrong;
  //                                                 the correct one is shown yellow)
  //   3. any option yellow (no green/red) → SKIPPED (not answered, yellow marks correct)
  //   4. no option has any color at all   → BONUS
  //   5. anything else                    → SKIPPED (safe fallback)
  function sscQuestionStatusAndChosen(options) {
    const colors = options.map(o => o.color);
    const hasGreen = colors.includes('green');
    const hasRed = colors.includes('red');
    const hasYellow = colors.includes('yellow');
    const allEmpty = colors.every(c => !c);

    if (hasGreen) return 'correct';
    if (hasRed) return 'wrong';
    if (hasYellow) return 'skipped';
    if (allEmpty) return 'bonus';
    return 'skipped';
  }

  function sscParsePart(html, partNum) {
    let sectionName = `Part ${partNum}`;
    const spanM = html.match(/<span[^>]*id=['"]lblsubject['"][^>]*>([^<]+)<\/span>/i);
    if (spanM) sectionName = decodeEntities(spanM[1]);

    const qPositions = [];
    const qnoRegex = /Q\.No:&nbsp;(\d+)/gi;
    let qm;
    while ((qm = qnoRegex.exec(html)) !== null) {
      qPositions.push({ qno: parseInt(qm[1], 10), pos: qm.index });
    }

    const questions = [];
    qPositions.forEach((qInfo, idx) => {
      const start = qInfo.pos;
      const end = idx + 1 < qPositions.length ? qPositions[idx + 1].pos : html.length;
      const block = html.substring(start, end);

      // Question text/images: the <td width='85%'> right after the Q.No cell.
      const qTdM = block.match(/Q\.No:&nbsp;\d+\s*<\/font>\s*<\/td>\s*<td[^>]*width=['"]85%['"][^>]*>([\s\S]*?)<\/td>/i);
      const qContent = qTdM ? qTdM[1] : '';

      const options = sscParseOptionBlocks(block);
      if (options.length < 4) return; // not a real question block

      const status = sscQuestionStatusAndChosen(options);

      // Maps colors -> flags exactly per the rule above:
      //   green  -> isCorrect: true,  isChosen: true   (user picked right)
      //   red    -> isCorrect: false, isChosen: true   (user picked wrong)
      //   yellow -> isCorrect: true,  isChosen: false  (the right answer,
      //             shown whether the question ended up wrong or skipped)
      //   none   -> isCorrect: false, isChosen: false
      const finalOptions = options.map(o => ({
        label: o.label,
        text: o.text,
        images: o.images,
        isCorrect: o.color === 'green' || o.color === 'yellow',
        isChosen: o.color === 'green' || o.color === 'red'
      }));

      questions.push({
        qno: qInfo.qno,
        qId: null,
        status,
        question: { text: stripTags(qContent), images: sscExtractImages(qContent) },
        options: finalOptions
      });
    });

    return { name: sectionName, questions };
  }

  function buildSSC(parts) {
    const sortedKeys = Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });

    let meta = { family: 'ssc' };
    const sections = [];

    sortedKeys.forEach((key, idx) => {
      const html = parts[key];
      if (Object.keys(meta).length <= 1) {
        const info = sscCandidateInfo(html);
        if (Object.keys(info).length) meta = Object.assign(meta, info);
      }
      sections.push(sscParsePart(html, idx + 1));
    });

    return { meta, sections };
  }

  // ═══════════════════════════════════════════════
  // RRB / TCS-iON / digialm extraction
  // ═══════════════════════════════════════════════

  function rrbResolveImg(src, baseUrl) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
    try {
      return new URL(src, baseUrl || 'https://rrb.digialm.com/').href;
    } catch (e) {
      return src;
    }
  }

  function rrbCandidateInfo(html) {
    const info = {};
    const panelM = html.match(/class=["']main-info-pnl["'][\s\S]*?<table[\s\S]*?<\/table>/i);
    const scope = panelM ? panelM[0] : html;
    const grab = (label) => {
      const re = new RegExp(`<td[^>]*>\\s*${label}\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
      const m = scope.match(re);
      return m ? stripTags(m[1]) : '';
    };
    info.rollNo = grab('Roll\\s*Number');
    info.candidateName = grab('Candidate\\s*Name');
    info.centre = grab('Test\\s*Centre\\s*Name');
    info.date = grab('Test\\s*Date');
    info.shift = grab('Test\\s*Time');
    info.examName = grab('Subject');
    Object.keys(info).forEach(k => { if (!info[k]) delete info[k]; });
    return info;
  }

  function rrbSplitSections(html) {
    const sections = [];
    const lblRegex = /class=["']section-lbl["'][^>]*>([\s\S]*?)<\/div>/gi;
    const labelPositions = [];
    let m;
    while ((m = lblRegex.exec(html)) !== null) {
      const name = stripTags(m[1]).replace(/^Section\s*:?\s*/i, '');
      labelPositions.push({ name: name || 'General', pos: m.index });
    }
    if (labelPositions.length === 0) return [{ name: 'General', html }];
    labelPositions.forEach((lbl, idx) => {
      const end = idx + 1 < labelPositions.length ? labelPositions[idx + 1].pos : html.length;
      sections.push({ name: lbl.name, html: html.substring(lbl.pos, end) });
    });
    return sections;
  }

  function rrbSplitQuestions(sectionHtml) {
    const positions = [];
    const qRegex = /<td[^>]*width=["']7%["'][^>]*>\s*Q\.(\d+)\s*<\/td>/gi;
    let m;
    while ((m = qRegex.exec(sectionHtml)) !== null) {
      positions.push({ qno: parseInt(m[1], 10), pos: m.index });
    }
    const blocks = [];
    positions.forEach((p, idx) => {
      const end = idx + 1 < positions.length ? positions[idx + 1].pos : sectionHtml.length;
      blocks.push({ qno: p.qno, html: sectionHtml.substring(p.pos, end) });
    });
    return blocks;
  }

  // Converts a WIRIS/MathJax-style <img data-mathml="..."> formula image
  // into a lightweight inline marker the review page can render via
  // MathJax, falling back to the img itself if data-mathml is absent.
  // We keep this intentionally simple (no MathML->LaTeX parsing here —
  // that already exists in the standalone python script for JSON export;
  // for in-browser review we just render the formula IMAGE directly,
  // which is simplest and always visually correct).
  function rrbCellContent(tdHtml, baseUrl) {
    // Collect standalone (non-formula) images separately from inline
    // formula images so the caller can decide layout, but for the
    // review page we render everything inline in reading order —
    // so here we just clean text and collect ALL <img> src's in order,
    // replacing each <img> with a placeholder token so text ordering
    // around images is preserved when rendered.
    const images = [];
    let html = tdHtml;
    html = html.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (full, src) => {
      const resolved = rrbResolveImg(src, baseUrl);
      images.push(resolved);
      return ` {{img:${images.length - 1}}} `;
    });
    const text = stripTags(html);
    return { text, images };
  }

  function rrbExtractAnswerRows(block) {
    const rows = [];
    const rowRegex = /class=["'](rightAns|wrngAns)["'][^>]*>[\s\S]*?>\s*([A-Z])\s*\./g;
    let m;
    while ((m = rowRegex.exec(block)) !== null) {
      rows.push({ cls: m[1], letter: m[2].toUpperCase() });
    }
    return rows;
  }

  function rrbExtractChosenOption(block) {
    const m = block.match(/Chosen\s*Option\s*:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    return m ? stripTags(m[1]) : '';
  }

  function rrbExtractQuestionId(block) {
    const m = block.match(/Question\s*ID\s*:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    return m ? stripTags(m[1]) : null;
  }

  function rrbQuestionStatus(chosenRaw, rows) {
    const chosen = chosenRaw.toUpperCase().trim();
    const isRealOption = /^[A-E]$/.test(chosen);
    if (!isRealOption) return 'skipped';
    const chosenRow = rows.find(r => r.letter === chosen);
    if (chosenRow) {
      if (chosenRow.cls === 'rightAns') return 'correct';
      if (chosenRow.cls === 'wrngAns') return 'wrong';
    }
    return 'bonus';
  }

  function rrbParseQuestionBlock(qBlock, baseUrl) {
    // Question text/images: the big <td class="bold" ...> right after the
    // "Q.N" index cell inside the questionRowTbl (before the "Ans" rows).
    const qTextM = qBlock.match(/class=["']bold["'][^>]*style=["'][^"']*text-align:\s*left[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    const qContent = qTextM ? qTextM[1] : '';
    const { text: qText, images: qImages } = rrbCellContent(qContent, baseUrl);

    // Options: each "Ans" row after the first is one option, in
    // <td class="rightAns|wrngAns" ...>ICON A. text</td> form.
    const options = [];
    const optRe = /<td[^>]*class=["'](rightAns|wrngAns)["'][^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = optRe.exec(qBlock)) !== null) {
      const cls = m[1];
      let cellHtml = m[2];
      // The leading tick/cross <img> icon is UI chrome, not option content —
      // strip the very first <img ...> before extracting real content/images.
      cellHtml = cellHtml.replace(/^\s*<img[^>]*>/i, '');
      const letterM = cellHtml.match(/^\s*([A-E])\s*\.\s*/);
      const letter = letterM ? letterM[1] : String.fromCharCode(65 + options.length);
      cellHtml = cellHtml.replace(/^\s*[A-E]\s*\.\s*/, '');
      const { text, images } = rrbCellContent(cellHtml, baseUrl);
      options.push({ label: letter, text, images, cls });
    }

    const rows = rrbExtractAnswerRows(qBlock);
    const chosenRaw = rrbExtractChosenOption(qBlock);
    const status = rrbQuestionStatus(chosenRaw, rows);
    const chosenLetter = chosenRaw.toUpperCase().trim();

    const finalOptions = options.map(o => ({
      label: o.label,
      text: o.text,
      images: o.images,
      isCorrect: o.cls === 'rightAns',
      isChosen: o.label === chosenLetter && /^[A-E]$/.test(chosenLetter)
    }));

    return {
      qId: rrbExtractQuestionId(qBlock),
      status,
      question: { text: qText, images: qImages },
      options: finalOptions
    };
  }

  function buildRRB(parts, sourceUrl) {
    const html = parts.p1 || Object.values(parts)[0] || '';
    const meta = Object.assign({ family: 'rrb' }, rrbCandidateInfo(html));
    const rawSections = rrbSplitSections(html);

    const sections = rawSections.map(sec => {
      const blocks = rrbSplitQuestions(sec.html);
      const questions = blocks.map(b => {
        const parsed = rrbParseQuestionBlock(b.html, sourceUrl);
        return Object.assign({ qno: b.qno }, parsed);
      });
      return { name: sec.name, questions };
    }).filter(s => s.questions.length > 0);

    return { meta, sections };
  }

  // ═══════════════════════════════════════════════
  // Public entry point
  // ═══════════════════════════════════════════════

  /**
   * @param {'ssc'|'rrb'} family
   * @param {Object<string,string>} parts - raw fetched HTML, same shape
   *        score-engine.js already uses ({p1: html, p2: html, ...})
   * @param {string} [sourceUrl] - original answer-key URL, used to resolve
   *        relative image paths for RRB/TCS pages
   * @returns {Object} unified review JSON (see schema at top of file)
   */
  function build(family, parts, sourceUrl) {
    if (family === 'rrb') return buildRRB(parts, sourceUrl);
    return buildSSC(parts);
  }

  return { build };
})();
