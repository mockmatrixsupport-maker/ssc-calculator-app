/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — parser-rrb.js
   Parses the single-page RRB / DigiAlm response sheet HTML
   into the same { candidateInfo, sections[] } shape the SSC
   parser produces, so the score engine doesn't care which
   exam family it came from.

   Logic mirrors rrb.py (the proven Python reference):
   - sections are delimited by class="section-cntnr" / "section-lbl"
   - each question row is class="rw"
   - the right/chosen answer cell carries class="rightAns" or "wrngAns"
   - "Chosen Option :" td tells us what the candidate picked;
     if it's "--" the question was not attempted.
═══════════════════════════════════════════════════ */

const RSMParserRRB = (() => {

  function stripTags(s) {
    return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  }

  function parseCandidateInfo(html) {
    const info = {};
    const grab = (label) => {
      const re = new RegExp(`${label}\\s*:?\\s*<\\/td>\\s*<td[^>]*class=["']bold["'][^>]*>([^<]+)<\\/td>`, 'i');
      const m = html.match(re);
      return m ? m[1].trim() : '';
    };
    info.rollNo = grab('Roll\\s*Number');
    info.name = grab('Candidate\\s*Name');
    info.exam = grab('Subject') || grab('Test\\s*Name');
    info.date = grab('Test\\s*Date');
    info.shift = grab('Test\\s*Time');
    info.centre = grab('Test\\s*Centre\\s*Name');
    // drop empty keys so renderResults doesn't show blank rows
    Object.keys(info).forEach(k => { if (!info[k]) delete info[k]; });
    return info;
  }

  /**
   * Splits the full page into section chunks using section-cntnr / section-lbl,
   * falling back to one big "General" section if those markers aren't present.
   */
  function splitSections(html) {
    const sections = [];
    const containerRegex = /<div[^>]*class=["'][^"']*section-cntnr[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*section-cntnr[^"']*["']|$)/gi;
    let m;
    let found = false;
    while ((m = containerRegex.exec(html)) !== null) {
      found = true;
      const chunk = m[1];
      const lblM = chunk.match(/class=["'][^"']*section-lbl[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      let name = lblM ? stripTags(lblM[1]).replace(/^Section\s*:?\s*/i, '') : 'General';
      sections.push({ name: name || 'General', html: chunk });
    }
    if (!found) {
      sections.push({ name: 'General', html });
    }
    return sections;
  }

  /**
   * Splits a section's html into individual question blocks using the
   * "Question ID :" marker, which appears once per question in the
   * metadata table regardless of how the question row itself is wrapped.
   */
  function splitQuestions(sectionHtml) {
    const positions = [];
    const qIdRegex = /Question\s*ID\s*:/gi;
    let m;
    while ((m = qIdRegex.exec(sectionHtml)) !== null) {
      positions.push(m.index);
    }
    const blocks = [];
    positions.forEach((pos, idx) => {
      const end = idx + 1 < positions.length ? positions[idx + 1] : sectionHtml.length;
      blocks.push(sectionHtml.substring(pos, end));
    });
    return blocks;
  }

  function questionStatusFromBlock(block) {
    const chosenM = block.match(/Chosen\s*Option\s*:\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>/i)
                  || block.match(/Chosen\s*Option\s*:[\s\S]{0,80}?class=["']bold["'][^>]*>([^<]+)</i);
    const chosen = chosenM ? chosenM[1].trim() : '--';

    const hasRight = /class=["'][^"']*\brightAns\b[^"']*["']/i.test(block);
    const hasWrong = /class=["'][^"']*\bwrngAns\b[^"']*["']/i.test(block);

    if (chosen === '--' || chosen === '' || /not\s*attempted/i.test(chosen)) {
      return 'skipped';
    }
    if (hasRight && !hasWrong) {
      // chosen option matches the row tagged rightAns
      return 'correct';
    }
    if (hasWrong) {
      return 'wrong';
    }
    // Chosen something but no rightAns/wrngAns markers found — treat as
    // skipped rather than silently miscounting (safer default).
    return 'skipped';
  }

  function parseSection(section, sectionIdx) {
    const blocks = splitQuestions(section.html);
    const questions = blocks.map((block, qIdx) => ({
      qno: qIdx + 1,
      status: questionStatusFromBlock(block)
    })).filter(q => q !== null);
    return { name: section.name || `Section ${sectionIdx + 1}`, questions };
  }

  /**
   * @param {Object<string,string>} parts - RRB fetcher always returns { p1: html }
   * @returns {{ candidateInfo: Object, sections: Array<{name,questions}> }}
   */
  function parse(parts) {
    const html = parts.p1 || Object.values(parts)[0] || '';
    const candidateInfo = parseCandidateInfo(html);
    const rawSections = splitSections(html);
    const sections = rawSections.map((s, i) => parseSection(s, i)).filter(s => s.questions.length > 0);

    return { candidateInfo, sections };
  }

  return { parse };
})();
