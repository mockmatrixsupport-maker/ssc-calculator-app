/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Generates the PDF for the result card's PDF button
   entirely in the background — no new tab/window ever
   opens, the person just taps the button and a file
   downloads.

   Called from ui-common.js's attachResultActions():
     RSMPdfDownload.handlePdfClick(btn, cardEl._rsmPdfData)
   where cardEl._rsmPdfData = { parts, family, url } is
   stashed by score-engine.js when the result renders.

   How it works, for both families:
     1. Each raw part page (RRB has one, "p1"; SSC has one
        per response-sheet part) is loaded into a detached,
        off-screen iframe. Its inline <script> tags are
        stripped first (SSC pages block Ctrl+P / right-click
        via inline JS — we don't want that running), and any
        watermark overlay (#lblWatermark / .watermark-container,
        which SSC tiles across the page) is removed from the
        DOM before capture.
     2. Each part is rendered to its own single-page PDF via
        html2pdf.js (canvas capture + jsPDF), sized exactly to
        its content — no page breaks needed.
     3. If there's only one part (RRB, or a single-part SSC
        result), that PDF is downloaded directly. If there are
        multiple parts (SSC), all of them are merged into ONE
        final PDF via pdf-lib and that merged file is downloaded.

   html2pdf.js / pdf-lib are lazy-loaded from CDN, and pdf-lib
   is only pulled in at all when a merge is actually needed.
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  const PDFLIB_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  // Matches the SSC watermark markup (#lblWatermark > .watermark-container
  // full of tiled .watermark-text divs) plus a generic id/class fallback.
  // Harmless no-op on RRB pages, which don't have this overlay at all.
  const WATERMARK_SELECTOR = '#lblWatermark, .watermark-container, [id*="watermark" i], [class*="watermark" i]';

  let html2pdfLoading = null;
  let pdfLibLoading = null;

  // ── CDN script loading (once, cached) ──
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureHtml2Pdf() {
    if (typeof window.html2pdf !== 'undefined') return Promise.resolve();
    if (!html2pdfLoading) html2pdfLoading = loadScript(HTML2PDF_URL);
    return html2pdfLoading;
  }
  function ensurePdfLib() {
    if (typeof window.PDFLib !== 'undefined') return Promise.resolve();
    if (!pdfLibLoading) pdfLibLoading = loadScript(PDFLIB_URL);
    return pdfLibLoading;
  }

  // ── Small helpers ──
  function safeFilename(base) {
    return (base || 'result').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'result';
  }

  function deriveFilenameBase(url, family) {
    try {
      const last = (url || '').split('?')[0].split('/').filter(Boolean).pop();
      if (last && last.replace(/\.\w+$/, '').length > 3) return last.replace(/\.\w+$/, '');
    } catch (e) { /* ignore */ }
    return `${family || 'exam'}-result`;
  }

  // Directory the source page lives in, e.g.
  // "https://sscexams.cbexams.com/xyz/ViewCandResponse2.aspx?..." ->
  // "https://sscexams.cbexams.com/xyz/". Injected as <base> so the
  // page's relative css/image paths (inc/edu_style.css, Images/ssc.jpg)
  // still resolve once the HTML is detached into an iframe.
  function deriveBaseHref(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/[^/]*$/, '');
    } catch (e) {
      return '';
    }
  }

  function withBaseHref(html, baseHref) {
    if (!baseHref) return html;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    }
    return `<base href="${baseHref}">` + html;
  }

  // Strip inline <script> tags — SSC pages block Ctrl+P / right-click via
  // inline JS which we don't want running inside our render iframe, and
  // RRB pages init media players we don't need for a static capture.
  function stripScripts(html) {
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function notify(msg, isError) {
    if (typeof RSMUI !== 'undefined' && RSMUI.toast) RSMUI.toast(msg);
    else if (isError) alert(msg);
  }

  function setButtonBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="btn-spinner"></span><span>${busyText || 'Please wait...'}</span>`;
    } else {
      btn.disabled = false;
      if (btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
    }
  }

  // ═══════════════ Off-screen render → single-part PDF ═══════════════

  // Renders `html` into a detached, off-screen (never visible, never
  // focused) iframe, strips scripts + watermark, and resolves once it's
  // laid out and ready to capture.
  function renderPartToIframe(html, widthPx, baseHref) {
    return new Promise((resolve, reject) => {
      const prepared = withBaseHref(stripScripts(html), baseHref);

      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.left = '-99999px';
      iframe.style.top = '0';
      iframe.style.width = widthPx + 'px';
      iframe.style.height = '100px';
      iframe.style.border = '0';
      iframe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(iframe);

      iframe.onload = () => {
        try {
          const doc = iframe.contentDocument;
          doc.querySelectorAll(WATERMARK_SELECTOR).forEach(el => el.remove());
          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 400);
          iframe.style.height = h + 'px';
          // small delay lets images finish laying out before capture
          setTimeout(() => resolve(iframe), 300);
        } catch (e) {
          reject(e);
        }
      };
      iframe.onerror = () => reject(new Error('Could not render part'));
      iframe.srcdoc = prepared;
    });
  }

  function partToPdfArrayBuffer(html, widthPx, baseHref) {
    return renderPartToIframe(html, widthPx, baseHref).then(iframe => {
      const body = iframe.contentDocument.body;
      const height = Math.max(body.scrollHeight, 800);
      const opt = {
        margin: 0,
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: true, windowWidth: widthPx },
        jsPDF: { unit: 'px', format: [widthPx, height], orientation: 'portrait' }
      };
      return window.html2pdf().set(opt).from(body).outputPdf('arraybuffer')
        .then(buf => { iframe.remove(); return buf; })
        .catch(err => { iframe.remove(); throw err; });
    });
  }

  async function mergeBuffers(buffers) {
    const { PDFDocument } = window.PDFLib;
    const merged = await PDFDocument.create();
    for (const buf of buffers) {
      const src = await PDFDocument.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    return merged.save();
  }

  function sortPartKeys(parts) {
    return Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
  }

  // ═══════════════ Main pipeline (RRB + SSC, unified) ═══════════════
  // RRB always has exactly one part ("p1") so this naturally skips the
  // merge step and just downloads that single rendered PDF — same code
  // path as SSC, just with 1 part instead of N.
  async function buildAndDownload(parts, url, family, btn) {
    await ensureHtml2Pdf();
    const baseHref = deriveBaseHref(url);
    const partKeys = sortPartKeys(parts);
    const filenameBase = deriveFilenameBase(url, family);

    const buffers = [];
    for (let i = 0; i < partKeys.length; i++) {
      setButtonBusy(btn, true, partKeys.length > 1
        ? `Rendering part ${i + 1}/${partKeys.length}...`
        : 'Generating PDF...');
      const buf = await partToPdfArrayBuffer(parts[partKeys[i]], 1000, baseHref);
      buffers.push(buf);
    }

    if (buffers.length === 1) {
      downloadBytes(new Uint8Array(buffers[0]), `${safeFilename(filenameBase)}.pdf`);
      return;
    }

    setButtonBusy(btn, true, 'Merging parts...');
    await ensurePdfLib();
    const merged = await mergeBuffers(buffers);
    downloadBytes(merged, `${safeFilename(filenameBase)}.pdf`);
  }

  // ═══════════════ Entry point (called from ui-common.js) ═══════════════

  async function handlePdfClick(btn, data) {
    const { parts, family, url } = data || {};
    if (!parts || !Object.keys(parts).length) {
      notify('Result HTML isn\u2019t available for PDF yet — please re-fetch this result and try again.', true);
      return;
    }

    setButtonBusy(btn, true, 'Generating PDF...');
    try {
      await buildAndDownload(parts, url, family, btn);
    } catch (e) {
      console.error('PDF generation failed:', e);
      notify('PDF banane mein error aa gaya. Dobara try karein.', true);
    } finally {
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();
