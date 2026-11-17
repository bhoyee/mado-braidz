import { BookingError } from './bookingErrors.js';

export async function verifyTurnstile(config, token, remoteip, action) {
  if (!config.TURNSTILE_ENABLED || !config.TURNSTILE_SECRET_KEY) return;
  const invalid = () =>
    new BookingError(
      'VERIFICATION_FAILED',
      'Please complete the security check and try again.',
    );
  if (typeof token !== 'string' || !token.trim() || token.length > 2048)
    throw invalid();
  let result;
  try {
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body: new URLSearchParams({
          secret: config.TURNSTILE_SECRET_KEY,
          response: token,
          ...(remoteip ? { remoteip } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.ok === false)
      throw new Error('Verification service unavailable');
    result = await response.json();
  } catch {
    throw new BookingError(
      'VERIFICATION_UNAVAILABLE',
      'Verification is temporarily unavailable. Please try again.',
      503,
    );
  }
  if (
    result?.success !== true ||
    result.hostname !== new URL(config.APP_URL).hostname ||
    result.action !== action
  )
    throw invalid();
}
