// Client list search and client notes. Scoped, because page scripts share names.
(() => {
  const form = document.querySelector('[data-client-filters]');
  if (form) {
    const status = document.querySelector('[data-client-status]');
    const search = form.elements.search;
    let timer,
      controller,
      version = 0;
    form.querySelector('[data-client-submit]').hidden = true;
    async function find() {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const asked = ++version;
      const url = new URL(form.action || location.href);
      url.search = new URLSearchParams(new FormData(form)).toString();
      const results = document.querySelector('[data-client-results]');
      results.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'text/html' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Unable to search. Try again.');
        const page = new DOMParser().parseFromString(
          await response.text(),
          'text/html',
        );
        const next = page.querySelector('[data-client-results]');
        if (asked !== version) return;
        if (!next) throw new Error('Refresh and sign in again.');
        results.replaceWith(document.importNode(next, true));
        history.replaceState(null, '', url);
        const count = next.querySelectorAll('.client-row').length;
        status.textContent = search.value.trim()
          ? `${count || 'No'} ${count === 1 ? 'client' : 'clients'} shown.`
          : '';
      } catch (error) {
        if (error.name !== 'AbortError' && asked === version) {
          status.textContent = error.message;
          results.removeAttribute('aria-busy');
        }
      }
    }
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(find, 300);
    });
    form.elements.sort.addEventListener('change', find);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      find();
    });
  }

  // "Scroll for more" shows only while there is more below.
  for (const hint of document.querySelectorAll('[data-scroll-hint]')) {
    const box = hint.previousElementSibling;
    if (!box.matches('.client-scroll')) continue;
    const show = () =>
      (hint.hidden = box.scrollHeight - box.clientHeight - box.scrollTop < 12);
    box.addEventListener('scroll', show, { passive: true });
    addEventListener('resize', show);
    hint.addEventListener('click', () =>
      box.scrollBy({
        top: box.clientHeight * 0.8,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      }),
    );
    show();
  }

  const notes = document.querySelector('[data-client-notes]');
  if (notes) {
    const field = notes.querySelector('[data-tags-field]');
    const list = notes.querySelector('.client-tag-pick > div');
    const added = notes.querySelector('[data-tag-new]');
    const collect = () =>
      (field.value = JSON.stringify(
        [...notes.querySelectorAll('[data-tag]:checked')].map((i) => i.value),
      ));
    function addTag() {
      const value = added.value.trim().replace(/\s+/g, ' ');
      if (!value) return;
      const same = [...notes.querySelectorAll('[data-tag]')].find(
        (input) => input.value.toLowerCase() === value.toLowerCase(),
      );
      if (same) same.checked = true;
      else {
        const label = document.createElement('label');
        label.className = 'pick';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.tag = '';
        input.value = value;
        input.checked = true;
        const text = document.createElement('span');
        text.textContent = value;
        label.append(input, text);
        list.append(label);
      }
      added.value = '';
      collect();
    }
    notes.addEventListener('change', collect);
    added.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addTag();
    });
    added.addEventListener('blur', addTag);
  }
})();
