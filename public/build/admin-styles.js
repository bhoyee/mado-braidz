// Styles, prices and extras in the owner studio. Scoped, because page scripts
// share one set of global names.
(() => {
  const csrf = () => document.querySelector('meta[name="csrf-token"]').content;
  function toast(message, success = false) {
    window.dispatchEvent(
      new CustomEvent('owner-toast', { detail: { message, success } }),
    );
  }
  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': csrf(),
      },
      body: JSON.stringify(body),
    });
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error(
        'Your session may have ended. Refresh and sign in again.',
      );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message || result.error || 'Unable to save.');
    return result;
  }

  // Search and tabs on the list.
  const rows = [...document.querySelectorAll('.style-row[data-text]')];
  const search = document.querySelector('[data-style-search]');
  let view = 'all';
  const inView = (row, key) =>
    key === 'all' ||
    (key === 'published' && row.dataset.published === 'yes') ||
    (key === 'hidden' && row.dataset.published === 'no') ||
    (key === 'featured' && row.dataset.featured === 'yes') ||
    (key === 'attention' && row.dataset.attention === 'yes');
  const PAGE_SIZE = 20;
  const pager = document.querySelector('[data-style-pages]');
  const pageKey = 'mado-style-page';
  let pageNumber = 1,
    everyRow = false;
  try {
    // Coming back from a style returns to the same page.
    pageNumber = Number(sessionStorage.getItem(pageKey)) || 1;
  } catch {
    // Start on the first page.
  }
  function showRows() {
    if (!search) return;
    const terms = search.value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    // Read from the page, so a newly saved order is respected.
    const matches = [
      ...document.querySelectorAll('.style-row[data-text]'),
    ].filter(
      (row) =>
        inView(row, view) &&
        terms.every((term) => row.dataset.text.includes(term)),
    );
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    pageNumber = Math.min(Math.max(1, pageNumber), pages);
    const first = (pageNumber - 1) * PAGE_SIZE;
    const shown = new Set(
      everyRow ? matches : matches.slice(first, first + PAGE_SIZE),
    );
    for (const row of rows) row.hidden = !shown.has(row);
    for (const count of document.querySelectorAll('[data-style-count]'))
      count.textContent = rows.filter((row) =>
        inView(row, count.dataset.styleCount),
      ).length;
    document.querySelector('[data-style-empty]').hidden = matches.length > 0;
    document.querySelector('[data-style-status]').textContent =
      terms.length || view !== 'all'
        ? `${matches.length} of ${rows.length} styles found.`
        : '';
    pager.hidden = everyRow || pages === 1;
    pager.querySelector('[data-page-range]').textContent =
      `${first + 1}–${Math.min(first + PAGE_SIZE, matches.length)} of ${matches.length}`;
    pager.querySelector('[data-page-step="-1"]').disabled = pageNumber === 1;
    pager.querySelector('[data-page-step="1"]').disabled = pageNumber === pages;
    pager.querySelector('[data-page-numbers]').replaceChildren(
      ...Array.from({ length: pages }, (_, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.page = index + 1;
        button.textContent = index + 1;
        button.setAttribute('aria-label', `Page ${index + 1}`);
        if (index + 1 === pageNumber)
          button.setAttribute('aria-current', 'page');
        return button;
      }),
    );
    try {
      sessionStorage.setItem(pageKey, String(pageNumber));
    } catch {
      // Only a convenience.
    }
  }
  pager?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    pageNumber = button.dataset.page
      ? Number(button.dataset.page)
      : pageNumber + Number(button.dataset.pageStep);
    showRows();
    const current = pager.querySelector('[aria-current]');
    (button.isConnected && !button.disabled ? button : current).focus({
      preventScroll: true,
    });
    document
      .querySelector('[data-style-tools]')
      .scrollIntoView({ block: 'center' });
  });
  search?.addEventListener('input', () => {
    pageNumber = 1;
    showRows();
  });
  for (const tab of document.querySelectorAll('[data-style-view]'))
    tab.addEventListener('click', () => {
      view = tab.dataset.styleView;
      pageNumber = 1;
      for (const other of document.querySelectorAll('[data-style-view]'))
        other.setAttribute('aria-pressed', String(other === tab));
      showRows();
    });
  showRows();

  // Published, Featured and Available switches.
  document.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-flag]');
    if (!input) return;
    const wanted = input.checked;
    input.disabled = true;
    try {
      await post(input.dataset.flagUrl, { [input.dataset.flag]: wanted });
      const row = input.closest('.style-row');
      if (row.dataset.text) {
        row.dataset[
          input.dataset.flag === 'active' ? 'published' : 'featured'
        ] = wanted ? 'yes' : 'no';
        if (input.dataset.flag === 'active')
          row.querySelector('[data-public-link]').hidden = !wanted;
        showRows();
      }
      toast('Saved.', true);
    } catch (error) {
      input.checked = !wanted;
      toast(error.message);
    } finally {
      input.disabled = false;
      input.focus({ preventScroll: true });
    }
  });

  // Moves one item inside a list by dragging; arrows call the same code.
  function draggable(list, allowed, changed) {
    let dragged = null;
    list.addEventListener('dragstart', (event) => {
      dragged = allowed() ? event.target.closest('li') : null;
      if (!dragged) return event.preventDefault();
      event.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragover', (event) => {
      const over = event.target.closest('li');
      if (!dragged || !over || over.parentNode !== list) return;
      event.preventDefault();
      if (over === dragged) return;
      const items = [...list.children];
      if (items.indexOf(over) < items.indexOf(dragged)) over.before(dragged);
      else over.after(dragged);
    });
    list.addEventListener('drop', (event) => event.preventDefault());
    list.addEventListener('dragend', () => {
      if (dragged) changed();
      dragged = null;
    });
  }
  const orderList = document.querySelector('[data-order-list]');
  const orderStart = document.querySelector('[data-order-start]');
  if (orderList && orderStart) {
    const bar = document.querySelector('[data-order-bar]');
    const tools = orderStart.closest('.style-tools');
    let before = [];
    const ordering = () => !bar.hidden;
    function setOrdering(on) {
      if (on) {
        if (search) search.value = '';
        document.querySelector('[data-style-view="all"]')?.click();
        before = [...orderList.children];
      }
      bar.hidden = !on;
      tools.hidden = on;
      // Every style must be reachable while ordering.
      everyRow = on;
      showRows();
      orderList.classList.toggle('is-ordering', on);
      for (const row of orderList.children) {
        row.draggable = on;
        row.querySelector('.order-arrows').hidden = !on;
      }
    }
    orderStart.addEventListener('click', () => setOrdering(true));
    document
      .querySelector('[data-order-cancel]')
      .addEventListener('click', () => {
        orderList.replaceChildren(...before);
        setOrdering(false);
        orderStart.focus();
      });
    document
      .querySelector('[data-order-save]')
      .addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await post(orderList.dataset.orderUrl, {
            ids: [...orderList.children].map((row) =>
              Number(row.dataset.orderId),
            ),
          });
          setOrdering(false);
          toast('Order saved.', true);
        } catch (error) {
          toast(error.message);
        } finally {
          button.disabled = false;
        }
      });
    orderList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-order-move]');
      if (!button) return;
      const row = button.closest('li');
      if (button.dataset.orderMove === '-1')
        row.previousElementSibling?.before(row);
      else row.nextElementSibling?.after(row);
      button.focus();
    });
    draggable(orderList, ordering, () => {});
  }

  // Extras: one window for adding and editing.
  const extraDialog = document.querySelector('#extra-dialog');
  if (extraDialog) {
    const form = extraDialog.querySelector('[data-extra-form]');
    const list = form.querySelector('[data-extra-styles]');
    const where = () => {
      const all = form.elements.appliesToAll.value === 'true';
      list.hidden = all;
    };
    for (const radio of form.querySelectorAll('[data-extra-all]'))
      radio.addEventListener('change', where);
    function open(item) {
      form.reset();
      form.querySelector('[data-owner-form-error]').hidden = true;
      extraDialog.querySelector('[data-extra-title]').textContent = item
        ? 'Edit extra'
        : 'Add an extra';
      form.elements.id.value = item?.id || '';
      if (item) {
        for (const name of ['name', 'price', 'durationMin', 'description'])
          form.elements[name].value = item[name];
        // The row's switch may have changed since the page loaded.
        form.elements.active.checked = document.querySelector(
          `#extra-${item.id} [data-flag]`,
        ).checked;
        form.elements.appliesToAll.value = String(Boolean(item.appliesToAll));
        for (const box of list.querySelectorAll('input'))
          box.checked = item.styleIds.includes(Number(box.value));
      }
      where();
      extraDialog.showModal();
      form.elements.name.focus();
    }
    for (const button of document.querySelectorAll('[data-extra-open]'))
      button.addEventListener('click', () =>
        open(button.dataset.extra ? JSON.parse(button.dataset.extra) : null),
      );
    // Links from search open the right extra.
    const linked = location.hash.match(/^#extra-\d+$/);
    if (linked)
      document.querySelector(linked[0] + ' [data-extra-open]')?.click();
  }

  // Photo previews before anything is uploaded.
  for (const input of document.querySelectorAll('[data-photo-input]'))
    input.addEventListener('change', () => {
      const image =
        input.dataset.previewInto === 'edit'
          ? input.closest('dialog').querySelector('[data-edit-image]')
          : input.closest('form').querySelector('[data-photo-preview]');
      const file = input.files[0];
      if (!image || !file) return;
      image.src = URL.createObjectURL(file);
      image.hidden = false;
    });

  const form = document.querySelector('[data-style-form]');
  if (form) {
    const usd = (value) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: value % 1 ? 2 : 0,
      }).format(value);
    const cells = [...form.querySelectorAll('[data-cell]')];
    const priceInput = (cell) => cell.querySelector('[data-cell-price]');
    const activeInput = (cell) => cell.querySelector('[data-cell-active]');
    const pricesField = form.querySelector('[data-prices]');
    const consultation = () =>
      form.elements.priceOnConsultation.value === 'true';
    const validPrice = (text) => /^\d{1,6}(?:\.\d{1,2})?$/.test(text);

    // Sections
    const sections = [...document.querySelectorAll('[data-section]')];
    const panels = [...document.querySelectorAll('[data-panel]')];
    const key = 'mado-style-section';
    function showSection(name, keep = true) {
      if (!sections.length) return;
      for (const tab of sections)
        tab.setAttribute('aria-pressed', String(tab.dataset.section === name));
      for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
      form.hidden = name === 'photos';
      if (keep)
        try {
          sessionStorage.setItem(key, location.pathname + '|' + name);
        } catch {
          // Only a convenience.
        }
    }
    for (const tab of sections)
      tab.addEventListener('click', () => showSection(tab.dataset.section));
    if (sections.length) {
      let start = /^#(style-photos|photo-\d+)$/.test(location.hash)
        ? 'photos'
        : '';
      try {
        const [path, name] = (sessionStorage.getItem(key) || '').split('|');
        if (!start && path === location.pathname) start = name;
      } catch {
        // Start on the details.
      }
      showSection(start || 'details', false);
    }
    // A mistake in a hidden section must be seen.
    form.addEventListener(
      'invalid',
      (event) => {
        const panel = event.target.closest('[data-panel]');
        if (panel?.hidden) showSection(panel.dataset.panel);
      },
      true,
    );

    // Price grid
    function showGrid() {
      const shown = (attribute) =>
        new Set(
          [...form.querySelectorAll(`[data-${attribute}]:checked`)].map(
            (input) => input.dataset[attribute],
          ),
        );
      const sizes = shown('size'),
        lengths = shown('length');
      for (const item of form.querySelectorAll('[data-price-grid] [data-col]'))
        item.hidden = !sizes.has(item.dataset.col);
      for (const row of form.querySelectorAll('[data-price-grid] [data-row]'))
        row.hidden = !lengths.has(row.dataset.row);
      form.querySelector('[data-price-grid]').hidden =
        !sizes.size || !lengths.size;
    }
    function showWas(cell) {
      const saved = cell.dataset.price,
        now = priceInput(cell).value.trim();
      cell.querySelector('[data-cell-was]').textContent =
        saved && now && Number(now) !== Number(saved)
          ? 'was ' + usd(Number(saved))
          : '';
      cell.classList.toggle(
        'is-off',
        Boolean(now) && !activeInput(cell).checked,
      );
    }
    for (const cell of cells) {
      priceInput(cell).addEventListener('input', () => {
        // Typing a price offers it; the saved price comes back when it is empty.
        activeInput(cell).checked = priceInput(cell).value.trim() !== '';
        priceInput(cell).setCustomValidity('');
        showWas(cell);
      });
      activeInput(cell).addEventListener('change', () => showWas(cell));
      showWas(cell);
    }
    for (const input of form.querySelectorAll('[data-size],[data-length]'))
      input.addEventListener('change', showGrid);
    form
      .querySelector('[data-own-times]')
      .addEventListener('change', (event) => {
        for (const more of form.querySelectorAll('[data-cell-more]'))
          more.hidden = !event.target.checked;
      });
    function showMode() {
      form.querySelector('[data-consult-fields]').hidden = !consultation();
      form.querySelector('[data-grid-fields]').hidden = consultation();
    }
    for (const radio of form.querySelectorAll('[data-consult]'))
      radio.addEventListener('change', showMode);
    showGrid();
    showMode();

    // Bulk change
    let undo = null;
    const bulkStatus = form.querySelector('[data-bulk-status]');
    const undoButton = form.querySelector('[data-bulk-undo]');
    form.querySelector('[data-bulk-apply]').addEventListener('click', () => {
      const amount = Number(form.querySelector('[data-bulk-amount]').value);
      const sign = Number(form.querySelector('[data-bulk-sign]').value);
      const percent = form.querySelector('[data-bulk-unit]').value === '%';
      if (!(amount > 0)) return (bulkStatus.textContent = 'Enter an amount.');
      const changes = cells
        .filter(
          (cell) =>
            !cell.hidden &&
            !cell.closest('tr').hidden &&
            validPrice(priceInput(cell).value.trim()),
        )
        .map((cell) => {
          const old = Number(priceInput(cell).value);
          const next = percent
            ? Math.round(old * (1 + (sign * amount) / 100))
            : old + sign * amount;
          return { cell, old: priceInput(cell).value, next };
        });
      if (!changes.length)
        return (bulkStatus.textContent = 'There are no prices to change.');
      if (changes.some(({ next }) => next < 0.5 || next > 999999))
        return (bulkStatus.textContent =
          'That would make a price too low or too high.');
      undo = changes;
      for (const { cell, next } of changes) {
        priceInput(cell).value = Number(next.toFixed(2));
        showWas(cell);
      }
      undoButton.hidden = false;
      bulkStatus.textContent = `${changes.length} prices changed below. Check them, then save.`;
      markDirty();
    });
    undoButton.addEventListener('click', () => {
      for (const { cell, old } of undo || []) {
        priceInput(cell).value = old;
        showWas(cell);
      }
      undo = null;
      undoButton.hidden = true;
      bulkStatus.textContent = 'Prices put back.';
      markDirty();
    });

    // Suggested text: only facts from this form, only into empty boxes.
    form.querySelector('[data-suggest]').addEventListener('click', () => {
      const name = form.elements.name.value.trim();
      if (!name) return toast('Enter the style name first.');
      const short = form.querySelector('[data-short]'),
        long = form.querySelector('[data-long]');
      const time = form.elements.durationMin.selectedOptions[0].textContent;
      const labels = (attribute) =>
        [...form.querySelectorAll(`[data-${attribute}]:checked`)]
          .filter((input) => input.dataset[attribute])
          .map((input) =>
            input.closest('label').textContent.trim().toLowerCase(),
          );
      const words = (items) =>
        items.length > 1
          ? items.slice(0, -1).join(', ') + ' or ' + items.at(-1)
          : items[0];
      const sizes = consultation() ? [] : labels('size'),
        lengths = consultation() ? [] : labels('length');
      let filled = 0;
      if (!short.value.trim()) {
        short.value = `${name} by Mado African Braids. ${
          consultation()
            ? 'Tell us the finish you want and we will agree your price together.'
            : sizes.length
              ? 'Choose the size and length that suit you.'
              : 'Choose your time and book online.'
        }`;
        filled++;
      }
      if (!long.value.trim()) {
        const details = [
          sizes.length ? `- Sizes: ${words(sizes)}` : '',
          lengths.length ? `- Lengths: ${words(lengths)}` : '',
          `- Usual appointment time: ${time}`,
        ].filter(Boolean);
        long.value = `Bring a photo of the look you have in mind and we will talk it through before we start.\n\n${details.join('\n')}`;
        filled++;
      }
      toast(
        filled
          ? 'Suggested text added. Read it before saving.'
          : 'Both boxes already have text.',
        Boolean(filled),
      );
      if (filled) markDirty();
      preview();
    });

    // Search preview
    function preview() {
      const name = form.elements.name.value.trim() || 'Style name';
      const clip = (text, size) =>
        text.length > size ? text.slice(0, size - 1).trimEnd() + '…' : text;
      form.querySelector('[data-preview-title]').textContent = clip(
        form.elements.seoTitle.value.trim() || `${name} | Mado African Braids`,
        60,
      );
      form.querySelector('[data-preview-desc]').textContent = clip(
        form.elements.seoDescription.value.trim() ||
          form.elements.shortDesc.value.trim() ||
          `See prices and book ${name} at Mado African Braids.`,
        160,
      );
      for (const input of form.querySelectorAll('[data-count]')) {
        const limit = Number(input.dataset.count),
          used = input.value.length;
        const note = form.querySelector(`[data-count-for="${input.id}"]`);
        note.textContent =
          used > limit
            ? `${used} characters. Google may cut it after about ${limit}.`
            : `${used} of about ${limit} characters`;
        note.classList.toggle('pay-due', used > limit);
      }
    }
    preview();

    // Unsaved changes
    const dirtyStatus = form.querySelector('[data-dirty-status]');
    const snapshot = () =>
      JSON.stringify([
        [...new FormData(form)].filter(
          ([name]) => !['prices', '_csrf', 'photo'].includes(name),
        ),
        collect(),
        form.elements.photo?.files.length || 0,
      ]);
    function collect() {
      return cells
        .filter((cell) => cell.dataset.id || priceInput(cell).value.trim())
        .map((cell) => {
          const offered = !cell.hidden && !cell.closest('tr').hidden;
          return {
            id: cell.dataset.id || null,
            size: cell.dataset.col,
            length: cell.closest('tr').dataset.row,
            price: priceInput(cell).value.trim(),
            active: offered && activeInput(cell).checked,
            durationMin: cell.querySelector('[data-cell-duration]').value,
            label: cell.querySelector('[data-cell-label]').value.trim(),
          };
        })
        .filter((row) => row.id || row.active);
    }
    const saved = snapshot();
    const isDirty = () => snapshot() !== saved;
    function markDirty() {
      const dirty = isDirty();
      form.querySelector('[data-save-bar]').classList.toggle('is-dirty', dirty);
      dirtyStatus.textContent = dirty
        ? 'Unsaved changes'
        : form.elements.id.value
          ? 'All changes saved'
          : 'Not saved yet';
    }
    for (const name of ['input', 'change'])
      form.addEventListener(name, () => {
        preview();
        markDirty();
      });
    addEventListener('beforeunload', (event) => {
      if (isDirty() && form.getAttribute('aria-busy') !== 'true')
        event.preventDefault();
    });
    // Runs before the shared save code, which sends the fields.
    document.addEventListener(
      'submit',
      (event) => {
        if (event.target !== form) {
          if (event.target.closest('main') && isDirty()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toast('Save your style changes first.');
          }
          return;
        }
        const stop = (message, cell) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          showSection('prices');
          toast(message);
          if (cell) priceInput(cell).focus();
        };
        const rowsToSave = collect();
        for (const cell of cells) {
          const value = priceInput(cell).value.trim();
          if (value && (!validPrice(value) || Number(value) < 0.5))
            return stop('Enter prices like 160 or 160.50.', cell);
        }
        if (
          !consultation() &&
          form.elements.active.checked &&
          !rowsToSave.some((row) => row.active && row.price)
        )
          return stop(
            'Add at least one price, choose price on consultation, or switch off Published.',
          );
        pricesField.value = JSON.stringify(rowsToSave);
      },
      true,
    );

    // Photos
    const photoList = document.querySelector('[data-photo-order]');
    if (photoList) {
      const savePhotos = async () => {
        if (isDirty()) {
          toast('Save your style changes first.');
          return;
        }
        try {
          await post(photoList.dataset.photoUrl, {
            ids: [...photoList.children].map((item) =>
              Number(item.dataset.photo),
            ),
          });
          sessionStorage.setItem('owner-message', 'Photo order saved.');
        } catch (error) {
          sessionStorage.setItem('owner-message', error.message);
        }
        location.reload();
      };
      draggable(photoList, () => !isDirty(), savePhotos);
      photoList.addEventListener('click', (event) => {
        const item = event.target.closest('li');
        const shift = event.target.closest('[data-photo-shift]');
        if ((shift || event.target.closest('[data-photo-cover]')) && isDirty())
          return toast('Save your style changes first.');
        if (shift) {
          if (shift.dataset.photoShift === '-1')
            item.previousElementSibling?.before(item);
          else item.nextElementSibling?.after(item);
          return savePhotos();
        }
        if (event.target.closest('[data-photo-cover]')) {
          photoList.prepend(item);
          return savePhotos();
        }
        const edit = event.target.closest('[data-photo-edit]');
        if (!edit) return;
        const dialog = document.querySelector('#photo-edit');
        const details = dialog.querySelector('[data-edit-form]');
        details.action = '/admin/gallery/' + edit.dataset.id;
        details.elements.alt.value = edit.dataset.alt;
        details.elements.sort.value = edit.dataset.sort;
        details.elements.showInWork.checked = Boolean(edit.dataset.work);
        dialog.querySelector('[data-replace-form]').reset();
        dialog.querySelector('[data-replace-form]').action =
          `/admin/gallery/${edit.dataset.id}/replace`;
        dialog.querySelector('[data-remove-form]').action =
          `/admin/gallery/${edit.dataset.id}/remove`;
        dialog.querySelector('[data-edit-image]').src = edit.dataset.src;
        dialog.showModal();
      });
    }
  }
})();
