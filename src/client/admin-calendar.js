import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';

const ZONE = 'America/New_York';
const INTERVAL = 15000;
const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const element = document.querySelector('#owner-calendar');
const dialog = document.querySelector('#owner-dialog');
const details = document.querySelector('#calendar-details');

function remembered(store, key) {
  try {
    return window[store].getItem(key);
  } catch {
    return null;
  }
}
function remember(store, key, value) {
  try {
    window[store].setItem(key, value);
  } catch {
    // The calendar works the same without browser storage.
  }
}
function toast(message, success = false) {
  window.dispatchEvent(
    new CustomEvent('owner-toast', { detail: { message, success } }),
  );
}
const hourText = (hour) => String(hour).padStart(2, '0') + ':00:00';
function localHour(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  return part('hour') + part('minute') / 60;
}

if (element) {
  const phone = window.innerWidth < 700;
  const status = document.querySelector('[data-calendar-status]');
  const cancelledSwitch = document.querySelector('[data-show-cancelled]');
  const weekly = JSON.parse(element.dataset.hours || '{}');
  const special = JSON.parse(element.dataset.special || '[]');
  const openDays = Object.values(weekly).filter((day) => !day.closed);
  const clock = (text) => Number(text.slice(0, 2)) + Number(text.slice(3)) / 60;
  const firstHour = openDays.length
    ? Math.floor(Math.min(...openDays.map((day) => clock(day.open))))
    : 8;
  const lastHour = openDays.length
    ? Math.ceil(Math.max(...openDays.map((day) => clock(day.close))))
    : 20;
  const businessHours = DAYS.flatMap((name, index) =>
    weekly[name] && !weekly[name].closed
      ? [
          {
            daysOfWeek: [index],
            startTime: weekly[name].open,
            endTime: weekly[name].close,
          },
        ]
      : [],
  );
  const views = ['listUpcoming', 'timeGridDay', 'timeGridWeek', 'dayGridMonth'];
  const savedView = remembered('sessionStorage', 'mado-calendar-view');
  const savedDate = remembered('sessionStorage', 'mado-calendar-date');
  let showCancelled =
    remembered('localStorage', 'mado-calendar-cancelled') === '1';
  let latest = '',
    range = null,
    dragging = false,
    moving = false,
    pressed = false,
    polling = false,
    stopped = false;
  cancelledSwitch.checked = showCancelled;

  const say = (text) => (status.textContent = text);
  const sayUpdated = () =>
    say(
      'Live · updated ' +
        new Intl.DateTimeFormat('en-US', {
          timeZone: ZONE,
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date()) +
        ' ET',
    );
  async function load(start, end) {
    const response = await fetch(
      '/admin/api/calendar?' + new URLSearchParams({ start, end }),
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    );
    if (response.redirected || response.status === 401) {
      stopped = true;
      say('Your session ended. Refresh to sign in again.');
      throw new Error('Your session ended. Refresh to sign in again.');
    }
    if (!response.ok)
      throw new Error('Unable to load appointments. Refresh to try again.');
    return response.text();
  }
  const isHidden = (item) =>
    !showCancelled &&
    ['cancelled', 'expired'].includes(item.extendedProps.status);

  // Show opening hours, but never hide an appointment outside them.
  function fitHours(items) {
    let first = firstHour,
      last = lastHour;
    for (const item of items) {
      if (item.extendedProps.block) continue;
      const start = localHour(item.start),
        end = localHour(item.end);
      first = Math.min(first, Math.floor(start));
      last = end <= start ? 24 : Math.max(last, Math.ceil(end));
    }
    for (const [name, hour] of [
      ['slotMinTime', first],
      ['slotMaxTime', last],
    ])
      if (calendar.getOption(name) !== hourText(hour))
        calendar.setOption(name, hourText(hour));
  }

  function openDetails(event) {
    const info = event.extendedProps;
    const set = (name, value) => {
      const field = details.querySelector(`[data-detail="${name}"]`);
      field.textContent = value;
      return field;
    };
    set('name', info.name);
    set('when', info.when);
    set('style', info.style);
    set('phone', info.phoneLabel || 'Not recorded');
    set('paid', info.paid);
    set('source', info.source);
    set('balance', info.balance).className = !info.open
      ? ''
      : info.owes
        ? 'pay-due'
        : 'pay-good';
    set('status', info.statusLabel).className =
      `owner-badge status-${info.review ? 'review' : info.status}`;
    const call = details.querySelector('[data-detail-call]');
    call.hidden = !info.phone;
    if (info.phone) call.href = 'tel:' + info.phone;
    const view = details.querySelector('[data-detail-view]');
    view.href = event.url + (info.review ? '#payment-review' : '');
    view.textContent = info.review ? 'Review payment' : 'View appointment';
    details.showModal();
  }
  details
    .querySelector('[data-detail-close]')
    .addEventListener('click', () => details.close());
  details.addEventListener('click', (event) => {
    if (event.target === details) details.close();
  });

  // An empty time: book it, or block it.
  const slot = document.querySelector('#calendar-slot');
  const slotForm = slot.querySelector('[data-slot-form]');
  const blocked = document.querySelector('#calendar-blocked');
  let slotDay = '',
    blockedId = null;
  for (const button of document.querySelectorAll('[data-slot-close]'))
    button.addEventListener('click', () => button.closest('dialog').close());
  const later = (time, limit) => {
    const [h, m] = time.split(':').map(Number);
    const next = `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return limit && next > limit ? limit : next;
  };
  function showSlotTimes() {
    const all = slotForm.elements.allDay.checked;
    slot.querySelector('[data-slot-times]').hidden = all;
    slotForm.elements.start.required = slotForm.elements.end.required = !all;
  }
  slotForm.elements.allDay.addEventListener('change', showSlotTimes);
  function openSlot(day, time, close) {
    slotDay = day;
    slotForm.reset();
    slotForm.elements.start.value = time;
    slotForm.elements.end.value = later(time, close);
    slot.querySelector('[data-slot-error]').hidden = true;
    slot.querySelector('[data-slot-title]').textContent =
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(`${day}T${time}:00Z`));
    slot.querySelector('[data-slot-book]').href =
      '/admin/bookings/new?' + new URLSearchParams({ date: day, time });
    showSlotTimes();
    slot.showModal();
  }
  function openBlocked(event) {
    const info = event.extendedProps;
    blockedId = info.blockId || null;
    blocked.querySelector('[data-blocked-title]').textContent = event.title;
    blocked.querySelector('[data-blocked-when]').textContent = info.special
      ? 'This is a special day. Change it in Time off.'
      : info.repeat
        ? `${info.when}. Part of a longer block; removing here opens only this day.`
        : info.when;
    blocked.querySelector('[data-blocked-remove]').hidden = !blockedId;
    blocked.querySelector('[data-blocked-error]').hidden = true;
    blocked.showModal();
  }
  async function save(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': document.querySelector('meta[name="csrf-token"]')
          .content,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to save.');
  }
  slotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = slotForm.querySelector('[type="submit"]');
    const problem = slot.querySelector('[data-slot-error]');
    if (button.disabled) return;
    button.disabled = true;
    problem.hidden = true;
    try {
      const all = slotForm.elements.allDay.checked;
      await save('/admin/availability/blocks', {
        date: slotDay,
        allDay: all,
        start: all ? '' : slotForm.elements.start.value,
        end: all ? '' : slotForm.elements.end.value,
        reason: slotForm.elements.reason.value,
        repeat: 'once',
      });
      slot.close();
      calendar.refetchEvents();
      toast('Time blocked.', true);
    } catch (error) {
      problem.textContent = error.message;
      problem.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  blocked
    .querySelector('[data-blocked-remove]')
    .addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const problem = blocked.querySelector('[data-blocked-error]');
      button.disabled = true;
      try {
        await save(`/admin/availability/blocks/${blockedId}/remove`, {
          series: false,
        });
        blocked.close();
        calendar.refetchEvents();
        toast('Block removed.', true);
      } catch (error) {
        problem.textContent = error.message;
        problem.hidden = false;
      } finally {
        button.disabled = false;
      }
    });

  const calendar = new Calendar(element, {
    plugins: [
      dayGridPlugin,
      timeGridPlugin,
      listPlugin,
      interactionPlugin,
      luxonPlugin,
    ],
    timeZone: ZONE,
    initialView: views.includes(savedView)
      ? savedView
      : phone
        ? 'listUpcoming'
        : 'timeGridWeek',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(savedDate || '')
      ? { initialDate: savedDate }
      : {}),
    views: {
      listUpcoming: { type: 'list', duration: { days: 7 }, buttonText: 'List' },
      dayGridMonth: { dayMaxEvents: phone ? 2 : 3 },
    },
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: phone
        ? 'listUpcoming,timeGridDay,dayGridMonth'
        : 'listUpcoming,timeGridDay,timeGridWeek,dayGridMonth',
    },
    buttonText: {
      prev: 'Previous',
      next: 'Next',
      today: 'Today',
      month: 'Month',
      week: 'Week',
      day: 'Day',
    },
    buttonIcons: false,
    navLinks: true,
    navLinkDayClick: 'timeGridDay',
    moreLinkClick: phone ? 'timeGridDay' : 'popover',
    moreLinkContent: ({ num }) => (phone ? `+${num}` : `+${num} more`),
    moreLinkDidMount({ el }) {
      el.setAttribute('role', 'button');
    },
    noEventsContent: 'No appointments in these seven days.',
    listDayFormat: { weekday: 'long', month: 'long', day: 'numeric' },
    listDaySideFormat: false,
    allDaySlot: false,
    businessHours,
    slotMinTime: hourText(firstHour),
    slotMaxTime: hourText(lastHour),
    slotDuration: '00:30:00',
    snapDuration: '00:30:00',
    height: 'auto',
    nowIndicator: true,
    editable: true,
    eventDurationEditable: false,
    eventDisplay: 'block',
    slotEventOverlap: false,
    eventMaxStack: 3,
    lazyFetching: false,
    async events(info, success, failure) {
      let items;
      try {
        const body = await load(info.startStr, info.endStr);
        latest = body;
        range = [info.startStr, info.endStr];
        items = JSON.parse(body).filter((item) => !isHidden(item));
      } catch (error) {
        toast(error.message);
        return failure(error);
      }
      const type = calendar.view?.type || '';
      const month = info.end - info.start > 8 * 86400000;
      success(
        items.map((item) =>
          // Month and list views show blocked time as an entry of its own.
          item.extendedProps.block && !month && type !== 'listUpcoming'
            ? { ...item, display: 'background' }
            : item,
        ),
      );
      sayUpdated();
      setTimeout(() => fitHours(items));
    },
    datesSet({ view }) {
      remember('sessionStorage', 'mado-calendar-view', view.type);
      remember(
        'sessionStorage',
        'mado-calendar-date',
        calendar.formatIso(calendar.getDate()).slice(0, 10),
      );
    },
    eventDidMount({ event, el }) {
      el.dataset.eventId = event.id;
      el.title = event.extendedProps.block
        ? event.title
        : `${event.title} · ${event.extendedProps.statusLabel}`;
    },
    eventContent({ event, timeText, view }) {
      const info = event.extendedProps;
      const list = view.type === 'listUpcoming';
      // The list draws its own link around this content.
      const box = document.createElement(list && event.url ? 'a' : 'div');
      if (list && event.url) box.href = event.url;
      box.className = 'calendar-entry';
      const add = (name, text) => {
        const line = document.createElement('span');
        line.className = 'calendar-entry-' + name;
        line.textContent = text;
        box.append(line);
      };
      if (info.block) {
        add('name', event.title);
        return { domNodes: [box] };
      }
      if (!list) add('time', timeText);
      add('name', info.name);
      if (view.type !== 'dayGridMonth') add('style', info.style);
      if (info.review || info.status !== 'confirmed')
        add('note', info.statusLabel);
      if (list && info.open)
        add(
          info.owes ? 'owed' : 'paid',
          info.owes ? `Balance ${info.balance}` : 'Paid in full',
        );
      return { domNodes: [box] };
    },
    eventClick(info) {
      const click = info.jsEvent;
      if (click.ctrlKey || click.metaKey || click.shiftKey) return;
      click.preventDefault();
      if (info.event.extendedProps.block) openBlocked(info.event);
      else openDetails(info.event);
    },
    dateClick(info) {
      const day = info.dateStr.slice(0, 10);
      const timed = info.dateStr.length > 10;
      const hours =
        weekly[DAYS[new Date(day + 'T00:00:00Z').getUTCDay()]] || null;
      const now = new Date();
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
      if (day < today || (timed && info.date < now))
        return toast('That time has passed. Choose a later one.');
      if (timed) {
        const covering = calendar
          .getEvents()
          .find(
            (event) =>
              event.extendedProps.block &&
              event.start <= info.date &&
              event.end > info.date,
          );
        if (covering) return openBlocked(covering);
      }
      const exception = special.find((item) => item.date === day);
      const open = exception || hours;
      if (!open || open.closed) return toast('The studio is closed that day.');
      openSlot(day, timed ? info.dateStr.slice(11, 16) : open.open, open.close);
    },
    eventDragStart() {
      dragging = true;
    },
    eventDragStop() {
      dragging = false;
    },
    eventDrop(info) {
      moving = true;
      dialog.querySelector('[data-move-summary]').textContent =
        `${info.event.title} · ${new Intl.DateTimeFormat('en-US', { timeZone: ZONE, dateStyle: 'long', timeStyle: 'short' }).format(info.event.start)} Eastern`;
      dialog.returnValue = 'cancel';
      dialog.showModal();
      dialog.addEventListener(
        'close',
        async () => {
          if (dialog.returnValue !== 'save') {
            moving = false;
            return info.revert();
          }
          try {
            const response = await fetch(
              `/admin/api/bookings/${info.event.id}/move`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  'x-csrf-token': document.querySelector(
                    'meta[name="csrf-token"]',
                  ).content,
                },
                body: JSON.stringify({
                  startAt: info.event.start.toISOString(),
                  expectedUpdatedAt: info.event.extendedProps.updatedAt,
                  notifyClient:
                    dialog.querySelector('[data-move-notify]').checked,
                  requestKey: crypto.randomUUID(),
                }),
              },
            );
            const result = await response.json();
            if (!response.ok)
              throw new Error(result.message || 'Unable to move appointment.');
            calendar.refetchEvents();
            toast('Appointment moved.', true);
          } catch (error) {
            info.revert();
            toast(error.message);
          } finally {
            moving = false;
          }
        },
        { once: true },
      );
    },
  });
  calendar.render();

  cancelledSwitch.addEventListener('change', () => {
    showCancelled = cancelledSwitch.checked;
    remember(
      'localStorage',
      'mado-calendar-cancelled',
      showCancelled ? '1' : '0',
    );
    calendar.refetchEvents();
  });

  // Redraw only when something changed, and never under the owner's hands.
  addEventListener('pointerdown', () => (pressed = true));
  for (const name of ['pointerup', 'pointercancel', 'blur'])
    addEventListener(name, () => (pressed = false));
  const busy = () =>
    pressed ||
    dragging ||
    moving ||
    Boolean(document.querySelector('dialog[open], .fc-popover'));
  async function refresh() {
    if (polling || stopped || document.hidden || busy() || !range) return;
    polling = true;
    const asked = range;
    try {
      const body = await load(...asked);
      if (range !== asked || busy()) return;
      if (body !== latest) {
        const focused =
          document.activeElement?.closest('[data-event-id]')?.dataset.eventId;
        calendar.refetchEvents();
        if (focused)
          setTimeout(() => {
            const entry = element.querySelector(
              `[data-event-id="${CSS.escape(focused)}"]`,
            );
            (entry?.matches('a') ? entry : entry?.querySelector('a'))?.focus({
              preventScroll: true,
            });
          }, 600);
      }
      sayUpdated();
    } catch {
      if (!stopped) say('Reconnecting…');
    } finally {
      polling = false;
    }
  }
  setInterval(refresh, INTERVAL);
  document.addEventListener('visibilitychange', refresh);
  addEventListener('online', refresh);
  addEventListener('pageshow', (event) => {
    if (event.persisted) refresh();
  });
}
