const root = document.querySelector('[data-booking-wizard]');
// Keep the SSR select as the source of truth; enhance its menu so scrolling,
// keyboard controls and pointer colours are consistent on touch and desktop.
function enhanceBookingSelect(select) {
  const label = document.querySelector(`label[for="${select.id}"]`);
  label.id ||= `${select.id}-label`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'booking-select-trigger';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-labelledby', label.id);
  button.id = `${select.id}-trigger`;
  const valueText = document.createElement('span');
  valueText.id = `${select.id}-value`;
  button.append(valueText);
  button.setAttribute('aria-describedby', valueText.id);
  if (select.required) button.setAttribute('aria-required', 'true');
  const menu = document.createElement('div');
  menu.id = `${select.id}-menu`;
  menu.className = 'booking-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-labelledby', label.id);
  menu.hidden = true;
  button.setAttribute('aria-controls', menu.id);
  select.after(button);
  document.body.append(menu);
  select.classList.add('booking-native-select');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;
  let active = 0,
    options = [],
    search = '',
    searchedAt = 0;
  const isOpen = () => !menu.hidden;
  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-activedescendant');
  }
  function focusOption(index, scroll = true) {
    if (!options.length) return;
    active = Math.max(0, Math.min(options.length - 1, index));
    [...menu.children].forEach((item, i) =>
      item.classList.toggle('is-active', i === active),
    );
    button.setAttribute('aria-activedescendant', menu.children[active].id);
    if (scroll) menu.children[active].scrollIntoView({ block: 'nearest' });
  }
  function choose(index) {
    select.value = options[index].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
    close();
    button.focus({ preventScroll: true });
  }
  function refresh() {
    options = [...select.options].filter(
      (option) => option.value && !option.disabled,
    );
    valueText.textContent =
      select.selectedOptions[0]?.textContent ||
      select.options[0]?.textContent ||
      'Choose an option';
    button.disabled = select.disabled || !options.length;
    menu.replaceChildren();
    options.forEach((option, i) => {
      const item = document.createElement('div');
      item.id = `${select.id}-option-${i}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === select.value));
      item.textContent = option.textContent;
      item.addEventListener('click', () => choose(i));
      item.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'mouse') focusOption(i, false);
      });
      menu.append(item);
    });
    if (isOpen())
      focusOption(
        Math.max(
          0,
          options.findIndex((option) => option.value === select.value),
        ),
      );
  }
  function open() {
    document
      .querySelectorAll('.booking-select-trigger[aria-expanded="true"]')
      .forEach((other) => {
        if (other !== button) other.dispatchEvent(new Event('pickerclose'));
      });
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const bottom = top + (viewport?.height || innerHeight);
    const below = bottom - rect.bottom - 90;
    const above = rect.top - top - 12;
    const up = below < 160 && above > below;
    const height = Math.min(280, Math.max(96, up ? above : below));
    menu.style.left = `${rect.left}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.maxHeight = `${height}px`;
    menu.hidden = false;
    menu.style.top = `${up ? Math.max(top + 8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
    button.setAttribute('aria-expanded', 'true');
    focusOption(
      Math.max(
        0,
        options.findIndex((option) => option.value === select.value),
      ),
    );
  }
  button.addEventListener('click', () => (isOpen() ? close() : open()));
  button.addEventListener('pickerclose', close);
  label.addEventListener('click', (event) => {
    event.preventDefault();
    button.focus();
  });
  button.addEventListener('keydown', (event) => {
    if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(
        event.key,
      )
    ) {
      event.preventDefault();
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (!isOpen()) {
        open();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        choose(active);
        return;
      }
      focusOption(
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : active + (event.key === 'ArrowUp' ? -1 : 1),
      );
    } else if (event.key === 'Tab') close();
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      search = Date.now() - searchedAt > 700 ? event.key : search + event.key;
      searchedAt = Date.now();
      if (!isOpen()) open();
      const index = options.findIndex((option) =>
        option.textContent.toLowerCase().startsWith(search.toLowerCase()),
      );
      if (index >= 0) focusOption(index);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!button.contains(event.target) && !menu.contains(event.target)) close();
  });
  window.addEventListener('resize', close);
  window.addEventListener(
    'scroll',
    (event) => {
      if (!menu.contains(event.target)) close();
    },
    true,
  );
  refresh();
  return { refresh, close };
}
if (root) {
  const form = root.querySelector('form');
  document
    .getElementById('booking-summary-toggle')
    .addEventListener('click', (event) => {
      const button = event.currentTarget;
      button.setAttribute(
        'aria-expanded',
        String(button.getAttribute('aria-expanded') !== 'true'),
      );
    });
  const $ = (id) => document.getElementById(id);
  const style = $('booking-style'),
    size = $('booking-size'),
    variant = $('booking-variant');
  const allVariants = [...variant.options]
    .filter((o) => o.dataset.style)
    .map((o) => o.cloneNode(true));
  const pickers = [style, size, variant].map(enhanceBookingSelect);
  const params = new URLSearchParams(location.search);
  const dollars = (n) =>
    n === null
      ? 'Agreed at consultation'
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: n % 100 ? 2 : 0,
        }).format(n / 100);
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  let month = localDate.slice(0, 7),
    step = 1,
    startAt = '',
    date = '',
    quote = null,
    serial = 0,
    timeSerial = 0,
    submitted = false;
  let saved = {};
  try {
    saved = JSON.parse(sessionStorage.getItem('mado-booking') || '{}');
  } catch {
    /* storage is optional */
  }
  const error = (message) => {
    $('booking-error').textContent = message;
    $('booking-error').hidden = !message;
    if (message) $('booking-error').focus();
  };
  function fieldError(input, message) {
    const control = document.getElementById(input.id + '-trigger') || input;
    const id = input.id + '-error';
    let note = document.getElementById(id);
    if (!note) {
      note = document.createElement('p');
      note.id = id;
      note.className = 'booking-field-error';
      (input.closest('label') || control).after(note);
    }
    note.textContent = message;
    note.hidden = !message;
    for (const element of [input, control]) {
      if (message) element.setAttribute('aria-invalid', 'true');
      else element.removeAttribute('aria-invalid');
      const described = new Set(
        (element.getAttribute('aria-describedby') || '')
          .split(' ')
          .filter(Boolean),
      );
      if (message) described.add(id);
      else described.delete(id);
      if (described.size)
        element.setAttribute('aria-describedby', [...described].join(' '));
      else element.removeAttribute('aria-describedby');
    }
    (
      document.querySelector(`label[for="${input.id}"]`) ||
      input.closest('label')
    )?.classList.toggle('is-invalid', Boolean(message));
    return !message;
  }
  function validateField(input) {
    const value = input.value.trim();
    let message = '';
    if (input.type === 'checkbox')
      message = input.required && !input.checked ? 'Accept the policy' : '';
    else if (input.required && !value) message = 'Required field';
    else if (input.id === 'booking-name' && value.length < 2)
      message = 'Enter your name';
    else if (input.id === 'booking-email' && input.validity.typeMismatch)
      message = 'Invalid email';
    else if (input.id === 'booking-phone' && value) {
      const digits = value.replace(/[\s().-]/g, '');
      if (!/^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/.test(digits))
        message = 'Invalid phone number';
    }
    return fieldError(input, message);
  }
  const detailFields = [
    'booking-name',
    'booking-email',
    'booking-phone',
    'booking-policy',
  ].map($);
  detailFields.forEach((input) => {
    input.addEventListener('blur', () => validateField(input));
    input.addEventListener(
      input.type === 'checkbox' ? 'change' : 'input',
      () => {
        if (input.getAttribute('aria-invalid') === 'true') validateField(input);
      },
    );
  });
  const selection = () => ({
    styleId: Number(style.value),
    ...(variant.value ? { styleVariantId: Number(variant.value) } : {}),
    addonIds: [...form.querySelectorAll('[name="addonIds"]:checked')].map((e) =>
      Number(e.value),
    ),
    paymentChoice: form.querySelector('[name="paymentChoice"]:checked').value,
  });
  function persist() {
    const data = {
      ...selection(),
      size: size.value,
      startAt,
      date,
      month,
      step,
    };
    for (const name of ['name', 'email', 'phone', 'notes'])
      data[name] = form.elements[name].value;
    data.marketingConsent = $('booking-marketing').checked;
    try {
      sessionStorage.setItem('mado-booking', JSON.stringify(data));
    } catch {
      /* private browsing */
    }
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      style: style.selectedOptions[0]?.dataset.slug,
      size: size.value,
      variant: variant.value,
      step,
      date,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (startAt) url.searchParams.set('startAt', startAt);
    else url.searchParams.delete('startAt');
    history.replaceState(null, '', url);
  }
  async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) {
      const e = new Error(data.message || 'Please try again shortly.');
      e.data = data;
      throw e;
    }
    return data;
  }
  const query = () =>
    new URLSearchParams({
      ...selection(),
      addonIds: selection().addonIds.join(','),
    });
  function chooseStyle(preferredSize = '', preferredVariant = '') {
    const consult = style.selectedOptions[0]?.dataset.consultation === 'true';
    $('booking-variant-fields').hidden = consult;
    $('booking-consultation').hidden = !consult;
    $('booking-full').disabled = consult;
    if (consult)
      form.querySelector('[name="paymentChoice"][value="deposit"]').checked =
        true;
    size.replaceChildren(new Option('Choose a size', ''));
    const options = allVariants.filter((o) => o.dataset.style === style.value);
    const groups = new Map(
      options.map((o) => [o.dataset.size, o.dataset.sizeLabel]),
    );
    for (const [value, label] of groups) size.add(new Option(label, value));
    size.value = groups.has(preferredSize)
      ? preferredSize
      : groups.size === 1
        ? [...groups.keys()][0]
        : '';
    chooseSize(preferredVariant);
  }
  function chooseSize(preferred = '') {
    variant.replaceChildren(new Option('Choose a length', ''));
    for (const o of allVariants.filter(
      (o) => o.dataset.style === style.value && o.dataset.size === size.value,
    ))
      variant.append(o.cloneNode(true));
    variant.value = [...variant.options].some(
      (o) => o.value === String(preferred),
    )
      ? String(preferred)
      : '';
    if (variant.options.length === 2 && !variant.value)
      variant.selectedIndex = 1;
    pickers.forEach((picker) => picker.refresh());
  }
  async function refreshQuote(resetTime = true) {
    const current = ++serial;
    quote = null;
    if (resetTime) {
      startAt = '';
      date = '';
      $('summary-time').textContent = 'Choose a date and time';
      $('booking-slots').replaceChildren();
    }
    $('summary-total').textContent = '—';
    if (
      !style.value ||
      (!variant.value &&
        style.selectedOptions[0]?.dataset.consultation !== 'true')
    )
      return;
    try {
      const data = await api('/api/bookings/quote?' + query());
      if (current !== serial) return;
      quote = data;
      $('summary-style').textContent = data.styleName;
      $('summary-price').textContent = dollars(data.stylePriceCents);
      $('summary-extras').textContent = dollars(
        data.addons.reduce((n, a) => n + a.priceCents, 0),
      );
      $('summary-toggle-total').textContent = data.consultation
        ? 'Consultation'
        : dollars(data.subtotalCents);
      $('summary-total').textContent = data.consultation
        ? 'Final price at consultation'
        : dollars(data.subtotalCents);
      $('summary-today').textContent = dollars(data.dueTodayCents);
      $('summary-balance').textContent = dollars(data.balanceAfterPaymentCents);
      if (startAt)
        $('summary-time').textContent =
          new Date(startAt).toLocaleString('en-US', {
            timeZone: 'America/New_York',
          }) + ' Eastern';
    } catch (e) {
      if (current === serial) error(e.message);
    }
  }
  async function loadMonth() {
    const current = ++timeSerial;
    $('booking-time-status').textContent = 'Checking available days…';
    $('booking-calendar').replaceChildren();
    $('booking-month-title').textContent = new Date(
      month + '-01T12:00:00Z',
    ).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    try {
      const data = await api(
        '/api/availability?' + query() + '&month=' + month,
      );
      if (current !== timeSerial) return;
      const table = document.createElement('table');
      table.className = 'calendar';
      const caption = document.createElement('caption');
      caption.className = 'sr-only';
      caption.textContent = $('booking-month-title').textContent;
      table.append(caption);
      const head = table.createTHead().insertRow();
      for (const name of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = name;
        head.append(th);
      }
      const body = table.createTBody();
      let row = body.insertRow();
      const offset = new Date(month + '-01T12:00:00Z').getUTCDay();
      for (let i = 0; i < offset; i++) row.insertCell();
      for (const item of data.days) {
        if (row.cells.length === 7) row = body.insertRow();
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = Number(item.date.slice(-2));
        button.disabled = !item.available;
        button.setAttribute(
          'aria-label',
          item.date + (item.available ? ' · available' : ' · unavailable'),
        );
        button.setAttribute('aria-pressed', String(item.date === date));
        button.addEventListener('click', () => {
          date = item.date;
          startAt = '';
          persist();
          loadDay();
          for (const b of body.querySelectorAll('button'))
            b.setAttribute('aria-pressed', String(b === button));
        });
        row.insertCell().append(button);
      }
      $('booking-calendar').append(table);
      $('booking-time-status').textContent = data.days.some((d) => d.available)
        ? 'Choose a day to see its times.'
        : 'No available starts this month. Try the next month or call the studio.';
    } catch (e) {
      if (current === timeSerial) {
        $('booking-time-status').textContent = '';
        error(e.message);
      }
    }
  }
  async function loadDay() {
    const current = ++timeSerial;
    $('booking-time-status').textContent = 'Checking times…';
    $('booking-slots').replaceChildren();
    try {
      const data = await api(
        '/api/availability/day?' + query() + '&date=' + date,
      );
      if (current !== timeSerial) return;
      for (const slot of data.slots) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'slot';
        button.textContent =
          slot.label + (slot.available ? '' : ' · Fully booked');
        button.disabled = !slot.available;
        button.setAttribute('aria-pressed', String(slot.startAt === startAt));
        button.addEventListener('click', () => {
          startAt = slot.startAt;
          $('summary-time').textContent =
            date + ' · ' + slot.label + ' Eastern';
          for (const b of $('booking-slots').children)
            b.setAttribute('aria-pressed', String(b === button));
          persist();
        });
        $('booking-slots').append(button);
      }
      $('booking-time-status').textContent = data.slots.some((s) => s.available)
        ? 'Available starts for ' + date + ' · Eastern time'
        : 'No starts are available for this day. Choose another day.';
    } catch (e) {
      if (current === timeSerial) error(e.message);
    }
  }
  async function showStep(next, focus = true) {
    pickers.forEach((picker) => picker.close());
    const previousUrl = location.href;
    step = Math.max(1, Math.min(4, next));
    error('');
    for (const section of root.querySelectorAll('[data-booking-step]'))
      section.hidden = Number(section.dataset.bookingStep) !== step;
    [...root.querySelectorAll('.booking-progress li')].forEach((li, i) => {
      if (i + 1 === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    if (focus) root.querySelector(`[data-booking-step="${step}"] h2`).focus();
    persist();
    if (focus && previousUrl !== location.href) {
      const nextUrl = location.href;
      history.replaceState(null, '', previousUrl);
      history.pushState(null, '', nextUrl);
    }
    if (step === 3) {
      await loadMonth();
      if (date) await loadDay();
    }
  }
  style.addEventListener('change', () => {
    fieldError(style, '');
    chooseStyle();
    refreshQuote();
    persist();
  });
  size.addEventListener('change', () => {
    fieldError(size, '');
    chooseSize();
    refreshQuote();
    persist();
  });
  variant.addEventListener('change', () => {
    fieldError(variant, '');
    refreshQuote();
    persist();
  });
  for (const input of form.querySelectorAll(
    '[name="addonIds"],[name="paymentChoice"]',
  ))
    input.addEventListener('change', () => {
      refreshQuote(input.name === 'addonIds');
      persist();
    });
  for (const button of form.querySelectorAll('[data-book-next]'))
    button.addEventListener('click', async () => {
      if (!quote) {
        const missing = [
          style,
          ...($('booking-variant-fields').hidden ? [] : [size, variant]),
        ].filter((input) => !input.value);
        missing.forEach((input) => fieldError(input, 'Required field'));
        if (missing.length) {
          (
            document.getElementById(missing[0].id + '-trigger') || missing[0]
          ).focus();
          return;
        }
        return error('Check your selection');
      }
      if (step === 3 && !startAt) return error('Select a time');
      await showStep(step + 1);
    });
  for (const button of form.querySelectorAll('[data-book-back]'))
    button.addEventListener('click', () => showStep(step - 1));
  for (const [selector, delta] of [
    ['[data-month-prev]', -1],
    ['[data-month-next]', 1],
  ])
    root.querySelector(selector).addEventListener('click', () => {
      const d = new Date(month + '-01T12:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + delta);
      const candidate = d.toISOString().slice(0, 7);
      if (
        candidate < localDate.slice(0, 7) ||
        candidate >
          new Date(Date.now() + 93 * 86400000).toISOString().slice(0, 7)
      )
        return;
      month = candidate;
      date = '';
      startAt = '';
      $('booking-slots').replaceChildren();
      persist();
      loadMonth();
    });
  for (const input of form.querySelectorAll('input,textarea'))
    input.addEventListener('input', persist);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitted) return;
    if (step !== 4) {
      return error('Complete all four steps before holding a time.');
    }
    const valid = detailFields.map(validateField).every(Boolean);
    if (!valid) {
      detailFields
        .find((input) => input.getAttribute('aria-invalid') === 'true')
        ?.focus();
      return;
    }
    if (!quote || !startAt) return error('Select a time');
    const file = $('booking-inspiration').files[0];
    if (file && file.size > 8 * 1024 * 1024)
      return error('Choose an image smaller than 8 MB.');
    let phone = form.elements.phone.value.replace(/[\s().-]/g, '');
    if (/^\d{10}$/.test(phone)) phone = '+1' + phone;
    if (/^1\d{10}$/.test(phone)) phone = '+' + phone;
    const payload = {
      ...selection(),
      startAt,
      name: form.elements.name.value,
      email: form.elements.email.value,
      phone,
      notes: form.elements.notes.value,
      policyAccepted: $('booking-policy').checked,
      marketingConsent: $('booking-marketing').checked,
      website: form.elements.website.value,
      turnstileToken: form.elements['cf-turnstile-response']?.value || '',
    };
    const body = new FormData();
    body.append('payload', JSON.stringify(payload));
    if (file) body.append('inspiration', file);
    const button = $('booking-submit');
    button.disabled = true;
    error('');
    try {
      const result = await api('/api/bookings/hold', {
        method: 'POST',
        headers: { 'x-csrf-token': form.dataset.csrf },
        body,
      });
      submitted = true;
      for (const section of root.querySelectorAll('[data-booking-step]'))
        section.hidden = true;
      $('booking-result').hidden = false;
      $('booking-result-message').textContent = result.message;
      $('booking-reference').textContent = 'Reference: ' + result.ref;
      $('booking-expiry').textContent =
        'Hold expires ' +
        new Date(result.holdExpiresAt).toLocaleString('en-US', {
          timeZone: 'America/New_York',
        }) +
        ' Eastern.';
      try {
        sessionStorage.removeItem('mado-booking');
      } catch {
        /* optional storage */
      }
      $('booking-result').scrollIntoView({ block: 'center' });
    } catch (e) {
      window.turnstile?.reset();
      if (e.data?.error === 'SLOT_TAKEN') {
        startAt = '';
        await showStep(3);
        error(e.message + ' Select another available start.');
      } else if (e.data?.fields?.length) {
        const fields = {
          name: $('booking-name'),
          email: $('booking-email'),
          phone: $('booking-phone'),
          policyAccepted: $('booking-policy'),
        };
        let first;
        for (const issue of e.data.fields) {
          const input = fields[issue.field];
          if (input) {
            fieldError(
              input,
              issue.field === 'phone'
                ? 'Invalid phone number'
                : issue.field === 'email'
                  ? 'Invalid email'
                  : 'Required field',
            );
            first ||= input;
          }
        }
        if (first) first.focus();
        else error('Check required fields');
      } else error(e.message);
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    showStep(Number(p.get('step') || 1), false);
  });
  const incomingStyle = [...style.options].find(
    (o) => o.dataset.slug === params.get('style'),
  );
  style.value = incomingStyle?.value || String(saved.styleId || '');
  const preferredVariant = params.get('variant') || saved.styleVariantId;
  const incomingVariant = allVariants.find(
    (o) =>
      o.value === String(preferredVariant) && o.dataset.style === style.value,
  );
  chooseStyle(
    params.get('size') || incomingVariant?.dataset.size || saved.size || '',
    preferredVariant,
  );
  for (const field of form.querySelectorAll('[name="addonIds"]'))
    field.checked = saved.addonIds?.includes(Number(field.value)) || false;
  for (const name of ['name', 'email', 'phone', 'notes'])
    form.elements[name].value = saved[name] || '';
  $('booking-marketing').checked = Boolean(saved.marketingConsent);
  if (saved.paymentChoice === 'full' && !$('booking-full').disabled)
    $('booking-full').checked = true;
  startAt = params.get('startAt') || saved.startAt || '';
  date = params.get('date') || saved.date || '';
  if (/^\d{4}-\d{2}/.test(date)) month = date.slice(0, 7);
  refreshQuote(false).then(() =>
    showStep(quote ? Number(params.get('step') || saved.step || 1) : 1, false),
  );
}
