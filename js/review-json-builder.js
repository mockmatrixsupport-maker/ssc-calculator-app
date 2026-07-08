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

   ── Math + line breaks (matches rrb.py / test.html exactly) ──
   Formula images (WIRIS, <img data-mathml="...">) are never kept
   as <img> — that data-mathml is an obfuscated MathML tree; the
   img's own `src` is either a huge, useless base64 blob or an
   unsupported "data:image/webcam" MIME the browser can't paint at
   all (that's the "box"/broken-image bug). Instead we decode the
   MathML and emit real inline LaTeX text — "\( ... \)" — the exact
   same delimiters test.html's MathJax config expects, so equations
   render inline as text, not as an image or a scrolling box.
   Only genuine standalone diagram/photo images (real http(s)/relative
   server URLs) are kept as <img> and left pointing at the original
   digialm/SSC URL — no Cloudinary re-upload.
   <br> tags are preserved (as literal "<br>") instead of being
   collapsed to a space, so multi-line questions keep their line
   breaks instead of running on as one sentence.
═══════════════════════════════════════════════════ */

const RSMReviewBuilder = (() => {

  function esc(s) { return (s == null) ? '' : String(s); }

  // Non-whitespace, never-occurs-in-real-text placeholder for <br> —
  // survives the whitespace-collapsing step in decodeEntities() below
  // and is turned back into a literal "<br>" right after.
  const BR_TOKEN = '\u0001BR\u0001';

  // Decode ALL HTML entities (not just a hand-picked few) — same fix
  // already used in test.html's getLangText()/decodeHTML() helper and
  // mirrored server-side by rrb.py's html.unescape(). The old version
  // here only handled &nbsp;/&amp;/&lt;/&gt;/&quot;/&#39;, so anything
  // else the source HTML encoded — &lsquo;/&rsquo; (curly quotes),
  // &zwj; (zero-width joiner, common in Hindi conjuncts), &ndash;,
  // &pi;, &theta;, etc. — was left as literal, unreadable entity text
  // in rendered questions ("&lsquo;salt elbow care&rsquo;", "विस्&zwj;तृत").
  // A <textarea>'s innerHTML→value round-trip decodes via the browser's
  // own full HTML entity table, so every named/numeric entity resolves
  // correctly with no maintenance-prone whitelist to keep extending.
  const _decodeEl = (typeof document !== 'undefined') ? document.createElement('textarea') : null;
  function decodeEntities(s) {
    if (!s) return '';
    let out = s;
    if (_decodeEl) {
      _decodeEl.innerHTML = s;
      out = _decodeEl.value;
    } else {
      // Non-DOM fallback (shouldn't normally be hit in this app).
      out = out
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function stripTags(html) {
    // Keep <br> as an actual line break instead of collapsing it to a
    // space — fixes multi-line questions (e.g. coded-relation puzzles)
    // being flattened into a single run-on line.
    let h = (html || '').replace(/<br\s*\/?>/gi, BR_TOKEN);
    h = h.replace(/<[^>]+>/g, ' ');
    h = decodeEntities(h);
    h = h.split(BR_TOKEN).join('<br>');
    return h;
  }

  // ═══════════════════════════════════════════════
  // MathML (WIRIS-encoded) → LaTeX
  // ═══════════════════════════════════════════════
  // Mirrors mathml_to_latex() in rrb.py exactly: digialm/TCS-iON stores
  // each formula as a WIRIS image whose data-mathml="..." attribute
  // holds the real formula, obfuscated (« » stand in for < >, ¨ for ",
  // § for &). We decode that back into real MathML, parse it, and walk
  // the tree emitting \frac{}{}, ^{}, \sqrt{}, etc. — never the alt
  // text (which is just a "spoken" approximation) and never the img's
  // own src (a giant/unsupported-MIME base64 blob).

  const MATHML_DEOBFUSCATE = { '\u00ab': '<', '\u00bb': '>', '\u00a8': '"', '\u00a7': '&' };

  const MO_MAP = {
    '-': '-', '+': '+', '=': '=',
    '\u00d7': '\\times', '\u00f7': '\\div', '\u2212': '-',
    '\u2264': '\\leq', '\u2265': '\\geq', '\u2260': '\\neq',
    '\u00b1': '\\pm', '\u221a': '\\sqrt',
    '(': '(', ')': ')', ',': ',', '%': '\\%',
    '\u00a0': ' '
  };

  // Fallback "spoken alt text" -> symbol cleanup, only used if the
  // MathML fails to decode/parse (mirrors ALT_MAP in rrb.py).
  const ALT_MAP = {
    ' space ': ' ', ' comma ': ', ', ' period ': '.', ' colon ': ': ',
    ' semicolon ': '; ', ' left parenthesis ': '(', ' right parenthesis ': ')',
    ' left bracket ': '[', ' right bracket ': ']',
    ' left brace ': '{', ' right brace ': '}',
    ' vertical line ': '||', ' plus ': '+', ' minus ': '-',
    ' equals ': '=', ' not equals ': '\u2260',
    ' less than ': '<', ' greater than ': '>',
    ' multiplication sign ': '\u00d7', ' division sign ': '\u00f7',
    ' degree ': '\u00b0', ' percent sign ': '%',
    ' square root ': '\u221a', ' squared ': '\u00b2', ' cubed ': '\u00b3',
    ' pi ': '\u03c0', ' alpha ': '\u03b1', ' beta ': '\u03b2', ' theta ': '\u03b8',
    ' newline ': ' ', ' end root ': ''
  };

  function mathmlDeobfuscate(raw) {
    let out = raw || '';
    Object.keys(MATHML_DEOBFUSCATE).forEach(bad => {
      out = out.split(bad).join(MATHML_DEOBFUSCATE[bad]);
    });
    return out;
  }

  function cleanAlt(alt) {
    let t = alt || '';
    Object.keys(ALT_MAP).forEach(k => { t = t.split(k).join(ALT_MAP[k]); });
    return t.replace(/ {2,}/g, ' ').trim();
  }

  function mathmlLocalName(el) {
    const n = el.nodeName || '';
    const i = n.indexOf(':');
    return i === -1 ? n : n.slice(i + 1);
  }

  function mathmlChildren(el) {
    return Array.prototype.filter.call(el.childNodes, n => n.nodeType === 1);
  }

  function mathmlNode(el) {
    const tag = mathmlLocalName(el);
    const text = (el.textContent || '').trim();
    const kids = mathmlChildren(el);
    const childLatex = () => kids.map(mathmlNode).join('');

    switch (tag) {
      case 'math': return childLatex();
      case 'mn': case 'mi': return text;
      case 'mo': return MO_MAP.hasOwnProperty(text) ? MO_MAP[text] : text;
      case 'mtext': return text;
      case 'mrow': return childLatex();
      case 'mfrac': {
        const num = kids[0] ? mathmlNode(kids[0]) : '';
        const den = kids[1] ? mathmlNode(kids[1]) : '';
        return `\\frac{${num}}{${den}}`;
      }
      case 'msup': {
        let base = kids[0] ? mathmlNode(kids[0]) : '';
        const exp = kids[1] ? mathmlNode(kids[1]) : '';
        if (base.length > 1 && !(base.startsWith('(') && base.endsWith(')'))) base = `{${base}}`;
        return `${base}^{${exp}}`;
      }
      case 'msub': {
        const base = kids[0] ? mathmlNode(kids[0]) : '';
        const sub = kids[1] ? mathmlNode(kids[1]) : '';
        return `${base}_{${sub}}`;
      }
      case 'msubsup': {
        const base = kids[0] ? mathmlNode(kids[0]) : '';
        const sub = kids[1] ? mathmlNode(kids[1]) : '';
        const sup = kids[2] ? mathmlNode(kids[2]) : '';
        return `${base}_{${sub}}^{${sup}}`;
      }
      case 'msqrt': return `\\sqrt{${childLatex()}}`;
      case 'mroot': {
        const base = kids[0] ? mathmlNode(kids[0]) : '';
        const idx = kids[1] ? mathmlNode(kids[1]) : '';
        return `\\sqrt[${idx}]{${base}}`;
      }
      case 'mover': {
        const base = kids[0] ? mathmlNode(kids[0]) : '';
        const over = kids[1] ? mathmlNode(kids[1]) : '';
        if (over === '\u00af' || over === '-') return `\\overline{${base}}`;
        return `\\overset{${over}}{${base}}`;
      }
      case 'munder': {
        const base = kids[0] ? mathmlNode(kids[0]) : '';
        const under = kids[1] ? mathmlNode(kids[1]) : '';
        return `\\underset{${under}}{${base}}`;
      }
      case 'mfenced': {
        const opening = el.getAttribute('open') || '(';
        const closing = el.getAttribute('close') || ')';
        const inner = kids.map(mathmlNode).join(',');
        return `${opening}${inner}${closing}`;
      }
      case 'mtable': {
        const rows = kids.map(row => mathmlChildren(row).map(mathmlNode).join(' & '));
        return '\\begin{matrix}' + rows.join(' \\\\ ') + '\\end{matrix}';
      }
      case 'mtr': case 'mtd': case 'mstyle': return childLatex();
      case 'mspace': return ' ';
      default: return childLatex();
    }
  }

  function xmlParseOk(doc) {
    return !!doc && !doc.querySelector('parsererror');
  }

  function mathmlToLatex(rawDataMathml) {
    const decoded = mathmlDeobfuscate(rawDataMathml);
    const parser = new DOMParser();
    let doc = parser.parseFromString(decoded, 'application/xml');
    if (!xmlParseOk(doc)) {
      // Same fallback as rrb.py: escape any stray & that isn't already
      // a valid entity/numeric reference, then retry once.
      const fixed = decoded.replace(/&(?!#?\w+;)/g, '&amp;');
      doc = parser.parseFromString(fixed, 'application/xml');
    }
    if (!xmlParseOk(doc) || !doc.documentElement) return '';
    let latex = mathmlNode(doc.documentElement);
    latex = latex.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return latex;
  }

  // Converts one <img ...> tag (attrs string, no surrounding < >) into
  // the inline text that should replace it:
  //  - data-mathml present  -> "\( latex \)" (falls back to cleaned alt
  //    text only if the MathML itself fails to decode/parse)
  //  - otherwise a real diagram/photo image -> handled by the caller
  //    (kept as an actual <img>, see resolveInlineContent below)
  function mathImgLatex(attrs) {
    const mathmlM = attrs.match(/data-mathml=["']([^"']*)["']/i);
    if (!mathmlM) return null;
    try {
      const latex = mathmlToLatex(mathmlM[1]);
      if (latex) return ` \\(${latex}\\) `;
    } catch (e) { /* fall through to alt-text fallback */ }
    const altM = attrs.match(/alt=["']([^"']*)["']/i);
    const alt = altM ? decodeEntities(altM[1]) : '';
    const cleaned = cleanAlt(alt);
    return cleaned ? ` ${cleaned} ` : ' ';
  }

  // Shared image/math-aware inline-content resolver used by BOTH the
  // SSC and RRB extractors. Walks every <img> in reading order:
  //   • WIRIS formula (data-mathml) -> inline LaTeX text (no <img>,
  //     no Cloudinary — the formula becomes real text for MathJax)
  //   • real http(s)/relative server image -> kept as a genuine image,
  //     resolved to its original absolute URL and returned via the
  //     `images` array + a {{img:N}} placeholder (same mechanism
  //     review.js already renders)
  //   • unusable inline data: URI with no formula behind it (e.g. a
  //     decorative icon) -> dropped, never queued as a broken <img>
  // <br> tags are preserved as literal "<br>" line breaks throughout.
  function resolveInlineContent(html, baseUrl, resolveFn) {
    const images = [];
    let out = (html || '').replace(/<br\s*\/?>/gi, BR_TOKEN);

    out = out.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
      const mathLatex = mathImgLatex(attrs);
      if (mathLatex !== null) return mathLatex;

      const srcM = attrs.match(/src=["']([^"']*)["']/i);
      const src = srcM ? srcM[1] : '';
      if (!src || /^data:/i.test(src)) return ''; // no usable real image

      const resolved = resolveFn(src, baseUrl);
      if (!resolved) return '';
      images.push(resolved);
      return ` {{img:${images.length - 1}}} `;
    });

    out = out.replace(/<[^>]+>/g, ' ');
    out = decodeEntities(out);
    out = out.split(BR_TOKEN).join('<br>');
    return { text: out, images };
  }

  // ═══════════════════════════════════════════════
  // SSC extraction
  // ═══════════════════════════════════════════════
  // qimg/... paths are relative to whatever host/path the answer-key
  // page actually loaded from — NOT a fixed guessed domain. This
  // mirrors mmhtoolup.py exactly: it resolves every image with
  // urljoin(resp.url, src), where resp.url is the real URL the live
  // session fetched. A hardcoded fallback host is wrong for any
  // exam/session using a different subdomain or path, which silently
  // 404s every SSC image (the broken/blank-option bug). SSC_IMG_BASE
  // below is only a last-resort fallback for the rare case no source
  // URL was available to build() at all.
  const SSC_IMG_BASE = 'https://sscexams.cbexams.com/';

  function sscResolveImg(src, baseUrl) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
    try {
      return new URL(src, baseUrl || SSC_IMG_BASE).href;
    } catch (e) {
      if (src.startsWith('/')) return SSC_IMG_BASE.replace(/\/$/, '') + src;
      return SSC_IMG_BASE + src.replace(/^\.?\//, '');
    }
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
  function sscParseOptionBlocks(qBlock, baseUrl) {
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
      const { text, images } = resolveInlineContent(contentHtml, baseUrl, sscResolveImg);
      options.push({
        label: String.fromCharCode(64 + num), // 1->A, 2->B...
        text,
        images,
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

  function sscParsePart(html, partNum, baseUrl) {
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

      const options = sscParseOptionBlocks(block, baseUrl);
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
        question: resolveInlineContent(qContent, baseUrl, sscResolveImg),
        options: finalOptions
      });
    });

    return { name: sectionName, questions };
  }

  function buildSSC(parts, sourceUrl) {
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
      sections.push(sscParsePart(html, idx + 1, sourceUrl));
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

  // WIRIS/MathJax formula images (<img data-mathml="...">) are decoded to
  // real inline LaTeX text via mathmlToLatex()/resolveInlineContent()
  // above — never rendered as an <img> (their own src is either a huge
  // base64 blob or an unsupported "data:image/webcam" MIME the browser
  // can't paint, which is what produced the broken/boxed formulas).
  // Genuine standalone diagram/photo images are kept as real <img> tags
  // pointing at their original digialm URL. <br> line breaks are kept.
  function rrbCellContent(tdHtml, baseUrl) {
    return resolveInlineContent(tdHtml, baseUrl, rrbResolveImg);
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
    return buildSSC(parts, sourceUrl);
  }

  return { build };
})();



