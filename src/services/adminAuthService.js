import argon2 from 'argon2';
import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { BookingError } from './bookingErrors.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)
    .map((part) => alphabet[parseInt(part, 2)])
    .join('');
}
export function totpCode(secret, step) {
  const bits = [...secret]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}
function matchingStep(secret, code, now, lastStep = -1) {
  if (!/^\d{6}$/.test(code || '')) return null;
  const step = Math.floor(now / 30000);
  for (const candidate of [step, step - 1, step + 1]) {
    if (
      candidate > (lastStep ?? -1) &&
      timingSafeEqual(
        Buffer.from(totpCode(secret, candidate)),
        Buffer.from(code),
      )
    )
      return candidate;
  }
  return null;
}
export function createAdminAuthService(
  repository,
  config,
  clock = () => Date.now(),
  deliver = null,
) {
  const key = createHash('sha256')
    .update(config.SESSION_SECRET + ':admin-totp')
    .digest();
  function encrypt(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((b) => b.toString('base64url'))
      .join('.');
  }
  function decrypt(value) {
    const [iv, tag, encrypted] = value
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
      'utf8',
    );
  }
  async function audit(tx, admin, action, ip) {
    await tx.audit({
      adminId: admin.id,
      entity: 'admin',
      entityId: admin.id,
      action,
      ip,
    });
  }
  async function sendReset(admin, url) {
    if (deliver) return deliver(admin.email, url);
    if (config.EMAIL_PROVIDER === 'resend' && config.RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.EMAIL_FROM,
          to: [admin.email],
          subject: 'Reset your Mado owner password',
          text: `Reset your password within 30 minutes:\n${url}\n\nIf you did not request this, ignore this message.`,
        }),
      });
      if (!response.ok) throw new Error('Owner password reset delivery failed');
      return;
    }
    if (config.NODE_ENV !== 'production') {
      await mkdir('tmp/admin', { recursive: true });
      await writeFile(
        'tmp/admin/password-reset.txt',
        `Local development only\n${url}\n`,
        { mode: 0o600 },
      );
      return;
    }
    throw new Error('Configure Resend to deliver owner password resets');
  }
  return {
    async login(email, password, code, ip) {
      const result = await repository.transaction(async (tx) => {
        const admin = await tx.adminByEmail(email.toLowerCase());
        if (!admin || admin.role !== 'owner') return null;
        const now = clock();
        if (admin.lockedUntil && admin.lockedUntil.getTime() > now) return null;
        let step = null;
        const passwordOk = await argon2
          .verify(admin.passwordHash, password)
          .catch(() => false);
        if (passwordOk && admin.totpSecret)
          step = matchingStep(
            decrypt(admin.totpSecret),
            code,
            now,
            admin.totpLastStep,
          );
        if (!passwordOk || (admin.totpSecret && step === null)) {
          const failures = admin.lockedUntil
            ? 1
            : (admin.failedAttempts || 0) + 1;
          await tx.saveAdmin(admin.id, {
            failedAttempts: failures,
            lockedUntil: failures >= 5 ? new Date(now + 15 * 60000) : null,
          });
          await audit(tx, admin, 'login_failed', ip);
          return null;
        }
        const previousLogin = admin.lastLoginAt;
        await tx.saveAdmin(admin.id, {
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(now),
          ...(step === null ? {} : { totpLastStep: step }),
        });
        await audit(tx, admin, 'login', ip);
        return {
          id: admin.id,
          version: admin.authVersion || 0,
          since: previousLogin?.toISOString() || new Date(now).toISOString(),
        };
      });
      if (!result)
        throw new BookingError(
          'LOGIN_FAILED',
          'Invalid sign-in details. After five failed attempts, wait 15 minutes.',
          401,
        );
      return result;
    },
    async authenticate(grant) {
      if (!grant || grant.expiresAt < clock()) return null;
      const admin = await repository.adminById(grant.id);
      return admin?.role === 'owner' &&
        (admin.authVersion || 0) === grant.version
        ? admin
        : null;
    },
    async requestReset(email, ip) {
      const token = randomBytes(32).toString('hex');
      const admin = await repository.transaction(async (tx) => {
        const row = await tx.adminByEmail(email.toLowerCase());
        if (!row || row.role !== 'owner') return null;
        await tx.saveAdmin(row.id, {
          resetTokenHash: digest(token),
          resetExpiresAt: new Date(clock() + 30 * 60000),
        });
        await audit(tx, row, 'password_reset_requested', ip);
        return row;
      });
      if (admin)
        await sendReset(
          admin,
          `${config.APP_URL.replace(/\/$/, '')}/admin/reset#${token}`,
        );
    },
    async resetPassword(token, password, ip) {
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      return repository.transaction(async (tx) => {
        const admin = await tx.adminByReset(digest(token));
        if (
          !admin ||
          admin.role !== 'owner' ||
          !admin.resetExpiresAt ||
          admin.resetExpiresAt.getTime() <= clock()
        )
          throw new BookingError(
            'INVALID_RESET',
            'This reset link has expired. Request another.',
            400,
          );
        await tx.saveAdmin(admin.id, {
          passwordHash: hash,
          resetTokenHash: null,
          resetExpiresAt: null,
          authVersion: (admin.authVersion || 0) + 1,
          failedAttempts: 0,
          lockedUntil: null,
        });
        await audit(tx, admin, 'password_reset', ip);
      });
    },
    async signOutEverywhere(id, ip) {
      await repository.transaction(async (tx) => {
        const admin = await tx.adminById(id);
        await tx.saveAdmin(id, { authVersion: (admin.authVersion || 0) + 1 });
        await audit(tx, admin, 'sign_out_everywhere', ip);
      });
    },
    async changeSecurity(id, password, input, ip) {
      return repository.transaction(async (tx) => {
        const admin = await tx.adminById(id);
        if (
          !admin ||
          admin.role !== 'owner' ||
          !(await argon2.verify(admin.passwordHash, password))
        )
          throw new BookingError(
            'INVALID_PASSWORD',
            'Incorrect current password.',
            400,
          );
        const patch = { authVersion: (admin.authVersion || 0) + 1 };
        if (input.action === 'password') {
          if (admin.totpSecret) {
            const step = matchingStep(
              decrypt(admin.totpSecret),
              input.code,
              clock(),
              admin.totpLastStep,
            );
            if (step === null)
              throw new BookingError(
                'INVALID_CODE',
                'Invalid authentication code.',
                400,
              );
            patch.totpLastStep = step;
          }
          patch.passwordHash = await argon2.hash(input.newPassword, {
            type: argon2.argon2id,
          });
        } else {
          if (input.action === 'enable' && admin.totpSecret)
            throw new BookingError(
              'TOTP_ENABLED',
              'Two-factor authentication is already enabled.',
              409,
            );
          const secret =
            input.action === 'enable'
              ? input.secret
              : admin.totpSecret && decrypt(admin.totpSecret);
          const step =
            secret &&
            matchingStep(
              secret,
              input.code,
              clock(),
              input.action === 'enable' ? -1 : admin.totpLastStep,
            );
          if (step === null || step === false || !secret)
            throw new BookingError(
              'INVALID_CODE',
              'Invalid authentication code.',
              400,
            );
          patch.totpSecret = input.action === 'enable' ? encrypt(secret) : null;
          patch.totpLastStep = input.action === 'enable' ? step : null;
        }
        await tx.saveAdmin(id, patch);
        await audit(tx, admin, `security_${input.action}`, ip);
      });
    },
  };
}
