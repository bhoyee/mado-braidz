// Quietly keeps the overview and appointment book up to date. The page itself is
// the source, so filters, totals and access checks stay on the server.
const regions = () => [...document.querySelectorAll('[data-live]')];
if (regions().length) {
  const INTERVAL = 15000;
  const status = document.querySelector('[data-live-status]');
  const shown = new Map(regions().map((el) => [el.dataset.live, el.innerHTML]));
  let running = false,
    stopped = false,
    pointerDown = false;
  addEventListener('pointerdown', () => (pointerDown = true));
  for (const name of ['pointerup', 'pointercancel', 'blur'])
    addEventListener(name, () => (pointerDown = false));
  const say = (text) => {
    if (status) status.textContent = text;
  };
  // Never swap content while the owner is selecting, pressing or searching.
  const busy = (region) =>
    pointerDown ||
    region.getAttribute('aria-busy') === 'true' ||
    // A note being written, or a decision being saved, must never be lost.
    [...region.querySelectorAll('textarea, input:not([type=hidden])')].some(
      (field) => field.value || field === document.activeElement,
    ) ||
    Boolean(region.querySelector('button:disabled')) ||
    Boolean(document.querySelector('dialog[open]')) ||
    (!getSelection().isCollapsed && region.contains(getSelection().anchorNode));
  function swap(region, next) {
    const html = next.innerHTML;
    if (shown.get(region.dataset.live) === html) return;
    // Pages with forms reload whole, so their actions keep working.
    if (region.hasAttribute('data-live-reload')) {
      // Wait rather than stop a guide video that is being watched.
      if (document.querySelector('[data-guide-player]:not([hidden])')) return;
      return location.reload();
    }
    const wrap = region.querySelector('.owner-table-wrap');
    const scroll = wrap && [wrap.scrollTop, wrap.scrollLeft];
    const active = region.contains(document.activeElement)
      ? document.activeElement
      : null;
    const href = active?.getAttribute('href');
    const before = new Set(
      [...region.querySelectorAll('tbody tr')].map((row) => row.innerHTML),
    );
    const fresh = document.importNode(next, true);
    for (const row of fresh.querySelectorAll('tbody tr'))
      if (!before.has(row.innerHTML)) row.classList.add('row-fresh');
    region.replaceWith(fresh);
    shown.set(fresh.dataset.live, html);
    const newWrap = fresh.querySelector('.owner-table-wrap');
    if (newWrap && scroll) [newWrap.scrollTop, newWrap.scrollLeft] = scroll;
    if (active) {
      const target = href
        ? [...fresh.querySelectorAll('a')].find(
            (a) => a.getAttribute('href') === href,
          )
        : newWrap;
      target?.focus({ preventScroll: true });
    }
  }
  // Filters the rows already on the page; the server search covers the rest.
  const filter = document.querySelector('[data-live-filter]');
  const filterStatus = document.querySelector('[data-live-filter-status]');
  function applyFilter() {
    if (!filter) return;
    const query = filter.value.trim().toLowerCase();
    const digits = /^[+\d().\s-]+$/.test(query) ? query.replace(/\D/g, '') : '';
    const terms = query.split(/\s+/).filter(Boolean);
    const rows = [...document.querySelectorAll('[data-live] tr[data-search]')];
    let matches = 0;
    for (const row of rows) {
      const text = row.dataset.search;
      const match =
        terms.every((term) =>
          // A short number means a date or time, not part of every phone number.
          /^\d{1,2}$/.test(term)
            ? text.split(/\s+/).some((word) => word.startsWith(term))
            : text.includes(term),
        ) ||
        (digits.length >= 3 && text.replace(/\D/g, '').includes(digits));
      row.hidden = !match;
      if (match) matches++;
    }
    filterStatus.textContent = !query
      ? ''
      : matches
        ? `${matches} of ${rows.length} appointments shown.`
        : 'No upcoming appointments match your search.';
  }
  filter?.addEventListener('input', () => {
    applyFilter();
    updateHints();
  });
  function updateHints() {
    for (const hint of document.querySelectorAll('[data-scroll-hint]')) {
      const wrap = hint.previousElementSibling;
      hint.hidden = wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop < 12;
    }
  }
  document.addEventListener('scroll', updateHints, {
    capture: true,
    passive: true,
  });
  addEventListener('resize', updateHints);
  addEventListener('load', updateHints);
  document.addEventListener('click', (event) => {
    const hint = event.target.closest('[data-scroll-hint]');
    if (!hint) return;
    const wrap = hint.previousElementSibling;
    wrap.scrollBy({
      top: wrap.clientHeight * 0.8,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  });
  applyFilter();
  updateHints();
  async function refresh() {
    if (running || stopped || document.hidden) return;
    running = true;
    const url = location.href;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      });
      if (response.redirected || response.status === 401) {
        stopped = true;
        say('Your session ended. Refresh to sign in again.');
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const page = new DOMParser().parseFromString(
        await response.text(),
        'text/html',
      );
      if (url !== location.href) return;
      for (const region of regions()) {
        const next = page.querySelector(`[data-live="${region.dataset.live}"]`);
        if (next && !busy(region)) swap(region, next);
      }
      applyFilter();
      updateHints();
      say(
        'Live · updated ' +
          new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date()) +
          ' ET',
      );
    } catch {
      say('Reconnecting…');
    } finally {
      running = false;
    }
  }
  setInterval(refresh, INTERVAL);
  document.addEventListener('visibilitychange', refresh);
  addEventListener('online', refresh);
  addEventListener('pageshow', (event) => {
    if (event.persisted) refresh();
  });
}
