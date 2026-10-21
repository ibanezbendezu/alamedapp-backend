import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { prayers } from '../db/schema.ts';
import { requireSubject } from './auth.ts';
import { apiHandler, HttpError } from './http.ts';
import { databaseOperation, readBody } from './handlers.ts';
import { creationKey, createPrayerOnce, normalizeCreation } from './prayerCreation.ts';

export type PrayerChanges = { title?: string | null; content?: string; color?: string; isAnswered?: boolean; audience?: 'friends' | 'public' };
const invalid = () => new HttpError(400, 'INVALID_PRAYER', 'Datos de oración no válidos.');
export function prayerId(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw invalid();
  return Number(value);
}
export function validatePrayer(value: unknown, create = false): PrayerChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (!keys.length || keys.some(k => !['title', 'content', 'color', 'isAnswered', 'audience'].includes(k))) throw invalid();
  if (create && typeof row.content !== 'string') throw invalid();
  if ('content' in row && (typeof row.content !== 'string' || !row.content.trim() || row.content.length > 10000)) throw invalid();
  if ('title' in row && row.title !== null && (typeof row.title !== 'string' || row.title.length > 200)) throw invalid();
  if ('color' in row && (typeof row.color !== 'string' || !/^(default|red|orange|yellow|green|teal|blue|darkBlue|purple|pink|brown|gray|#[0-9a-fA-F]{6})$/.test(row.color))) throw invalid();
  if ('isAnswered' in row && typeof row.isAnswered !== 'boolean') throw invalid();
  if ('audience' in row && !['friends', 'public'].includes(row.audience as string)) throw invalid();
  return { ...row } as PrayerChanges;
}
export function validateOrder(value: unknown): number[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'ids') throw invalid();
  const ids = (value as { ids: unknown }).ids;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 2147483647) || new Set(ids).size !== ids.length) throw invalid();
  return ids;
}
export function prayerDto(row: typeof prayers.$inferSelect) {
  return { id: row.id, userId: row.userId, title: row.title, content: row.content, color: row.color,
    position: row.position, isAnswered: row.isAnswered, audience: row.audience,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function visiblePrayers(subject: string, owner: string) {
  return sql`${prayers.userId} = ${owner} and (${prayers.userId} = ${subject} or ${prayers.audience} = 'public' or (
    ${prayers.audience} = 'friends' and exists(select 1 from follows where follower_id = ${subject} and following_id = ${owner})
    and exists(select 1 from follows where follower_id = ${owner} and following_id = ${subject})))`;
}
export function listPrayersQuery(subject: string, owner: string, cursor: number) {
  return getDb().select().from(prayers).where(and(visiblePrayers(subject, owner), gt(prayers.id, cursor)))
    .orderBy(asc(prayers.id)).limit(101);
}
export async function listPrayers(subject: string, owner: string, cursor: number) {
  return listPrayersQuery(subject, owner, cursor);
}
export async function insertPrayer(subject: string, changes: PrayerChanges) {
  const rows = await getDb().insert(prayers).values({ userId: subject, ...normalizeCreation(changes),
    position: sql`(select coalesce(max(position), -1) + 1 from prayers where user_id = ${subject})`,
  }).returning();
  return rows[0];
}
export async function patchPrayer(subject: string, id: number, changes: PrayerChanges) {
  return (await getDb().update(prayers).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(prayers.id, id), eq(prayers.userId, subject))).returning())[0];
}
export async function removePrayer(subject: string, id: number) {
  return (await getDb().delete(prayers).where(and(eq(prayers.id, id), eq(prayers.userId, subject))).returning())[0];
}
export function orderStatement(subject: string, ids: number[]) {
  // One statement: either the complete owned set matches or no rows are written.
  const payload = JSON.stringify(ids);
  return sql`with wanted as (select value::integer id, ordinality - 1 position
      from jsonb_array_elements_text(${payload}::jsonb) with ordinality),
    owned as materialized (select id from prayers where user_id = ${subject} for update),
    valid as (select 1 where (select count(*) from owned) = ${ids.length}
      and (select count(distinct id) from wanted) = ${ids.length}
      and not exists(select id from wanted except select id from owned)),
    changed as (update prayers p set position = w.position::integer, updated_at = now()
      from wanted w, valid where p.id = w.id and p.user_id = ${subject} returning p.id)
    select exists(select 1 from valid) as ok, (select count(*) from changed) as count`;
}
export async function orderPrayers(subject: string, ids: number[]) {
  const result = await getDb().execute(orderStatement(subject, ids));
  return result.rows[0]?.ok === true;
}
const repository = { list: listPrayers, insert: createPrayerOnce, patch: patchPrayer, remove: removePrayer, order: orderPrayers };
export function createPrayersHandler(action: 'list' | 'create' | 'patch' | 'delete' | 'order',
  target?: string, authenticate = requireSubject, repo = repository) {
  return apiHandler(async request => {
    const subject = await authenticate(request);
    if (process.env.PRAYERS_API_ENABLED !== 'true') throw new HttpError(503, 'PRAYERS_NOT_ACTIVE', 'El diario de oración aún no está disponible.');
    if (action === 'list') {
      const owner = target ?? subject;
      if (!owner || owner.length > 255 || !/^[\w-]+$/.test(owner)) throw invalid();
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(k => k !== 'cursor')) throw invalid();
      const raw = query.get('cursor') ?? '0';
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) throw invalid();
      const rows = await databaseOperation(() => repo.list(subject, owner, Number(raw)));
      return { data: { items: rows.slice(0, 100).map(prayerDto), nextCursor: rows.length > 100 ? rows[99].id : null } };
    }
    if (action === 'order') {
      let value; try { value = JSON.parse(await readBody(request, 65536)); } catch (e) { if (e instanceof HttpError) throw e; throw invalid(); }
      const ids = validateOrder(value);
      if (!await databaseOperation(() => repo.order(subject, ids))) throw new HttpError(409, 'ORDER_CONFLICT', 'El diario cambió. Actualiza e inténtalo de nuevo.');
      return { data: { ok: true } };
    }
    const id = action === 'create' ? undefined : prayerId(target ?? '');
    let row;
    if (action === 'delete') row = await databaseOperation(() => repo.remove(subject, id!));
    else {
      let value; try { value = JSON.parse(await readBody(request)); } catch (e) { if (e instanceof HttpError) throw e; throw invalid(); }
      const changes = validatePrayer(value, action === 'create');
      const key = action === 'create' ? creationKey(request.headers.get('Idempotency-Key')) : undefined;
      row = await databaseOperation(() => action === 'create' ? repo.insert(subject, changes, key!) : repo.patch(subject, id!, changes));
    }
    if (!row) throw new HttpError(404, 'PRAYER_NOT_FOUND', 'Oración no encontrada.');
    return { data: prayerDto(row) };
  });
}
