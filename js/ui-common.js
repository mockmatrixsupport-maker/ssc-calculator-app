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

  // ── html-to-image (Modern lazy-loaded replacement for html2canvas) ──
  let htmlToImagePromise = null;
  function ensureHtmlToImage() {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    if (htmlToImagePromise) return htmlToImagePromise;
    htmlToImagePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html-to-image/1.11.11/html-to-image.min.js';
      s.onload = () => resolve(window.htmlToImage);
      s.onerror = () => reject(new Error('html-to-image load failed'));
      document.head.appendChild(s);
    });
    return htmlToImagePromise;
  }
   

  // Draws a "RANK SCORE MASTER" watermark onto a captured canvas: a
  // diagonal repeating tile across the whole card (light, unobtrusive)
  // plus one solid brand line pinned to the bottom edge — the exported
  // image should be identifiable as coming from the app even if it's
  // forwarded around outside it.
  
    async function captureCardImage(cardEl) {
    const htmlToImage = await ensureHtmlToImage();
    
    // 1. Hide buttons so they aren't in the saved image
    const actionRows = cardEl.querySelectorAll('.action-row');
    actionRows.forEach(el => { el.style.display = 'none'; });

    // 2. Save original styles to restore them instantly later
    const originalCssText = cardEl.style.cssText;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const baseBg = isDark ? '#131b19' : '#ffffff';
    const textColor = isDark ? '#f1f5f4' : '#14201d';

    // 3. Force Desktop Mode for crisp, uncropped rendering
    cardEl.style.setProperty('width', '900px', 'important');
    cardEl.style.setProperty('max-width', '900px', 'important');
    cardEl.style.setProperty('margin', '0', 'important');
    cardEl.style.setProperty('position', 'relative', 'important');
    cardEl.style.setProperty('background', baseBg, 'important');
    cardEl.style.setProperty('color', textColor, 'important');
    cardEl.style.setProperty('border', 'none', 'important');
    cardEl.style.setProperty('border-radius', '0', 'important');
    cardEl.style.setProperty('box-shadow', 'none', 'important');

    // 4. Force Tables to Expand & Prevent "Dot Dot" Truncation
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

    // 5. TEMPORARY CSS: Sharp, dense, and clean fonts (Not overly bulky)
    const tempStyle = document.createElement('style');
    tempStyle.textContent = `
      .result-card > * { position: relative; z-index: 2; }
      
      /* Crisp, thinner header */
      .result-card__header { font-size: 1.15rem !important; font-weight: 700 !important; background: transparent !important; border: none !important; margin-bottom: 20px !important; }
      
      /* Standardized, sharp table text */
      .detail-table__value, .detail-table__label, .marks-table th, .marks-table td { font-size: 0.95rem !important; font-weight: 600 !important; padding: 10px !important; }
      
      /* Fix the "dot dot" truncation on section names */
      .mt-col-section { white-space: normal !important; overflow: visible !important; text-overflow: clip !important; max-width: none !important; }
      
      /* Distinct but not massive scores */
      .mt-pass, .mt-fail, .mt-bonus, .mt-score { font-size: 1.1rem !important; font-weight: 700 !important; }
      
      /* Rank Data */
      .rank-card__value { font-size: 1.4rem !important; font-weight: 700 !important; }
      .rank-card__label { font-size: 0.85rem !important; font-weight: 600 !important; }
      .rank-banner { font-size: 1rem !important; font-weight: 700 !important; padding: 12px !important; }
    `;
    document.head.appendChild(tempStyle);

    // 6. Inject Logo Watermark (Exactly 5% Opacity)
    const watermark = document.createElement('img');
    watermark.src = 'logo.jpg';
    watermark.crossOrigin = 'anonymous';
    watermark.style.cssText = `
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 60%;
      z-index: 1;
      pointer-events: none;
      opacity: 0.05;
    `;
    cardEl.insertBefore(watermark, cardEl.firstChild);

    // 7. Footer Brand Bar
    const footerBar = document.createElement('div');
    footerBar.style.cssText = `
      background: rgba(15,118,110,1);
      color: #ffffff;
      text-align: center;
      padding: 14px;
      font-size: 16px;
      font-weight: 600;
      margin: 24px -16px -16px -16px;
      font-family: sans-serif;
      position: relative;
      z-index: 2;
    `;
    footerBar.textContent = 'RANK SCORE MASTER  ·  rankscoremaster.app';
    cardEl.appendChild(footerBar);

    // Wait for the logo image to download and fonts to apply
    await new Promise((resolve) => {
      if (watermark.complete) resolve();
      else {
        watermark.onload = resolve;
        watermark.onerror = resolve;
      }
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    let canvas;
    try {
      // Capture using html-to-image
      canvas = await htmlToImage.toCanvas(cardEl, {
        pixelRatio: 3,
        backgroundColor: baseBg,
        width: 900,
        style: { transform: 'none' }
      });
    } finally {
      // 8. Instantly restore everything back to mobile view
      watermark.remove();
      footerBar.remove();
      tempStyle.remove();
      actionRows.forEach(el => { el.style.display = ''; });
      cardEl.style.cssText = originalCssText;

      scrollEls.forEach(el => {
        const orig = originalStyles.get(el);
        if (orig) el.setAttribute('style', orig);
        else el.removeAttribute('style');
      });
    }

    return canvas;
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

  // ── Review Paper handoff ──
  // Builds the richer review JSON (full question/option text + image
  // URLs, not just the qno+status score-engine.js needs) fresh, on
  // demand, from the SAME raw HTML `parts` already sitting in memory on
  // the result card (cardEl._rsmPdfData.parts — the same stash
  // pdf-download.js reads). Nothing here is written to RSMCache/
  // localStorage: the JSON is handed to review.html through
  // sessionStorage under one short-lived key that review.js deletes the
  // instant it reads it (and again on unload), so no generated review
  // data is ever left sitting in app storage once the person navigates
  // back — exactly the "don't keep it cached, only keep it while the
  // page is open" behaviour that was asked for.
  const REVIEW_HANDOFF_KEY = 'rsm-review-handoff';

  function openReviewPaper(cardEl, meta) {
    if (typeof RSMReviewBuilder === 'undefined') {
      toast('Review module failed to load — refresh and try again');
      return;
    }
    const pdfData = cardEl && cardEl._rsmPdfData;
    const parts = pdfData && pdfData.parts;
    const family = (meta && meta.family) || (pdfData && pdfData.family);
    const url = (meta && meta.url) || (pdfData && pdfData.url);

    if (!parts || !family) {
      toast('Please recalculate this result once, then try Review Paper again');
      return;
    }

    try {
      const reviewJson = RSMReviewBuilder.build(family, parts, url);
      if (!reviewJson || !reviewJson.sections || !reviewJson.sections.length) {
        toast('Could not build a review paper from this result');
        return;
      }
      sessionStorage.setItem(REVIEW_HANDOFF_KEY, JSON.stringify(reviewJson));
      window.location.href = 'review.html';
    } catch (e) {
      toast('Could not open Review Paper — try again');
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
            if (typeof RSMPdfDownload !== 'undefined') {
              RSMPdfDownload.handlePdfClick(btn, cardEl._rsmPdfData);
            } else {
              toast('PDF module failed to load — refresh and try again');
            }
            break;
          case 'review-paper':
            openReviewPaper(cardEl, meta);
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

