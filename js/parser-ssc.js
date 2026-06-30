/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — parser-ssc.js  (v2)
   Parses SSC ViewCandResponse.aspx HTML (one or more "parts")
   into a structured { candidateInfo, sections[] } object.

   Question/Option extraction is unchanged from v1 (already
   proven solid). What changed is the STATUS LOGIC — rewritten
   to match the exact rules below instead of inferring from
   mixed signals:

     • bgcolor = green   →  CORRECT   (this option is right)
     • bgcolor = red      →  WRONG     (candidate picked wrong)
     • bgcolor = yellow   →  SKIPPED   (not answered, but the
                                        correct option highlighted)
     • no bgcolor at all  →  BONUS     (question discarded /
                                        marks given to everyone —
                                        e.g. SSC's "Purple" marker
                                        rows, or any case with zero
                                        colored options)
     • anything else      →  SKIPPED   (safe fallback)

   NOTE: no scoring/marks math happens here — that's score-engine.js.
   This file only classifies each question's status.
═══════════════════════════════════════════════════ */

const RSMParserSSC = (() => {

  /**
   * Pulls candidate info from WHICHEVER part contains it.
   * Some SSC links omit candidate details on part 1 (e.g. it only
   * appears on part 2 or 3) — so this is called across every part's
   * HTML, not just the first, and the first non-empty result wins.
   */
  function parseCandidateInfo(html) {
    const info = {};
    const rollM = html.match(/Roll\s*No[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<\s]+)/i);
    if (rollM) info.rollNo = rollM[1].trim();
    const nameM = html.match(/Candidate\s*Name[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (nameM) info.name = nameM[1].trim();
    const examM = html.match(/<option[^>]*selected[^>]*>([^<]+)<\/option>/i);
    if (examM) info.exam = examM[1].trim();
    const dateM = html.match(/Test\s*Date[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (dateM) info.date = dateM[1].trim();
    const shiftM = html.match(/Test\s*Time[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (shiftM) info.shift = shiftM[1].trim();
    const centreM = html.match(/Centre\s*Name[^<]*<\/td>\s*<td[^>]*>:?&nbsp;&nbsp;&nbsp;([^<]+)/i);
    if (centreM) info.centre = centreM[1].trim();
    return info;
  }

  function isInfoEmpty(info) {
    return !info || Object.keys(info).length === 0;
  }

  function parseOptions(block) {
    const options = [];
    const optCommentRegex = /<!--\s*Option\s+(\d+)\s*-->([\s\S]*?)(?=<!--\s*Option\s+\d+\s*-->|<!--\s*Candidate\s*Response|$)/gi;
    let m;
    while ((m = optCommentRegex.exec(block)) !== null) {
      const optBlock = m[2];
      // bgcolor can be single OR double quoted in real SSC pages
      const bgM = optBlock.match(/<td[^>]*width=['"]2%['"][^>]*bgcolor=['"]([^'"]+)['"][^>]*>/i);
      options.push({ num: parseInt(m[1], 10), color: bgM ? bgM[1].toLowerCase() : null });
    }
    if (options.length < 4) return parseOptionsFallback(block);
    return options;
  }

  function parseOptionsFallback(block) {
    const options = [];
    const tdRegex = /<tr[^>]*>[\s\S]*?<td[^>]*width=['"]2%['"][^>]*(?:bgcolor=['"]([^'"]+)['"])?[^>]*>/gi;
    let m, count = 0;
    while ((m = tdRegex.exec(block)) !== null && count < 8) {
      const full = m[0].toLowerCase();
      if (full.includes("valign='top'") || full.includes('valign="top"')) continue;
      options.push({ num: count + 1, color: m[1] ? m[1].toLowerCase() : null });
      count++;
    }
    return options.slice(0, 8);
  }

  /**
   * Status logic — exact rules, evaluated in this priority order:
   *   1. any option green             → correct
   *   2. any option red                → wrong
   *   3. any option yellow (no green/red) → skipped
   *   4. no option has any color at all   → bonus
   *   5. anything else (unexpected colors, mixed junk) → skipped
   */
  function questionStatus(options) {
    const colors = options.map(o => o.color);
    const hasGreen = colors.includes('green');
    const hasRed = colors.includes('red');
    const hasYellow = colors.includes('yellow');
    const allEmpty = colors.every(c => c === null || c === '');

    if (hasGreen) return 'correct';
    if (hasRed) return 'wrong';
    if (hasYellow) return 'skipped';
    if (allEmpty) return 'bonus';
    return 'skipped';
  }

  function parsePart(html, partNum) {
    let sectionName = `Part ${partNum}`;
    const spanM = html.match(/<span[^>]*id=['"]lblsubject['"][^>]*>([^<]+)<\/span>/i);
    if (spanM) sectionName = spanM[1].trim();

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
      const options = parseOptions(block);
      if (options.length >= 4) {
        questions.push({ qno: qInfo.qno, status: questionStatus(options) });
      }
    });

    return { name: sectionName, questions };
  }

  /**
   * @param {Object<string,string>} parts - { p1: html, p2: html, ... }
   * @returns {{ candidateInfo: Object, sections: Array<{name,questions}> }}
   */
  function parse(parts) {
    const sortedKeys = Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });

    let candidateInfo = {};
    const sections = [];

    sortedKeys.forEach((key, idx) => {
      const html = parts[key];

      // Candidate details may not be on every part (some SSC links omit
      // them on part 1 and only carry them on part 2/3) — so check EVERY
      // part until we find a non-empty result, instead of only checking idx 0.
      if (isInfoEmpty(candidateInfo)) {
        const found = parseCandidateInfo(html);
        if (!isInfoEmpty(found)) candidateInfo = found;
      }

      sections.push(parsePart(html, idx + 1));
    });

    return { candidateInfo, sections };
  }

  return { parse };
})();
