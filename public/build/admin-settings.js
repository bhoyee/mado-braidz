// Settings pages. Scoped, because page scripts share one set of global names.
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  // On phones the tabs scroll sideways: start on the open one.
  const tabs = $('.settings-tabs'),
    current = $('.settings-tabs [aria-current]');
  if (current && tabs.scrollWidth > tabs.clientWidth)
    tabs.scrollLeft =
      current.offsetLeft -
      tabs.offsetLeft -
      (tabs.clientWidth - current.offsetWidth) / 2;
  // Unsaved changes
  for (const form of $$('[data-settings-form]')) {
    const state = () =>
      JSON.stringify(
        [...new FormData(form)].filter(([name]) => name !== '_csrf'),
      );
    let saved = null;
    const bar = $('[data-save-bar]', form);
    const dirty = () => saved !== null && state() !== saved;
    const show = () => {
      if (!bar) return;
      bar.classList.toggle('is-dirty', dirty());
      $('[data-dirty-status]', bar).textContent = dirty()
        ? 'Unsaved changes'
        : 'All changes saved';
    };
    // After the other scripts on the page have filled their fields.
    addEventListener('load', () => {
      saved = state();
      show();
    });
    for (const name of ['input', 'change']) form.addEventListener(name, show);
    form.addEventListener('settings-change', show);
    addEventListener('beforeunload', (event) => {
      if (dirty() && form.getAttribute('aria-busy') !== 'true')
        event.preventDefault();
    });
  }
  // Business: check a link
  for (const input of $$('[data-link]')) {
    const link = $('[data-link-open]', input.closest('label'));
    const show = () => {
      const ok = /^https:\/\/[^\s]+\.[^\s]+$/.test(input.value.trim());
      link.hidden = !ok;
      if (ok) link.href = input.value.trim();
    };
    input.addEventListener('input', show);
  }
  // Payments and policies: what clients read
  const usd = (cents) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: cents % 100 ? 2 : 0,
    }).format(cents / 100);
  const deposit = $('[data-deposit]');
  if (deposit) {
    const show = () => {
      const ok = /^\d{1,6}(\.\d{1,2})?$/.test(deposit.value.trim());
      $('[data-deposit-preview]').textContent = ok
        ? `A ${usd(Math.round(Number(deposit.value) * 100))} deposit reserves your chair and is taken off your total.`
        : 'Enter an amount, such as 30.';
    };
    deposit.addEventListener('input', show);
    show();
  }
  const policy = $('[data-policy-preview]');
  if (policy) {
    const form = policy.closest('form');
    const show = () => {
      const hours = Number(form.elements.rescheduleHours.value) || 0,
        free = Number(form.elements.freeReschedules.value) || 0;
      const amount = usd(Number(policy.dataset.depositCents));
      const lines = [
        `Deposit: ${amount}, applied to your total.`,
        form.elements.depositRefundable.checked
          ? 'Please contact the studio about a deposit refund for your appointment.'
          : 'The deposit is non-refundable, except where we are unable to provide the time you paid for or where the law requires a refund.',
        free
          ? `You may reschedule ${free === 1 ? 'once' : `up to ${free} times`} at no charge with at least ${hours} hours of notice before your appointment.`
          : 'Please contact the studio as early as possible to ask about a change.',
      ];
      policy.replaceChildren(
        ...lines.map((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          return item;
        }),
      );
    };
    form.addEventListener('input', show);
    show();
  }
  // Alert addresses
  const field = $('[data-emails-field]');
  if (field) {
    const list = $('[data-emails]'),
      added = $('[data-email-new]');
    let emails = field.value.split(/[\s,]+/).filter(Boolean);
    const draw = () => {
      field.value = emails.join(', ');
      field.dispatchEvent(new Event('settings-change', { bubbles: true }));
      list.replaceChildren(
        ...emails.map((email) => {
          const item = document.createElement('li'),
            text = document.createElement('span'),
            button = document.createElement('button');
          text.textContent = email;
          button.type = 'button';
          button.className = 'owner-text-link';
          button.textContent = 'Remove';
          button.setAttribute('aria-label', 'Remove ' + email);
          button.addEventListener('click', () => {
            emails = emails.filter((other) => other !== email);
            draw();
            added.focus();
          });
          item.append(text, button);
          return item;
        }),
      );
    };
    const add = () => {
      const value = added.value.trim().toLowerCase();
      if (!value) return true;
      if (!added.checkValidity()) {
        added.reportValidity();
        return false;
      }
      if (!emails.includes(value)) emails.push(value);
      added.value = '';
      draw();
      return true;
    };
    $('[data-email-add]').addEventListener('click', add);
    added.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      add();
    });
    // An address typed but not added is still meant to be saved.
    document.addEventListener(
      'submit',
      (event) => {
        if (event.target === field.form && !add()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    draw();
  }
  // Opening hours
  const rows = $$('[data-hours-row]');
  const showRow = (row) => {
    const open = $('[data-open-switch]', row).checked;
    $('[data-closed]', row).value = String(!open);
    for (const part of $$('[data-hours-times]', row)) part.hidden = !open;
    $('[data-hours-closed]', row).hidden = open;
  };
  for (const row of rows) {
    $('[data-open-switch]', row).addEventListener('change', () => showRow(row));
    showRow(row);
  }
  $('[data-copy-hours]')?.addEventListener('click', () => {
    const [first, ...others] = rows;
    for (const row of others) {
      $('[data-open-switch]', row).checked = $(
        '[data-open-switch]',
        first,
      ).checked;
      const from = $$('input[type="time"]', first);
      $$('input[type="time"]', row).forEach((input, index) => {
        input.value = from[index].value;
      });
      showRow(row);
    }
    first.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Time off
  const special = $('[data-special-form]');
  if (special) {
    const closed = $('[data-special-closed]', special);
    const show = () =>
      ($('[data-special-times]', special).hidden = closed.checked);
    closed.addEventListener('change', show);
    show();
  }
  const block = $('[data-block-form]');
  if (block) {
    const allDay = $('[data-all-day]', block),
      repeat = $('[data-block-repeat]', block);
    const show = () => {
      $('[data-block-times]', block).hidden = allDay.checked;
      for (const name of ['start', 'end'])
        block.elements[name].required = !allDay.checked;
      const weekly = repeat.value === 'weekly';
      $('[data-block-until]', block).hidden = !weekly;
      block.elements.until.required = weekly;
      $('[data-block-last]', block).hidden = weekly;
      if (weekly) block.elements.endDate.value = '';
    };
    block.elements.date.addEventListener('change', () => {
      block.elements.endDate.min = block.elements.date.value;
    });
    allDay.addEventListener('change', show);
    repeat.addEventListener('change', show);
    show();
  }
  // Password
  const password = $('[data-password-form]');
  if (password) {
    const fresh = $('[data-new-password]'),
      again = $('[data-password-again]'),
      hint = $('[data-password-hint]');
    const check = () => {
      again.setCustomValidity(
        again.value && again.value !== fresh.value
          ? 'The two new passwords are different.'
          : '',
      );
      const value = fresh.value;
      if (!value)
        return (hint.textContent = 'Four or more random words work well.');
      const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((test) =>
        test.test(value),
      ).length;
      hint.textContent =
        value.length < 12
          ? `${12 - value.length} more character${value.length === 11 ? '' : 's'} needed.`
          : /^(.)\1+$/.test(value) ||
              /(password|123456|qwerty|mado)/i.test(value)
            ? 'Easy to guess. Try random words.'
            : value.length >= 16 || kinds >= 3
              ? 'Strong.'
              : 'Good. Longer is stronger.';
    };
    fresh.addEventListener('input', check);
    again.addEventListener('input', check);
    $('[data-password-show]').addEventListener('change', (event) => {
      for (const input of $$('input[autocomplete$="password"]', password))
        input.type = event.target.checked ? 'text' : 'password';
    });
  }
})();
