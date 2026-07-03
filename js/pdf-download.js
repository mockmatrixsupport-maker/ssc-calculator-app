/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — pdf-download.js (v2)
   No more html2canvas / html2pdf / pdf-lib. Both source
   sites already ship their own native window.print() —
   RRB via printPage() + a real @media print stylesheet,
   SSC via a plain onclick="window.print();" "Save / Print"
   link (which deliberately bypasses SSC's own Ctrl+P
   blocker). This module just reuses that: assemble clean
   HTML (images embedded, watermark stripped for SSC, parts
   stitched for multi-part SSC), write it to a file, and
   open it in the SYSTEM browser (via @capacitor/browser),
   because the in-app WebView has no print dialog but Chrome
   does. Real pagination, real page-break-inside handling,
   no re-rasterizing, no per-part PDF merge step.
═══════════════════════════════════════════════════ */

const RSMPdfDownload = (() => {

  const WATERMARK_SELECTOR = '#lblWatermark, .watermark-container, [id*="watermark" i], [class*="watermark" i]';
  const IMAGE_FETCH_TIMEOUT_MS = 12000;

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
    } catch (e) { return ''; }
  }
  function guessMime(url) {
    const m = /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.exec(url || '');
    if (!m) return 'image/jpeg';
    const ext = m[1].toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'svg') return 'image/svg+xml';
    return `image/${ext}`;
  }
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // Fetches one image with the correct Referer (needed because these
  // exam servers check it) and returns it as a data: URI. Native
  // builds go through CapacitorHttp; browser dev/testing falls back
  // to fetch(). Never throws — a failed image is just dropped.
  async function fetchImageAsDataUri(url, referer) {
    const work = (async () => {
      const CapacitorHttp = nativePlugin('CapacitorHttp');
      if (isNativeApp() && CapacitorHttp && CapacitorHttp.request) {
        const res = await CapacitorHttp.request({
          url, method: 'GET',
          headers: referer ? { Referer: referer } : {},
          responseType: 'arraybuffer'
        });
        if (!res || (res.status && res.status >= 400)) return null;
        const base64 = typeof res.data === 'string' ? res.data : null;
        return base64 ? `data:${guessMime(url)};base64,${base64}` : null;
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
    try { return await withTimeout(work, IMAGE_FETCH_TIMEOUT_MS, 'Image fetch'); }
    catch (e) { return null; }
  }

  // Parses one part's HTML in a detached document, strips the
  // watermark + inline <script> tags (SSC's Ctrl+P blocker etc —
  // irrelevant once we're in the system browser), resolves every
  // <img> to an absolute URL against the source page's own base,
  // and embeds it as a data: URI (all in parallel).
  async function cleanPartHtml(html, baseHref, referer, stripWatermark) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (stripWatermark) {
      doc.querySelectorAll(WATERMARK_SELECTOR).forEach(el => el.remove());
    }
    doc.querySelectorAll('script').forEach(el => el.remove());

    const base = doc.createElement('base');
    base.href = baseHref;
    doc.head.insertBefore(base, doc.head.firstChild);

    const imgs = Array.from(doc.querySelectorAll('img'));
    await Promise.all(imgs.map(async img => {
      const raw = img.getAttribute('src') || '';
      if (!raw || raw.startsWith('data:')) return;
      let absoluteUrl;
      try { absoluteUrl = new URL(raw, baseHref).href; } catch (e) { return; }
      const dataUri = await fetchImageAsDataUri(absoluteUrl, referer);
      if (dataUri) img.setAttribute('src', dataUri);
      else img.removeAttribute('src');
    }));

    return { doc, bodyHtml: doc.body.innerHTML, headHtml: doc.head.innerHTML };
  }

  function sortPartKeys(parts) {
    return Object.keys(parts).sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
  }

  // Builds ONE self-contained HTML document. Single part (RRB): use
  // that page's own <head> as-is, so its @media print stylesheet and
  // printPage()-equivalent chrome are preserved untouched. Multiple
  // parts (SSC): use part 1's <head>/styles as the shared stylesheet,
  // stitch every part's <body> content together with a page-break
  // between each so they land on separate printed pages.
  async function buildMergedHtml(parts, url, family) {
    const baseHref = deriveBaseHref(url);
    const referer = deriveOrigin(url);
    const stripWatermark = family === 'ssc';
    const keys = sortPartKeys(parts);

    const cleaned = [];
    for (const key of keys) {
      cleaned.push(await cleanPartHtml(parts[key], baseHref, referer, stripWatermark));
    }

    const headHtml = cleaned[0].headHtml;
    const bodyParts = cleaned.map((c, i) =>
      i === 0 ? c.bodyHtml : `<div style="page-break-before: always;">${c.bodyHtml}</div>`
    );

    return `<!DOCTYPE html><html><head>${headHtml}</head><body>${bodyParts.join('')}
<script>window.addEventListener('load', function () {
  setTimeout(function () { window.print(); }, 400);
});</script>
</body></html>`;
  }

  function notify(msg) {
    if (typeof RSMUI !== 'undefined' && RSMUI.toast) RSMUI.toast(msg);
  }

  function setButtonBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span class="btn-spinner"></span><span>${busyText || 'Please wait...'}</span>`;
    } else {
      btn.disabled = false;
      if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
    }
  }

  // ═══════════════ Entry point (called from ui-common.js) ═══════════════
  // Opens the assembled result in the system browser, where its own
  // native print button (RRB's printPage() / SSC's "Save / Print" link)
  // — or the auto window.print() we append above — produces a real,
  // correctly-paginated PDF via the device's Print/Save-as-PDF sheet.
  async function handlePdfClick(btn, data) {
    const { parts, family, url } = data || {};
    if (!parts || !Object.keys(parts).length) {
      notify('Result HTML isn\u2019t available yet — please re-fetch this result and try again.');
      return;
    }

    setButtonBusy(btn, true, 'Preparing…');
    try {
      const mergedHtml = await buildMergedHtml(parts, url, family);
      const fileName = `${safeFilename(deriveFilenameBase(url, family))}.html`;

      const Filesystem = nativePlugin('Filesystem');
      const Browser = nativePlugin('Browser');

      if (isNativeApp() && Filesystem && Browser) {
        await Filesystem.writeFile({ path: fileName, data: mergedHtml, directory: 'CACHE', recursive: true, encoding: 'utf8' });
        const { uri } = await Filesystem.getUri({ path: fileName, directory: 'CACHE' });
        await Browser.open({ url: uri });
        notify('Opened in browser — tap Print / Save as PDF there');
        return;
      }

      // Browser fallback (dev/testing outside the packaged app)
      const win = window.open('', '_blank');
      if (win) { win.document.write(mergedHtml); win.document.close(); }
      else notify('Please allow pop-ups to preview/print this result.');
    } catch (e) {
      console.error('PDF prep failed:', e);
      notify(e && e.message ? e.message : 'Something went wrong preparing this. Please try again.');
    } finally {
      setButtonBusy(btn, false);
    }
  }

  return { handlePdfClick };
})();

