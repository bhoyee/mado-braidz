const alertBox = document.querySelector('.owner-alert');
const firstStylePrice = document.querySelector('[data-first-style-price]');
if (firstStylePrice) {
  const consultation = firstStylePrice.form.elements.priceOnConsultation;
  const togglePrice = () => {
    firstStylePrice.hidden = consultation.checked;
    firstStylePrice.disabled = consultation.checked;
    firstStylePrice.querySelector('[name="initialPrice"]').required =
      !consultation.checked;
  };
  consultation.addEventListener('change', togglePrice);
  togglePrice();
}
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
let toastTimer;
function dismissToast() {
  clearTimeout(toastTimer);
  alertBox.hidden = true;
}
function toast(message, success = false) {
  clearTimeout(toastTimer);
  alertBox.querySelector('[data-owner-toast-message]').textContent = message;
  alertBox.classList.toggle('owner-alert-success', success);
  alertBox.setAttribute('role', success ? 'status' : 'alert');
  alertBox.hidden = false;
  toastTimer = setTimeout(dismissToast, success ? 5000 : 8000);
}
alertBox
  .querySelector('[data-owner-toast-close]')
  .addEventListener('click', dismissToast);
alertBox.addEventListener('mouseenter', () => clearTimeout(toastTimer));
alertBox.addEventListener('focusin', () => clearTimeout(toastTimer));
alertBox.addEventListener('mouseleave', () => {
  toastTimer = setTimeout(dismissToast, 5000);
});
alertBox.addEventListener('focusout', () => {
  toastTimer = setTimeout(dismissToast, 5000);
});
window.addEventListener('owner-toast', (event) =>
  toast(event.detail.message, event.detail.success),
);
function report(message) {
  toast(message);
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
function clearFieldErrors(form) {
  for (const note of form.querySelectorAll('[data-field-error]')) note.remove();
  for (const input of form.querySelectorAll('[data-had-error]')) {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    input.removeAttribute('data-had-error');
  }
}
// Marks the exact boxes to fix, and goes to the first one.
function showFieldErrors(form, fields) {
  let first = null;
  for (const [name, message] of Object.entries(fields || {})) {
    const input = form.elements[name];
    if (!(input instanceof HTMLElement)) continue;
    const target =
      input.type === 'hidden'
        ? form.querySelector('[data-email-new]') || input
        : input;
    const note = document.createElement('span');
    note.className = 'field-problem';
    note.dataset.fieldError = '';
    note.id = `problem-${name}`;
    note.textContent = message;
    target.after(note);
    target.setAttribute('aria-invalid', 'true');
    target.setAttribute('aria-describedby', note.id);
    target.dataset.hadError = '';
    first ||= target;
  }
  first?.focus();
}
document.querySelectorAll('[data-owner-form]').forEach((form) => {
  const formError = form.querySelector('[data-owner-form-error]');
  const reportError = (message) => {
    if (!formError) return report(message);
    formError.textContent = message;
    formError.hidden = false;
    report(message);
  };
  let busy = false;
  let confirming = false;
  let acknowledged = false;
  form.addEventListener('submit', async (event) => {
    // A preview opens in its own tab instead of saving.
    if (event.submitter?.hasAttribute('data-native-submit')) return;
    event.preventDefault();
    if (busy || confirming) return;
    if (form.dataset.confirm && !acknowledged) {
      confirming = true;
      const accepted = await confirmAction(form);
      confirming = false;
      if (!accepted) return;
    }
    const data = new FormData(form);
    if (event.submitter?.name)
      data.set(event.submitter.name, event.submitter.value);
    const body = Object.fromEntries(data);
    if (acknowledged) body.acknowledge = 'true';
    acknowledged = false;
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
    const originalButtons = buttons.map((button) => ({
      button,
      disabled: button.disabled,
      text: button.textContent,
    }));
    buttons.forEach((button) => (button.disabled = true));
    const submitter = event.submitter || buttons[0];
    if (submitter)
      submitter.textContent =
        form.enctype === 'multipart/form-data' ? 'Uploading…' : 'Saving…';
    form.setAttribute('aria-busy', 'true');
    let navigating = false,
      acceptedWarning = false;
    clearFieldErrors(form);
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
      if (response.status === 409 && result.confirm) {
        const asked = { ...form.dataset };
        form.dataset.confirm = result.confirm.title;
        form.dataset.confirmDetail = result.confirm.detail;
        form.dataset.confirmLabel = result.confirm.label;
        const accepted = await confirmAction(form);
        for (const key of ['confirm', 'confirmDetail', 'confirmLabel'])
          if (asked[key] === undefined) delete form.dataset[key];
          else form.dataset[key] = asked[key];
        acceptedWarning = accepted;
        return;
      }
      if (!response.ok) {
        showFieldErrors(form, result.fields);
        throw new Error(
          result.message || result.error || 'Unable to save. Please try again.',
        );
      }
      if (result.url) {
        navigating = true;
        sessionStorage.setItem('owner-message', result.message || 'Saved.');
        const target = new URL(result.url, location.href);
        if (
          target.origin === location.origin &&
          target.pathname === location.pathname &&
          target.search === location.search
        ) {
          // A photo anchor alone would leave the old library and dialog open.
          history.replaceState(null, '', target.href);
          location.reload();
        } else location.assign(result.url);
      } else toast(result.message || 'Saved.', true);
    } catch (error) {
      reportError(error.message);
    } finally {
      if (!navigating) {
        busy = false;
        form.removeAttribute('aria-busy');
        for (const { button, disabled, text } of originalButtons) {
          button.disabled = disabled;
          button.textContent = text;
        }
        if (acceptedWarning) {
          acknowledged = true;
          form.requestSubmit(submitter);
        }
      }
    }
  });
});
const savedMessage = sessionStorage.getItem('owner-message');
if (savedMessage) {
  sessionStorage.removeItem('owner-message');
  toast(savedMessage, true);
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
  const change = editor.querySelector('[data-change-style]');
  const dateField = editor.querySelector('[data-owner-date]'),
    timeField = editor.querySelector('[data-owner-time]'),
    slotBox = editor.querySelector('[data-owner-slots]');
  const manual = editor.querySelector('[data-manual-fields]');
  const usd = (cents) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  const hours = (minutes) =>
    `${Number((minutes / 60).toFixed(2))} ${minutes === 60 ? 'hr' : 'hrs'}`;
  // Until the style changes, an existing booking keeps its agreed price.
  let price = editor.dataset.bookingId
    ? {
        subtotalCents: Number(editor.dataset.total),
        durationMin: Number(editor.dataset.duration),
      }
    : null;
  const original = price;
  let quoteVersion = 0,
    slotVersion = 0,
    quoteError = '';
  const mode = () =>
    editor.querySelector('[data-payment-mode]:checked')?.value || null;
  const sum = (name, value) => {
    const field = editor.querySelector(`[data-sum="${name}"]`);
    if (field) field.textContent = value || '—';
  };
  function summary() {
    const changed = !fields.disabled;
    sum('client', editor.elements.name.value.trim());
    sum(
      'style',
      changed
        ? [
            style.selectedOptions[0]?.textContent,
            variant.value &&
              variant.selectedOptions[0].textContent.replace(/ · \$.*$/, ''),
          ]
            .filter(Boolean)
            .join(' · ')
        : editor.dataset.styleName,
    );
    sum(
      'extras',
      [...fields.querySelectorAll('[name="addonIds"]:checked')]
        .map((input) =>
          input
            .closest('label')
            .textContent.trim()
            .replace(/ · \$.*$/, ''),
        )
        .join(', ') || 'None',
    );
    const when =
      dateField.value &&
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        ...(timeField.value ? { hour: 'numeric', minute: '2-digit' } : {}),
      }).format(
        new Date(`${dateField.value}T${timeField.value || '00:00'}:00Z`),
      );
    sum('when', when && timeField.value ? when + ' ET' : when);
    sum('duration', price && hours(price.durationMin));
    if (!price) {
      sum('total', quoteError || '—');
      for (const name of ['deposit', 'balance']) sum(name, '—');
      return;
    }
    const provisional = price.consultation ? ' (to agree)' : '';
    sum('total', usd(price.subtotalCents) + provisional);
    sum(
      'deposit',
      price.depositCents === undefined ? '' : usd(price.depositCents),
    );
    const received = manual?.querySelector('[data-money]').value;
    const paid = editor.dataset.bookingId
      ? Number(editor.dataset.paid)
      : mode() === 'manual'
        ? Math.round(Number(received) * 100) || 0
        : 0;
    sum(
      'balance',
      usd(Math.max(0, price.subtotalCents - paid)) +
        (mode() === 'link' ? ' until the deposit is paid' : ''),
    );
    const help = editor.querySelector('[data-manual-help]');
    if (help)
      help.textContent = `At least the ${usd(price.depositCents)} deposit, and no more than ${usd(price.subtotalCents)}.`;
  }
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
      const next = await response.json();
      if (version !== quoteVersion || fields.disabled) return;
      if (!response.ok) throw new Error(next.message);
      const longer = price?.durationMin !== next.durationMin;
      price = next;
      quoteError = '';
      editor.dataset.duration = price.durationMin;
      if (longer || !slotBox.querySelector('button')) loadSlots();
    } catch (error) {
      if (version !== quoteVersion) return;
      price = null;
      quoteError = error.message || 'Unable to load price.';
    }
    summary();
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
  function markTime() {
    for (const button of slotBox.querySelectorAll('button'))
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.time === timeField.value),
      );
  }
  function slotMessage(text) {
    const note = document.createElement('p');
    note.className = 'owner-muted';
    note.textContent = text;
    slotBox.replaceChildren(note);
  }
  async function loadSlots() {
    const version = ++slotVersion;
    if (!dateField.value)
      return slotMessage('Choose a date to see free times.');
    if (!editor.dataset.duration) return;
    const query = new URLSearchParams({
      date: dateField.value,
      durationMin: editor.dataset.duration,
    });
    if (editor.dataset.bookingId)
      query.set('bookingId', editor.dataset.bookingId);
    slotMessage('Checking free times…');
    try {
      const response = await fetch('/admin/api/slots?' + query, {
        headers: { Accept: 'application/json' },
      });
      const slots = await response.json();
      if (version !== slotVersion) return;
      if (!response.ok) throw new Error(slots.message);
      const free = slots.filter((slot) => slot.available);
      if (!free.length)
        return slotMessage('No free times that day. Choose another date.');
      const groups = new Map([
        ['Morning', []],
        ['Afternoon', []],
        ['Evening', []],
      ]);
      for (const slot of free) {
        const start = new Date(slot.startAt);
        const local = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(start);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.time = local;
        const label = document.createElement('strong');
        label.textContent = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric',
          minute: '2-digit',
        }).format(start);
        const chairs = document.createElement('span');
        chairs.textContent = `${slot.remaining} ${slot.remaining === 1 ? 'chair' : 'chairs'} left`;
        button.append(label, chairs);
        button.addEventListener('click', () => {
          timeField.value = local;
          markTime();
          summary();
          notifyState();
        });
        const hour = Number(local.slice(0, 2));
        groups
          .get(hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening')
          .push(button);
      }
      slotBox.replaceChildren();
      for (const [name, buttons] of groups) {
        if (!buttons.length) continue;
        const heading = document.createElement('h3');
        heading.textContent = name;
        const list = document.createElement('div');
        list.className = 'owner-slot-list';
        list.append(...buttons);
        slotBox.append(heading, list);
      }
      markTime();
      if (
        timeField.value &&
        !free.some(
          (slot, i) =>
            slotBox.querySelectorAll('button')[i].dataset.time ===
            timeField.value,
        )
      ) {
        const warn = document.createElement('p');
        warn.className = 'slot-warning';
        warn.textContent =
          'The chosen start time is not free for this visit. Pick one below.';
        slotBox.prepend(warn);
      }
    } catch (error) {
      if (version === slotVersion)
        slotMessage(error.message || 'Unable to load free times.');
    }
  }
  function notifyState() {
    const notify = editor.querySelector('[data-notify]');
    if (!notify) return;
    const moved =
      `${dateField.value} ${timeField.value}` !== editor.dataset.start;
    notify.disabled = !moved;
    editor.querySelector('[data-notify-help]').hidden = moved;
  }
  style.addEventListener('change', () => filterVariants(true));
  variant.addEventListener('change', quote);
  fields
    .querySelectorAll('[name="addonIds"]')
    .forEach((input) => input.addEventListener('change', quote));
  change?.addEventListener('change', () => {
    fields.disabled = !change.checked;
    if (change.checked) return filterVariants();
    quoteVersion++;
    price = original;
    editor.dataset.duration = original.durationMin;
    loadSlots();
    summary();
  });
  dateField.addEventListener('change', loadSlots);
  timeField.addEventListener('change', markTime);
  for (const radio of editor.querySelectorAll('[data-payment-mode]'))
    radio.addEventListener('change', () => {
      manual.hidden = mode() !== 'manual';
      const amount = manual.querySelector('[data-money]');
      amount.required = !manual.hidden;
      if (!manual.hidden && !amount.value && price)
        amount.value = (price.depositCents / 100).toFixed(2);
    });
  for (const name of ['input', 'change'])
    editor.addEventListener(name, () => {
      summary();
      notifyState();
    });

  const lookup = editor.querySelector('[data-client-lookup]');
  if (lookup) {
    const search = lookup.querySelector('[data-client-search]'),
      results = lookup.querySelector('[data-client-results]'),
      status = lookup.querySelector('[data-client-status]');
    let timer,
      version = 0;
    async function find() {
      const asked = ++version;
      const query = search.value.trim();
      if (query.length < 2) {
        results.hidden = true;
        status.textContent = 'Or enter a new client below.';
        return;
      }
      try {
        const response = await fetch(
          '/admin/api/clients?' + new URLSearchParams({ q: query }),
          { headers: { Accept: 'application/json' } },
        );
        const data = await response.json();
        if (asked !== version) return;
        if (!response.ok) throw new Error(data.message);
        results.replaceChildren();
        for (const client of data.clients) {
          const button = document.createElement('button');
          button.type = 'button';
          const name = document.createElement('strong');
          name.textContent = client.name;
          const info = document.createElement('span');
          info.textContent = [client.phoneLabel, client.email]
            .filter(Boolean)
            .join(' · ');
          button.append(name, info);
          button.addEventListener('click', () => {
            editor.elements.name.value = client.name;
            editor.elements.email.value = client.email;
            editor.elements.phone.value = client.phone;
            search.value = '';
            results.hidden = true;
            status.textContent = `${client.name}’s details are filled in.`;
            summary();
            editor.elements.name.focus();
          });
          results.append(button);
        }
        results.hidden = !data.clients.length;
        status.textContent = data.clients.length
          ? `${data.clients.length} found. Select one to fill in their details.`
          : 'No match. Enter a new client below.';
      } catch {
        if (asked === version)
          status.textContent =
            'Search is unavailable. Enter the details below.';
      }
    }
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(find, 250);
    });
    search.addEventListener('keydown', (event) => {
      // Enter must never submit the booking from the search box.
      if (event.key === 'Enter') {
        event.preventDefault();
        results.querySelector('button')?.focus();
      }
      if (event.key === 'Escape') results.hidden = true;
    });
  }
  filterVariants();
  if (editor.dataset.bookingId) loadSlots();
  notifyState();
  summary();
}
document.querySelectorAll('[data-copy-text]').forEach((button) =>
  button.addEventListener('click', async () => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copyText);
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = label), 2500);
    } catch {
      window.prompt('Copy this link', button.dataset.copyText);
    }
  }),
);
// Filter the appointment book without moving focus out of the search field.
const appointmentFilters = document.querySelector('[data-appointment-filters]');
if (appointmentFilters) {
  const status = document.querySelector('[data-appointment-search-status]');
  const search = appointmentFilters.elements.search;
  let timer,
    controller,
    version = 0;
  appointmentFilters.querySelector('[type="submit"]').hidden = true;
  const clearLink = appointmentFilters.querySelector(
    '[data-appointment-clear]',
  );
  const narrowing = () =>
    ['from', 'to', 'status', 'paymentStatus'].some(
      (name) => appointmentFilters.elements[name].value,
    );
  const filtering = () => Boolean(search.value.trim() || narrowing());
  // Phones start with the filters folded away unless one is in use.
  if (matchMedia('(max-width: 760px)').matches && !narrowing())
    appointmentFilters.querySelector('[data-appointment-more]').open = false;
  async function findAppointments() {
    clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const requestVersion = ++version;
    const url = new URL(appointmentFilters.action || location.href);
    url.search = new URLSearchParams(
      new FormData(appointmentFilters),
    ).toString();
    const results = document.querySelector('[data-appointment-results]');
    results.setAttribute('aria-busy', 'true');
    status.textContent = 'Searching appointments…';
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error('Unable to load appointments. Try again.');
      const page = new DOMParser().parseFromString(
        await response.text(),
        'text/html',
      );
      if (requestVersion !== version) return;
      const updated = page.querySelector('[data-appointment-results]');
      if (!updated) throw new Error('Please refresh and sign in again.');
      results.replaceWith(document.importNode(updated, true));
      const tabs = page.querySelector('.appointment-views');
      if (tabs)
        document
          .querySelector('.appointment-views')
          .replaceWith(document.importNode(tabs, true));
      clearLink.hidden = !filtering();
      history.replaceState(null, '', url);
      const count = updated.querySelectorAll('tbody tr[data-search]').length;
      status.textContent = count
        ? `${count} appointment${count === 1 ? '' : 's'} shown.`
        : 'No appointments found.';
    } catch (error) {
      if (error.name !== 'AbortError' && requestVersion === version)
        status.textContent = error.message;
    } finally {
      if (requestVersion === version)
        document
          .querySelector('[data-appointment-results]')
          .removeAttribute('aria-busy');
    }
  }
  search.addEventListener('input', () => {
    clearTimeout(timer);
    controller?.abort();
    version++;
    timer = setTimeout(findAppointments, 300);
  });
  appointmentFilters.addEventListener('change', (event) => {
    if (event.target !== search) findAppointments();
  });
  appointmentFilters.addEventListener('submit', (event) => {
    event.preventDefault();
    findAppointments();
  });
}
