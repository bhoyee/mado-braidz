// Native controls remain usable without JavaScript; these enhance the map and preview.
document.querySelectorAll('[data-load-map]').forEach((button) => {
  button.addEventListener('click', () => {
    const panel = button.closest('[data-map]');
    const iframe = document.createElement('iframe');
    iframe.src = panel.dataset.map;
    iframe.title = 'Map to Mado African Braidz';
    iframe.referrerPolicy = 'no-referrer';
    iframe.allowFullscreen = true;
    panel.replaceChildren(iframe);
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

// Hero films: silent loops that start on their own, with no controls.
// They never load for reduced-motion or data-saver visitors (poster only),
// and pause whenever they are off screen or the tab is hidden.
const heroClips = [...document.querySelectorAll('video[data-hero-video]')];
if (heroClips.length && !reducedMotion.matches && !saveData) {
  const visible = new Set();
  const start = (video) => {
    const source = video.querySelector('source');
    if (!source.getAttribute('src')) {
      source.src = source.dataset.src;
      video.load();
    }
    video.play().catch(() => {});
  };
  const sync = (video) => {
    if (visible.has(video) && !document.hidden && !reducedMotion.matches)
      start(video);
    else video.pause();
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
          sync(entry.target);
        }),
      { threshold: 0.2 },
    );
    heroClips.forEach((video) => observer.observe(video));
  } else heroClips.forEach((video) => (visible.add(video), sync(video)));
  document.addEventListener('visibilitychange', () => heroClips.forEach(sync));
  reducedMotion.addEventListener('change', () => heroClips.forEach(sync));
}

// Price menu tabs: show one style's prices at a time. Without JavaScript the
// tab row stays hidden and every price grid is shown in turn.
const priceTabs = document.querySelector('[data-price-tabs]');
if (priceTabs) {
  const buttons = [...priceTabs.querySelectorAll('[data-panel]')];
  const panels = buttons.map((b) => document.getElementById(b.dataset.panel));
  priceTabs.hidden = false;
  priceTabs.setAttribute('role', 'tablist');
  buttons.forEach((button, i) => {
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panels[i].id);
    panels[i].setAttribute('role', 'tabpanel');
    panels[i].setAttribute('aria-labelledby', button.id);
    panels[i].removeAttribute('aria-label');
    panels[i].tabIndex = 0;
  });
  const select = (index, focus) => {
    buttons.forEach((button, i) => {
      const on = i === index;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    if (focus) buttons[index].focus();
    // Keep the chosen tab visible in the scrollable row without moving the page.
    const b = buttons[index];
    const left = b.offsetLeft - priceTabs.offsetLeft;
    if (
      left < priceTabs.scrollLeft ||
      left + b.offsetWidth > priceTabs.scrollLeft + priceTabs.clientWidth
    )
      priceTabs.scrollTo({ left: left - 16, behavior: 'smooth' });
  };
  buttons.forEach((button, i) => {
    button.addEventListener('click', () => select(i, false));
    button.addEventListener('keydown', (event) => {
      const last = buttons.length - 1;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: last }[
        event.key
      ];
      if (next === undefined) return;
      event.preventDefault();
      select((next + buttons.length) % buttons.length, true);
    });
  });
  select(0, false);
}

// Styles page live search: filters style blocks and their price tiles as you
// type. A style shows when every word matches it; if the words only match some
// options (e.g. "waist"), just those tiles show. The form still submits to the
// server when JavaScript is unavailable.
const styleSearch = document.querySelector('[data-style-search]');
if (styleSearch) {
  const input = styleSearch.querySelector('input[type="search"]');
  const blocks = [...document.querySelectorAll('.catalog-style[data-search]')];
  const count = document.querySelector('[data-result-count]');
  const empty = document.querySelector('[data-search-empty]');
  const words = (text) =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  const apply = () => {
    const query = words(input.value);
    let shown = 0;
    blocks.forEach((block) => {
      const base = block.dataset.search;
      const options = [...block.querySelectorAll('[data-option]')];
      const styleMatch = query.every((w) => base.includes(w));
      let any = styleMatch;
      options.forEach((option) => {
        const ok =
          styleMatch ||
          query.every((w) => `${base} ${option.dataset.option}`.includes(w));
        option.hidden = !ok;
        if (ok) any = true;
      });
      block.querySelectorAll('.option-group').forEach((group) => {
        group.hidden = ![...group.querySelectorAll('[data-option]')].some(
          (o) => !o.hidden,
        );
      });
      block.hidden = !any;
      if (any) shown += 1;
    });
    count.textContent = `${shown} ${shown === 1 ? 'style' : 'styles'} to explore`;
    if (empty) empty.hidden = shown > 0;
    const url = new URL(location.href);
    if (input.value.trim()) url.searchParams.set('q', input.value.trim());
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
  };
  input.addEventListener('input', apply);
  if (input.value.trim()) apply();
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value) {
      input.value = '';
      apply();
    }
  });
  styleSearch.addEventListener('submit', (event) => {
    event.preventDefault();
    apply();
    input.blur();
  });
}
