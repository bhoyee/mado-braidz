import { Calendar } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
const element = document.querySelector('#owner-calendar');
const alertBox = document.querySelector('.owner-alert');
const dialog = document.querySelector('#owner-dialog');
if (element) {
  const calendar = new Calendar(element, {
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin, luxonPlugin],
    timeZone: 'America/New_York',
    initialView: window.innerWidth < 700 ? 'timeGridDay' : 'timeGridWeek',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,timeGridDay',
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
    allDaySlot: false,
    slotMinTime: '06:00:00',
    slotMaxTime: '21:00:00',
    slotDuration: '00:30:00',
    snapDuration: '00:30:00',
    height: 'auto',
    nowIndicator: true,
    editable: true,
    eventDurationEditable: false,
    eventDisplay: 'block',
    slotEventOverlap: false,
    events: '/admin/api/calendar',
    eventSourceFailure() {
      alertBox.textContent =
        'Unable to load appointments. Refresh or sign in again.';
      alertBox.hidden = false;
    },
    dateClick(info) {
      const local = info.dateStr;
      const query = new URLSearchParams({
        date: local.slice(0, 10),
        time: local.length > 10 ? local.slice(11, 16) : '09:00',
      });
      location.assign('/admin/bookings/new?' + query);
    },
    eventDrop(info) {
      dialog.querySelector('[data-move-summary]').textContent =
        `${info.event.title} · ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' }).format(info.event.start)} Eastern`;
      dialog.returnValue = 'cancel';
      dialog.showModal();
      dialog.addEventListener(
        'close',
        async () => {
          if (dialog.returnValue !== 'save') return info.revert();
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
            alertBox.textContent = 'Appointment moved.';
            alertBox.classList.add('owner-alert-success');
            alertBox.hidden = false;
          } catch (error) {
            info.revert();
            alertBox.classList.remove('owner-alert-success');
            alertBox.textContent = error.message;
            alertBox.hidden = false;
          }
        },
        { once: true },
      );
    },
  });
  calendar.render();
}
