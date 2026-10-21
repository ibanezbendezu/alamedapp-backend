import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { neonConfig } from '@neondatabase/serverless';
import { syncOwnAccount, readClerkAccount, accountTimeoutMs } from '../src/server/account.ts';
import { profileSelection, validateProfilePatch } from '../src/server/profile.ts';
import { createSyncHandler, createPatchMeHandler, createMedalsHandler } from '../src/server/handlers.ts';
import { POST } from '../src/app/api/v1/me/sync/route.ts';
import { PATCH } from '../src/app/api/v1/me/route.ts';
import { GET as ownMedals } from '../src/app/api/v1/me/medals/route.ts';
import { GET as catalog } from '../src/app/api/v1/medals/route.ts';

process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
process.env.CLERK_AUTHORIZED_PARTIES = 'http://localhost:8081';
process.env.DATABASE_TIMEOUT_MS = '1000';
process.env.CLERK_SECRET_KEY = 'sk_test_fixture';
const provider = { primaryEmailAddressId: 'primary', emailAddresses: [
  { id: 'unverified', emailAddress: 'wrong@example.test', verification: { status: 'unverified' } },
  { id: 'primary', emailAddress: 'alice@example.test', verification: { status: 'verified' } },
], username: 'alice', firstName: 'Proveedor', lastName: 'Nombre', imageUrl: 'https://example.test/avatar' };
const req = (method: string, body?: string, token?: string) => new Request('http://localhost/api/v1/me?userId=B', {
  method, ...(body === undefined ? {} : { body }), headers: token ? { Authorization: `Bearer ${token}` } : {},
});
const row = { clerkId: 'A', username: 'local', email: 'old@example.test', displayName: 'Local', avatarUrl: null as string | null,
  balance: '450.50', followerCount: 7, followingCount: 3, favoriteVerse: null, bio: 'Bio local',
  cardColor: '#000000', createdAt: new Date('2026-01-01') };
function result(profile: typeof row) {
  return Response.json({ fields: Object.entries(profileSelection).map(([key, column]) => ({ name: column.name,
    dataTypeID: key === 'createdAt' ? 1114 : key === 'balance' ? 1700 : key.endsWith('Count') ? 23 : 25,
  })), rows: [Object.keys(profileSelection).map(key => {
    const value = profile[key as keyof typeof row];
    return value instanceof Date ? '2026-01-01 00:00:00' : value === null ? null : String(value);
  })], command: 'INSERT', rowCount: 1 });
}

test('todas las rutas predeterminadas rechazan sin auth antes de Clerk/Neon', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No red real'); });
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async () => { calls++; throw new Error('No Neon real'); };
  try {
    for (const [handler, method] of [[POST, 'POST'], [PATCH, 'PATCH'], [ownMedals, 'GET'], [catalog, 'GET']] as const) {
      assert.equal((await handler(req(method))).status, 401);
    }
    assert.equal(calls, 0);
  } finally { neonConfig.fetchFunction = previous; }
});

test('metadata exige email primario verificado antes de escribir', async () => {
  let writes = 0;
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async () => { writes++; throw new Error('No escribir'); };
  try {
    for (const primaryEmailAddressId of [null, 'unverified', 'missing']) {
      await assert.rejects(syncOwnAccount('A', async () => ({ ...provider, primaryEmailAddressId })), { status: 409 });
    }
    assert.equal(writes, 0);
  } finally { neonConfig.fetchFunction = previous; }
});

test('SQL real: sync concurrente conserva campos locales, siembra catálogo y no asigna medallas', async () => {
  const previous = neonConfig.fetchFunction;
  let writes = 0;
  let seeds = 0;
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const { query, params } = JSON.parse(init.body as string);
    if (query.startsWith('insert into "medals"')) {
      seeds++;
      assert.equal(params.length, 9 * 5);
      return Response.json({ fields: [], rows: [], command: 'INSERT', rowCount: 0 });
    }
    writes++;
    assert.match(query, /on conflict \("clerk_id"\) do update set "email" = .*"avatar_url" =/);
    const update = query.split('do update set')[1].split('returning')[0];
    for (const field of ['username', 'display_name', 'balance', 'security_pin', 'bio', 'favorite_verse', 'created_at', 'follower_count']) assert.equal(update.includes(field), false);
    assert.equal(query.split('returning')[1].includes('security_pin'), false);
    assert.equal(params[0], 'A');
    assert.ok(params.includes('alice@example.test'));
    return result({ ...row, email: provider.emailAddresses[1].emailAddress, avatarUrl: provider.imageUrl });
  };
  try {
    const rows = await Promise.all([syncOwnAccount('A', async () => provider), syncOwnAccount('A', async () => provider)]);
    for (const profile of rows) {
      assert.equal(profile.balance, row.balance);
      assert.equal(profile.displayName, 'Local');
      assert.equal(profile.username, 'local');
      assert.equal(profile.bio, 'Bio local');
    }
    assert.equal(writes, 2); assert.equal(seeds, 2);
  } finally { neonConfig.fetchFunction = previous; }
});

test('colisión username usa sufijo estable y conflicto email retorna 409 sin reasignar', async () => {
  const previous = neonConfig.fetchFunction;
  const usernames: unknown[] = [];
  let failAll = false;
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const { query, params } = JSON.parse(init.body as string);
    if (query.startsWith('insert into "medals"')) return Response.json({ fields: [], rows: [], command: 'INSERT', rowCount: 0 });
    usernames.push(params[1]);
    if (params[1] === 'alice' || failAll) return Response.json({ message: 'private', code: '23505' }, { status: 400 });
    return result(row);
  };
  try {
    await syncOwnAccount('A', async () => provider);
    await syncOwnAccount('A', async () => provider);
    assert.equal(usernames[1], usernames[3]);
    assert.match(usernames[1] as string, /^alice_[0-9a-f]{20}$/);
    failAll = true;
    await assert.rejects(syncOwnAccount('A', async () => provider), { status: 409 });
  } finally { neonConfig.fetchFunction = previous; }
});

test('PATCH whitelist, JSON BibleVerse y límites 50/160/5000; null permitido', async () => {
  const verse = JSON.stringify({ book: 'Juan', chapter: 3, verse: 16, text: 'Texto' });
  for (const value of [{ displayName: 'n'.repeat(50), bio: 'b'.repeat(160), favoriteVerse: verse }, { displayName: null, bio: null, favoriteVerse: null }]) assert.deepEqual(validateProfilePatch(value), value);
  const invalid = [{}, [], null, { clerkId: 'B' }, { balance: '10' }, { securityPin: '123456' }, { username: 'admin' }, { bio: false }, { displayName: 'n'.repeat(51) }, { bio: 'b'.repeat(161) }, { favoriteVerse: 'x'.repeat(5001) }, { favoriteVerse: '{}' }, { favoriteVerse: JSON.stringify({ book: 'Juan', chapter: 0, verse: 1, text: 'Texto' }) }, { favoriteVerse: JSON.stringify({ book: 'Juan', chapter: 1, verse: 1, text: 'Texto', extra: true }) }];
  let calls = 0;
  const handler = createPatchMeHandler(async () => 'A', async () => { calls++; return row; });
  for (const value of invalid) assert.equal((await handler(req('PATCH', JSON.stringify(value)))).status, 400);
  assert.equal((await handler(req('PATCH', '{bad'))).status, 400);
  assert.equal(calls, 0);
});

test('rutas predeterminadas SDK Clerk y SQL Neon simulados: identidad A, PATCH propio y medallas lectura', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLERK_JWT_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })).toString('base64url');
  const data = Buffer.from(JSON.stringify({ sub: 'A', sid: 'session', azp: 'http://localhost:8081', iss: 'https://fixture.clerk.accounts.dev', iat: now, nbf: now - 5, exp: now + 60 })).toString('base64url');
  const token = `${head}.${data}.${sign('RSA-SHA256', Buffer.from(`${head}.${data}`), privateKey).toString('base64url')}`;
  let clerkReads = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    assert.match(String(input), /\/users\/A/);
    clerkReads++;
    return Response.json({ object: 'user', id: 'A', primary_email_address_id: 'primary', email_addresses: [
      { object: 'email_address', linked_to: [], id: 'primary', email_address: 'alice@example.test', verification: { status: 'verified' } },
    ], username: 'alice', first_name: 'Proveedor', last_name: 'Nombre', image_url: provider.imageUrl });
  });
  const previous = neonConfig.fetchFunction;
  const queries: string[] = [];
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const { query, params } = JSON.parse(init.body as string);
    queries.push(query);
    if (query.startsWith('update "users"')) {
      assert.match(query, /where "users"\."clerk_id" =/);
      assert.equal(params.at(-1), 'A');
      assert.equal(params[0], 'Editado');
      return result({ ...row, displayName: 'Editado' });
    }
    if (query.startsWith('insert into "users"')) { assert.equal(params[0], 'A'); return result(row); }
    if (query.includes('from "user_medals"')) {
      assert.equal(params[0], 'A');
      return Response.json({ fields: ['id', 'title', 'description', 'color', 'icon_name', 'category', 'earned_at'].map(name => ({ name, dataTypeID: name === 'earned_at' ? 1114 : 25 })),
        rows: [['m1', 'Madrugador', 'Descripción', '#fff', 'Sun', null, '2026-01-02 03:04:05']], command: 'SELECT', rowCount: 1 });
    }
    assert.equal(query.includes('security_pin'), false);
    return Response.json({ fields: [], rows: [], command: 'SELECT', rowCount: 0 });
  };
  try {
    const synced = await POST(req('POST', undefined, token));
    assert.equal(synced.status, 200); assert.equal(clerkReads, 1);
    assert.equal('securityPin' in (await synced.json()).data, false);
    const patched = await PATCH(req('PATCH', JSON.stringify({ displayName: 'Editado' }), token));
    assert.equal(patched.status, 200); assert.equal((await patched.json()).data.displayName, 'Editado');
    const earned = await ownMedals(req('GET', undefined, token));
    assert.equal(earned.status, 200);
    assert.deepEqual((await earned.json()).data, [{ id: 'm1', title: 'Madrugador', description: 'Descripción', color: '#fff', iconName: 'Sun', category: null, earnedAt: '2026-01-02T03:04:05.000Z' }]);
    assert.equal((await catalog(req('GET', undefined, token))).status, 200);
    assert.ok(queries.some(query => query.includes('user_medals')));
    assert.equal((await POST(req('POST', JSON.stringify({ clerkId: 'B' }), token))).status, 400);
  } finally { neonConfig.fetchFunction = previous; }
});

test('sync admite objeto vacío formateado; cuerpos enormes fallan antes de dependencias', async () => {
  let calls = 0;
  const sync = createSyncHandler(async () => 'A', async () => { calls++; return row; });
  assert.equal((await sync(req('POST', '{ \n }'))).status, 200);
  for (const body of ['null', '[]', '{"clerkId":"B"}', '{bad']) assert.equal((await sync(req('POST', body))).status, 400);
  const patch = createPatchMeHandler(async () => 'A', async () => { calls++; return row; });
  assert.equal((await patch(req('PATCH', JSON.stringify({ bio: 'x'.repeat(40000) })))).status, 413);
  assert.equal((await sync(req('POST', 'x'.repeat(40000)))).status, 413);
  assert.equal(calls, 1);
});

test('sync reserva tiempo para Clerk y Neon sin cortar al vencer sólo un presupuesto DB', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handler = createSyncHandler(async () => 'A', async () => { await new Promise(r => setTimeout(r, 1500)); return row; });
  let complete = false;
  const pending = handler(req('POST')).then(response => { complete = true; return response; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(complete, false);
  t.mock.timers.tick(500);
  assert.equal((await pending).status, 200);
});

test('servicios caídos/timeouts devuelven 503 seguro; Clerk exige secretKey', async t => {
  t.mock.method(console, 'error', () => {});
  delete process.env.CLERK_SECRET_KEY;
  await assert.rejects(readClerkAccount('A'), { status: 503 });
  process.env.CLERK_SECRET_KEY = 'sk_test_fixture';
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private credentials'); });
  for (const handler of [createSyncHandler(async () => 'A', async () => { throw new Error('private'); }), createPatchMeHandler(async () => 'A', async () => { throw new Error('private'); }), createMedalsHandler(true, async () => 'A', async () => { throw new Error('private'); })]) {
    const response = await handler(req('PATCH', JSON.stringify({ bio: 'x' })));
    // Sync requiere cuerpo vacío antes de consultar servicios.
    if (response.status === 400) continue;
    assert.equal(response.status, 503); assert.equal((await response.text()).includes('private'), false);
  }
  assert.equal((await createSyncHandler(async () => 'A', async () => { throw new Error('private'); })(req('POST'))).status, 503);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const pending = readClerkAccount('A');
  const rejected = assert.rejects(pending, { status: 503 });
  await Promise.resolve();
  t.mock.timers.tick(accountTimeoutMs);
  await rejected;
});
