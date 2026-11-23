import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../db/schema.js';

const ownerInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  name: z.string().trim().min(1).max(255),
});

// Adds one owner without changing any other account. Nobody knows the generated
// password; the new owner sets theirs through "Forgot password".
export async function addOwner(db, values) {
  const { email, name } = ownerInput.parse(values);
  const passwordHash = await argon2.hash(randomBytes(32).toString('hex'), {
    type: argon2.argon2id,
  });
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(s.admins)
      .where(eq(s.admins.email, email))
      .for('update');
    if (existing && existing.role !== 'owner')
      throw new Error('This email belongs to a non-owner account');
    if (existing) return { id: existing.id, email, created: false };
    const [result] = await tx.insert(s.admins).values({
      email,
      name,
      role: 'owner',
      passwordHash,
      createdAt: new Date(),
    });
    await tx.insert(s.auditLog).values({
      adminId: result.insertId,
      entity: 'admin',
      entityId: result.insertId,
      action: 'owner_added',
    });
    return { id: result.insertId, email, created: true };
  });
}
