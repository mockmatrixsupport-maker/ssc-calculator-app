/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Native Capacitor Print Engine (Zero White Space, Copiable Text)
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
  function extractCleanContent(rawHtml, isFirstPart) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Remove watermark garbage
    doc.querySelectorAll('.watermark-container, .watermark-text, #lblWatermark, script, noscript').forEach(el => el.remove());

    const wrapper = document.createElement('div');

    if (isFirstPart) {
        let candInfo = doc.querySelector('.main-info-pnl') || 
                       Array.from(doc.querySelectorAll('table')).find(t => t.textContent.includes('Candidate Name') || t.textContent.includes('Roll No'));
        if (candInfo) {
            const header = candInfo.cloneNode(true);
            header.style.marginBottom = '30px';
            wrapper.appendChild(header);
        }
    }

    let questions = Array.from(doc.querySelectorAll('.question-pnl'));
    if (questions.length === 0) {
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
      let combinedHtml = '';
      for (let i = 0; i < partKeys.length; i++) {
         const rawHtml = parts[partKeys[i]];
         combinedHtml += extractCleanContent(rawHtml, i === 0);
      }

      // 1. Parse into a temporary container to fetch and swap images to base64
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = combinedHtml;

      setButtonBusy(btn, true, 'Fetching Images securely...');
      const imgs = Array.from(tempDiv.querySelectorAll('img'));
      await Promise.all(imgs.map(async img => {
        const absoluteUrl = img.src; 
        if (!absoluteUrl || absoluteUrl.startsWith('data:')) return;
        
        const dataUri = await fetchImageAsDataUri(absoluteUrl, referer);
        if (dataUri) {
            img.src = dataUri;
        } else {
            img.style.display = 'none'; 
        }
      }));

      // 2. Wrap the fully processed HTML (with base64 images) in Print CSS
      const finalDocumentHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; color: #000; background: #fff; }
          table { width: 100%; border-collapse: collapse; page-break-inside: auto; margin-bottom: 15px; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          td, th { padding: 4px; word-wrap: break-word; }
          img { max-width: 100%; height: auto; display: block; }
          .question-pnl, table[cellpadding="8"] { page-break-inside: avoid; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        ${tempDiv.innerHTML}
      </body>
      </html>
      `;

      // 3. Trigger the Native Print Spooler
      setButtonBusy(btn, true, 'Opening PDF...');
      
      setTimeout(async () => {
        if (isNativeApp()) {
            // ---> CAPACITOR ANDROID LOGIC
            const Printer = nativePlugin('Printer');
            if (Printer) {
                try {
                    await Printer.print({
                        content: finalDocumentHtml,
                        name: 'Rank_Score_Master_Result'
                    });
                } catch (err) {
                    console.error('Print plugin failed:', err);
                    notify('Failed to open PDF dialog.', true);
                }
            } else {
                notify('Printer plugin is missing. Please update the app.', true);
            }
        } else {
            // ---> STANDARD WEB BROWSER LOGIC (Chrome/Desktop)
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

            setTimeout(() => {
                printIframe.contentWindow.focus();
                printIframe.contentWindow.print();
                setTimeout(() => document.body.removeChild(printIframe), 60000);
            }, 500);
        }
        
        setButtonBusy(btn, false);
      }, 500);

    } catch (e) {
      console.error('PDF generation failed:', e);
      notify('An error occurred while generating the PDF.', true);
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();

