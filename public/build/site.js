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
