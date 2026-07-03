/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Generates the PDF for the result card's PDF button
   entirely in the background — no new tab/window opens.

   Called from ui-common.js's attachResultActions():
     RSMPdfDownload.handlePdfClick(btn, cardEl._rsmPdfData)
   where cardEl._rsmPdfData = { parts, family, url } is
   stashed by score-engine.js when the result renders.

   Pipeline (same for RRB [1 part] and SSC [N parts]):
     1. Each raw part page is loaded into a detached,
        off-screen iframe. Inline <script> tags are stripped
        (SSC pages block Ctrl+P / right-click via inline JS),
        watermark overlay removed (#lblWatermark /
        .watermark-container).
     2. Every <img> in that part is given a bounded wait
        (IMAGE_TIMEOUT_MS) — if it hasn't loaded by then it's
        dropped rather than left to stall the whole render.
     3. Each part is rendered to its own single-page PDF via
        html2pdf.js, wrapped in an overall PART_TIMEOUT_MS
        timeout so a stuck render fails loudly instead of
        leaving the button stuck on "Generating PDF..." forever.
     4. 1 part -> delivered directly. >1 parts (SSC) -> merged
        into ONE PDF via pdf-lib, then delivered.
     5. Delivery mirrors handleImage()/handleShare() in
        ui-common.js exactly:
          - Native (Capacitor) build: write bytes via the
            Filesystem plugin, get a file:// / content:// URI,
            hand it to the native Share sheet. A plain blob
            <a download> click does NOT reliably trigger a
            save on Android WebView — this is why nothing
            downloaded even after rendering finished.
          - Browser tab: try the Web Share API
            (navigator.canShare/navigator.share with a File),
            same as handleShare() does — falls back to a plain
            blob download if that's not supported.

   html2pdf.js / pdf-lib are lazy-loaded from CDN, and pdf-lib
   is only pulled in when a merge is actually needed.
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  const PDFLIB_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  const WATERMARK_SELECTOR = '#lblWatermark, .watermark-container, [id*="watermark" i], [class*="watermark" i]';

  const SCRIPT_LOAD_TIMEOUT_MS = 25000; // CDN can be slow on bad connections too
  const IMAGE_TIMEOUT_MS = 6000;        // per-image cap, all images wait in parallel
  const PART_TIMEOUT_MS = 60000;        // whole-part render cap (capture + PDF encode)

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

  // Waits for every <img> in doc to either load, error, or hit
  // IMAGE_TIMEOUT_MS — whichever comes first — instead of letting one
  // slow/blocked image stall the entire PDF render indefinitely.
  // Timed-out/broken images are simply dropped.
  function settleImages(doc) {
    const imgs = Array.from(doc.querySelectorAll('img'));
    return Promise.all(imgs.map(img => new Promise(resolve => {
      if (img.complete && img.naturalWidth > 0) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', () => { img.removeAttribute('src'); finish(); }, { once: true });
      setTimeout(() => { if (!done) { img.removeAttribute('src'); finish(); } }, IMAGE_TIMEOUT_MS);
    })));
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
    // ── Native (Capacitor) path: Filesystem.writeFile -> getUri -> Share.share ──
    // Exactly the pattern writeCanvasToNativeCache() + handleShare() use for
    // images. A plain blob <a download> click does not reliably trigger a
    // save inside the Android WebView, which is why nothing downloaded
    // before even when rendering succeeded.
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
        // fall through to the browser path below
      }
    }

    // ── Browser tab: Web Share API first (same as handleShare()), ──
    // then a plain blob download if that's not supported.
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

      iframe.onload = async () => {
        try {
          const doc = iframe.contentDocument;
          doc.querySelectorAll(WATERMARK_SELECTOR).forEach(el => el.remove());
          await settleImages(doc); // bounded — never waits forever on a slow image
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

  function partToPdfArrayBuffer(html, widthPx, baseHref) {
    const work = renderPartToIframe(html, widthPx, baseHref).then(iframe => {
      const body = iframe.contentDocument.body;
      const height = Math.max(body.scrollHeight, 800);
      const opt = {
        margin: 0,
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 1.5, useCORS: true, allowTaint: true, windowWidth: widthPx, logging: false, imageTimeout: IMAGE_TIMEOUT_MS },
        jsPDF: { unit: 'px', format: [widthPx, height], orientation: 'portrait' }
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
