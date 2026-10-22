import { sql } from 'drizzle-orm';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { getDb } from '../db/index.ts';
import { requireSubject } from './auth.ts';
import { apiHandler, HttpError } from './http.ts';
import { databaseOperation, readBody } from './handlers.ts';
import { creationKey } from './prayerCreation.ts';
const scrypt = promisify(scryptCallback);
type Row = Record<string, unknown>;
export function amountString(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,2})?$/.test(value))
        throw new HttpError(400, 'INVALID_AMOUNT', 'Cantidad inválida. Usa hasta dos decimales.');
    const [whole, decimal = ''] = value.split('.');
    const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
    if (cents <= 0n || cents >= 100000000000000000000n)
        throw new HttpError(400, 'INVALID_AMOUNT', 'Cantidad fuera de rango.');
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export async function hashPin(pin: string) {
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(pin, salt, 64) as Buffer;
    return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function matchesPin(pin: string, encoded: string | null) {
    if (!encoded)
        return false;
    const [algorithm, salt, hash] = encoded.split(':');
    if (algorithm !== 'scrypt' || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash))
        return false;
    const key = await scrypt(pin, salt, 64) as Buffer;
    return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
const pinValue = (v: unknown) => { if (typeof v !== 'string' || !/^\d{6}$/.test(v))
    throw new HttpError(400, 'INVALID_PIN', 'El PIN debe tener seis dígitos.'); return v; };
const idValue = (v: unknown) => { if (typeof v !== 'string' || !v || v.length > 255)
    throw new HttpError(400, 'INVALID_ID', 'Identidad inválida.'); return v; };
const integer = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647)
    throw new HttpError(400, 'INVALID_ID', 'ID inválido.'); return n; };
export function checkResult<T>(value: T): T {
    const error = (value as {
        error?: string;
    })?.error;
    if (error)
        throw new HttpError(error === 'INVALID_PAIR' ? 400 : error === 'NOT_FOUND' ? 404 : error === 'PIN_LOCKED' ? 429 : error === 'INVALID_PIN' ? 403 : 409, error, error === 'PIN_LOCKED' ? 'Demasiados intentos. Espera 15 minutos.' : error === 'INVALID_PIN' ? 'PIN incorrecto.' : error === 'PIN_REQUIRED' ? 'Crea un PIN nuevo antes de transferir.' : 'No se pudo completar la operación.');
    return value;
}
async function rows(query: ReturnType<typeof sql>) { return (await getDb().execute(query)).rows as Row[]; }
async function result(query: ReturnType<typeof sql>) { return checkResult((await rows(query))[0]?.data); }
const publicFields = sql `u.clerk_id as "clerkId",u.username,u.display_name as "displayName",u.avatar_url as "avatarUrl",u.bio,u.favorite_verse as "favoriteVerse",u.follower_count as "followerCount",u.following_count as "followingCount",to_char(u.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;
const relationFields = (a: string) => sql `exists(select 1 from follows where follower_id=${a} and following_id=u.clerk_id) as "iFollow",
 exists(select 1 from follows where follower_id=u.clerk_id and following_id=${a}) as "theyFollow",
 exists(select 1 from streaks where is_active and least(user_a_id,user_b_id)=least(${a},u.clerk_id) and greatest(user_a_id,user_b_id)=greatest(${a},u.clerk_id)) as "hasActiveStreak",
 (select case when sender_id=${a} then 'pending_sent' else 'pending_received' end from streak_requests where status='pending' and least(sender_id,receiver_id)=least(${a},u.clerk_id) and greatest(sender_id,receiver_id)=greatest(${a},u.clerk_id)) as "streakRequestStatus",
 (select id from streak_requests where status='pending' and least(sender_id,receiver_id)=least(${a},u.clerk_id) and greatest(sender_id,receiver_id)=greatest(${a},u.clerk_id)) as "streakRequestId"`;
const streakFields = sql `s.id,api_streak_count(coalesce(s.last_stoked_at,s.last_interaction),s.count,clock_timestamp()) as count,
 s.is_active as "isActive",to_char(s.last_interaction,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastInteraction",to_char(s.last_stoked_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastStokedAt",to_char(s.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
 coalesce(timezone('America/Santiago',s.last_stoked_at at time zone 'UTC')::date=timezone('America/Santiago',clock_timestamp())::date,false) as "isAlreadyStokedToday",
 u.clerk_id as "friendId",u.display_name as "friendName",u.username as "friendUsername",u.avatar_url as "friendAvatar"`;
export async function communityOperation(a: string, op: string, body: Row, params: URLSearchParams, key: string | null) {
    const cursor = params.get('cursor') ?? '';
    const target = params.get('target');
    if (op === 'profile') {
        const b = idValue(target);
        const profile = (await rows(sql `select ${publicFields},${relationFields(a)} from users u where clerk_id=${b}`))[0];
        if (!profile)
            throw new HttpError(404, 'NOT_FOUND', 'Perfil no encontrado.');
        const medals = await rows(sql `select m.id,m.title,m.description,m.color,m.icon_name as "iconName",m.category,to_char(um.earned_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "earnedAt" from user_medals um join medals m on m.id=um.medal_id where um.user_id=${b} order by um.earned_at,m.id`);
        return { ...profile, medals };
    }
    if (op === 'search') {
        const q = (params.get('q') ?? '').trim();
        if (q.length > 100 || cursor.length > 255)
            throw new HttpError(400, 'INVALID_SEARCH', 'Búsqueda inválida.');
        const items = await rows(sql `select ${publicFields},${relationFields(a)} from users u where clerk_id<>${a} and clerk_id>${cursor}
 and (position(lower(${q}) in lower(username))>0 or position(lower(${q}) in lower(coalesce(display_name,'')))>0) order by clerk_id limit 50`);
        return { items, nextCursor: items.length === 50 ? items[49].clerkId : null };
    }
    if (op === 'follow')
        return result(sql `select api_follow(${a},${idValue(body.target)},${body.enabled}) data`);
    if (op === 'notifications') {
        const c = cursor ? integer(cursor) : 2147483647;
        const items = await rows(sql `select n.id,n.type,n.is_read as "isRead",to_char(n.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",json_build_object('clerkId',u.clerk_id,'username',u.username,'displayName',u.display_name,'avatarUrl',u.avatar_url,'iFollow',exists(select 1 from follows where follower_id=${a} and following_id=u.clerk_id)) actor from notifications n join users u on u.clerk_id=n.actor_id where recipient_id=${a} and not dismissed and n.id<${c} order by n.id desc limit 50`);
        const counts = await rows(sql `select count(*)::integer count from notifications where recipient_id=${a} and not dismissed and not is_read`);
        return { items, nextCursor: items.length === 50 ? items[49].id : null, unreadCount: counts[0].count };
    }
    if (op === 'notification-read') {
        await rows(sql `update notifications set is_read=true where recipient_id=${a} and id<=${integer(body.maxId)} returning id`);
        return { ok: true };
    }
    if (op === 'notification-dismiss') {
        await rows(sql `update notifications set dismissed=true where recipient_id=${a} and id=${integer(body.id)} returning id`);
        return { ok: true };
    }
    if (op === 'streaks' || op === 'streak-detail') {
        const items = await rows(sql `select ${streakFields} from streaks s join users u on u.clerk_id=case when s.user_a_id=${a} then s.user_b_id else s.user_a_id end where ${a} in(s.user_a_id,s.user_b_id) and s.is_active ${op === 'streak-detail' ? sql `and s.id=${integer(params.get('id'))}` : sql ``} order by s.id`);
        if (op === 'streak-detail') {
            if (!items[0])
                throw new HttpError(404, 'NOT_FOUND', 'Racha no encontrada.');
            return items[0];
        }
        return items;
    }
    if (op === 'streak-requests')
        return rows(sql `select r.id,r.sender_id as "actorId",json_build_object('clerkId',u.clerk_id,'username',u.username,'displayName',u.display_name,'avatarUrl',u.avatar_url) actor from streak_requests r join users u on u.clerk_id=r.sender_id where receiver_id=${a} and status='pending' order by r.id`);
    if (op === 'streak-action') {
        if (!['request', 'accept', 'reject', 'presence'].includes(String(body.action)))
            throw new HttpError(400, 'INVALID_ACTION', 'Acción inválida.');
        return result(sql `select api_streak(${a},${String(body.action)},${body.action === 'request' ? idValue(body.target) : null},${body.action === 'request' ? null : integer(body.id)}) data`);
    }
    if (op === 'wallet') {
        // One statement/snapshot binds the balance and its recent ledger page.
        const account = (await rows(sql `select balance::text,card_color as "cardColor",(pin_hash is not null) as "hasPin",
          (select coalesce(jsonb_agg(t order by t.id desc),'[]'::jsonb) from (
            select id,user_id as "userId",related_user_id as "relatedUserId",related_user_username as "relatedUserUsername",amount::text,type,description,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
            from transactions where user_id=${a} and id<${cursor ? integer(cursor) : 2147483647} order by id desc limit 50
          ) t) transactions from users where clerk_id=${a}`))[0];
        if (!account)
            throw new HttpError(404, 'NOT_FOUND', 'Cuenta no encontrada.');
        const items = account.transactions as Row[];
        return { ...account, transactions: items, nextCursor: items.length === 50 ? items[49].id : null };
    }
    if (op === 'card-color') {
        if (typeof body.color !== 'string' || (!/^#[a-f\d]{6}$/i.test(body.color) && !['slate','blue','green','red','purple','amber'].includes(body.color)))
            throw new HttpError(400, 'INVALID_COLOR', 'Color inválido.');
        await rows(sql `update users set card_color=${body.color} where clerk_id=${a} returning clerk_id`);
        return { ok: true };
    }
    if (op === 'pin' || op === 'transfer') {
        const pin = pinValue(body.pin);
        const current = (await rows(sql `select pin_hash from users where clerk_id=${a}`))[0]?.pin_hash as string | null;
        if (op === 'pin') {
            if (current) {
                const old = pinValue(body.previousPin);
                await result(sql `select api_pin_attempt(${a},${current},${await matchesPin(old, current)}) data`);
            }
            const next = await hashPin(pin);
            const changed = await rows(sql `update users set pin_hash=${next},pin_failures=0,pin_locked_until=null where clerk_id=${a} and pin_hash is not distinct from ${current} and (pin_locked_until is null or pin_locked_until<=clock_timestamp()) returning clerk_id`);
            if (!changed.length)
                throw new HttpError(409, 'PIN_CHANGED', 'La credencial cambió. Reintenta.');
            return { ok: true };
        }
        const b = idValue(body.receiverId);
        if (a === b)
            throw new HttpError(400, 'INVALID_PAIR', 'Elige otra cuenta.');
        const amount = amountString(body.amount);
        if (typeof body.description !== 'string' || body.description.length > 280)
            throw new HttpError(400, 'INVALID_DESCRIPTION', 'Descripción inválida.');
        const k = creationKey(key);
        const fp = createHash('sha256').update(JSON.stringify({ receiverId: b, amount, description: body.description })).digest('hex');
        const old = (await rows(sql `select fingerprint,receipt from transfer_receipts where actor_id=${a} and key=${k}::uuid`))[0];
        if (old) {
            if (old.fingerprint !== fp)
                throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Este intento corresponde a otra transferencia.');
            return checkResult(old.receipt);
        }
        if (!current)
            throw new HttpError(409, 'PIN_REQUIRED', 'Crea un PIN nuevo antes de transferir.');
        await result(sql `select api_pin_attempt(${a},${current},${await matchesPin(pin, current)}) data`);
        return result(sql `select api_transfer(${a},${b},${amount}::numeric,${body.description},${k}::uuid,${fp},${current}) data`);
    }
    throw new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada.');
}
const reads = new Set(['profile', 'search', 'notifications', 'streaks', 'streak-detail', 'streak-requests', 'wallet']);
const fields: Record<string, string[]> = { follow: ['target', 'enabled'], 'notification-read': ['maxId'], 'notification-dismiss': ['id'], 'streak-action': ['action', 'target', 'id'], 'card-color': ['color'], pin: ['pin', 'previousPin'], transfer: ['receiverId', 'amount', 'description', 'pin'] };
export function createCommunityHandler(op: string, authenticate = requireSubject, run = communityOperation) {
    return apiHandler(async (request) => {
        const actor = await authenticate(request);
        const isRead = reads.has(op);
        if (request.method !== (isRead ? 'GET' : 'POST'))
            throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método inválido.');
        let body: Row = {};
        if (!isRead) {
            const text = await readBody(request);
            try {
                body = JSON.parse(text);
            }
            catch {
                throw new HttpError(400, 'INVALID_BODY', 'JSON inválido.');
            }
            if (!body || typeof body !== 'object' || Array.isArray(body) || !fields[op] || Object.keys(body).some(k => !fields[op].includes(k)))
                throw new HttpError(400, 'INVALID_BODY', 'Campos inválidos.');
            if (op === 'follow' && typeof body.enabled !== 'boolean')
                throw new HttpError(400, 'INVALID_BODY', 'enabled debe ser booleano.');
        }
        return { data: await databaseOperation(() => run(actor, op, body, new URL(request.url).searchParams, request.headers.get('Idempotency-Key'))) };
    });
}
