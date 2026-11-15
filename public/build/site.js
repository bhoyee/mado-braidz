// Native controls remain usable without JavaScript; these enhance the map and preview.
document.querySelectorAll('[data-load-map]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.closest('[data-map]');
    const iframe = document.createElement('iframe');
    iframe.src = panel.dataset.map;
    iframe.title = 'Map to Mado African Braidz';
    iframe.referrerPolicy = 'no-referrer';
    iframe.allowFullscreen = true;
    panel.append(iframe);
    button.remove();
  });
});
document
  .querySelectorAll('[data-open-dialog]')
  .forEach((button) =>
    button.addEventListener('click', () =>
      document.getElementById(button.dataset.openDialog).showModal(),
    ),
  );
document
  .querySelectorAll('[data-close-dialog]')
  .forEach((button) =>
    button.addEventListener('click', () => button.closest('dialog').close()),
  );
document
  .querySelectorAll('[data-dismiss]')
  .forEach((button) =>
    button.addEventListener(
      'click',
      () => (button.closest('[data-toast]').hidden = true),
    ),
  );
document.querySelectorAll('[data-toggle-group]').forEach((group) =>
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    group
      .querySelectorAll('button')
      .forEach((item) =>
        item.setAttribute('aria-pressed', String(item === button)),
      );
  }),
);
document.querySelectorAll('[data-summary-toggle]').forEach((button) =>
  button.addEventListener('click', () => {
    const summary = document.getElementById('demo-summary');
    summary.hidden = !summary.hidden;
    button.setAttribute('aria-expanded', String(!summary.hidden));
    if (!summary.hidden) summary.querySelector('button').focus();
  }),
);
document
  .querySelector('[data-summary-close]')
  ?.addEventListener('click', () => {
    document.getElementById('demo-summary').hidden = true;
    const button = document.querySelector('[data-summary-toggle]');
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  });

// Studio films stay as lightweight posters until playback is appropriate.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const saveData = navigator.connection?.saveData;
document.querySelectorAll('[data-studio-player]').forEach((player) => {
  const video = player.querySelector('video');
  const button = player.querySelector('[data-video-toggle]');
  const label = player.querySelector('[data-video-label]');
  const icon = player.querySelector('[data-video-icon]');
  const feedback = player.querySelector('[data-video-feedback]');
  let wantsPlayback =
    video.hasAttribute('data-hero-video') &&
    !reducedMotion.matches &&
    !saveData;
  let inView = false;
  let readyToAutoPlay = document.readyState === 'complete';
  function setButton(playing) {
    button.setAttribute('aria-pressed', String(playing));
    label.textContent = playing ? 'Pause film' : 'Play film';
    icon.textContent = playing ? 'Ⅱ' : '▶';
  }
  async function play() {
    const source = video.querySelector('source');
    if (!source.getAttribute('src')) {
      source.src = source.dataset.src;
      video.load();
    }
    try {
      await video.play();
      feedback.textContent = '';
    } catch {
      setButton(false);
      feedback.textContent =
        'The film could not start. Press Play to try again.';
    }
  }
  video.addEventListener('play', () => setButton(true));
  video.addEventListener('pause', () => setButton(false));
  video.addEventListener('error', () => {
    setButton(false);
    feedback.textContent =
      'The film is unavailable. You can still browse the studio and styles.';
  });
  button.addEventListener('click', () => {
    wantsPlayback = video.paused;
    if (wantsPlayback) play();
    else video.pause();
  });
  const maybePlay = () => {
    if (inView && wantsPlayback && readyToAutoPlay && !document.hidden) play();
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView) maybePlay();
        else video.pause();
      },
      { threshold: 0.35 },
    ).observe(video);
  }
  window.addEventListener(
    'load',
    () => {
      readyToAutoPlay = true;
      setTimeout(maybePlay, 600);
    },
    { once: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else maybePlay();
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      wantsPlayback = false;
      video.pause();
    }
  });
});
