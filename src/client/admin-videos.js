const videoPanel = document.querySelector('#library-videos');
if (videoPanel) {
  const buttons = [...document.querySelectorAll('[data-library-panel]')];
  const show = (mode) => {
    document.querySelector('#library-photos').hidden = mode === 'videos';
    document.querySelectorAll('[data-library-photo-only]').forEach((el) => {
      el.hidden = mode === 'videos';
    });
    videoPanel.hidden = mode !== 'videos';
    if (mode !== 'videos')
      videoPanel.querySelectorAll('video').forEach((v) => v.pause());
    buttons.forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.libraryPanel === mode)),
    );
  };
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      show(b.dataset.libraryPanel);
      history.replaceState(
        null,
        '',
        b.dataset.libraryPanel === 'videos' ? '#videos' : location.pathname,
      );
    }),
  );
  show(
    location.hash === '#videos' || location.hash.startsWith('#video-')
      ? 'videos'
      : 'photos',
  );
  if (location.hash.startsWith('#video-'))
    requestAnimationFrame(() =>
      document
        .getElementById(location.hash.slice(1))
        ?.scrollIntoView({ block: 'center' }),
    );
  const editDialog = document.querySelector('#library-video-edit'),
    edit = document.querySelector('[data-video-edit-form]');
  videoPanel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-manage-video]');
    if (!button) return;
    const data = button.closest('[data-video-id]').dataset;
    edit.action = '/admin/gallery/videos/' + data.videoId;
    edit.elements.title.value = data.videoTitle;
    edit.elements.description.value = data.videoDescription;
    edit.elements.enabled.checked = data.videoEnabled === 'true';
    edit.elements.showInWork.checked = data.videoWork === 'true';
    edit.querySelector('[data-owner-form-error]').hidden = true;
    videoPanel.querySelectorAll('video').forEach((v) => v.pause());
    editDialog.showModal();
    edit.elements.title.focus();
  });
  const dialog = document.querySelector('#library-video-upload'),
    form = document.querySelector('[data-video-upload-form]'),
    preview = document.querySelector('[data-video-preview]');
  const file = form.elements.video,
    error = form.querySelector('[data-owner-form-error]'),
    submit = form.querySelector('[type=submit]');
  let url,
    token = 0;
  const clear = () => {
    token++;
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    preview.hidden = true;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  document
    .querySelector('[data-video-upload]')
    .addEventListener('click', () => {
      form.reset();
      clear();
      error.hidden = true;
      file.setCustomValidity('');
      submit.disabled = false;
      dialog.showModal();
      file.focus();
    });
  dialog.addEventListener('close', clear);
  file.addEventListener('change', () => {
    clear();
    error.hidden = true;
    file.setCustomValidity('');
    form.elements.poster.value = '';
    const selected = file.files[0];
    if (!selected) return;
    const current = token;
    const fail = (message) => {
      if (current !== token) return;
      error.textContent = message;
      error.hidden = false;
      file.setCustomValidity(message);
      submit.disabled = false;
    };
    if (selected.size > 30 * 1024 * 1024)
      return fail('Choose a video under 30 MB.');
    url = URL.createObjectURL(selected);
    preview.src = url;
    preview.preload = 'auto';
    preview.hidden = false;
    submit.disabled = true;
    let captured = false;
    const capture = () => {
      if (current !== token || captured || !preview.videoWidth) return;
      captured = true;
      const canvas = document.createElement('canvas'),
        scale = Math.min(1, 960 / preview.videoWidth);
      canvas.width = Math.round(preview.videoWidth * scale);
      canvas.height = Math.round(preview.videoHeight * scale);
      canvas
        .getContext('2d')
        .drawImage(preview, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (current !== token) return;
          if (blob && !form.elements.poster.files.length) {
            const transfer = new DataTransfer();
            transfer.items.add(
              new File([blob], 'video-cover.jpg', { type: 'image/jpeg' }),
            );
            form.elements.poster.files = transfer.files;
          }
          submit.disabled = false;
        },
        'image/jpeg',
        0.88,
      );
    };
    preview.onloadedmetadata = () => {
      if (current !== token) return;
      if (!Number.isFinite(preview.duration) || preview.duration > 60)
        return fail('Choose a video up to 60 seconds.');
      if (Math.max(preview.videoWidth, preview.videoHeight) > 1920)
        return fail('Choose a video up to 1080p.');
      preview.currentTime = Math.min(0.2, preview.duration / 2);
    };
    preview.onseeked = capture;
    preview.onerror = () => fail('Use an MP4 video in H.264 format.');
    preview.load();
  });
}
