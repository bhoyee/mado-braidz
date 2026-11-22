const search = document.querySelector('[data-owner-search]');
if (search) {
  const input = search.querySelector('[data-owner-search-input]'),
    popup = search.querySelector('[data-owner-search-popup]'),
    list = search.querySelector('[data-owner-search-results]'),
    status = search.querySelector('[data-owner-search-status]');
  let timer,
    controller,
    version = 0,
    active = -1,
    options = [];
  const close = () => {
    version++;
    clearTimeout(timer);
    controller?.abort();
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const select = (index) => {
    active = index;
    options.forEach((option, i) =>
      option.setAttribute('aria-selected', String(i === active)),
    );
    if (options[active]) {
      input.setAttribute('aria-activedescendant', options[active].id);
      options[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const lookup = () => {
    const query = input.value.trim();
    version++;
    const request = version;
    clearTimeout(timer);
    controller?.abort();
    options = [];
    active = -1;
    list.replaceChildren();
    list.hidden = true;
    input.removeAttribute('aria-activedescendant');
    if (query.length < 2) {
      close();
      return;
    }
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = 'Searching…';
    status.classList.remove('is-error');
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const response = await fetch(
          '/admin/api/search?' + new URLSearchParams({ q: query }),
          {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (request !== version) return;
        if (response.status === 401) {
          status.textContent = 'Sign in again to search. ';
          const link = document.createElement('a');
          link.href = '/admin/login';
          link.textContent = 'Sign in';
          status.append(link);
          return;
        }
        if (
          !response.ok ||
          !response.headers.get('content-type')?.includes('application/json')
        )
          throw Error('Unable to search. Try again shortly.');
        const data = await response.json();
        if (request !== version) return;
        for (const group of data.groups) {
          const section = document.createElement('div');
          section.setAttribute('role', 'group');
          section.setAttribute('aria-label', group.label);
          const heading = document.createElement('div');
          heading.className = 'owner-search-group';
          heading.textContent = group.label;
          heading.setAttribute('aria-hidden', 'true');
          section.append(heading);
          for (const result of group.items) {
            if (!result.href.startsWith('/admin')) continue;
            const option = document.createElement('a');
            option.href = result.href;
            option.id = 'owner-search-option-' + options.length;
            option.className = 'owner-search-result';
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.tabIndex = -1;
            const title = document.createElement('strong'),
              detail = document.createElement('span');
            title.textContent = result.title;
            detail.textContent = result.description;
            option.append(title, detail);
            const index = options.length;
            option.addEventListener('pointermove', () => select(index));
            section.append(option);
            options.push(option);
          }
          list.append(section);
        }
        status.textContent = options.length
          ? `${options.length} ${options.length === 1 ? 'result' : 'results'}`
          : 'No results found';
        list.hidden = options.length === 0;
      } catch (error) {
        if (error.name !== 'AbortError' && request === version) {
          status.textContent = 'Unable to search. Try again shortly.';
          status.classList.add('is-error');
        }
      }
    }, 250);
  };
  input.addEventListener('input', lookup);
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) lookup();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key === 'Tab') {
      close();
      return;
    }
    if (popup.hidden) return;
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      select((active + 1) % options.length);
    }
    if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      select(active <= 0 ? options.length - 1 : active - 1);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      (options[active] || options[0])?.click();
    }
  });
  document.addEventListener('click', (event) => {
    if (!search.contains(event.target)) close();
  });
}
const anchored = document.getElementById(location.hash.slice(1));
if (anchored instanceof HTMLDetailsElement) anchored.open = true;
