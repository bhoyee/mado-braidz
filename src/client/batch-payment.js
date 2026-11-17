const dollars = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    value / 100,
  );
async function post(url, csrf) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: '{}',
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.message || 'Please try again shortly.');
  return data;
}
const form = document.querySelector('[data-pay-all]');
if (form)
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button'),
      error = form.querySelector('[role="alert"]');
    button.disabled = true;
    error.hidden = true;
    try {
      const result = await post('/api/pay/all', form.dataset.csrf);
      location.assign(result.url);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      button.disabled = false;
    }
  });
const result = document.querySelector('[data-batch-result]');
if (result) {
  const heading = document.getElementById('batch-heading'),
    message = document.getElementById('batch-message');
  let checks = 0;
  const started = Date.now();
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  async function poll() {
    try {
      const response = await fetch(
        '/api/pay/batch-status?session_id=' +
          encodeURIComponent(result.dataset.session),
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.message || 'Please call the studio to check this payment.',
        );
      if (data.status === 'paid') {
        const attention = data.entries.some(
          (entry) =>
            entry.refundPending ||
            entry.status === 'payment_conflict' ||
            !['confirmed', 'completed'].includes(entry.status),
        );
        heading.textContent = attention
          ? 'Your payment needs attention.'
          : 'Your payments are confirmed.';
        message.textContent = attention
          ? 'Payment received. Check each appointment below for any refund or follow-up.'
          : 'One payment, all recorded. Your appointment details are below.';
        document.getElementById('batch-details').hidden = false;
        document.getElementById('batch-total').textContent =
          dollars(data.totalCents) + ' paid';
        document.getElementById('batch-refund').textContent = data.refundedCents
          ? dollars(data.refundedCents) + ' refunded'
          : '';
        const entries = document.getElementById('batch-entries');
        entries.replaceChildren();
        for (const entry of data.entries) {
          const card = element('article', '', 'pay-found batch-entry');
          const reference = element('div', '', 'appointment-reference');
          reference.append(
            element('span', 'Booking reference'),
            element('strong', entry.ref),
          );
          card.append(
            reference,
            element('h2', entry.styleName),
            element(
              'p',
              new Date(entry.startAt).toLocaleString('en-US', {
                timeZone: 'America/New_York',
                dateStyle: 'long',
                timeStyle: 'short',
              }) + ' Eastern',
            ),
          );
          card.append(element('p', 'Payment: ' + dollars(entry.amountCents)));
          if (entry.refundedCents)
            card.append(
              element('p', 'Refunded: ' + dollars(entry.refundedCents)),
            );
          if (entry.refundPending)
            card.append(
              element('p', 'Refund being processed. Please call the studio.'),
            );
          else if (entry.status === 'payment_conflict')
            card.append(
              element(
                'p',
                'This appointment could not be confirmed. Please call the studio.',
              ),
            );
          else
            card.append(
              element(
                'p',
                'Remaining balance: ' +
                  (entry.balanceCents === null
                    ? 'Agreed at consultation'
                    : dollars(entry.balanceCents)),
              ),
            );
          const link = element('a', 'View payment details', 'text-link');
          link.href = entry.url;
          card.append(link);
          entries.append(card);
        }
        return;
      }
      if (data.status === 'expired') {
        heading.textContent = 'This checkout has ended.';
        message.textContent =
          'No appointments were confirmed by this checkout. If you paid, call the studio before paying again.';
        return;
      }
      if (++checks < 30 && Date.now() - started < 60000) setTimeout(poll, 2000);
      else
        message.textContent =
          'Your payment is still being checked. Please call the studio before paying again.';
    } catch (e) {
      heading.textContent = 'Let’s check your payments.';
      message.textContent = e.message;
    }
  }
  if (result.dataset.cancel === 'true')
    post(
      '/api/pay/all/' + result.dataset.batchId + '/cancel',
      result.dataset.csrf,
    )
      .then((data) => location.assign(data.url))
      .catch((e) => (message.textContent = e.message));
  else if (result.dataset.session) poll();
  else {
    heading.textContent = 'Payment link missing.';
    message.textContent = 'Return from Stripe or call the studio for help.';
  }
}
