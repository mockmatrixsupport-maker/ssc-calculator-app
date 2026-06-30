/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — parser-rrb.js  (v2 — rewritten)
   Parses the single-page RRB / DigiAlm response sheet HTML
   into the same { candidateInfo, sections[] } shape the SSC
   parser produces.

   Verified against a real fetched RRB NTPC response page.
   Real structure confirmed:

   CANDIDATE INFO — plain table, no wrapper class on values:
     <tr><td>Roll Number</td><td>247254121825965</td></tr>
     <tr><td>Candidate Name</td><td>VIMAL PRAJAPAT</td></tr>
     <tr><td>Subject</td><td>RRB NTPC UnderGraduate CBT I</td></tr>
     ...

   SECTIONS:
     <div class="section-lbl">
       <span>Section :&nbsp;</span><span class="bold">Mathematics</span>
     </div>

   QUESTIONS — each question starts with "Q.<number>" in a
   <td width="7%" class="bold">, e.g. "Q.1", "Q.99", "Q.100".

   ANSWER ROWS — exactly 4 rows per question, each one's own
   text starts with its own letter ("A.", "B.", "C.", "D.")
   and each row carries class="rightAns" or class="wrngAns":
     <td class="wrngAns">...>A. 15</td>
     <td class="rightAns">...>B. 18</td>
     ...

   METADATA — per question, in the menu-tbl panel:
     <tr><td>Status :</td><td class="bold">Answered</td></tr>
     <tr><td>Chosen Option :</td><td class="bold">C</td></tr>

   STATUS LOGIC (exact rules):
     1. Chosen Option is not a real letter (A/B/C/D) —
        e.g. "--", blank, missing                      → skipped
        (Determined from the Chosen Option value itself,
        NOT from the page's own "Status: Answered /
        Not Answered" text label.)
     2. Chosen Option letter's row class
        is "rightAns"                                  → correct
     3. Chosen Option letter's row class
        is "wrngAns"                                   → wrong
     4. Anything else — chosen letter looked valid but
        no matching row found, malformed block, etc.   → bonus
═══════════════════════════════════════════════════ */

const RSMParserRRB = (() => {

  function decodeEntities(s) {
    return (s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  /**
   * Candidate info — plain "<td>Key</td>  <td>Value</td>" rows inside
   * the .main-info-pnl table. No class wrapper on the value cell.
   */
  function parseCandidateInfo(html) {
    const info = {};
    const panelM = html.match(/class=["']main-info-pnl["'][\s\S]*?<table[\s\S]*?<\/table>/i);
    const scope = panelM ? panelM[0] : html;

    const grab = (label) => {
      const re = new RegExp(`<td[^>]*>\\s*${label}\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
      const m = scope.match(re);
      return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')) : '';
    };

    info.rollNo = grab('Roll\\s*Number');
    info.name = grab('Candidate\\s*Name');
    info.registrationNo = grab('Registration\\s*Number');
    info.community = grab('Community');
    info.centre = grab('Test\\s*Centre\\s*Name');
    info.date = grab('Test\\s*Date');
    info.shift = grab('Test\\s*Time');
    info.exam = grab('Subject');

    Object.keys(info).forEach(k => { if (!info[k]) delete info[k]; });
    return info;
  }

  /**
   * Splits the page into sections using section-lbl markers.
   * Falls back to one "General" section if none found.
   */
  function splitSections(html) {
    const sections = [];
    const lblRegex = /class=["']section-lbl["'][^>]*>([\s\S]*?)<\/div>/gi;
    const labelPositions = [];
    let m;
    while ((m = lblRegex.exec(html)) !== null) {
      const name = decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/^Section\s*:?\s*/i, '');
      labelPositions.push({ name: name || 'General', pos: m.index });
    }

    if (labelPositions.length === 0) {
      return [{ name: 'General', html }];
    }

    labelPositions.forEach((lbl, idx) => {
      const end = idx + 1 < labelPositions.length ? labelPositions[idx + 1].pos : html.length;
      sections.push({ name: lbl.name, html: html.substring(lbl.pos, end) });
    });

    return sections;
  }

  /**
   * Splits a section's html into individual question blocks using
   * the "Q.<number>" marker inside a width="7%" cell, which appears
   * exactly once at the start of every question's row.
   */
  function splitQuestions(sectionHtml) {
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

  /**
   * Extracts each answer row's letter + class from a question block.
   * Each row's own text starts with its own letter ("A.", "B.", etc.),
   * so we read the letter directly from the row rather than assuming
   * row order — this is robust even if rows were ever reordered.
   */
  function extractAnswerRows(block) {
    const rows = [];
    const rowRegex = /class=["'](rightAns|wrngAns)["'][^>]*>[\s\S]*?>\s*([A-Z])\s*\./g;
    let m;
    while ((m = rowRegex.exec(block)) !== null) {
      rows.push({ cls: m[1], letter: m[2].toUpperCase() });
    }
    return rows;
  }

  /**
   * Extracts the raw "Chosen Option" value (e.g. "A", "B", " -- ").
   * This is the actual signal used to decide answered vs not-answered —
   * NOT the page's separate "Status:" text label.
   */
  function extractChosenOption(block) {
    const m = block.match(/Chosen\s*Option\s*:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')) : '';
  }

  /**
   * Status logic — exact rules, evaluated in this priority order:
   *   1. Chosen Option is not a real option letter (A/B/C/D) —
   *      e.g. "--", blank, "-", or missing entirely  → skipped
   *      (We deliberately do NOT trust the page's own "Status:
   *      Answered / Not Answered" text label for this — whether
   *      a real option letter was chosen is the actual signal.)
   *   2. Chosen letter's row has class "rightAns"     → correct
   *   3. Chosen letter's row has class "wrngAns"       → wrong
   *   4. Anything else (chosen letter present but no
   *      matching row found, malformed block, etc.)    → bonus
   */
  function questionStatus(block) {
    const chosenRaw = extractChosenOption(block);
    const chosen = chosenRaw.toUpperCase().trim();
    const rows = extractAnswerRows(block);

    const isRealOption = /^[A-D]$/.test(chosen);

    if (!isRealOption) {
      return 'skipped';
    }

    const chosenRow = rows.find(r => r.letter === chosen);

    if (chosenRow) {
      if (chosenRow.cls === 'rightAns') return 'correct';
      if (chosenRow.cls === 'wrngAns') return 'wrong';
    }

    // Chosen letter looked valid but no row matched it (malformed
    // block, unexpected markup) — treat as bonus per spec.
    return 'bonus';
  }

  function parseSection(section) {
    const blocks = splitQuestions(section.html);
    const questions = blocks.map(b => ({
      qno: b.qno,
      status: questionStatus(b.html)
    }));
    return { name: section.name, questions };
  }

  /**
   * @param {Object<string,string>} parts - RRB fetcher always returns { p1: html }
   * @returns {{ candidateInfo: Object, sections: Array<{name,questions}> }}
   */
  function parse(parts) {
    const html = parts.p1 || Object.values(parts)[0] || '';
    const candidateInfo = parseCandidateInfo(html);
    const rawSections = splitSections(html);
    const sections = rawSections.map(parseSection).filter(s => s.questions.length > 0);

    return { candidateInfo, sections };
  }

  return { parse };
})();
