const alertBox = document.querySelector('.owner-alert');
document.querySelectorAll('[data-owner-modal-open]').forEach((button) => {
  const dialog = document.getElementById(button.dataset.ownerModalOpen);
  if (!(dialog instanceof HTMLDialogElement)) return;
  button.addEventListener('click', () => {
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"])')?.focus();
  });
});
document.querySelectorAll('[data-owner-modal-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog')?.close());
});
document
  .querySelector('[data-owner-password-toggle]')
  ?.addEventListener('click', (event) => {
    const button = event.currentTarget,
      input = document.getElementById(button.getAttribute('aria-controls'));
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute(
      'aria-label',
      visible ? 'Hide password' : 'Show password',
    );
  });
const notificationBadge = document.querySelector('[data-notification-count]');
const bell = document.querySelector('[data-notification-bell]');
const dropdown = document.querySelector('[data-notification-dropdown]');
const preview = document.querySelector('[data-notification-preview]');
let pollNotifications = async () => {};
if (bell) {
  const close = () => {
    dropdown.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  };
  bell.addEventListener('click', () => {
    dropdown.hidden = !dropdown.hidden;
    bell.setAttribute('aria-expanded', String(!dropdown.hidden));
    if (!dropdown.hidden) pollNotifications();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.owner-notification-menu')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dropdown.hidden) {
      close();
      bell.focus();
    }
  });
}
if (notificationBadge) {
  const poll = async () => {
    if (document.hidden) return;
    try {
      const response = await fetch('/admin/api/notifications?since=0', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      notificationBadge.textContent =
        data.unread > 99 ? '99+' : String(data.unread || 0);
      notificationBadge.hidden = !data.unread;
      bell.setAttribute(
        'aria-label',
        `Notifications, ${data.unread || 0} unread`,
      );
      preview.replaceChildren();
      for (const item of data.items.slice(0, 6)) {
        const link = document.createElement('a');
        link.className =
          'owner-notification-preview' + (item.readAt ? '' : ' unread');
        link.href = /^\/admin(?:\/|$)/.test(item.url || '')
          ? item.url
          : '/admin/notifications';
        const title = document.createElement('strong');
        title.textContent = item.title;
        const body = document.createElement('span');
        body.textContent = item.body;
        const time = document.createElement('time');
        time.dateTime = item.createdAt;
        time.textContent = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(item.createdAt));
        link.append(title, body, time);
        link.addEventListener('click', () => {
          if (item.readAt) return;
          fetch('/admin/notifications/read', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')
                .content,
            },
            body: JSON.stringify({ id: item.id }),
            keepalive: true,
          }).catch(() => {});
        });
        preview.append(link);
      }
      if (!data.items.length) preview.textContent = 'You are all caught up.';
    } catch {
      /* The next poll retries without interrupting owner work. */
    }
  };
  pollNotifications = poll;
  poll();
  setInterval(poll, 30000);
}
const pushStatus = document.querySelector('[data-push-status]');
const appleMobile =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const homeScreen =
  window.matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone;
const pushHelp = document.querySelector('[data-push-help]');
const permissionHelp = appleMobile
  ? 'Open Settings on your iPhone or iPad, select Notifications, then Mado Owner Studio and allow notifications. Reopen the Home Screen app and try again.'
  : /Android/.test(navigator.userAgent)
    ? "In your browser, open this site's permissions and allow Notifications. Also check Android Settings > Apps > your browser > Notifications. Then reload this page and try again."
    : "Open this site's permissions in your browser and allow Notifications. Also check your computer's notification settings, then try again.";
if (pushHelp) {
  pushHelp.textContent = appleMobile
    ? 'iPhone / iPad: use iOS or iPadOS 16.4 or later. Open this portal in Safari, tap Share > Add to Home Screen, then open its Home Screen icon to enable alerts.'
    : /Android/.test(navigator.userAgent)
      ? 'Android phone / tablet: open this portal in an up-to-date browser, turn on the push switch and allow notifications. No app installation is required.'
      : 'Enable alerts in a supported browser on this computer. Each device needs its own permission.';
}
const pushCsrf = () =>
  document.querySelector('meta[name="csrf-token"]').content;
const pushRequest = async (method, input) => {
  const response = await fetch('/admin/api/push-subscriptions', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': pushCsrf() },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.message || 'Unable to update push alerts');
  return data;
};
const worker = () =>
  navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
if (notificationBadge && 'serviceWorker' in navigator) worker().catch(() => {});
const pushSwitch = document.querySelector('[data-push-switch]');
if (pushSwitch && 'serviceWorker' in navigator && 'Notification' in window) {
  navigator.serviceWorker
    .getRegistration('/admin/')
    .then(async (registration) => {
      const subscribed = !!(await registration?.pushManager.getSubscription());
      if (!pushSwitch.disabled)
        pushSwitch.checked =
          Notification.permission === 'granted' && subscribed;
    })
    .catch(() => {});
}
document
  .querySelector('[data-push-switch]')
  ?.addEventListener('change', async (event) => {
    const button = event.currentTarget;
    const raw = button.dataset.vapidKey;
    const enabling = button.checked;
    button.disabled = true;
    pushStatus.textContent = 'Checking notification permission…';
    try {
      if (!enabling) {
        const registration =
          await navigator.serviceWorker.getRegistration('/admin/');
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await pushRequest('DELETE', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        pushStatus.textContent = 'Push alerts disabled on this device.';
        return;
      }
      if (appleMobile && !homeScreen)
        throw new Error(
          'On iPhone or iPad, open Safari > Share > Add to Home Screen. Open the new Home Screen icon, sign in and enable push there.',
        );
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      )
        throw new Error(
          'Push is unavailable in this browser. Update your browser or use a supported browser. On iPhone or iPad, use the Home Screen app on iOS / iPadOS 16.4 or later. Email and portal updates remain available.',
        );
      const permission =
        Notification.permission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
      if (permission !== 'granted')
        throw new Error(
          permission === 'denied'
            ? 'Notifications are blocked on this device. ' + permissionHelp
            : 'Notification permission was not granted. Turn on the push switch again and choose Allow. If no prompt appears: ' +
                permissionHelp,
        );
      pushStatus.textContent = 'Connecting this device…';
      await worker();
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'Connection timed out. Reload this page and try again.',
                ),
              ),
            15000,
          ),
        ),
      ]);
      const bytes = Uint8Array.from(
        atob(raw.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      const data = await pushRequest('POST', subscription.toJSON());
      pushStatus.textContent = data.message;
    } catch (error) {
      button.checked = !enabling;
      pushStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
document
  .querySelector('[data-test-push]')
  ?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    pushStatus.textContent = 'Sending a test alert…';
    try {
      if (
        !('serviceWorker' in navigator) ||
        !('Notification' in window) ||
        Notification.permission !== 'granted'
      )
        throw new Error(
          'Turn on push notifications on this device first. ' + permissionHelp,
        );
      const registration =
        await navigator.serviceWorker.getRegistration('/admin/');
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription)
        throw new Error('Turn on push notifications on this device first.');
      const response = await fetch('/admin/api/push-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': pushCsrf(),
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      const data = await response.json();
      pushStatus.textContent = data.message || 'Unable to send the test alert.';
    } catch (error) {
      pushStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
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
function confirmAction(form) {
  const dialog = document.querySelector('#owner-confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  dialog.querySelector('#owner-confirm-title').textContent =
    form.dataset.confirm;
  dialog.querySelector('#owner-confirm-detail').textContent =
    form.dataset.confirmDetail || 'Please confirm that you want to continue.';
  dialog.querySelector('[data-confirm-submit]').textContent =
    form.dataset.confirmLabel || 'Continue';
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'confirm'),
      { once: true },
    );
    dialog.showModal();
  });
}
if (resetToken && /^[a-f0-9]{64}$/.test(location.hash.slice(1))) {
  resetToken.value = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
}
document.querySelectorAll('[data-owner-form]').forEach((form) => {
  const formError = form.querySelector('[data-owner-form-error]');
  const reportError = (message) => {
    if (!formError) return report(message);
    formError.textContent = message;
    formError.hidden = false;
  };
  let busy = false;
  let confirming = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || confirming) return;
    if (form.dataset.confirm) {
      confirming = true;
      const accepted = await confirmAction(form);
      confirming = false;
      if (!accepted) return;
    }
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
      if (!match) return reportError('Enter a valid amount in USD.');
      body[input.dataset.money] =
        Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    }
    busy = true;
    alertBox.hidden = true;
    if (formError) formError.hidden = true;
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
      reportError(error.message);
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
  photoList.addEventListener('dragend', () => {
    dragged = null;
  });
  photoList.addEventListener('dragover', (event) => {
    if (dragged) event.preventDefault();
  });
  photoList.addEventListener('drop', (event) => {
    if (!dragged) return;
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
