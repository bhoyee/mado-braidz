// Photo library. Scoped, because page scripts share one set of global names.
(() => {
  const list = document.querySelector('[data-photo-list]');
  if (!list) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  const csrf = () => $('meta[name="csrf-token"]').content;
  const toast = (message, success = false) =>
    window.dispatchEvent(
      new CustomEvent('owner-toast', { detail: { message, success } }),
    );
  const store = {
    get(key) {
      try {
        return JSON.parse(sessionStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Only a convenience.
      }
    },
  };
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
      throw new Error('Your session may have ended. Refresh and sign in.');
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message || result.error || 'Unable to save.');
    return result;
  }
  // Sends a photo with progress, which fetch cannot report.
  function sendPhoto(url, fields, blob, progress) {
    return new Promise((resolve, reject) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      data.set('photo', blob, 'photo.jpg');
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.setRequestHeader('Accept', 'application/json');
      request.setRequestHeader('x-csrf-token', csrf());
      request.upload.onprogress = (event) =>
        event.lengthComputable &&
        progress?.(Math.round((event.loaded / event.total) * 100));
      request.onload = () => {
        let result = {};
        try {
          result = JSON.parse(request.responseText);
        } catch {
          // Reported below.
        }
        if (request.status >= 200 && request.status < 300) resolve(result);
        else
          reject(
            new Error(
              result.message || result.error || 'The upload did not finish.',
            ),
          );
      };
      request.onerror = request.ontimeout = () =>
        reject(new Error('No connection. Try again.'));
      request.timeout = 180000;
      request.send(data);
    });
  }

  // One small image editor, used for new and existing photos.
  const MAX_SIDE = 2200;
  async function loadImage(source) {
    if (source instanceof Blob)
      return createImageBitmap(source, { imageOrientation: 'from-image' });
    const image = new Image();
    image.src = source;
    await image.decode();
    return image;
  }
  function makeEditor(canvas) {
    const state = { image: null, turns: 0, ratio: 0, focus: { x: 50, y: 50 } };
    const size = () => {
      const width = state.image.naturalWidth || state.image.width,
        height = state.image.naturalHeight || state.image.height;
      return state.turns % 2 ? [height, width] : [width, height];
    };
    // The crop keeps as much as possible around the focus point.
    function area() {
      const [width, height] = size();
      if (!state.ratio) return { x: 0, y: 0, width, height };
      const w = Math.min(width, height * state.ratio),
        h = w / state.ratio;
      const at = (full, part, percent) =>
        Math.min(full - part, Math.max(0, (full * percent) / 100 - part / 2));
      return {
        x: at(width, w, state.focus.x),
        y: at(height, h, state.focus.y),
        width: w,
        height: h,
      };
    }
    function paint(target, limit, crop) {
      const [width, height] = size();
      const box = crop ? area() : { x: 0, y: 0, width, height };
      const scale = Math.min(1, limit / Math.max(box.width, box.height));
      target.width = Math.max(1, Math.round(box.width * scale));
      target.height = Math.max(1, Math.round(box.height * scale));
      const context = target.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, target.width, target.height);
      context.scale(scale, scale);
      context.translate(-box.x, -box.y);
      context.translate(width / 2, height / 2);
      context.rotate((state.turns * Math.PI) / 2);
      const [w, h] = state.turns % 2 ? [height, width] : [width, height];
      context.drawImage(state.image, -w / 2, -h / 2, w, h);
    }
    return {
      state,
      async load(source) {
        state.image = await loadImage(source);
        state.turns = 0;
        state.ratio = 0;
        this.draw();
      },
      draw(crop = true) {
        paint(canvas, 720, crop);
      },
      rotate() {
        state.turns = (state.turns + 1) % 4;
        this.draw();
      },
      changed: () => Boolean(state.turns || state.ratio),
      blob() {
        const output = document.createElement('canvas');
        paint(output, MAX_SIDE, true);
        return new Promise((resolve, reject) =>
          output.toBlob(
            (blob) =>
              blob ? resolve(blob) : reject(new Error('Unable to read photo.')),
            'image/jpeg',
            0.88,
          ),
        );
      },
    };
  }

  // Panels
  const panels = ['photos', 'work', 'videos'];
  function showPanel(name) {
    for (const panel of panels) $('#library-' + panel).hidden = panel !== name;
    for (const button of $$('[data-library-panel]'))
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.libraryPanel === name),
      );
    for (const video of $$('video')) video.pause();
  }
  for (const button of $$('[data-library-panel]'))
    button.addEventListener('click', () => {
      const name = button.dataset.libraryPanel;
      showPanel(name);
      history.replaceState(
        null,
        '',
        location.pathname + (name === 'photos' ? '' : '#' + name),
      );
    });
  showPanel(
    /^#video(s|-)/.test(location.hash)
      ? 'videos'
      : location.hash === '#work'
        ? 'work'
        : 'photos',
  );

  // Filters and pages
  const PAGE_SIZE = 20;
  const cards = $$('[data-photo-id]');
  const search = $('[data-library-search]');
  const stylePick = $('[data-library-style]');
  const pager = $('[data-photo-pages]');
  const saved = store.get('mado-library') || {};
  let view = saved.view || 'all',
    pageNumber = saved.page || 1;
  search.value = saved.search || '';
  stylePick.value = saved.style || '';
  if (stylePick.selectedIndex < 0) stylePick.value = '';
  const inView = (card, key) => {
    const data = card.dataset;
    if (key === 'removed') return data.removed === 'yes';
    if (data.removed === 'yes') return false;
    return (
      key === 'all' ||
      (key === 'style' && data.onStyle === 'yes') ||
      (key === 'work' && data.inWork === 'yes') ||
      (key === 'hidden' && data.hidden === 'yes') ||
      (key === 'attention' && data.attention === 'yes')
    );
  };
  const matches = () => {
    const terms = search.value.trim().toLowerCase().split(/\s+/);
    return cards.filter(
      (card) =>
        inView(card, view) &&
        (!stylePick.value ||
          (stylePick.value === 'untagged'
            ? !card.dataset.style
            : card.dataset.style === stylePick.value)) &&
        terms.every((term) => card.dataset.text.includes(term)),
    );
  };
  function showCards() {
    const found = matches();
    const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
    pageNumber = Math.min(Math.max(1, pageNumber), pages);
    const first = (pageNumber - 1) * PAGE_SIZE;
    const shown = new Set(found.slice(first, first + PAGE_SIZE));
    for (const card of cards) card.hidden = !shown.has(card);
    for (const count of $$('[data-photo-count]'))
      count.textContent = cards.filter((card) =>
        inView(card, count.dataset.photoCount),
      ).length;
    for (const tab of $$('[data-photo-view]'))
      tab.setAttribute('aria-pressed', String(tab.dataset.photoView === view));
    $('[data-library-empty]').hidden = found.length > 0;
    $('[data-removed-help]').hidden = view !== 'removed';
    $('[data-library-results]').textContent =
      `${found.length} ${found.length === 1 ? 'photo' : 'photos'}`;
    pager.hidden = pages === 1;
    $('[data-page-range]', pager).textContent =
      `${first + 1}–${Math.min(first + PAGE_SIZE, found.length)} of ${found.length}`;
    $('[data-page-step="-1"]', pager).disabled = pageNumber === 1;
    $('[data-page-step="1"]', pager).disabled = pageNumber === pages;
    $('[data-page-numbers]', pager).replaceChildren(
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
    store.set('mado-library', {
      view,
      page: pageNumber,
      search: search.value,
      style: stylePick.value,
    });
  }
  const restart = () => {
    pageNumber = 1;
    showCards();
  };
  search.addEventListener('input', restart);
  stylePick.addEventListener('change', restart);
  for (const tab of $$('[data-photo-view]'))
    tab.addEventListener('click', () => {
      view = tab.dataset.photoView;
      if (selecting && view === 'removed') setSelecting(false);
      restart();
    });
  pager.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    pageNumber = button.dataset.page
      ? Number(button.dataset.page)
      : pageNumber + Number(button.dataset.pageStep);
    showCards();
    (button.isConnected && !button.disabled
      ? button
      : $('[aria-current]', pager)
    ).focus({ preventScroll: true });
    list.scrollIntoView({ block: 'start' });
  });

  // Undo after removing
  const undoBar = $('[data-undo]');
  const removedIds = store.get('mado-removed');
  if (removedIds?.length) {
    store.set('mado-removed', null);
    undoBar.hidden = false;
    $('[data-undo-text]').textContent =
      `${removedIds.length} ${removedIds.length === 1 ? 'photo' : 'photos'} removed. Kept for 7 days.`;
    $('[data-undo-button]').addEventListener('click', () =>
      act(
        () => post('/admin/gallery/restore', { ids: removedIds }),
        'Put back.',
      ),
    );
  }
  async function act(run, message) {
    try {
      await run();
      try {
        sessionStorage.setItem('owner-message', message);
      } catch {
        // The page still refreshes.
      }
      location.reload();
    } catch (error) {
      toast(error.message);
    }
  }
  async function confirmRemove(count) {
    const dialog = $('#owner-confirm-dialog');
    $('#owner-confirm-title').textContent =
      count === 1 ? 'Remove this photo?' : `Remove ${count} photos?`;
    $('#owner-confirm-detail').textContent =
      'It leaves the website now. You can restore it for 7 days.';
    $('[data-confirm-submit]', dialog).textContent =
      count === 1 ? 'Remove photo' : 'Remove photos';
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise((resolve) =>
      dialog.addEventListener(
        'close',
        () => resolve(dialog.returnValue === 'confirm'),
        { once: true },
      ),
    );
  }
  async function removePhotos(ids) {
    if (!(await confirmRemove(ids.length))) return;
    await act(async () => {
      await post('/admin/gallery/trash', { ids });
      store.set('mado-removed', ids);
    }, 'Removed.');
  }

  // Our Work switch on each card
  list.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-work-switch]');
    if (!input) return;
    const wanted = input.checked;
    input.disabled = true;
    try {
      await post('/admin/gallery/place', {
        ids: [Number(input.value)],
        showInWork: wanted,
      });
      const card = input.closest('[data-photo-id]');
      card.dataset.inWork = wanted ? 'yes' : '';
      card.dataset.hidden =
        !wanted && card.dataset.onStyle !== 'yes' ? 'yes' : '';
      card.classList.toggle('is-dim', card.dataset.hidden === 'yes');
      toast(
        card.dataset.hidden === 'yes'
          ? 'Hidden. It is not on any page now.'
          : 'Saved.',
        true,
      );
      for (const count of $$('[data-photo-count]'))
        count.textContent = cards.filter((item) =>
          inView(item, count.dataset.photoCount),
        ).length;
    } catch (error) {
      input.checked = !wanted;
      toast(error.message);
    } finally {
      input.disabled = false;
      input.focus({ preventScroll: true });
    }
  });
  list.addEventListener('click', (event) => {
    const restore = event.target.closest('[data-restore]');
    if (restore)
      act(
        () =>
          post('/admin/gallery/restore', {
            ids: [Number(restore.dataset.restore)],
          }),
        'Photo restored.',
      );
  });

  // Select several
  const bar = $('[data-select-bar]');
  let selecting = false;
  const picked = () =>
    $$('[data-pick]:checked').map((input) => Number(input.value));
  function showPicked() {
    const count = picked().length;
    $('[data-select-count]').textContent = `${count} selected`;
    for (const control of $$('[data-bulk], [data-bulk-style]'))
      control.disabled = !count;
  }
  function setSelecting(on) {
    selecting = on;
    if (on && view === 'removed') view = 'all';
    bar.hidden = !on;
    list.classList.toggle('is-selecting', on);
    for (const pick of $$('.photo-pick')) pick.hidden = !on;
    if (!on) for (const input of $$('[data-pick]')) input.checked = false;
    showPicked();
    showCards();
  }
  $('[data-select-start]').addEventListener('click', () =>
    setSelecting(!selecting),
  );
  $('[data-select-done]').addEventListener('click', () => {
    setSelecting(false);
    $('[data-select-start]').focus();
  });
  $('[data-select-page]').addEventListener('click', () => {
    for (const card of cards)
      if (!card.hidden) $('[data-pick]', card).checked = true;
    showPicked();
  });
  list.addEventListener('change', (event) => {
    if (event.target.matches('[data-pick]')) showPicked();
  });
  bar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-bulk]')?.dataset.bulk;
    const ids = picked();
    if (!action || !ids.length) return;
    if (action === 'remove') return removePhotos(ids);
    act(
      () =>
        post('/admin/gallery/place', {
          ids,
          showInWork: action === 'work-on',
        }),
      'Photos updated.',
    );
  });
  $('[data-bulk-style]').addEventListener('change', (event) => {
    const ids = picked();
    if (!event.target.value || !ids.length) return;
    act(
      () =>
        post('/admin/gallery/place', {
          ids,
          styleId: Number(event.target.value),
        }),
      'Style set.',
    );
  });

  // Photo window
  const dialog = $('#photo-window');
  const form = $('[data-window-form]');
  const canvas = $('[data-window-canvas]');
  const editor = makeEditor(canvas);
  const dot = $('[data-focus-dot]');
  let current = null,
    newFile = null,
    ready = false,
    before = '',
    token = 0;
  const cropPick = $('[data-window-crop]');
  const snapshot = () =>
    JSON.stringify([
      form.elements.alt.value,
      form.elements.styleId.value,
      form.elements.showOnStyle.checked,
      form.elements.showInWork.checked,
      editor.state.focus,
      editor.state.turns,
      editor.state.ratio,
      Boolean(newFile),
    ]);
  const dirty = () => snapshot() !== before;
  function placeDot() {
    dot.style.left = editor.state.focus.x + '%';
    dot.style.top = editor.state.focus.y + '%';
    dot.hidden = Boolean(editor.state.ratio);
  }
  const imageStatus = (text) =>
    ($('[data-window-image-status]').textContent = text);
  function navigable() {
    return matches();
  }
  async function openPhoto(card) {
    const mine = ++token;
    current = card;
    newFile = null;
    ready = false;
    const data = card.dataset;
    form.reset();
    cropPick.value = '';
    $('[data-window-file]').value = '';
    $('[data-window-error]').hidden = true;
    form.elements.alt.value = data.alt;
    form.elements.styleId.value = data.style;
    form.elements.showOnStyle.checked = data.onStyle === 'yes';
    form.elements.showInWork.checked = data.inWork === 'yes';
    const [x, y] = data.focus.split(',').map(Number);
    editor.state.focus = { x, y };
    editor.state.turns = editor.state.ratio = 0;
    $('[data-window-title]').textContent = data.styleName || 'Portfolio photo';
    const items = navigable(),
      index = items.indexOf(card);
    $('[data-window-position]').textContent =
      index >= 0 ? `Photo ${index + 1} of ${items.length}` : 'Photo';
    $('[data-window-step="-1"]').disabled = index <= 0;
    $('[data-window-step="1"]').disabled =
      index < 0 || index === items.length - 1;
    const links = $('[data-window-links]');
    links.replaceChildren();
    const link = (href, text) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'owner-text-link';
      a.textContent = text + ' ↗';
      links.append(a, ' ');
    };
    if (data.styleLink) link(data.styleLink, 'See its style page');
    if (data.inWork === 'yes') link('/our-work', 'See it on Our Work');
    if (!dialog.open) dialog.showModal();
    imageStatus('Loading photo…');
    before = snapshot();
    placeDot();
    try {
      const focus = editor.state.focus;
      const image = await loadImage(data.full);
      if (mine !== token) return;
      editor.state.image = image;
      editor.state.focus = focus;
      editor.draw();
      ready = true;
      imageStatus('');
    } catch {
      if (mine === token) imageStatus('The photo could not be loaded.');
    }
  }
  list.addEventListener('click', (event) => {
    const open = event.target.closest('[data-photo-edit]');
    if (!open) return;
    const card = open.closest('[data-photo-id]');
    if (selecting) {
      const pick = $('[data-pick]', card);
      pick.checked = !pick.checked;
      return showPicked();
    }
    openPhoto(card);
  });
  $('[data-focus-box]').addEventListener('click', (event) => {
    if (!ready || editor.state.ratio) return;
    const box = canvas.getBoundingClientRect();
    const percent = (value, size) =>
      Math.min(100, Math.max(0, Math.round((value / size) * 10) * 10));
    editor.state.focus = {
      x: percent(event.clientX - box.left, box.width),
      y: percent(event.clientY - box.top, box.height),
    };
    placeDot();
  });
  $('[data-window-rotate]').addEventListener('click', () => {
    if (!ready) return;
    editor.state.focus = { x: 50, y: 50 };
    editor.rotate();
    placeDot();
  });
  cropPick.addEventListener('change', () => {
    if (!ready) return;
    editor.state.ratio = Number(cropPick.value) || 0;
    editor.draw();
    placeDot();
  });
  $('[data-window-file]').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await editor.load(file);
      editor.state.focus = { x: 50, y: 50 };
      cropPick.value = '';
      newFile = file;
      ready = true;
      placeDot();
      imageStatus('New image chosen. Save to use it.');
    } catch {
      event.target.value = '';
      toast('Choose a JPEG, PNG, WebP or AVIF photo.');
    }
  });
  $('[data-window-suggest]').addEventListener('click', () => {
    const name = form.elements.styleId.selectedOptions[0];
    if (!form.elements.styleId.value) return toast('Choose a style first.');
    form.elements.alt.value = `${name.textContent.trim()} hairstyle by Mado African Braids`;
    form.elements.alt.focus();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('[type="submit"]', form);
    const problem = $('[data-window-error]');
    if (button.disabled) return;
    if (form.elements.showOnStyle.checked && !form.elements.styleId.value) {
      problem.textContent = 'Choose a style to show it on a style page.';
      problem.hidden = false;
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    problem.hidden = true;
    const id = current.dataset.photoId;
    try {
      const edited = newFile || editor.changed();
      // A cropped image is already centred on the chosen point.
      const focus = editor.state.ratio ? { x: 50, y: 50 } : editor.state.focus;
      if (edited)
        await sendPhoto(
          `/admin/gallery/${id}/replace`,
          { returnTo: 'gallery', ...(newFile ? {} : { edited: '1' }) },
          await editor.blob(),
          (done) => imageStatus(`Uploading ${done}%`),
        );
      await post(`/admin/gallery/${id}/details`, {
        alt: form.elements.alt.value,
        styleId: form.elements.styleId.value
          ? Number(form.elements.styleId.value)
          : null,
        showOnStyle: form.elements.showOnStyle.checked,
        showInWork: form.elements.showInWork.checked,
        focus,
      });
      sessionStorage.setItem('owner-message', 'Photo saved.');
      before = snapshot();
      location.reload();
    } catch (error) {
      problem.textContent = error.message;
      problem.hidden = false;
      button.disabled = false;
      button.textContent = 'Save photo';
      imageStatus('');
    }
  });
  $('[data-window-remove]').addEventListener('click', () =>
    removePhotos([Number(current.dataset.photoId)]),
  );
  function stepPhoto(by) {
    if (dirty()) return toast('Save this photo first, or close it.');
    const items = navigable();
    const next = items[items.indexOf(current) + by];
    if (next) openPhoto(next);
  }
  for (const button of $$('[data-window-step]'))
    button.addEventListener('click', () =>
      stepPhoto(Number(button.dataset.windowStep)),
    );
  dialog.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') stepPhoto(-1);
    if (event.key === 'ArrowRight') stepPhoto(1);
  });
  dialog.addEventListener('close', () => {
    token++;
    $('[data-photo-edit]', current)?.focus({ preventScroll: true });
  });

  // Add photos
  const add = $('#photos-add');
  const addList = $('[data-add-list]');
  const addFiles = $('[data-add-files]');
  const addStyle = $('[data-add-style]');
  const uploadButton = $('[data-add-upload]');
  const addError = $('[data-add-error]');
  let rows = [],
    uploading = false;
  function showRows() {
    const waiting = rows.filter((row) => !row.done).length;
    uploadButton.disabled = uploading || !waiting;
    uploadButton.textContent = uploading
      ? 'Uploading…'
      : waiting
        ? `Upload ${waiting} ${waiting === 1 ? 'photo' : 'photos'}`
        : 'Upload photos';
    $('[data-add-all]').hidden = rows.length < 2;
  }
  function suggest(row) {
    const name = row.field.style.selectedOptions[0];
    if (row.field.style.value && (!row.field.alt.value || row.suggested)) {
      row.field.alt.value = `${name.textContent.trim()} hairstyle`;
      row.suggested = true;
    }
    row.field.onStyle.disabled = !row.field.style.value;
    if (!row.field.style.value) row.field.onStyle.checked = false;
  }
  async function addFile(file, styleId = '') {
    if (rows.length >= 30) {
      addError.textContent = 'Add up to 30 photos at a time.';
      addError.hidden = false;
      return;
    }
    const node = $('[data-add-row]').content.firstElementChild.cloneNode(true);
    const row = {
      node,
      name: file.name,
      editor: makeEditor($('[data-canvas]', node)),
      field: Object.fromEntries(
        $$('[data-field]', node).map((input) => [input.dataset.field, input]),
      ),
      status: $('[data-status]', node),
      progress: $('[data-progress]', node),
    };
    try {
      await row.editor.load(file);
    } catch {
      addError.textContent = `${file.name} is not a photo this page can read. Use JPEG, PNG, WebP or AVIF.`;
      addError.hidden = false;
      return;
    }
    $('[data-canvas]', node).setAttribute('aria-label', file.name);
    $('[data-canvas]', node).setAttribute('role', 'img');
    row.field.style.value = styleId || addStyle.value;
    row.field.onStyle.checked = Boolean(styleId);
    row.field.inWork.checked = !styleId;
    row.field.alt.addEventListener('input', () => (row.suggested = false));
    row.field.style.addEventListener('change', () => suggest(row));
    $('[data-rotate]', node).addEventListener('click', () =>
      row.editor.rotate(),
    );
    $('[data-crop]', node).addEventListener('change', (event) => {
      row.editor.state.ratio = Number(event.target.value) || 0;
      row.editor.draw();
    });
    $('[data-drop-row]', node).addEventListener('click', () => {
      if (uploading) return;
      rows = rows.filter((other) => other !== row);
      node.remove();
      showRows();
    });
    rows.push(row);
    suggest(row);
    addList.append(node);
    showRows();
  }
  let startStyle = '';
  async function addMany(files) {
    addError.hidden = true;
    for (const file of files) await addFile(file, startStyle);
  }
  function openAdd(styleId = '') {
    rows = [];
    startStyle = styleId;
    addList.replaceChildren();
    addFiles.value = '';
    addStyle.value = '';
    addError.hidden = true;
    showRows();
    add.showModal();
  }
  $('[data-photos-add]').addEventListener('click', () => openAdd());
  for (const button of $$('[data-add-style-photo]'))
    button.addEventListener('click', () =>
      openAdd(button.dataset.addStylePhoto),
    );
  addFiles.addEventListener('change', async () => {
    const files = [...addFiles.files];
    addFiles.value = '';
    await addMany(files);
  });
  const drop = $('[data-drop]');
  for (const name of ['dragover', 'dragleave', 'drop'])
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.toggle('is-over', name === 'dragover');
      if (name === 'drop' && !uploading) addMany(event.dataTransfer.files);
    });
  addStyle.addEventListener('change', () => {
    for (const row of rows.filter((item) => !item.done)) {
      row.field.style.value = addStyle.value;
      suggest(row);
    }
  });
  uploadButton.addEventListener('click', async () => {
    addError.hidden = true;
    const waiting = rows.filter((row) => !row.done);
    for (const row of waiting) {
      const problem =
        row.field.alt.value.trim().length < 3
          ? ['Describe this photo in a few words.', row.field.alt]
          : !row.field.onStyle.checked && !row.field.inWork.checked
            ? ['Choose Style page, Our Work or both.', row.field.inWork]
            : null;
      row.status.textContent = problem?.[0] || '';
      if (problem) {
        row.status.className = 'add-status is-error';
        return problem[1].focus();
      }
    }
    uploading = true;
    showRows();
    for (const row of waiting) {
      row.status.className = 'add-status';
      row.status.textContent = 'Preparing…';
      row.progress.hidden = false;
      row.progress.value = 0;
      try {
        await sendPhoto(
          '/admin/gallery/upload',
          {
            alt: row.field.alt.value.trim(),
            styleId: row.field.style.value,
            placementFields: '1',
            ...(row.field.onStyle.checked ? { showOnStyle: 'on' } : {}),
            ...(row.field.inWork.checked ? { showInWork: 'on' } : {}),
            sort: '9999',
            returnTo: 'gallery',
          },
          await row.editor.blob(),
          (done) => {
            row.progress.value = done;
            row.status.textContent =
              done < 100 ? `Uploading ${done}%` : 'Making website sizes…';
          },
        );
        row.done = true;
        row.status.textContent = 'Uploaded';
        row.node.classList.add('is-done');
      } catch (error) {
        row.status.className = 'add-status is-error';
        row.status.textContent = error.message;
      }
      row.progress.hidden = true;
    }
    uploading = false;
    showRows();
    const failed = rows.filter((row) => !row.done).length;
    if (!failed) {
      sessionStorage.setItem(
        'owner-message',
        `${rows.length} ${rows.length === 1 ? 'photo' : 'photos'} added.`,
      );
      location.reload();
    } else {
      addError.textContent = `${failed} did not upload. Press Upload to try again; the others are saved.`;
      addError.hidden = false;
    }
  });
  const closeAdd = () => {
    if (uploading) return toast('Wait for the upload to finish.');
    add.close();
    if (rows.some((row) => row.done)) location.reload();
  };
  for (const button of $$('[data-add-close]'))
    button.addEventListener('click', closeAdd);
  add.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeAdd();
  });
  addEventListener('beforeunload', (event) => {
    if (uploading) event.preventDefault();
  });

  // Our Work order
  const workList = $('[data-work-list]');
  const workSave = $('[data-work-save]');
  let dragged = null;
  const moved = () => (workSave.disabled = false);
  workList.addEventListener('dragstart', (event) => {
    dragged = event.target.closest('li');
    event.dataTransfer.effectAllowed = 'move';
  });
  workList.addEventListener('dragover', (event) => {
    const over = event.target.closest('li');
    if (!dragged || !over) return;
    event.preventDefault();
    if (over === dragged) return;
    const items = [...workList.children];
    if (items.indexOf(over) < items.indexOf(dragged)) over.before(dragged);
    else over.after(dragged);
    moved();
  });
  workList.addEventListener('drop', (event) => event.preventDefault());
  workList.addEventListener('dragend', () => (dragged = null));
  workList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-move]');
    if (!button) return;
    const item = button.closest('li');
    if (button.dataset.workMove === '-1')
      item.previousElementSibling?.before(item);
    else item.nextElementSibling?.after(item);
    moved();
    button.focus();
  });
  workSave.addEventListener('click', async () => {
    workSave.disabled = true;
    try {
      await post('/admin/gallery/work-order', {
        order: [...workList.children].map((item) => item.dataset.workKey),
      });
      toast('Our Work order saved.', true);
    } catch (error) {
      workSave.disabled = false;
      toast(error.message);
    }
  });

  showPicked();
  // Links from search and other pages land on the right card.
  const linked = /^#photo-\d+$/.test(location.hash) && $(location.hash);
  if (linked && !matches().includes(linked)) {
    view = linked.dataset.removed === 'yes' ? 'removed' : 'all';
    search.value = stylePick.value = '';
  }
  if (linked)
    pageNumber = Math.floor(matches().indexOf(linked) / PAGE_SIZE) + 1;
  showCards();
  if (linked)
    requestAnimationFrame(() => linked.scrollIntoView({ block: 'center' }));
})();
