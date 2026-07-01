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
  function initRecentChips(ctx, onPick) {
    const { urlInput, chipsContainer } = ctx || {};
    if (!urlInput || !chipsContainer || typeof RSMCache === 'undefined') return;

    function render() {
      const items = RSMCache.recent(3);
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

  async function captureCardImage(cardEl) {
    const html2canvas = await ensureHtml2Canvas();
    // Hide the action button rows so the exported image is a clean
    // scorecard — details + marks + rank grid only.
    const actionRows = cardEl.querySelectorAll('.action-row');
    actionRows.forEach(el => { el.style.display = 'none'; });

    let bg = '#0b0f14';
    try {
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') bg = bodyBg;
    } catch (e) {}

    let canvas;
    try {
      canvas = await html2canvas(cardEl, { scale: 3, backgroundColor: bg, useCORS: true });
    } finally {
      actionRows.forEach(el => { el.style.display = ''; });
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

  async function handleShare(cardEl, meta) {
    try {
      toast('Preparing image…');
      const canvas = await captureCardImage(cardEl);
      canvas.toBlob(async blob => {
        if (!blob) { toast('Could not create image'); return; }
        const fileName = fileNameFor(meta, 'share');
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
      }, 'image/png', 1.0);
    } catch (e) {
      toast('Could not create image — try again');
    }
  }

  async function handleImage(cardEl, meta) {
    try {
      toast('Saving high-quality image…');
      const canvas = await captureCardImage(cardEl);
      canvas.toBlob(blob => {
        if (!blob) { toast('Could not create image'); return; }
        downloadBlob(blob, fileNameFor(meta, 'image'));
        toast('Image saved');
      }, 'image/png', 1.0);
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
    initDesktopToggle
  };
})();
