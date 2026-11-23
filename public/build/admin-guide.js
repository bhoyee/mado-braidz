// A floating guide video. It never locks the page, and YouTube is contacted
// only after the owner asks to watch.
const openButton = document.querySelector('[data-guide-open]');
const player = document.querySelector('[data-guide-player]');
if (openButton && player) {
  const frameBox = player.querySelector('[data-guide-frame]');
  const bar = player.querySelector('[data-guide-bar]');
  const sizeButton = player.querySelector('[data-guide-size]');
  const minButton = player.querySelector('[data-guide-min]');
  const ORIGIN = 'https://www.youtube-nocookie.com';
  let drag = null;

  const pause = () =>
    frameBox
      .querySelector('iframe')
      ?.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'pauseVideo', args: '' }),
        ORIGIN,
      );
  function setMinimised(on) {
    if (on) pause();
    player.classList.toggle('is-minimised', on);
    minButton.setAttribute('aria-label', on ? 'Show video' : 'Minimise video');
    minButton.title = on ? 'Show' : 'Minimise';
    minButton.firstElementChild.textContent = on ? '▢' : '–';
    keepInside();
  }
  function setLarge(on) {
    player.classList.toggle('is-large', on);
    sizeButton.setAttribute('aria-label', on ? 'Make smaller' : 'Make bigger');
    sizeButton.title = on ? 'Smaller' : 'Bigger';
    sizeButton.firstElementChild.textContent = on ? '⤡' : '⤢';
    if (on) setMinimised(false);
    resetPosition();
  }
  function resetPosition() {
    player.style.left = player.style.top = '';
    player.style.right = player.style.bottom = '';
  }
  function place(left, top) {
    const box = player.getBoundingClientRect();
    player.style.left =
      Math.max(8, Math.min(left, innerWidth - box.width - 8)) + 'px';
    player.style.top =
      Math.max(8, Math.min(top, innerHeight - box.height - 8)) + 'px';
    player.style.right = player.style.bottom = 'auto';
  }
  function keepInside() {
    if (player.hidden || !player.style.left) return;
    if (innerWidth <= 760) return resetPosition();
    const box = player.getBoundingClientRect();
    place(box.left, box.top);
  }
  function open() {
    if (!frameBox.firstChild) {
      const frame = document.createElement('iframe');
      frame.src = `${ORIGIN}/embed/${player.dataset.video}?rel=0&playsinline=1&autoplay=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
      frame.title = player.getAttribute('aria-label');
      frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      frame.allowFullscreen = true;
      // YouTube refuses to play without knowing the embedding site.
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frameBox.append(frame);
    }
    player.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    setMinimised(false);
    player.focus({ preventScroll: true });
  }
  function close() {
    player.hidden = true;
    frameBox.replaceChildren();
    openButton.setAttribute('aria-expanded', 'false');
    setLarge(false);
    setMinimised(false);
    openButton.focus({ preventScroll: true });
  }
  openButton.addEventListener('click', () =>
    player.hidden ? open() : close(),
  );
  player.querySelector('[data-guide-close]').addEventListener('click', close);
  sizeButton.addEventListener('click', () =>
    setLarge(!player.classList.contains('is-large')),
  );
  minButton.addEventListener('click', () =>
    setMinimised(!player.classList.contains('is-minimised')),
  );
  player.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  bar.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || innerWidth <= 760) return;
    const box = player.getBoundingClientRect();
    drag = { x: event.clientX - box.left, y: event.clientY - box.top };
    bar.setPointerCapture(event.pointerId);
    // The video would otherwise swallow the pointer while dragging.
    player.classList.add('is-dragging');
  });
  bar.addEventListener('pointermove', (event) => {
    if (drag) place(event.clientX - drag.x, event.clientY - drag.y);
  });
  for (const name of ['pointerup', 'pointercancel'])
    bar.addEventListener(name, () => {
      drag = null;
      player.classList.remove('is-dragging');
    });
  addEventListener('resize', keepInside);
}
