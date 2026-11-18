const alertBox = document.querySelector('.owner-alert');
document
  .querySelector('nav[aria-label="Owner navigation"] a[aria-current]')
  ?.scrollIntoView({ block: 'nearest', inline: 'center' });
function report(message) {
  alertBox.classList.remove('owner-alert-success');
  alertBox.textContent = message;
  alertBox.hidden = false;
  alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
const resetToken = document.querySelector('#reset-token');
if (resetToken && /^[a-f0-9]{64}$/.test(location.hash.slice(1))) {
  resetToken.value = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
}
document.querySelectorAll('[data-owner-form]').forEach((form) => {
  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
    const data = new FormData(form);
    if (event.submitter?.name)
      data.set(event.submitter.name, event.submitter.value);
    const body = Object.fromEntries(data);
    if (data.has('addonIds')) body.addonIds = data.getAll('addonIds');
    if (data.has('styleIds')) body.styleIds = data.getAll('styleIds');
    for (const input of form.querySelectorAll('[data-money]')) {
      if (input.disabled || input.value === '' || input.closest('[hidden]'))
        continue;
      const match = input.value.match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!match) return report('Enter a valid amount in USD.');
      body[input.dataset.money] =
        Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    }
    busy = true;
    alertBox.hidden = true;
    const buttons = [
      ...form.querySelectorAll('button[type="submit"], button:not([type])'),
    ];
    buttons.forEach((button) => (button.disabled = true));
    try {
      // A control named "action" shadows HTMLFormElement.action. Read the
      // attribute so booking actions and hidden action fields cannot replace
      // the request URL with a select/input element.
      const response = await fetch(
        form.getAttribute('action') || location.href,
        {
          method: 'POST',
          headers:
            form.enctype === 'multipart/form-data'
              ? {
                  Accept: 'application/json',
                  'x-csrf-token': document.querySelector(
                    'meta[name="csrf-token"]',
                  ).content,
                }
              : {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
          body:
            form.enctype === 'multipart/form-data'
              ? data
              : JSON.stringify(body),
        },
      );
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error(
          response.redirected &&
            new URL(response.url).pathname === '/admin/login'
            ? 'Your session expired. Sign in again.'
            : 'Unable to save. Refresh the page and try again.',
        );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || result.error || 'Unable to save. Please try again.',
        );
      if (result.url) {
        sessionStorage.setItem('owner-message', result.message || 'Saved.');
        location.assign(result.url);
      }
    } catch (error) {
      report(error.message);
    } finally {
      busy = false;
      buttons.forEach((button) => (button.disabled = false));
    }
  });
});
const savedMessage = sessionStorage.getItem('owner-message');
const photoList = document.querySelector('[data-photo-list]');
if (photoList) {
  let dragged;
  photoList.addEventListener('dragstart', (event) => {
    dragged = event.target.closest('[data-photo-id]');
  });
  photoList.addEventListener('dragover', (event) => event.preventDefault());
  photoList.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target.closest('[data-photo-id]');
    if (dragged && target && dragged !== target)
      photoList.insertBefore(dragged, target);
    dragged = null;
  });
  photoList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-photo-move]');
    if (!button) return;
    const card = button.closest('[data-photo-id]');
    if (button.dataset.photoMove === '-1' && card.previousElementSibling)
      photoList.insertBefore(card, card.previousElementSibling);
    if (button.dataset.photoMove === '1' && card.nextElementSibling)
      photoList.insertBefore(card.nextElementSibling, card);
  });
  document
    .querySelector('[data-save-photo-order]')
    .addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await fetch('/admin/gallery/reorder', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-csrf-token': document.querySelector('meta[name="csrf-token"]')
              .content,
          },
          body: JSON.stringify({
            ids: [...photoList.querySelectorAll('[data-photo-id]')].map(
              (card) => Number(card.dataset.photoId),
            ),
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw Error(result.message || 'Unable to save photo order');
        sessionStorage.setItem('owner-message', 'Photo order saved.');
        location.reload();
      } catch (error) {
        report(error.message);
        button.disabled = false;
      }
    });
}
if (savedMessage) {
  sessionStorage.removeItem('owner-message');
  alertBox.textContent = savedMessage;
  alertBox.classList.add('owner-alert-success');
  alertBox.hidden = false;
}
document.querySelectorAll('[data-copy-link]').forEach((button) =>
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.copyLink);
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = 'Link copied';
    } catch {
      input.select();
      button.textContent = 'Select and copy this link';
    }
  }),
);
const editor = document.querySelector('[data-booking-editor]');
if (editor) {
  const style = editor.querySelector('[data-owner-style]'),
    variant = editor.querySelector('[data-owner-variant]'),
    fields = editor.querySelector('[data-style-fields]');
  const change = editor.querySelector('[data-change-style]'),
    preview = editor.querySelector('[data-price-preview]');
  let quoteVersion = 0;
  async function quote() {
    if (fields.disabled) return;
    const version = ++quoteVersion;
    const data = new FormData(editor);
    const body = {
      styleId: Number(style.value),
      addonIds: data.getAll('addonIds').map(Number),
    };
    if (variant.value) body.styleVariantId = Number(variant.value);
    try {
      const response = await fetch('/admin/api/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-csrf-token': document.querySelector('meta[name="csrf-token"]')
            .content,
        },
        body: JSON.stringify(body),
      });
      const price = await response.json();
      if (version !== quoteVersion) return;
      if (!response.ok) throw new Error(price.message);
      preview.textContent = `${price.consultation ? 'Consultation · provisional ' : 'New total '}${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(price.subtotalCents / 100)} · ${price.durationMin} minutes`;
      editor.dataset.duration = price.durationMin;
    } catch (error) {
      preview.textContent = error.message || 'Unable to load price.';
    }
  }
  function filterVariants(changed = false) {
    for (const field of fields.querySelectorAll('[data-addon-styles]')) {
      const allowed =
        field.dataset.addonAll !== 'false' ||
        field.dataset.addonStyles.split(',').includes(style.value);
      field.disabled = !allowed;
      field.closest('label').hidden = !allowed;
      if (!allowed) field.checked = false;
    }
    const options = [...variant.options];
    const matching = options.filter(
      (option) => option.dataset.style === style.value,
    );
    for (const option of options) {
      option.hidden = option.value
        ? option.dataset.style !== style.value
        : matching.length > 0;
      option.disabled = option.hidden;
    }
    if (changed || variant.selectedOptions[0]?.disabled)
      variant.value = matching[0]?.value || '';
    quote();
  }
  style.addEventListener('change', () => filterVariants(true));
  variant.addEventListener('change', quote);
  fields
    .querySelectorAll('[name="addonIds"]')
    .forEach((input) => input.addEventListener('change', quote));
  change?.addEventListener('change', () => {
    fields.disabled = !change.checked;
    if (change.checked) filterVariants();
  });
  filterVariants();
  const mode = editor.querySelector('[data-payment-mode]');
  mode?.addEventListener('change', () => {
    const manual = editor.querySelector('[data-manual-fields]');
    manual.hidden = mode.value !== 'manual';
    manual.querySelector('input').required = mode.value === 'manual';
  });
  editor
    .querySelector('[data-check-slots]')
    .addEventListener('click', async () => {
      const date = editor.querySelector('[data-owner-date]').value,
        target = editor.querySelector('[data-owner-slots]');
      if (!date) return report('Choose a date first.');
      const query = new URLSearchParams({
        date,
        durationMin: editor.dataset.duration || '240',
      });
      if (editor.dataset.bookingId)
        query.set('bookingId', editor.dataset.bookingId);
      // A changed style can have a different duration than the original booking.
      if (change?.checked) query.set('durationMin', editor.dataset.duration);
      target.textContent = 'Checking available times…';
      try {
        const response = await fetch('/admin/api/slots?' + query, {
          headers: { Accept: 'application/json' },
        });
        const slots = await response.json();
        if (!response.ok) throw new Error(slots.message);
        target.replaceChildren();
        for (const slot of slots.filter((s) => s.available)) {
          const button = document.createElement('button');
          button.type = 'button';
          const local = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(new Date(slot.startAt));
          button.textContent = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: 'numeric',
            minute: '2-digit',
          }).format(new Date(slot.startAt));
          button.addEventListener('click', () => {
            editor.querySelector('[data-owner-time]').value = local;
            target
              .querySelectorAll('button')
              .forEach((b) =>
                b.setAttribute('aria-pressed', String(b === button)),
              );
          });
          target.append(button);
        }
        if (!target.children.length)
          target.textContent = 'No available times. Choose another date.';
      } catch (error) {
        target.textContent = error.message;
      }
    });
}
