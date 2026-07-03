/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js
   Filesystem Export Method (No Website Needed)
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

    // Clean Layout
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

      // 1. Swap images to base64 so they work entirely offline
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

      // 2. Build the final HTML string
      const finalDocumentHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Answer Key - Print</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; color: #000; background: #fff; }
          .print-header { text-align: center; margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
          .print-btn { background-color: #0f766e; color: #fff; border: none; padding: 14px 28px; font-size: 16px; font-weight: bold; border-radius: 6px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
          .print-btn:hover { background-color: #115e59; }
          .print-hint { font-size: 12px; color: #64748b; margin-top: 10px; }
          table { width: 100%; border-collapse: collapse; page-break-inside: auto; margin-bottom: 15px; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          td, th { padding: 4px; word-wrap: break-word; }
          img { max-width: 100%; height: auto; display: block; }
          .question-pnl, table[cellpadding="8"] { page-break-inside: avoid; margin-bottom: 20px; }
          @media print {
              .print-header { display: none !important; }
              body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <div class="print-header">
            <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
            <div class="print-hint">Tap the button above to generate a high-quality PDF.</div>
        </div>
        ${tempDiv.innerHTML}
        <script>
            window.onload = function() { setTimeout(function() { window.print(); }, 500); };
        </script>
      </body>
      </html>
      `;

      // ─── 3. LOGIC FOR ANDROID APP (Filesystem + Share) ───
      if (isNativeApp()) {
          setButtonBusy(btn, true, 'Creating File...');
          const Filesystem = nativePlugin('Filesystem');
          const Share = nativePlugin('Share');

          if (Filesystem && Share) {
              const fileName = `RankScoreMaster_${Date.now()}.html`;

              // Write HTML to physical device storage
              await Filesystem.writeFile({
                  path: fileName,
                  data: finalDocumentHtml,
                  directory: 'CACHE',
                  encoding: 'utf8'
              });

              // Get the secure file URI that external apps can access
              const uriResult = await Filesystem.getUri({
                  path: fileName,
                  directory: 'CACHE'
              });

              setButtonBusy(btn, true, 'Opening Menu...');

              // Trigger Android Share menu to let user open it in Chrome
              await Share.share({
                  title: 'Print Exam Result',
                  text: 'Open this file in your browser to Print or Save as PDF.',
                  url: uriResult.uri,
                  dialogTitle: 'Open with Browser'
              });

              notify('Select Chrome or your browser from the menu to open and print.');
          } else {
              notify('Filesystem/Share plugins missing. Please update app.', true);
          }
          
          setButtonBusy(btn, false);
      } 
      
      // ─── 4. LOGIC FOR WEB BROWSER (Direct Link/Blob) ───
      else {
          setButtonBusy(btn, true, 'Opening PDF Link...');
          const blob = new Blob([finalDocumentHtml], { type: 'text/html;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);

          setTimeout(() => {
            const linkElement = document.createElement('a');
            linkElement.href = blobUrl;
            linkElement.target = '_blank'; 
            document.body.appendChild(linkElement);
            linkElement.click();
            document.body.removeChild(linkElement);
            
            setButtonBusy(btn, false);
          }, 500);
      }

    } catch (e) {
      console.error('PDF page generation failed:', e);
      notify('An error occurred while generating the page link.', true);
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();
                     
