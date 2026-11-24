(() => {
  const videoPanel = document.querySelector('#library-videos');
  if (videoPanel) {
    if (location.hash.startsWith('#video-'))
      requestAnimationFrame(() =>
        document
          .getElementById(location.hash.slice(1))
          ?.scrollIntoView({ block: 'center' }),
      );
    const say = (message, success = false) =>
      window.dispatchEvent(
        new CustomEvent('owner-toast', { detail: { message, success } }),
      );
    const videoToken = () =>
      document.querySelector('meta[name="csrf-token"]').content;
    async function result(response) {
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('Your session may have ended. Refresh and sign in.');
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.message || body.error || 'Unable to save.');
      return body;
    }
    videoPanel.addEventListener('change', async (event) => {
      const input = event.target.closest('[data-video-flag]');
      if (!input) return;
      const wanted = input.checked;
      input.disabled = true;
      const card = input.closest('[data-video-id]');
      try {
        await result(
          await fetch(`/admin/gallery/videos/${card.dataset.videoId}/flags`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'x-csrf-token': videoToken(),
            },
            body: JSON.stringify({ [input.dataset.videoFlag]: wanted }),
          }),
        );
        card.classList.toggle(
          'is-dim',
          !card.querySelector('[data-video-flag="enabled"]').checked,
        );
        say('Saved.', true);
      } catch (error) {
        input.checked = !wanted;
        say(error.message);
      } finally {
        input.disabled = false;
        input.focus({ preventScroll: true });
      }
    });
    const editDialog = document.querySelector('#library-video-edit'),
      edit = document.querySelector('[data-video-edit-form]'),
      editVideo = editDialog.querySelector('[data-edit-video]'),
      coverStatus = editDialog.querySelector('[data-cover-status]'),
      coverFile = editDialog.querySelector('[data-cover-file]'),
      frameButton = editDialog.querySelector('[data-use-frame]'),
      removeForm = editDialog.querySelector('[data-video-remove]');
    let editing = null;
    videoPanel.addEventListener('click', (event) => {
      const button = event.target.closest('[data-manage-video]');
      if (!button) return;
      const card = button.closest('[data-video-id]');
      const data = card.dataset;
      editing = data.videoId;
      edit.action = '/admin/gallery/videos/' + data.videoId;
      removeForm.action = edit.action + '/remove';
      removeForm.hidden = data.videoBuiltin === 'yes';
      editDialog.querySelector('[data-video-fixed]').hidden =
        data.videoBuiltin !== 'yes';
      edit.elements.title.value = data.videoTitle;
      edit.elements.description.value = data.videoDescription;
      for (const name of ['enabled', 'showInWork'])
        edit.elements[name].value = String(
          card.querySelector(`[data-video-flag="${name}"]`).checked,
        );
      edit.querySelector('[data-owner-form-error]').hidden = true;
      coverFile.value = '';
      coverStatus.textContent =
        'Pause the video where it looks best, then use that moment.';
      editVideo.poster = data.videoPoster;
      editVideo.src = data.videoSrc;
      editDialog.showModal();
      edit.elements.title.focus();
    });
    editDialog.addEventListener('close', () => {
      editVideo.pause();
      editVideo.removeAttribute('src');
      editVideo.load();
    });
    async function sendCover(blob) {
      frameButton.disabled = coverFile.disabled = true;
      coverStatus.textContent = 'Saving the cover…';
      try {
        const data = new FormData();
        data.set('photo', blob, 'cover.jpg');
        await result(
          await fetch(`/admin/gallery/videos/${editing}/cover`, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'x-csrf-token': videoToken(),
            },
            body: data,
          }),
        );
        sessionStorage.setItem('owner-message', 'Cover changed.');
        history.replaceState(null, '', '#video-' + editing);
        location.reload();
      } catch (error) {
        coverStatus.textContent = error.message;
        frameButton.disabled = coverFile.disabled = false;
      }
    }
    frameButton.addEventListener('click', () => {
      if (!editVideo.videoWidth || editVideo.readyState < 2) {
        coverStatus.textContent = 'Play the video, pause it, then try again.';
        return;
      }
      editVideo.pause();
      const canvas = document.createElement('canvas');
      canvas.width = editVideo.videoWidth;
      canvas.height = editVideo.videoHeight;
      canvas.getContext('2d').drawImage(editVideo, 0, 0);
      canvas.toBlob((blob) => blob && sendCover(blob), 'image/jpeg', 0.9);
    });
    coverFile.addEventListener('change', () => {
      const image = coverFile.files[0];
      if (!image) return;
      if (image.size > 8 * 1024 * 1024) {
        coverStatus.textContent = 'Choose an image under 8 MB.';
        return;
      }
      sendCover(image);
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
})();
