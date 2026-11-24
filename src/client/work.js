// Our Work: filters and a larger view. Every photo still links to its style
// without this script.
(() => {
  const tiles = [...document.querySelectorAll('[data-work-item]')];
  const filters = document.querySelector('[data-work-filters]');
  if (filters) {
    filters.hidden = false;
    filters.addEventListener('click', (event) => {
      const button = event.target.closest('[data-work-group]');
      if (!button) return;
      for (const other of filters.querySelectorAll('button'))
        other.setAttribute('aria-pressed', String(other === button));
      const group = button.dataset.workGroup;
      let shown = 0;
      for (const tile of tiles) {
        tile.hidden = Boolean(group) && tile.dataset.workItem !== group;
        if (!tile.hidden) shown++;
        else tile.querySelector('video')?.pause();
      }
      document.querySelector('[data-work-status]').textContent =
        `${shown} shown.`;
    });
  }
  const viewer = document.querySelector('[data-work-viewer]');
  if (!viewer?.showModal) return;
  const image = viewer.querySelector('[data-viewer-image]');
  const link = viewer.querySelector('[data-viewer-link]');
  let current = null;
  const photos = () =>
    tiles.filter((tile) => tile.dataset.workPhoto && !tile.hidden);
  function show(tile) {
    current = tile;
    image.src = tile.dataset.workPhoto;
    image.alt = tile.dataset.workAlt;
    viewer.querySelector('[data-viewer-title]').textContent =
      tile.dataset.workLabel;
    link.hidden = !tile.dataset.workHref;
    if (tile.dataset.workHref) link.href = tile.dataset.workHref;
  }
  function step(by) {
    const list = photos();
    show(list[(list.indexOf(current) + by + list.length) % list.length]);
  }
  function open(tile) {
    show(tile);
    viewer.showModal();
  }
  for (const tile of photos()) {
    if (tile.querySelector('a')) continue;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', 'Enlarge ' + tile.dataset.workLabel);
    tile.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open(tile);
    });
  }
  document.querySelector('.work-grid').addEventListener('click', (event) => {
    const tile = event.target.closest('[data-work-photo]');
    if (!tile || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    open(tile);
  });
  viewer.addEventListener('click', (event) => {
    const button = event.target.closest('[data-viewer-step]');
    if (button) step(Number(button.dataset.viewerStep));
    else if (
      event.target === viewer ||
      event.target.closest('[data-viewer-close]')
    )
      viewer.close();
  });
  viewer.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
  viewer.addEventListener('close', () => {
    image.removeAttribute('src');
    (current?.querySelector('a') || current)?.focus({ preventScroll: true });
  });
})();
