// Style photos: thumbnails, arrows and a larger view. Without this script the
// photos still swipe and the thumbnails still work as links.
(() => {
  const gallery = document.querySelector('[data-style-gallery]');
  if (!gallery) return;
  const track = gallery.querySelector('[data-gallery-track]');
  const slides = [...track.children];
  const thumbs = [...gallery.querySelectorAll('[data-gallery-thumb]')];
  const steps = [...gallery.querySelectorAll('[data-gallery-step]')];
  const count = gallery.querySelector('[data-gallery-count]');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0;
  function mark(index) {
    current = index;
    thumbs.forEach((thumb, i) => {
      if (i === index) thumb.setAttribute('aria-current', 'true');
      else thumb.removeAttribute('aria-current');
    });
    if (count) count.textContent = `${index + 1} / ${slides.length}`;
    for (const step of steps)
      step.disabled =
        Number(step.dataset.galleryStep) < 0
          ? index === 0
          : index === slides.length - 1;
    // Keep the chosen thumbnail in view without moving the page.
    const thumb = thumbs[index],
      rail = thumb?.parentElement.parentElement;
    if (!rail) return;
    rail.scrollTo({
      left: thumb.offsetLeft - (rail.clientWidth - thumb.clientWidth) / 2,
      top: thumb.offsetTop - (rail.clientHeight - thumb.clientHeight) / 2,
      behavior: calm.matches ? 'auto' : 'smooth',
    });
  }
  function go(index) {
    const next = Math.min(slides.length - 1, Math.max(0, index));
    track.scrollTo({
      left: next * track.clientWidth,
      behavior: calm.matches ? 'auto' : 'smooth',
    });
    mark(next);
  }
  thumbs.forEach((thumb, index) =>
    thumb.addEventListener('click', (event) => {
      event.preventDefault();
      go(index);
    }),
  );
  for (const step of steps) {
    step.hidden = slides.length < 2;
    step.addEventListener('click', () =>
      go(current + Number(step.dataset.galleryStep)),
    );
  }
  track.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      go(current + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  let settle;
  track.addEventListener(
    'scroll',
    () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const index = Math.round(track.scrollLeft / track.clientWidth);
        if (index !== current) mark(index);
      }, 90);
    },
    { passive: true },
  );
  addEventListener('resize', () => {
    track.scrollLeft = current * track.clientWidth;
  });
  if (slides.length) mark(0);

  const viewer = document.querySelector('[data-style-viewer]');
  if (!viewer?.showModal) return;
  const image = viewer.querySelector('[data-viewer-image]');
  function show(index) {
    const at = (index + slides.length) % slides.length;
    const photo = slides[at].querySelector('img');
    image.src = photo.getAttribute('src');
    image.alt = photo.alt;
    viewer.querySelector('[data-viewer-count]').textContent =
      `${at + 1} of ${slides.length}`;
    go(at);
  }
  for (const slide of slides) {
    const button = slide.querySelector('[data-gallery-zoom]');
    button.hidden = false;
    button.addEventListener('click', () => {
      show(slides.indexOf(slide));
      viewer.showModal();
    });
  }
  for (const step of viewer.querySelectorAll('[data-viewer-step]'))
    step.hidden = slides.length < 2;
  viewer.addEventListener('click', (event) => {
    const step = event.target.closest('[data-viewer-step]');
    if (step) show(current + Number(step.dataset.viewerStep));
    else if (
      event.target === viewer ||
      event.target.closest('[data-viewer-close]')
    )
      viewer.close();
  });
  viewer.addEventListener('keydown', (event) => {
    if (slides.length < 2) return;
    if (event.key === 'ArrowLeft') show(current - 1);
    if (event.key === 'ArrowRight') show(current + 1);
  });
  viewer.addEventListener('close', () => {
    image.removeAttribute('src');
    slides[current]
      .querySelector('[data-gallery-zoom]')
      .focus({ preventScroll: true });
  });
})();
