/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — official-print.js
   Takes the SAME raw per-part HTML already sitting in memory on the
   result card (cardEl._rsmPdfData.parts — the exact stash pdf-download.js
   and review.js's builder already read), sanitizes it, merges every
   part into ONE clean document, and hands it off to official-print.html
   for a genuine native print (via capacitor-webview-print) — real
   selectable text, correct pagination, no watermark, no dead portal
   buttons. No canvas/rasterization anywhere in this pipeline.

   WHY SANITIZE AS A STRING, NOT IN A LIVE DOM:
   The official response-sheet pages ship an integrity watchdog script
   that polls document.body.innerHTML every second and force-reloads
   the page (from the exam portal's own servers) the instant it detects
   any change. If we loaded the raw page live and then tried to strip
   the watermark/buttons out of its DOM, that watchdog would detect the
   edit and undo it. So every part's HTML is parsed and cleaned OFFLINE
   via DOMParser (no scripts ever execute) before anything is rendered.

   WHAT GETS REMOVED:
   - Every <script> tag (kills the watermark-restoring watchdog, the
     right-click/Ctrl+P blockers, and any analytics beacons in one go —
     none of them are needed once this is a static merged document)
   - Every element whose class or id contains "watermark" (covers both
     the tiled <div class="watermark-text"> pattern seen on SSC pages
     and the single <div id="watermark"> pattern seen on RRB pages)
   - The portal's own dead navigation buttons ("Click Here for
     PART-A/B/C/..." submit buttons) and any "print panel" the source
     page shipped — irrelevant and non-functional once merged
   - External stylesheet <link> tags (can't reliably resolve relative
     portal paths from inside our app) — the inline <style> blocks
     already present in every part carry the real visible formatting,
     so nothing is lost by dropping the external link
   - The outer <form> wrapper is unwrapped (children kept, the <form>
     tag itself dropped) rather than removed, since the real content —
     tables, questions, options — all live INSIDE it
═══════════════════════════════════════════════════ */

const RSMOfficialPrint = (() => {

  const HANDOFF_KEY = 'rsm-official-print-handoff';

  // Every <img> in the raw portal HTML (tick/cross status icons,
  // qimg/... question images) uses a path relative to whatever page
  // the source portal originally served from — same as the SSC image
  // bug already fixed in review-json-builder.js's sscResolveImg(). Once
  // that markup is merged into OUR OWN app page, those relative paths
  // resolve against the wrong host entirely and 404 (the missing
  // tick/cross icons). Rewrite every src to an absolute URL here,
  // using the real fetched page URL as the base — exactly the same
  // urljoin(resp.url, src) fix mmhtoolup.py already does server-side.
  function resolveImages(doc, baseUrl) {
    if (!baseUrl) return;
    doc.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (!src || /^https?:\/\//i.test(src) || src.startsWith('data:')) return;
      try {
        img.setAttribute('src', new URL(src, baseUrl).href);
      } catch (e) { /* leave malformed src as-is */ }
    });
  }

  function sanitizePart(rawHtml, baseUrl) {
    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

    // Kill every script outright — this alone removes the anti-tamper
    // watchdog, right-click/Ctrl+P blockers, and any tracking beacons.
    doc.querySelectorAll('script').forEach(el => el.remove());

    // Remove every watermark element, whichever pattern this portal used.
    doc.querySelectorAll('[class*="watermark"], [id*="watermark"]').forEach(el => el.remove());

    // Remove the portal's own dead inter-part navigation buttons and
    // any leftover "print panel" — non-functional once merged, and
    // visually just clutter/noise on the final printed page.
    doc.querySelectorAll('input[type="submit"], button, .print-pnl').forEach(el => el.remove());

    // Can't reliably resolve the portal's relative external stylesheet
    // paths from inside the app — drop the link, keep the inline
    // <style> blocks (already present) which carry the real formatting.
    doc.querySelectorAll('link[rel="stylesheet"]').forEach(el => el.remove());

    // Fix every image's src BEFORE serializing — see resolveImages() above.
    resolveImages(doc, baseUrl);

    // Unwrap <form> — keep its children (the real content), drop the
    // tag itself so nothing tries to submit anywhere.
    doc.querySelectorAll('form').forEach(form => {
      const parent = form.parentNode;
      while (form.firstChild) parent.insertBefore(form.firstChild, form);
      parent.removeChild(form);
    });

    const styleBlocks = Array.from(doc.querySelectorAll('style')).map(s => s.innerHTML);
    // Style tags are kept out of bodyHtml (collected separately above)
    // so they aren't duplicated once merged into the final document's
    // single <head>.
    doc.querySelectorAll('style').forEach(el => el.remove());

    return {
      styles: styleBlocks,
      bodyHtml: doc.body ? doc.body.innerHTML : ''
    };
  }

  /**
   * @param {Object<string,string>} parts - e.g. { p1: '<html>...', p2: '...' }
   *   same shape fetcher-ssc.js / fetcher-rrb.js already produce.
   * @param {string} [baseUrl] - the real page URL the parts were fetched
   *   from, used to resolve every relative image src to absolute.
   * @returns {{ styles: string[], bodyHtml: string }}
   */
  function mergeParts(parts, baseUrl) {
    const partKeys = Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });

    const seenStyles = new Set();
    const allStyles = [];
    const bodyPieces = [];

    partKeys.forEach((key, idx) => {
      const { styles, bodyHtml } = sanitizePart(parts[key], baseUrl);
      styles.forEach(s => {
        if (!seenStyles.has(s)) { seenStyles.add(s); allStyles.push(s); }
      });
      // Every part after the first starts on a fresh printed page.
      const pageBreak = idx > 0 ? '<div style="page-break-before: always;"></div>' : '';
      bodyPieces.push(pageBreak + bodyHtml);
    });

    return { styles: allStyles, bodyHtml: bodyPieces.join('\n') };
  }

  /**
   * Mirrors ui-common.js's openReviewPaper() pattern exactly: reads the
   * same cardEl._rsmPdfData.parts stash, builds the merged document,
   * hands it off through sessionStorage (short-lived, consumed once by
   * official-print.html), and navigates there.
   */
  function openOfficialPrint(cardEl, meta) {
    const pdfData = cardEl && cardEl._rsmPdfData;
    const parts = pdfData && pdfData.parts;
    const examName = (meta && meta.examName) || (pdfData && pdfData.examName) || 'Answer Key';
    const url = (meta && meta.url) || (pdfData && pdfData.url);

    if (!parts || !Object.keys(parts).length) {
      return { ok: false, message: 'Please recalculate this result once, then try again' };
    }

    try {
      const merged = mergeParts(parts, url);
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
        title: examName,
        styles: merged.styles,
        bodyHtml: merged.bodyHtml
      }));
      window.location.href = 'official-print.html';
      return { ok: true };
    } catch (e) {
      return { ok: false, message: 'Could not prepare the printable answer key — try again' };
    }
  }

  return { HANDOFF_KEY, mergeParts, openOfficialPrint };
})();

