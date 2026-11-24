// The Notifications page. Clicks are handled on the document because the live
// refresh replaces parts of the page.
(() => {
  const post = async (url, body = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')
          .content,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Please try again.');
    return data;
  };
  const refresh = () => document.dispatchEvent(new Event('visibilitychange'));
  let undoBar;
  function offerUndo(ids) {
    undoBar?.remove();
    undoBar = document.createElement('div');
    undoBar.className = 'alert-undo';
    undoBar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = `${ids.length} marked as read.`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Undo';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await post('/admin/notifications/unread', { ids });
        undoBar.remove();
        refresh();
      } catch (error) {
        text.textContent = error.message;
        button.disabled = false;
      }
    });
    undoBar.append(text, button);
    document.querySelector('[data-live="feed"]').before(undoBar);
    setTimeout(() => undoBar?.isConnected && undoBar.remove(), 20000);
  }
  document.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-alert-id][data-unread]');
    if (row) {
      fetch('/admin/notifications/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')
            .content,
        },
        body: JSON.stringify({ id: Number(row.dataset.alertId) }),
        keepalive: true,
      }).catch(() => {});
      return;
    }
    const all = event.target.closest('[data-mark-all]');
    const action = event.target.closest('[data-alert-post]');
    const button = all || action;
    if (!button) return;
    button.disabled = true;
    try {
      const data = await post(
        all ? '/admin/notifications/read' : action.dataset.alertPost,
      );
      if (all) {
        button.disabled = false;
        if (data.ids.length) offerUndo(data.ids);
        refresh();
      } else {
        sessionStorage.setItem('owner-message', data.message);
        location.reload();
      }
    } catch (error) {
      button.disabled = false;
      window.toast(error.message);
    }
  });
})();
