/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — parser-ssc.js
   Parses SSC ViewCandResponse.aspx HTML (one or more "parts")
   into a structured { candidateInfo, sections[] } object.

   Each option cell is wrapped as <!-- Option N --> ... and the
   chosen/correct state is read from the bgcolor on the small
   indicator <td width="2%">. green = correct, red = wrong,
   yellow = candidate's wrong-but-marked choice, gray = unattempted.
═══════════════════════════════════════════════════ */

const RSMParserSSC = (() => {

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

  function parseOptions(block) {
    const options = [];
    const optCommentRegex = /<!--\s*Option\s+(\d+)\s*-->([\s\S]*?)(?=<!--\s*Option\s+\d+\s*-->|<!--\s*Candidate\s*Response|$)/gi;
    let m;
    while ((m = optCommentRegex.exec(block)) !== null) {
      const optBlock = m[2];
      const bgM = optBlock.match(/<td[^>]*width=['"]2%['"][^>]*bgcolor=['"](\w+)['"][^>]*>/i);
      options.push({ num: parseInt(m[1], 10), color: bgM ? bgM[1].toLowerCase() : null });
    }
    if (options.length < 4) return parseOptionsFallback(block);
    return options;
  }

  function parseOptionsFallback(block) {
    const options = [];
    const tdRegex = /<tr[^>]*>[\s\S]*?<td[^>]*width=['"]2%['"][^>]*(?:bgcolor=['"](\w+)['"])?[^>]*>/gi;
    let m, count = 0;
    while ((m = tdRegex.exec(block)) !== null && count < 8) {
      const full = m[0].toLowerCase();
      if (full.includes("valign='top'") || full.includes('valign="top"')) continue;
      options.push({ num: count + 1, color: m[1] ? m[1].toLowerCase() : null });
      count++;
    }
    return options.slice(0, 8);
  }

  function questionStatus(options) {
    const colors = options.map(o => o.color);
    const real = colors.filter(c => c !== null);
    if (real.length === 0) return 'skipped';
    if (colors.includes('green') && !colors.includes('red')) return 'correct';
    if (colors.includes('red')) return 'wrong';
    if (colors.includes('yellow') && !colors.includes('green') && !colors.includes('red')) return 'skipped';
    if (colors.every(c => c === 'gray' || c === null)) return 'skipped';
    if (colors.filter(c => c === 'green').length > 1) return 'bonus';
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
      if (idx === 0 || Object.keys(candidateInfo).length === 0) {
        candidateInfo = parseCandidateInfo(html);
      }
      sections.push(parsePart(html, idx + 1));
    });

    return { candidateInfo, sections };
  }

  return { parse };
})();
