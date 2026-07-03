/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Dynamic width rendering for SSC & RRB exam sheets
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  const PDFLIB_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  const WATERMARK_SELECTOR = '#lblWatermark, .watermark-container, [id*="watermark" i], [class*="watermark" i]';

  const SCRIPT_LOAD_TIMEOUT_MS = 25000; 
  const IMAGE_FETCH_TIMEOUT_MS = 12000; 
  const PART_TIMEOUT_MS = 90000;        

  // Lowered scale slightly for speed since we are rendering exact dynamic width now
  const CANVAS_SCALE = 1.25;

  let html2pdfLoading = null;
  let pdfLibLoading = null;

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — check your internet connection and try again`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

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

  function isNativeApp() {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch (e) { return false; }
  }
  
  function nativePlugin(name) {
    try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null; }
    catch (e) { return null; }
  }

  function safeFilename(base) {
    return (base || 'result').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'result';
  }

  function deriveFilenameBase(url, family) {
    try {
      const last = (url || '').split('?')[0].split('/').filter(Boolean).pop();
      if (last && last.replace(/\.\w+$/, '').length > 3) return last.replace(/\.\w+$/, '');
    } catch (e) { }
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
        const base64 = typeof res.data === 'string' ? res.data : null;
        if (!base64) return null;
        return `data:${guessMime(url)};base64,${base64}`;
      }
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

  async function embedImages(doc, referer) {
    const imgs = Array.from(doc.querySelectorAll('img'));
    await Promise.all(imgs.map(async img => {
      const absoluteUrl = img.src; 
      if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
      const dataUri = await fetchImageAsDataUri(absoluteUrl, referer);
      if (dataUri) img.src = dataUri;
      else img.removeAttribute('src');
    }));
  }

  function applyPdfLayoutRules(doc) {
    const style = doc.createElement('style');
    style.textContent = `
      * { box-sizing: border-box !important; }
      body { 
        margin: 0 !important; 
        padding: 0 !important; 
        width: 100% !important; 
        overflow-x: hidden !important; 
        background: #fff !important; 
      }
      
      /* Force all centering elements to align strictly to the left to remove white space */
      center, table {
        margin-left: 0 !important;
        margin-right: auto !important;
        text-align: left !important;
      }

      /* Dynamically contain wide elements so they don't break right boundaries */
      img { max-width: 100% !important; height: auto !important; }
      table { 
        width: 100% !important; 
        max-width: 100% !important; 
        table-layout: auto !important; 
      }
      td, th, div { word-break: break-word !important; }

      .question-pnl, table[cellpadding="8"] {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }

      .main-info-pnl {
        page-break-after: always !important;
        break-after: page !important;
      }
    `;
    doc.head.appendChild(style);

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
    } catch (e) { }
    downloadBlob(blob, filename);
    notify('PDF downloaded');
  }

  function renderPartToIframe(html, baseHref, referer) {
    return new Promise((resolve, reject) => {
      const prepared = withBaseHref(stripScripts(html), baseHref);

      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.left = '-99999px';
      iframe.style.top = '0';
      // Set to 100% initially to let the DOM settle into its natural layout
      iframe.style.width = '100%'; 
      iframe.style.height = '100px';
      iframe.style.border = '0';
      iframe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(iframe);

      iframe.onload = async () => {
        try {
          const doc = iframe.contentDocument;
          doc.querySelectorAll(WATERMARK_SELECTOR).forEach(el => el.remove());
          
          await embedImages(doc, referer); 
          applyPdfLayoutRules(doc);         

          // Dynamically read exact required width AFTER injected CSS is applied
          const contentWidth = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth, 800);
          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 400);
          
          iframe.style.width = contentWidth + 'px';
          iframe.style.height = h + 'px';
          
          resolve({ iframe, contentWidth });
        } catch (e) {
          iframe.remove();
          reject(e);
        }
      };
      iframe.onerror = () => { iframe.remove(); reject(new Error('Could not render part')); };
      iframe.srcdoc = prepared;
    });
  }

  function partToPdfArrayBuffer(html, baseHref, referer) {
    const work = renderPartToIframe(html, baseHref, referer).then(({ iframe, contentWidth }) => {
      const body = iframe.contentDocument.body;
      const opt = {
        margin: [10, 8, 10, 8], 
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: {
          scale: CANVAS_SCALE,
          useCORS: true,
          allowTaint: true,
          windowWidth: contentWidth,  // Set dynamically to precise width requirement
          width: contentWidth,        // Ensure Canvas matches DOM strictly
          logging: false,
          imageTimeout: 0 
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
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

  async function buildAndDeliver(parts, url, family, btn) {
    await ensureHtml2Pdf();
    const baseHref = deriveBaseHref(url);
    const referer = deriveOrigin(url);
    const partKeys = sortPartKeys(parts);
    const filenameBase = deriveFilenameBase(url, family);

    setButtonBusy(btn, true, partKeys.length > 1
      ? `Rendering ${partKeys.length} parts...`
      : 'Generating PDF...');

    // This Promise.all architecture guarantees multiple frames process concurrently for speed
    const buffers = await Promise.all(
      partKeys.map(key => partToPdfArrayBuffer(parts[key], baseHref, referer))
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

  async function handlePdfClick(btn, data) {
    const { parts, family, url } = data || {};
    if (!parts || !Object.keys(parts).length) {
      notify('Result HTML isn’t available for PDF yet — please re-fetch this result and try again.', true);
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

