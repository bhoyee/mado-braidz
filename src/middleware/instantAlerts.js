// Sends owner alerts soon after a change instead of waiting for the timer, which
// stays as the backup. Nothing here can delay or fail the request itself.
export function instantAlerts(service, log = () => {}, delay = 700) {
  let timer = null,
    running = false,
    again = false;
  async function deliver(attempt = 0) {
    if (running) {
      again = true;
      return;
    }
    running = true;
    let sent = true;
    try {
      sent = await service.deliverAlerts();
    } catch (error) {
      log(error);
    } finally {
      running = false;
    }
    // The timer holds the lock: it may already have passed the alerts step.
    if (sent === false && attempt < 2)
      setTimeout(() => deliver(attempt + 1), 4000).unref();
    if (again) {
      again = false;
      schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(deliver, delay);
    timer.unref();
  }
  return (req, res, next) => {
    if (req.method === 'POST')
      res.on('finish', () => {
        if (res.statusCode < 400) schedule();
      });
    next();
  };
}
