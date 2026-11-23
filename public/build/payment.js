const result = document.querySelector('[data-payment-result]');
const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    n / 100,
  );
if (result) {
  const heading = document.getElementById('payment-heading'),
    message = document.getElementById('payment-message');
  let checks = 0;
  const started = Date.now();
  const showActions = (retry = true) => {
    document.getElementById('payment-retry').hidden = !retry;
    document.getElementById('payment-actions').hidden = false;
  };
  const setPending = (pending) => {
    try {
      if (pending)
        sessionStorage.setItem('mado-payment-pending', result.dataset.session);
      else if (
        sessionStorage.getItem('mado-payment-pending') ===
        result.dataset.session
      )
        sessionStorage.removeItem('mado-payment-pending');
    } catch {
      /* storage is optional */
    }
  };
  document.getElementById('payment-retry').href = location.href;
  // Stripe has finished with this checkout, so the next booking starts clean.
  if (result.dataset.session) {
    try {
      sessionStorage.removeItem('mado-booking');
      sessionStorage.removeItem('mado-checkout-request');
    } catch {
      /* storage is optional */
    }
  }
  async function poll() {
    try {
      const response = await fetch(
        '/api/bookings/payment-status?session_id=' +
          encodeURIComponent(result.dataset.session),
      );
      if (!response.ok)
        throw new Error(
          'We could not verify this payment. Please open your original booking link or call the studio.',
        );
      const data = await response.json();
      if (data.status === 'confirmed' || data.status === 'completed') {
        result.dataset.state = 'confirmed';
        setPending(false);
        document.getElementById('payment-actions').hidden = true;
        heading.textContent = 'Your chair is booked.';
        message.textContent =
          'Payment received. We look forward to seeing you.';
        document.getElementById('payment-details').hidden = false;
        document.getElementById('payment-style').textContent = data.styleName;
        document.getElementById('payment-time').textContent =
          new Date(data.startAt).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'long',
            timeStyle: 'short',
          }) + ' Eastern';
        document.getElementById('payment-reference').textContent = data.ref;
        document.getElementById('payment-paid').textContent = money(
          data.paidCents,
        );
        document.getElementById('payment-balance').textContent =
          data.balanceCents === null
            ? 'Agreed at consultation'
            : money(data.balanceCents);
        document.getElementById('payment-manage').href = data.manageUrl;
        const stamp = (v) =>
          new Date(v)
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}Z$/, 'Z');
        const ics = [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'PRODID:-//Mado African Braids//Appointments//EN',
          'BEGIN:VEVENT',
          `UID:${data.ref}@madoafricanbraidz.com`,
          `DTSTAMP:${stamp(new Date())}`,
          `DTSTART:${stamp(data.startAt)}`,
          `DTEND:${stamp(data.endAt)}`,
          'SUMMARY:Mado African Braids appointment',
          'LOCATION:7375 Executive Place\\, Lanham MD 20706',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n');
        document.getElementById('payment-calendar').href = URL.createObjectURL(
          new Blob([ics], { type: 'text/calendar' }),
        );
        return;
      }
      if (data.status === 'payment_conflict') {
        heading.textContent = 'Let’s find another time.';
        setPending(false);
        showActions(false);
        message.textContent =
          data.paymentStatus === 'refunded'
            ? 'Your payment was refunded because the time was no longer available. Please choose another appointment.'
            : 'Your payment could not secure this time. A refund is being processed; please call the studio.';
        return;
      }
      if (['expired', 'cancelled'].includes(data.status)) {
        heading.textContent = 'This hold has ended.';
        setPending(true);
        showActions();
        message.textContent =
          'If you completed payment, confirmation may still arrive. Please call the studio before paying again.';
        return;
      }
      setPending(true);
      if (++checks < 30 && Date.now() - started < 60000) setTimeout(poll, 2000);
      else {
        message.textContent =
          'This is taking longer than usual. Please don’t pay again for this visit. Call the studio if confirmation does not arrive.';
        showActions();
        // Keep checking quietly in case confirmation arrives late.
        if (checks < 90) setTimeout(poll, 10000);
      }
    } catch (error) {
      heading.textContent = 'Let’s check your appointment.';
      message.textContent = error.message;
      showActions();
    }
  }
  if (result.dataset.session) poll();
  else {
    heading.textContent = 'Payment link missing.';
    message.textContent = 'Return from Stripe or call the studio for help.';
  }
}
const balance = document.querySelector('[data-balance-form]');
if (balance)
  balance.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = balance.querySelector('button'),
      error = balance.querySelector('[role=alert]');
    button.disabled = true;
    error.hidden = true;
    try {
      const response = await fetch(
        `/api/bookings/${balance.dataset.ref}/balance`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': balance.dataset.csrf,
          },
          body: '{}',
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.message || 'Payment is unavailable.');
      location.assign(data.url);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      button.disabled = false;
    }
  });
for (const form of document.querySelectorAll(
  '[data-proof-form], [data-initial-checkout]',
)) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button'),
      error = form.querySelector('[role="alert"]');
    button.disabled = true;
    error.hidden = true;
    try {
      const proof = form.hasAttribute('data-proof-form');
      const response = await fetch(
        `/api/bookings/${form.dataset.ref}/${proof ? 'proof' : 'checkout'}`,
        {
          method: 'POST',
          headers: {
            'x-csrf-token': form.dataset.csrf,
            ...(!proof ? { 'content-type': 'application/json' } : {}),
          },
          body: proof ? new FormData(form) : '{}',
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Please try again.');
      location.assign(data.url);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      button.disabled = false;
    }
  });
}
