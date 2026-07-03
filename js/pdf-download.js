/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Generates the PDF for the result card's PDF button
   entirely in the background — no new tab/window opens.

   Called from ui-common.js's attachResultActions():
     RSMPdfDownload.handlePdfClick(btn, cardEl._rsmPdfData)
   where cardEl._rsmPdfData = { parts, family, url } is
   stashed by score-engine.js when the result renders.

   ── Why images were blank before ──
   fetcher-ssc.js / fetcher-rrb.js fetch the raw HTML with a
   spoofed Referer header (via the native HTTP layer) because
   the exam server checks it before serving anything. A plain
   <img src="..."> tag loaded by the WebView itself can NOT
   carry a custom Referer — JS has no way to set that on an
   element load — so the server saw a missing/wrong referer
   and served nothing. Same root cause the reference Python
   script solves by downloading every image through its own
   authenticated `requests.Session()` instead of trusting a
   browser <img> tag to fetch it.

   Fix here: every <img> found in a part is fetched ourselves
   (via Capacitor's built-in CapacitorHttp plugin on native
   builds, with the correct Referer header — falling back to
   a plain fetch() in a normal browser tab), turned into a
   data: URI, and swapped into the DOM *before* capture. The
   WebView never has to load the image over the network at
   all, so Referer/CORS/cookies stop being a problem.

   ── Why it was one giant page (fixed) ──
   The PDF page size used to be set to the exact height of
   the whole part. Now it's a real 'a4' page size, so long
   parts paginate into multiple normal-looking pages instead
   of one continuous strip.

   ── Why pages had huge white gaps + right-edge cut-off (fixed) ──
   Two separate bugs, both now fixed in this version:

   1. The old `pagebreak.avoid` list (['tr', '.qstn-row',
      '.rw', '.questionRowTbl']) doesn't match the real DOM.
      '.qstn-row' / '.questionRowTbl' aren't containers in
      either source page, and 'tr' matches *every* row in
      *every* table on the page (header table, answer-key
      table, every option row — hundreds of elements). Combined
      with html2pdf's 'legacy' pagebreak mode, that caused a
      blank filler to get inserted before nearly every row it
      couldn't safely place, which is what produced the mostly-
      empty pages. It was also slow, since legacy mode has to
      evaluate every one of those matches.

      The real per-question containers are:
        - RRB source pages: `.question-pnl` (already carries
          an inline `page-break-inside:avoid` — we just needed
          to stop fighting it)
        - SSC source pages: each question is its own
          `<table cellpadding="8">` — no shared class, but the
          attribute is consistent across every question.

      We now inject a small stylesheet into the rendered iframe
      that marks exactly those two containers as
      page-break-inside:avoid, use html2pdf's 'css' pagebreak
      mode only (drop 'legacy'), and force a clean break right
      after the candidate-info header block — `.main-info-pnl`
      on RRB pages, or the table holding the "Click Here for
      PART-A/B/C" buttons on SSC pages — so the header table and
      the question list never share a page.

   2. Some source elements (e.g. the RRB banner image, wide
      fixed-width table cells) are wider than the 1000px the
      iframe used to render at, so html2canvas silently clipped
      them at the right edge. We now render wider (1400px) and
      inject CSS that caps images/tables to the viewport width
      so nothing runs past the printable area.

   Pipeline (same for RRB [1 part] and SSC [N parts]):
     1. Each raw part page loads into a detached, off-screen
        iframe. Inline <script> tags stripped (SSC blocks
        Ctrl+P / right-click via inline JS), watermark overlay
        removed (#lblWatermark / .watermark-container).
     2. Every <img> is fetched with the correct Referer and
        inlined as a data: URI (bounded per-image timeout —
        a failed/slow image is dropped, not left hanging).
     3. Page-break + responsive-width rules are injected (see
        above) before we ever measure/capture the iframe.
     4. Each part renders to its own (possibly multi-page) A4
        PDF via html2pdf.js, wrapped in an overall timeout.
     5. 1 part -> delivered directly. >1 parts (SSC) -> all
        parts render in parallel, then merged into ONE PDF via
        pdf-lib, then delivered.
     6. Delivery mirrors handleImage()/handleShare() in
        ui-common.js: native builds write via Filesystem +
        hand off to the native Share sheet (a blob <a download>
        click does not reliably trigger a save in the Android
        WebView); browser tabs try the Web Share API first,
        then fall back to a plain blob download.

   html2pdf.js / pdf-lib are lazy-loaded from CDN, and pdf-lib
   is only pulled in when a merge is actually needed.
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  const PDFLIB_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  const WATERMARK_SELECTOR = '#lblWatermark, .watermark-container, [id*="watermark" i], [class*="watermark" i]';

  const SCRIPT_LOAD_TIMEOUT_MS = 25000; // CDN can be slow on bad connections
  const IMAGE_FETCH_TIMEOUT_MS = 12000; // per-image cap, all images fetched in parallel
  const PART_TIMEOUT_MS = 90000;        // whole-part render cap (image fetch + capture + encode)

  // Render width for the off-screen iframe. Wide enough that fixed-width
  // source elements (banner images, legacy table cells) never get clipped
  // at the right edge; html2canvas scale is tuned down to compensate so
  // total output pixel size — and render time — stays about the same.
  const RENDER_WIDTH_PX = 1400;
  const CANVAS_SCALE = 1.15;

  let html2pdfLoading = null;
  let pdfLibLoading = null;

  // ── Generic timeout wrapper so nothing can hang the UI forever ──
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — check your internet connection and try again`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ── CDN script loading (once, cached, with timeout) ──
  function loadScript(src, label) {
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + label));
      document.head.appendChild(s);
    });
    return withTimeout(p, SCRIPT_LOAD_TIMEOUT_MS, `Loading ${label}`);
  }
  function ensureHtml2Pdf() {
    if (typeof window.html2pdf !== 'undefined') return Promise.resolve();
    if (!html2pdfLoading) html2pdfLoading = loadScript(HTML2PDF_URL, 'PDF engine').catch(e => { html2pdfLoading = null; throw e; });
    return html2pdfLoading;
  }
  function ensurePdfLib() {
    if (typeof window.PDFLib !== 'undefined') return Promise.resolve();
    if (!pdfLibLoading) pdfLibLoading = loadScript(PDFLIB_URL, 'PDF merge engine').catch(e => { pdfLibLoading = null; throw e; });
    return pdfLibLoading;
  }

  // ── Capacitor native helpers (mirrors the pattern in ui-common.js) ──
  function isNativeApp() {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch (e) { return false; }
  }
  function nativePlugin(name) {
    try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null; }
    catch (e) { return null; }
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

  function deriveOrigin(url) {
    try { return new URL(url).origin + '/'; } catch (e) { return ''; }
  }

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

  function stripScripts(html) {
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }

  function guessMime(url) {
    const m = /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.exec(url || '');
    if (!m) return 'image/jpeg';
    const ext = m[1].toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'svg') return 'image/svg+xml';
    return `image/${ext}`;
  }

  // ── Fetch one image's bytes with the correct Referer and turn it into ──
  // a data: URI. Native builds go through Capacitor's built-in
  // CapacitorHttp plugin (same bypass-CORS / custom-header mechanism
  // fetcher-ssc.js relies on for the page HTML itself); a plain browser
  // tab falls back to fetch(). Returns null (never throws) on failure —
  // callers just drop the image rather than let it stall the render.
  async function fetchImageAsDataUri(url, referer) {
    const work = (async () => {
      const CapacitorHttp = nativePlugin('CapacitorHttp');
      if (isNativeApp() && CapacitorHttp && CapacitorHttp.request) {
        const res = await CapacitorHttp.request({
          url,
          method: 'GET',
          headers: referer ? { Referer: referer } : {},
          responseType: 'arraybuffer'
        });
        if (!res || (res.status && res.status >= 400)) return null;
        // CapacitorHttp returns arraybuffer responses as a base64 string in `data`.
        const base64 = typeof res.data === 'string' ? res.data : null;
        if (!base64) return null;
        return `data:${guessMime(url)};base64,${base64}`;
      }
      // Browser fallback (dev/testing outside the packaged app) — no
      // custom Referer possible here, so this only helps for
      // non-referer-gated sources.
      const resp = await fetch(url, { credentials: 'omit' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    })();

    try {
      return await withTimeout(work, IMAGE_FETCH_TIMEOUT_MS, 'Image fetch');
    } catch (e) {
      return null;
    }
  }

  // Replaces every <img src> in doc with a self-fetched data: URI (see
  // fetchImageAsDataUri above). Images that fail/time out are simply
  // removed rather than left as broken/blank placeholders.
  async function embedImages(doc, referer) {
    const imgs = Array.from(doc.querySelectorAll('img'));
    await Promise.all(imgs.map(async img => {
      const absoluteUrl = img.src; // resolved against the injected <base href>
      if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
      const dataUri = await fetchImageAsDataUri(absoluteUrl, referer);
      if (dataUri) img.src = dataUri;
      else img.removeAttribute('src');
    }));
  }

  // ── Page-break + responsive-width rules ──
  // Injected into the rendered iframe right before capture. Two jobs:
  //   1. Keep each individual question intact across a page break
  //      (RRB: .question-pnl, SSC: table[cellpadding="8"]) without
  //      touching every unrelated <tr> on the page.
  //   2. Force a clean break between the candidate-info header and the
  //      question list, and stop wide fixed-width elements (banner
  //      image, legacy table cells) from getting clipped at the right
  //      edge of the render.
  function applyPdfLayoutRules(doc) {
    const style = doc.createElement('style');
    style.textContent = `
      * { box-sizing: border-box !important; }
      body { width: 100% !important; overflow-x: hidden !important; }
      img { max-width: 100% !important; height: auto !important; }
      table { max-width: 100% !important; table-layout: auto !important; }
      td, th { word-break: break-word !important; }

      /* Keep each question on one page where possible */
      .question-pnl, table[cellpadding="8"] {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }

      /* Clean split between the candidate-info header and the questions (RRB) */
      .main-info-pnl {
        page-break-after: always !important;
        break-after: page !important;
      }
    `;
    doc.head.appendChild(style);

    // SSC pages don't have a dedicated header class — the row of
    // "Click Here for PART-X" buttons marks the same boundary, so force
    // a break right after whichever table holds them.
    const candidates = Array.from(doc.querySelectorAll('input[type="submit"], button, td, div, span'));
    const partBtn = candidates.find(el => /Click Here for PART/i.test(el.value || el.textContent || ''));
    if (partBtn) {
      const tbl = partBtn.closest('table') || partBtn.closest('tr');
      if (tbl) {
        tbl.style.pageBreakAfter = 'always';
        tbl.style.breakAfter = 'page';
      }
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // ── Same shape as downloadBlob() in ui-common.js ──
  function downloadBlob(blob, filename) {
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

  // ═══════════════ Delivery — mirrors handleImage()/handleShare() ═══════════════

  async function deliverPdf(bytes, filename) {
    if (isNativeApp()) {
      try {
        const Filesystem = nativePlugin('Filesystem');
        if (Filesystem) {
          const base64Data = bytesToBase64(bytes);
          await Filesystem.writeFile({ path: filename, data: base64Data, directory: 'CACHE', recursive: true });
          const uriResult = await Filesystem.getUri({ path: filename, directory: 'CACHE' });
          const Share = nativePlugin('Share');
          if (Share) {
            await Share.share({
              title: 'Save PDF',
              text: 'Your Rank Score Master result PDF',
              files: [uriResult.uri],
              dialogTitle: 'Save / Share PDF'
            });
            notify('Choose "Save to Files" (or Drive) in the share sheet to keep this PDF');
            return;
          }
        }
      } catch (e) {
        console.warn('Native PDF delivery failed, falling back to browser download:', e);
      }
    }

    const blob = new Blob([bytes], { type: 'application/pdf' });
    try {
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My Result PDF' });
        return;
      }
    } catch (e) {
      // fall through to plain download
    }
    downloadBlob(blob, filename);
    notify('PDF downloaded');
  }

  // ═══════════════ Off-screen render → single-part PDF ═══════════════

  function renderPartToIframe(html, widthPx, baseHref, referer) {
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

      iframe.onload = async () => {
        try {
          const doc = iframe.contentDocument;
          doc.querySelectorAll(WATERMARK_SELECTOR).forEach(el => el.remove());
          await embedImages(doc, referer); // fetch + inline every image ourselves
          applyPdfLayoutRules(doc);         // fix page-break + width clipping (see notes above)
          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 400);
          iframe.style.height = h + 'px';
          resolve(iframe);
        } catch (e) {
          iframe.remove();
          reject(e);
        }
      };
      iframe.onerror = () => { iframe.remove(); reject(new Error('Could not render part')); };
      iframe.srcdoc = prepared;
    });
  }

  function partToPdfArrayBuffer(html, widthPx, baseHref, referer) {
    const work = renderPartToIframe(html, widthPx, baseHref, referer).then(iframe => {
      const body = iframe.contentDocument.body;
      const opt = {
        margin: [10, 8, 10, 8], // mm
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: {
          scale: CANVAS_SCALE,
          useCORS: true,
          allowTaint: true,
          windowWidth: widthPx,
          logging: false,
          imageTimeout: 0 // images are already inlined as data URIs — nothing left to wait on
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        // 'css' mode respects the page-break-inside/page-break-after rules
        // applyPdfLayoutRules() just set (both inline and via the injected
        // stylesheet) instead of re-deriving its own — much cheaper than
        // 'legacy' mode and doesn't insert filler blank space before every
        // unrelated <tr> on the page.
        pagebreak: { mode: ['css'], avoid: ['.question-pnl', 'table[cellpadding="8"]'] }
      };
      return window.html2pdf().set(opt).from(body).outputPdf('arraybuffer')
        .then(buf => { iframe.remove(); return buf; })
        .catch(err => { iframe.remove(); throw err; });
    });
    return withTimeout(work, PART_TIMEOUT_MS, 'Rendering this part');
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

  async function buildAndDeliver(parts, url, family, btn) {
    await ensureHtml2Pdf();
    const baseHref = deriveBaseHref(url);
    const referer = deriveOrigin(url);
    const partKeys = sortPartKeys(parts);
    const filenameBase = deriveFilenameBase(url, family);

    setButtonBusy(btn, true, partKeys.length > 1
      ? `Rendering ${partKeys.length} parts...`
      : 'Generating PDF...');

    // Independent parts render in parallel now instead of one-at-a-time —
    // each part is its own detached iframe, so there's no shared state to
    // race on, and this cuts total time roughly by the part count on SSC's
    // 3-part papers.
    const buffers = await Promise.all(
      partKeys.map(key => partToPdfArrayBuffer(parts[key], RENDER_WIDTH_PX, baseHref, referer))
    );

    if (buffers.length === 1) {
      await deliverPdf(new Uint8Array(buffers[0]), `${safeFilename(filenameBase)}.pdf`);
      return;
    }

    setButtonBusy(btn, true, 'Merging parts...');
    await ensurePdfLib();
    const merged = await mergeBuffers(buffers);
    await deliverPdf(merged, `${safeFilename(filenameBase)}.pdf`);
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
      await buildAndDeliver(parts, url, family, btn);
    } catch (e) {
      console.error('PDF generation failed:', e);
      notify(e && e.message ? e.message : 'PDF banane mein error aa gaya. Dobara try karein.', true);
    } finally {
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();
         
