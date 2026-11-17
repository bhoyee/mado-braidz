import { randomBytes } from 'node:crypto';

// A public payment lookup grants payment actions only, never the private
// appointment-management link. Grants are tied to this browser session.
export function paymentToken(req, ref) {
  const grant = req.session.paymentAccess?.[ref];
  return (
    req.session.bookingAccess?.[ref] ||
    (grant?.expiresAt > Date.now() ? grant.token : undefined)
  );
}
export function paymentPageUrl(req, ref) {
  if (req.session.bookingAccess?.[ref])
    return '/booking/' + req.session.bookingAccess[ref];
  const grant = req.session.paymentAccess?.[ref];
  return grant?.expiresAt > Date.now()
    ? '/pay/appointment/' + grant.key
    : '/pay';
}
export function grantPaymentAccess(req, ref, token) {
  if (req.session.paymentAccess?.[ref]?.expiresAt > Date.now())
    return paymentPageUrl(req, ref);
  const active = Object.entries(req.session.paymentAccess || {}).filter(
    ([, grant]) => grant.expiresAt > Date.now(),
  );
  req.session.paymentAccess = Object.fromEntries(active);
  req.session.paymentAccess[ref] = {
    key: randomBytes(24).toString('hex'),
    token,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  return paymentPageUrl(req, ref);
}
