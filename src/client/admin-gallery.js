const list = document.querySelector('[data-photo-list]');
if (list) {
  const cards = [...list.querySelectorAll('[data-photo-id]')];
  const search = document.querySelector('[data-library-search]');
  const style = document.querySelector('[data-library-style]');
  const tabs = [...document.querySelectorAll('[data-library-kind]')];
  const results = document.querySelector('[data-library-results]');
  let kind = 'all';
  const filter = () => {
    const term = search.value.trim().toLowerCase();
    let count = 0;
    for (const card of cards) {
      const data = card.dataset;
      const visible =
        (kind === 'all' ||
          kind === data.photoKind ||
          (kind === 'gallery' && data.photoWork === 'true')) &&
        (!style.value ||
          (style.value === 'untagged'
            ? !data.photoStyle
            : style.value === data.photoStyle)) &&
        `${data.photoName} ${data.photoAlt}`.toLowerCase().includes(term);
      card.hidden = !visible;
      if (visible) count++;
    }
    results.textContent = `${count} ${count === 1 ? 'photo' : 'photos'}${count !== cards.length ? ` of ${cards.length}` : ''}`;
    document.querySelector('[data-library-empty]').hidden = count !== 0;
    for (const tab of tabs)
      tab.setAttribute(
        'aria-pressed',
        String(tab.dataset.libraryKind === kind),
      );
  };
  search.addEventListener('input', filter);
  style.addEventListener('change', filter);
  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      kind = tab.dataset.libraryKind;
      filter();
    }),
  );

  const uploadDialog = document.querySelector('#library-upload-dialog');
  const uploadForm = document.querySelector('[data-gallery-upload-form]');
  const uploadPreview = document.querySelector('[data-gallery-upload-preview]');
  let previewUrl;
  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    uploadPreview.removeAttribute('src');
    uploadPreview.hidden = true;
  };
  const openUpload = (styleId = '', name = '') => {
    uploadForm.reset();
    clearPreview();
    uploadForm.querySelector('[data-owner-form-error]').hidden = true;
    uploadForm.elements.styleId.value = styleId;
    uploadForm.elements.showOnStyle.checked = !!styleId;
    uploadForm.elements.showInWork.checked = !styleId;
    uploadForm.elements.alt.value = name ? `${name} hairstyle` : '';
    uploadDialog.showModal();
    uploadForm.elements.photo.focus();
  };
  document
    .querySelector('[data-gallery-upload]')
    .addEventListener('click', () => openUpload());
  document.querySelectorAll('[data-add-style-photo]').forEach((button) => {
    button.addEventListener('click', () =>
      openUpload(button.dataset.addStylePhoto, button.dataset.styleName),
    );
  });
  uploadForm.elements.photo.addEventListener('change', () => {
    clearPreview();
    const file = uploadForm.elements.photo.files[0];
    if (file?.type.startsWith('image/')) {
      previewUrl = URL.createObjectURL(file);
      uploadPreview.src = previewUrl;
      uploadPreview.hidden = false;
    }
  });
  uploadDialog.addEventListener('close', clearPreview);

  const editDialog = document.querySelector('#library-edit-dialog');
  const edit = document.querySelector('[data-gallery-edit-form]');
  const replace = document.querySelector('[data-gallery-replace-form]');
  const remove = document.querySelector('[data-gallery-remove-form]');
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-photo-edit]');
    if (!button) return;
    const data = button.closest('[data-photo-id]').dataset;
    edit.reset();
    replace.reset();
    edit.action = `/admin/gallery/${data.photoId}`;
    replace.action = `/admin/gallery/${data.photoId}/replace`;
    remove.action = `/admin/gallery/${data.photoId}/remove`;
    edit.elements.alt.value = data.photoAlt;
    edit.elements.styleId.value = data.photoStyle;
    edit.elements.showOnStyle.checked = data.photoKind === 'style';
    edit.elements.showInWork.checked = data.photoWork === 'true';
    edit.elements.sort.value = data.photoSort;
    const preview = document.querySelector('[data-gallery-edit-preview]');
    preview.src = data.photoPath;
    preview.alt = data.photoAlt;
    editDialog.querySelectorAll('[data-owner-form-error]').forEach((box) => {
      box.hidden = true;
    });
    editDialog.showModal();
    edit.elements.alt.focus();
  });

  const toggle = document.querySelector('[data-photo-reorder-toggle]');
  const bar = document.querySelector('[data-library-order-bar]');
  let originalOrder;
  const reorderMode = (enabled) => {
    toggle.hidden = enabled;
    bar.hidden = !enabled;
    search.disabled = style.disabled = enabled;
    tabs.forEach((tab) => {
      tab.disabled = enabled;
    });
    for (const card of cards) {
      card.draggable = enabled;
      card.querySelector('.library-move').hidden = !enabled;
      card.querySelector('[data-photo-edit]').hidden = enabled;
    }
  };
  toggle.addEventListener('click', () => {
    originalOrder = [...list.children];
    search.value = style.value = '';
    kind = 'all';
    filter();
    reorderMode(true);
    bar.querySelector('button').focus();
  });
  document
    .querySelector('[data-photo-reorder-cancel]')
    .addEventListener('click', () => {
      for (const card of originalOrder) list.append(card);
      reorderMode(false);
      toggle.focus();
    });
  filter();
}
