/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Extraction & Re-templating engine for SSC & RRB 
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const HTML2PDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
  const PDFLIB_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

  const SCRIPT_LOAD_TIMEOUT_MS = 25000; 
  const IMAGE_FETCH_TIMEOUT_MS = 12000; 
  const PART_TIMEOUT_MS = 90000;        

  // Strict width for perfect A4 scaling
  const RENDER_WIDTH = 1000; 
  const CANVAS_SCALE = 1.5;

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

  // ═══════════════ THE NEW DATA EXTRACTOR ═══════════════
  // This takes the dirty SSC/RRB HTML and builds a clean template
  function rebuildCleanHtml(rawHtml, baseHref) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Remove garbage
    doc.querySelectorAll('.watermark-container, .watermark-text, #lblWatermark, script, noscript').forEach(el => el.remove());

    // Create the clean container (similar to your Python script's logic)
    const cleanBody = document.createElement('div');
    cleanBody.style.fontFamily = 'Arial, sans-serif';
    cleanBody.style.width = RENDER_WIDTH + 'px';
    cleanBody.style.margin = '0';
    cleanBody.style.padding = '20px';
    cleanBody.style.background = '#fff';
    cleanBody.style.color = '#000';

    // 1. Extract Candidate Header
    let candInfo = doc.querySelector('.main-info-pnl'); 
    if (!candInfo) { // SSC fallback
        candInfo = Array.from(doc.querySelectorAll('table')).find(t => t.textContent.includes('Candidate Name') || t.textContent.includes('Roll No'));
    }
    if (candInfo) {
        const header = candInfo.cloneNode(true);
        header.style.width = '100%';
        header.style.marginBottom = '30px';
        header.style.borderCollapse = 'collapse';
        cleanBody.appendChild(header);
    }

    // 2. Extract Questions cleanly
    let questions = Array.from(doc.querySelectorAll('.question-pnl')); // RRB
    if (questions.length === 0) {
        // SSC Extract: Find tables that contain "Q.No"
        const tds = Array.from(doc.querySelectorAll('td')).filter(td => td.textContent.includes('Q.No'));
        const sscTables = new Set();
        tds.forEach(td => {
            const table = td.closest('table[border="1"]') || td.closest('table');
            if (table) sscTables.add(table);
        });
        questions = Array.from(sscTables);
    }

    // Put extracted questions into the clean body
    if (questions.length > 0) {
        questions.forEach(q => {
            const qClone = q.cloneNode(true);
            qClone.style.width = '100%';
            qClone.style.marginBottom = '25px';
            qClone.style.pageBreakInside = 'avoid';
            
            if (qClone.tagName.toLowerCase() === 'table') {
                qClone.style.borderCollapse = 'collapse';
                qClone.style.tableLayout = 'auto';
            }
            cleanBody.appendChild(qClone);
        });
    } else {
        // Fallback if extremely strange layout
        cleanBody.innerHTML = doc.body.innerHTML;
    }

    // 3. NUCLEAR DOM CLEANUP ON THE EXTRACTED TEMPLATE
    // Remove all <center> tags entirely
    cleanBody.querySelectorAll('center').forEach(c => {
        const frag = document.createDocumentFragment();
        while (c.firstChild) frag.appendChild(c.firstChild);
        c.parentNode.replaceChild(frag, c);
    });

    // Strip every legacy layout attribute that ruins html2canvas
    cleanBody.querySelectorAll('*').forEach(el => {
        el.removeAttribute('width');
        el.removeAttribute('height');
        el.removeAttribute('align');
        el.removeAttribute('valign');
        el.style.width = '';
        el.style.height = '';
        el.style.minWidth = '';
        el.style.maxWidth = '100%'; 
        
        // Force text wrapping
        if(['TD', 'TH', 'DIV', 'SPAN', 'P'].includes(el.tagName)) {
            el.style.wordBreak = 'break-word';
            el.style.whiteSpace = 'normal';
        }
    });

    // Force tables to behave
    cleanBody.querySelectorAll('table').forEach(t => {
        t.style.width = '100%';
        t.style.borderCollapse = 'collapse';
        t.style.tableLayout = 'fixed';
    });

    // Fix images
    cleanBody.querySelectorAll('img').forEach(img => {
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
    });

    // Add Base Href for image fetching
    const baseTag = baseHref ? `<base href="${baseHref}">` : '';

    return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        ${baseTag}
      </head>
      <body style="margin:0; padding:0; background:#fff;">
        ${cleanBody.outerHTML}
      </body>
    </html>`;
  }
  // ═════════════════════════════════════════════════════

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
      // 1. Convert dirty HTML to clean, extracted template
      const cleanHtml = rebuildCleanHtml(html, baseHref);

      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.left = '-99999px';
      iframe.style.top = '0';
      iframe.style.width = RENDER_WIDTH + 'px'; 
      iframe.style.height = '100px';
      iframe.style.border = '0';
      iframe.setAttribute('aria-hidden', 'true');
      document.body.appendChild(iframe);

      iframe.onload = async () => {
        try {
          const doc = iframe.contentDocument;
          
          // Fetch images via custom bypass natively
          await embedImages(doc, referer); 

          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 800);
          iframe.style.height = h + 'px';
          
          resolve({ iframe });
        } catch (e) {
          iframe.remove();
          reject(e);
        }
      };
      iframe.onerror = () => { iframe.remove(); reject(new Error('Could not render part')); };
      iframe.srcdoc = cleanHtml; // Feed the extracted HTML to the iframe
    });
  }

  function partToPdfArrayBuffer(html, baseHref, referer) {
    const work = renderPartToIframe(html, baseHref, referer).then(({ iframe }) => {
      const body = iframe.contentDocument.body;
      const opt = {
        margin: [10, 8, 10, 8], 
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: CANVAS_SCALE, // Clean HTML scales perfectly now
          useCORS: true,
          allowTaint: true,
          windowWidth: RENDER_WIDTH,
          width: RENDER_WIDTH,       
          logging: false,
          imageTimeout: 0 
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
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
         
