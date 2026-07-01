/* ═══════════════════════════════════════════════════
   RANK SCORE MASTER — ui-common.js  (RSMUI)
   Shared interactive behaviour used by both ssc-calculator.html
   and rrb-calculator.html:

     • enterResultMode / exitResultMode — swap the input form for
       a compact "Edit URL" bar once a result is showing, and back.
     • initRecentChips — up to 3 "recently checked" chips shown
       when the URL field is focused; tapping one instantly loads
       that cached result.
     • attachResultActions — wires the result card's action
       buttons (New URL / Share / Image / PDF / Review Paper /
       Attempt as Mock).
     • captureCardImage / handleShare / handleImage — high quality
       PNG export of the result card via html2canvas (loaded lazily
       from CDN only when first needed).
     • initDesktopToggle — toggles a wider viewport so the whole
       page can be viewed "zoomed out" like a desktop layout.
═══════════════════════════════════════════════════ */

const RSMUI = (() => {

  // ── Toast ──
  function toast(msg) {
    let el = document.getElementById('rsmToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rsmToast';
      el.className = 'rsm-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('rsm-toast--show');
    clearTimeout(el._rsmTimer);
    el._rsmTimer = setTimeout(() => el.classList.remove('rsm-toast--show'), 2200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function shortenUrl(url) {
    if (!url) return '';
    return url.length > 46 ? url.slice(0, 28) + '…' + url.slice(-14) : url;
  }

  // ── Result-mode transitions ──
  // ctx = { inputCard, editBar, editBarText, resultsSection, urlInput, chipsContainer }
  function enterResultMode(ctx, url) {
    if (!ctx) return;
    if (ctx.inputCard) ctx.inputCard.classList.add('hidden');
    if (ctx.chipsContainer) ctx.chipsContainer.classList.add('hidden');
    if (ctx.editBar) {
      ctx.editBar.classList.remove('hidden');
      if (ctx.editBarText) ctx.editBarText.textContent = shortenUrl(url);
    }
  }

  // opts.clearUrl: true for "New URL" (empties the field so the user
  // types a fresh one); left false/undefined for "Edit URL" (keeps the
  // current URL in the field so the user can tweak it in place).
  function exitResultMode(ctx, opts = {}) {
    if (!ctx) return;
    if (ctx.resultsSection) {
      ctx.resultsSection.classList.add('hidden');
      ctx.resultsSection.innerHTML = '';
    }
    if (ctx.editBar) ctx.editBar.classList.add('hidden');
    if (ctx.inputCard) {
      ctx.inputCard.classList.remove('hidden');
      ctx.inputCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (opts.clearUrl && ctx.urlInput) {
      ctx.urlInput.value = '';
      ctx.urlInput.focus();
    }
  }

  function initEditBar(ctx) {
    if (!ctx || !ctx.editBar) return;
    const editBtn = ctx.editBar.querySelector('[data-action="edit-url"]');
    if (editBtn) editBtn.addEventListener('click', () => exitResultMode(ctx));
  }

  // ── Recent-cache chips ──
  // onPick(url) is called after the field is filled — the caller should
  // trigger its normal fetch flow, which will hit the cache instantly.
  function initRecentChips(ctx, onPick, family = null) {
    const { urlInput, chipsContainer } = ctx || {};
    if (!urlInput || !chipsContainer || typeof RSMCache === 'undefined') return;

    function render() {
      const items = RSMCache.recent(3, family);
      if (!items.length) {
        chipsContainer.innerHTML = '';
        chipsContainer.classList.add('hidden');
        return;
      }
      chipsContainer.innerHTML = `
        <div class="recent-chips__label">Recently checked</div>
        <div class="recent-chips__row">
          ${items.map((it, i) => {
            const label = (it.candidateInfo && (it.candidateInfo.name || it.candidateInfo.rollNo)) || `Result ${i + 1}`;
            const score = (it.totalScore != null && it.maxScore != null) ? `${it.totalScore}/${it.maxScore}` : '';
            return `
              <button type="button" class="recent-chip" data-idx="${i}">
                <span class="recent-chip__name">${escapeHtml(label)}</span>
                ${score ? `<span class="recent-chip__score">${escapeHtml(score)}</span>` : ''}
              </button>`;
          }).join('')}
        </div>`;
      chipsContainer.classList.remove('hidden');

      chipsContainer.querySelectorAll('.recent-chip').forEach(btn => {
        // Prevent input blur from hiding the chip before the click registers.
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          const item = items[idx];
          if (!item) return;
          urlInput.value = item.url;
          chipsContainer.classList.add('hidden');
          if (typeof onPick === 'function') onPick(item.url, item);
        });
      });
    }

    urlInput.addEventListener('focus', render);
    urlInput.addEventListener('input', () => {
      if (!urlInput.value.trim()) render();
      else chipsContainer.classList.add('hidden');
    });
    document.addEventListener('click', e => {
      if (e.target !== urlInput && !chipsContainer.contains(e.target)) {
        chipsContainer.classList.add('hidden');
      }
    });
  }

  // ── Required-field validation (red border + single toast) ──
  // Accepts an array of form elements (input/select/checkbox). Marks each
  // empty one with a `.field-error` class (checkboxes get the class on
  // their wrapping `.checkbox-wrap` instead, since the native checkbox
  // box can't show a border reliably across platforms), scrolls/focuses
  // the first invalid field, and returns true only if everything is filled.
  function fieldIsEmpty(el) {
    if (!el) return false;
    if (el.type === 'checkbox') return !el.checked;
    return !String(el.value || '').trim();
  }

  function errorTarget(el) {
    if (el.type === 'checkbox') return el.closest('.checkbox-wrap') || el;
    return el;
  }

  function markFieldError(el) {
    if (!el) return;
    errorTarget(el).classList.add('field-error');
  }

  function clearFieldError(el) {
    if (!el) return;
    errorTarget(el).classList.remove('field-error');
  }

  function validateFields(fieldEls) {
    let firstInvalid = null;
    (fieldEls || []).forEach(el => {
      if (!el) return;
      if (fieldIsEmpty(el)) {
        markFieldError(el);
        if (!firstInvalid) firstInvalid = el;
      } else {
        clearFieldError(el);
      }
    });
    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { firstInvalid.focus({ preventScroll: true }); } catch (e) { firstInvalid.focus(); }
    }
    return !firstInvalid;
  }

  // Clears the red state on a field as soon as the user fixes it, so
  // errors don't linger after the person has actually filled the field.
  function initFieldErrorClearing(fieldEls) {
    (fieldEls || []).forEach(el => {
      if (!el) return;
      const evt = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(evt, () => { if (!fieldIsEmpty(el)) clearFieldError(el); });
    });
  }

  // ── Capacitor native-platform detection ──
  function isNativeApp() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  function nativePlugin(name) {
    try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null; }
    catch (e) { return null; }
  }

  // ── html2canvas (lazy-loaded) ──
  let html2canvasPromise = null;
  function ensureHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (html2canvasPromise) return html2canvasPromise;
    html2canvasPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error('html2canvas load failed'));
      document.head.appendChild(s);
    });
    return html2canvasPromise;
  }

  // Draws a "RANK SCORE MASTER" watermark onto a captured canvas: a
  // diagonal repeating tile across the whole card (light, unobtrusive)
  // plus one solid brand line pinned to the bottom edge — the exported
  // image should be identifiable as coming from the app even if it's
  // forwarded around outside it.
    async function captureCardImage(cardEl) {
    const html2canvas = await ensureHtml2Canvas();
    
    // 1. Hide the action buttons so they aren't in the saved image
    const actionRows = cardEl.querySelectorAll('.action-row');
    actionRows.forEach(el => { el.style.display = 'none'; });

    // 2. Save all original mobile styles so we can restore them later
    const originalWidth = cardEl.style.width;
    const originalMaxWidth = cardEl.style.maxWidth;
    const originalMargin = cardEl.style.margin;
    const originalBg = cardEl.style.background;
    const originalBorder = cardEl.style.border;
    const originalBoxShadow = cardEl.style.boxShadow;

    // 3. FORCE DESKTOP MODE & TRANSPARENCY
    // We make the card background transparent here so the watermark can show through from behind!
    cardEl.style.setProperty('width', '900px', 'important');
    cardEl.style.setProperty('max-width', '900px', 'important');
    cardEl.style.setProperty('margin', '0', 'important');
    cardEl.style.setProperty('background', 'transparent', 'important');
    cardEl.style.setProperty('border', 'none', 'important');
    cardEl.style.setProperty('box-shadow', 'none', 'important');

    // 4. Force Tables to Expand (No scrollbars/cropping)
    const scrollEls = cardEl.querySelectorAll('.table-scroll, .mt-section-scroll, .mt-col-section--scroll');
    const originalStyles = new Map();
    scrollEls.forEach(el => {
      originalStyles.set(el, el.getAttribute('style') || '');
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-x', 'visible', 'important');
      if (el.classList.contains('mt-col-section--scroll')) {
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('white-space', 'nowrap', 'important');
      }
    });

    // Determine if the app is currently in Dark or Light mode
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const baseBg = isDark ? '#131b19' : '#ffffff'; 

    let contentCanvas;
    try {
      // Take the picture with a NULL background so we can layer things manually
      contentCanvas = await html2canvas(cardEl, { 
        scale: 3, 
        backgroundColor: null, 
        useCORS: true,
        windowWidth: 1000 
      });
    } finally {
      // 5. RESTORE ORIGINAL MOBILE STYLES INSTANTLY
      actionRows.forEach(el => { el.style.display = ''; });
      
      cardEl.style.width = originalWidth;
      cardEl.style.maxWidth = originalMaxWidth;
      cardEl.style.margin = originalMargin;
      cardEl.style.background = originalBg;
      cardEl.style.border = originalBorder;
      cardEl.style.boxShadow = originalBoxShadow;

      scrollEls.forEach(el => {
        const orig = originalStyles.get(el);
        if (orig) el.setAttribute('style', orig);
        else el.removeAttribute('style');
      });
    }

    // 6. COMPOSE THE FINAL IMAGE (Layers: Background -> Watermark -> Text -> Footer)
    const w = contentCanvas.width;
    const h = contentCanvas.height;
    
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = w;
    finalCanvas.height = h;
    const ctx = finalCanvas.getContext('2d');

    // Layer A: Solid base background
    ctx.fillStyle = baseBg;
    ctx.fillRect(0, 0, w, h);

    // Layer B: Center Logo Watermark
    try {
      const logo = new Image();
      logo.crossOrigin = 'anonymous';
      logo.src = 'logo.jpg';
      await new Promise((resolve, reject) => {
        logo.onload = resolve;
        logo.onerror = reject;
      });
      
      const size = Math.min(w, h) * 0.6;
      const x = (w - size) / 2;
      const y = (h - size) / 2;
      
      ctx.save();
      if (!isDark) {
        // In light mode, 'multiply' mathematically deletes the white background of a jpeg
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.05;
      } else {
        // In dark mode, we just drop the opacity super low so the white box blends in
        ctx.globalAlpha = 0.03;
      }
      ctx.drawImage(logo, x, y, size, size);
      ctx.restore();
    } catch (e) {
      console.warn('Could not load logo for watermark', e);
    }

    // Layer C: Diagonal Text Watermark
    ctx.save();
    ctx.font = `bold ${Math.round(w * 0.045)}px sans-serif`;
    ctx.fillStyle = 'rgba(150,150,150,0.06)'; // Super faint
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 7);
    const stepY = h * 0.16;
    for (let y = -h; y < h; y += stepY) {
      ctx.fillText('RANK SCORE MASTER', 0, y);
    }
    ctx.restore();

    // Layer D: The actual Tables, Text, and Scores (Placing them ON TOP of the watermark)
    ctx.drawImage(contentCanvas, 0, 0);

    // Layer E: Solid Brand Bar pinned at the very bottom
    const barH = Math.max(30, Math.round(h * 0.035));
    ctx.save();
    ctx.fillStyle = 'rgba(15,118,110,0.95)';
    ctx.fillRect(0, h - barH, w, barH);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(barH * 0.45)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RANK SCORE MASTER  ·  rankscoremaster.app', w / 2, h - barH / 2);
    ctx.restore();

    return finalCanvas;
    }
       


  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function fileNameFor(meta, suffix) {
    const fam = (meta && meta.family) ? meta.family : 'exam';
    return `scorecard-${fam}-${suffix}-${Date.now()}.png`;
  }

  function canvasToBase64(canvas) {
    // Strip the "data:image/png;base64," prefix — native Filesystem
    // writes want the raw base64 payload only.
    const dataUrl = canvas.toDataURL('image/png', 1.0);
    return dataUrl.split(',')[1];
  }

  function canvasToBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png', 1.0));
  }

  // Writes the canvas into the app's cache dir via the Capacitor
  // Filesystem plugin and returns a file:// / content:// URI that other
  // native plugins (Share, Media) can consume. Used only inside the
  // packaged app — browsers use the Blob/download path instead.
  async function writeCanvasToNativeCache(canvas, fileName) {
    const Filesystem = nativePlugin('Filesystem');
    if (!Filesystem) throw new Error('Filesystem plugin not available');
    const base64Data = canvasToBase64(canvas);
    await Filesystem.writeFile({
      path: fileName,
      data: base64Data,
      directory: 'CACHE',
      recursive: true
    });
    const uriResult = await Filesystem.getUri({ path: fileName, directory: 'CACHE' });
    return uriResult.uri;
  }

  async function handleShare(cardEl, meta) {
    try {
      toast('Preparing image…');
      const canvas = await captureCardImage(cardEl);
      const fileName = fileNameFor(meta, 'share');

      if (isNativeApp()) {
        try {
          const fileUri = await writeCanvasToNativeCache(canvas, fileName);
          const Share = nativePlugin('Share');
          if (Share) {
            await Share.share({
              title: 'My Score Card',
              text: 'My score card from Rank Score Master',
              files: [fileUri],
              dialogTitle: 'Share your scorecard'
            });
            return;
          }
        } catch (e) {
          // fall through to web share/download below
        }
      }

      const blob = await canvasToBlob(canvas);
      if (!blob) { toast('Could not create image'); return; }
      try {
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My Score Card' });
          return;
        }
      } catch (e) {
        // fall through to download
      }
      downloadBlob(blob, fileName);
      toast('Sharing not supported here — image saved instead');
    } catch (e) {
      toast('Could not create image — try again');
    }
  }

  async function handleImage(cardEl, meta) {
    try {
      toast('Saving high-quality image…');
      const canvas = await captureCardImage(cardEl);
      const fileName = fileNameFor(meta, 'image');

      if (isNativeApp()) {
        try {
          const fileUri = await writeCanvasToNativeCache(canvas, fileName);
          const Media = nativePlugin('Media');
          if (Media && Media.savePhoto) {
            await Media.savePhoto({ path: fileUri, albumIdentifier: 'Rank Score Master' });
            toast('Saved to gallery');
            return;
          }
          // No gallery plugin bundled — fall back to sharing the file so
          // the person can still save it via the system share sheet
          // ("Save to Photos" / "Save image" is offered by the OS there).
          const Share = nativePlugin('Share');
          if (Share) {
            await Share.share({ title: 'Save Score Card', files: [fileUri] });
            toast('Choose "Save image" in the share sheet to add it to your gallery');
            return;
          }
        } catch (e) {
          // fall through to web download below
        }
      }

      const blob = await canvasToBlob(canvas);
      if (!blob) { toast('Could not create image'); return; }
      downloadBlob(blob, fileName);
      toast('Image saved');
    } catch (e) {
      toast('Could not create image — try again');
    }
  }

  // ── Action buttons on the result card ──
  function attachResultActions(cardEl, ctx, meta) {
    if (!cardEl) return;
    cardEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        switch (action) {
          case 'new-url':
            exitResultMode(ctx, { clearUrl: true });
            break;
          case 'share':
            handleShare(cardEl, meta);
            break;
          case 'image':
            handleImage(cardEl, meta);
            break;
          case 'pdf':
            toast('PDF export (full answer key) — coming soon');
            break;
          case 'review-paper':
            toast('Review Paper — coming soon');
            break;
          case 'attempt-mock':
            toast('Attempt as Mock — coming soon');
            break;
        }
      });
    });
  }

  // ── Desktop-mode viewport toggle ──
  function initDesktopToggle(btn) {
    if (!btn) return;
    const meta = document.querySelector('meta[name="viewport"]');
    const original = meta ? meta.getAttribute('content') : null;
    let isDesktop = false;
    btn.addEventListener('click', () => {
      isDesktop = !isDesktop;
      if (meta) meta.setAttribute('content', isDesktop ? 'width=1200' : original);
      document.documentElement.classList.toggle('desktop-mode', isDesktop);
      btn.classList.toggle('active', isDesktop);
      btn.setAttribute('aria-pressed', String(isDesktop));
    });
  }

  return {
    toast,
    enterResultMode,
    exitResultMode,
    initEditBar,
    initRecentChips,
    attachResultActions,
    captureCardImage,
    handleShare,
    handleImage,
    initDesktopToggle,
    validateFields,
    initFieldErrorClearing,
    markFieldError,
    clearFieldError,
    isNativeApp
  };
})();
