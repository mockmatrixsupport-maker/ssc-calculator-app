/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Native Print Engine with Copiable Text
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const IMAGE_FETCH_TIMEOUT_MS = 12000; 

  function isNativeApp() {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
    catch (e) { return false; }
  }
  
  function nativePlugin(name) {
    try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null; }
    catch (e) { return null; }
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

  // Uses Capacitor bypass to securely fetch protected images
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
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), IMAGE_FETCH_TIMEOUT_MS);
      });
      return await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    } catch (e) {
      return null;
    }
  }

  // ════════════ THE HTML EXTRACTOR ════════════
  // Extracts only the clean data from the messy SSC/RRB source
  function extractCleanContent(rawHtml, isFirstPart) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Remove watermark garbage
    doc.querySelectorAll('.watermark-container, .watermark-text, #lblWatermark, script, noscript').forEach(el => el.remove());

    const wrapper = document.createElement('div');

    // Only extract Candidate details if this is the very first part
    if (isFirstPart) {
        let candInfo = doc.querySelector('.main-info-pnl') || 
                       Array.from(doc.querySelectorAll('table')).find(t => t.textContent.includes('Candidate Name') || t.textContent.includes('Roll No'));
        if (candInfo) {
            const header = candInfo.cloneNode(true);
            header.style.marginBottom = '30px';
            wrapper.appendChild(header);
        }
    }

    // Extract questions
    let questions = Array.from(doc.querySelectorAll('.question-pnl')); // RRB
    if (questions.length === 0) {
        // SSC Extract
        const tds = Array.from(doc.querySelectorAll('td')).filter(td => td.textContent.includes('Q.No'));
        const sscTables = new Set();
        tds.forEach(td => {
            const table = td.closest('table[border="1"]') || td.closest('table');
            if (table) sscTables.add(table);
        });
        questions = Array.from(sscTables);
    }

    questions.forEach(q => {
        const qClone = q.cloneNode(true);
        qClone.style.marginBottom = '25px';
        qClone.style.pageBreakInside = 'avoid';
        wrapper.appendChild(qClone);
    });

    // Nuclear Layout Cleanup
    wrapper.querySelectorAll('center').forEach(c => {
        const frag = document.createDocumentFragment();
        while (c.firstChild) frag.appendChild(c.firstChild);
        c.parentNode.replaceChild(frag, c);
    });

    wrapper.querySelectorAll('*').forEach(el => {
        el.removeAttribute('width');
        el.removeAttribute('height');
        el.removeAttribute('align');
        el.style.width = '';
        el.style.maxWidth = '100%'; 
    });

    wrapper.querySelectorAll('table').forEach(t => {
        t.style.width = '100%';
        t.style.borderCollapse = 'collapse';
    });

    return wrapper.innerHTML;
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

  function sortPartKeys(parts) {
    return Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
  }

  // ════════════ MAIN GENERATOR ════════════
  async function handlePdfClick(btn, data) {
    const { parts, url } = data || {};
    if (!parts || !Object.keys(parts).length) {
      notify('Result HTML isn’t available for PDF yet — please re-fetch this result.', true);
      return;
    }

    setButtonBusy(btn, true, 'Preparing Document...');
    const referer = deriveOrigin(url);
    const partKeys = sortPartKeys(parts);

    try {
      // 1. Extract and combine all parts into one long clean HTML string
      let combinedHtml = '';
      for (let i = 0; i < partKeys.length; i++) {
         const rawHtml = parts[partKeys[i]];
         combinedHtml += extractCleanContent(rawHtml, i === 0);
      }

      // 2. Wrap it in standard print CSS
      const finalDocumentHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; color: #000; background: #fff; }
          table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          td, th { padding: 5px; word-wrap: break-word; }
          img { max-width: 100%; height: auto; display: block; }
          .question-pnl, table[cellpadding="8"] { page-break-inside: avoid; margin-bottom: 25px; }
        </style>
      </head>
      <body>
        ${combinedHtml}
      </body>
      </html>
      `;

      // 3. Create a hidden print iframe
      const printIframe = document.createElement('iframe');
      printIframe.style.position = 'fixed';
      printIframe.style.right = '0';
      printIframe.style.bottom = '0';
      printIframe.style.width = '0';
      printIframe.style.height = '0';
      printIframe.style.border = '0';
      document.body.appendChild(printIframe);

      const doc = printIframe.contentWindow.document;
      doc.open();
      doc.write(finalDocumentHtml);
      doc.close();

      setButtonBusy(btn, true, 'Fetching Images securely...');

      // 4. Fetch all images inside the iframe and convert to base64
      const imgs = Array.from(doc.querySelectorAll('img'));
      await Promise.all(imgs.map(async img => {
        const absoluteUrl = img.src; 
        if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
        const dataUri = await fetchImageAsDataUri(absoluteUrl, referer);
        if (dataUri) img.src = dataUri;
        else img.style.display = 'none'; // hide broken images
      }));

      // 5. Trigger the Native Print Spooler (Allows saving as true PDF)
      setButtonBusy(btn, true, 'Opening PDF...');
      
      // Short delay to ensure browser paints the DOM
      setTimeout(() => {
        printIframe.contentWindow.focus();
        printIframe.contentWindow.print();
        
        setButtonBusy(btn, false);
        
        // Clean up the iframe after a minute so the spooler has time to catch it
        setTimeout(() => {
            if (document.body.contains(printIframe)) {
                document.body.removeChild(printIframe);
            }
        }, 60000);
      }, 500);

    } catch (e) {
      console.error('PDF generation failed:', e);
      notify('An error occurred while generating the PDF.', true);
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();

