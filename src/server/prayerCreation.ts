import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { prayerCreationRequests as receipts, prayers } from '../db/schema.ts';
import type { PrayerChanges } from './prayers.ts';
import { HttpError } from './http.ts';

export function creationKey(value: string | null) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Se requiere una clave de intento UUIDv4 válida.');
  }
  return value.toLowerCase();
}

export function normalizeCreation(changes: PrayerChanges) {
  // Same defaults as the previous insert; fixed property order gives a canonical digest.
  return { title: changes.title ?? null, content: changes.content!, color: changes.color ?? 'default',
    audience: changes.audience ?? 'friends', isAnswered: changes.isAnswered ?? false };
}
export function creationFingerprint(changes: PrayerChanges) {
  return createHash('sha256').update(JSON.stringify(normalizeCreation(changes))).digest('hex');
}

export async function createPrayerOnce(subject: string, changes: PrayerChanges, key: string, database = getDb) {
  const db = database();
  const value = normalizeCreation(changes);
  const fingerprint = creationFingerprint(changes);
  const owned = and(eq(receipts.userId, subject), eq(receipts.key, key));
  const results = await db.batch([
    // Even a replay takes the row lock. The following statement uses a fresh snapshot
    // after a competing transaction commits. Never overwrite the hash or linked ID.
    db.insert(receipts).values({ userId: subject, key, fingerprint }).onConflictDoUpdate({
      target: [receipts.userId, receipts.key], set: { key: sql`${receipts.key}` },
    }),
    db.execute(sql`with created as (
      insert into prayers (user_id, title, content, color, audience, is_answered, position)
      select ${subject}, ${value.title}, ${value.content}, ${value.color}, ${value.audience}, ${value.isAnswered},
        (select coalesce(max(position), -1) + 1 from prayers where user_id = ${subject})
      from prayer_creation_requests where user_id = ${subject} and key = ${key}
        and fingerprint = ${fingerprint} and prayer_id is null
      returning id
    ) update prayer_creation_requests set prayer_id = created.id from created
      where user_id = ${subject} and key = ${key}`),
    db.select({ fingerprint: receipts.fingerprint, prayer: prayers }).from(receipts)
      .leftJoin(prayers, and(eq(prayers.id, receipts.prayerId), eq(prayers.userId, subject))).where(owned),
  ]);
  const receipt = results[2][0];
  if (!receipt) throw new Error('Missing creation receipt');
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Este intento ya corresponde a otra oración.');
  if (!receipt.prayer) throw new HttpError(410, 'PRAYER_DELETED', 'La oración de este intento fue eliminada.');
  return receipt.prayer;
}
