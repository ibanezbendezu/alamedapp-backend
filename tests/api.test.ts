import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { neonConfig } from '@neondatabase/serverless';
import { requireSubject, authenticationTimeoutMs } from '../src/server/auth.ts';
import { apiHandler, HttpError } from '../src/server/http.ts';
import { createMeHandler, createReadyHandler } from '../src/server/handlers.ts';
import { databaseEnvironment } from '../src/server/environment.ts';
import { findOwnProfile, profileSelection } from '../src/server/profile.ts';
import { me, health, ready } from '../src/server/routes.ts';
import { preflight as OPTIONS } from '../src/server/http.ts';

// Se elimina configuración heredada: ningún test carga archivos .env.
delete process.env.DATABASE_URL;
delete process.env.EXPO_PUBLIC_DATABASE_URL;
process.env.CLERK_AUTHORIZED_PARTIES = 'http://localhost:8081';
process.env.CLERK_JWT_KEY = 'fixture';
process.env.API_ALLOWED_ORIGINS = 'http://localhost:8081';
const request = (token?: string) => new Request('http://localhost/api/v1/me?userId=B', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const fixture = (clerkId: string) => ({
  clerkId, username: clerkId, email: `${clerkId}@example.test`, displayName: null,
  avatarUrl: null, balance: '0.00', followerCount: 0, followingCount: 0,
  favoriteVerse: null, bio: null, cardColor: '#000000', createdAt: new Date('2026-01-01'),
  securityPin: 'secret',
});

test('importación de rutas sin DATABASE_URL ni conexiones; liveness independiente', async () => {
  assert.equal((await health(request())).status, 200);
  assert.equal((await ready(request())).status, 503);
  assert.equal((await me(request())).status, 401);
});

test('Bearer inválido/ausente/vencido no consulta el repositorio', async () => {
  let reads = 0;
  const invalid = createMeHandler(r => requireSubject(r, async () => { throw new Error('expired'); }), async () => { reads++; return undefined; });
  for (const token of [undefined, 'invalid', 'expired']) {
    const response = await invalid(request(token));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(reads, 0);
});

test('token A + query B sólo devuelve A y el DTO excluye el PIN', async () => {
  const fixtures = [fixture('A'), fixture('B')];
  const handler = createMeHandler(r => requireSubject(r, async () => ({ sub: 'A', sid: 'session', azp: 'http://localhost:8081' })), async subject => fixtures.find(row => row.clerkId === subject));
  const response = await handler(request('valid'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.clerkId, 'A');
  assert.equal(body.data.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal('securityPin' in body.data, false);
  assert.equal('securityPin' in profileSelection, false);
});

test('cuenta ausente devuelve 404 sin aprovisionar y fallo DB queda acotado', async () => {
  const missing = createMeHandler(async () => 'A', async () => undefined);
  assert.equal((await missing(request('valid'))).status, 404);
  const failed = createMeHandler(async () => 'A', async () => { throw new Error('postgresql://secret'); });
  const response = await failed(request('valid'));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('postgresql'), false);
});

test('preflight real de la ruta permite Authorization y DELETE sólo al origen permitido', () => {
  for (const origin of ['http://localhost:8081', 'https://foreign.test']) {
    const response = OPTIONS(new Request('http://localhost/api/v1/me', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'DELETE', 'Access-Control-Request-Headers': 'authorization',
    } }));
    assert.equal(response.status, 204);
    if (origin.includes('localhost')) {
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(response.headers.get('access-control-allow-methods')!, /DELETE/);
      assert.match(response.headers.get('access-control-allow-headers')!, /Authorization/);
      assert.equal(response.headers.get('access-control-expose-headers'), 'X-Request-Id');
    } else assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('readiness disponible, caída y timeout con dobles', async () => {
  assert.equal((await createReadyHandler(async () => {}, () => 20)(request())).status, 200);
  const unavailable = createReadyHandler(async () => { throw new Error('credentials'); }, () => 20);
  assert.equal((await unavailable(request())).status, 503);
  const stuck = createReadyHandler(() => new Promise(() => {}), () => 10);
  const response = await stuck(request());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('credentials'), false);
});

test('sólo Neon privado con TLS; no usa variable pública', () => {
  const url = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  assert.equal(databaseEnvironment({ DATABASE_URL: url }).timeoutMs, 5000);
  for (const value of ['', url.replace('neon.tech', 'example.test'), url.replace('require', 'disable'), url.replace('?sslmode=require', '')]) {
    assert.throws(() => databaseEnvironment({ DATABASE_URL: value }), /Invalid private Neon/);
  }
  assert.throws(() => databaseEnvironment({ EXPO_PUBLIC_DATABASE_URL: url }));
});

test('GET real verifica Clerk local y lee el perfil con Drizzle/Neon simulado', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLERK_JWT_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const token = (overrides: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'A', sid: 'sess_fixture', azp: 'http://localhost:8081', iss: 'https://fixture.clerk.accounts.dev', iat: now, nbf: now - 10, exp: now + 60, ...overrides })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  };
  assert.equal(await requireSubject(request(token({}))), 'A');
  for (const value of [token({ exp: 1 }), token({ azp: 'https://foreign.test' }), token({ sid: null }), token({ sts: 'pending' }), `${token({})}tampered`]) {
    assert.equal((await me(request(value))).status, 401);
  }
  process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  process.env.DATABASE_TIMEOUT_MS = '15';
  const previous = neonConfig.fetchFunction;
  let reads = 0;
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const query = JSON.parse(init.body as string);
    assert.deepEqual(query.params, ['A', '1']);
    assert.equal(query.query.includes('security_pin'), false);
    reads++;
    const rows = [fixture('A'), fixture('B')].filter(row => row.clerkId === query.params[0]);
    return Response.json({
      fields: Object.entries(profileSelection).map(([key, column]) => ({ name: column.name,
        dataTypeID: key === 'createdAt' ? 1114 : key === 'balance' ? 1700 : key.endsWith('Count') ? 23 : 25,
      })),
      rows: rows.map(row => Object.keys(profileSelection).map(key => {
        if (key === 'balance') return '123456789012345678.90';
        if (key === 'createdAt') return '2026-01-01 00:00:00';
        const value = row[key as keyof typeof row];
        return value === null ? null : String(value);
      })), command: 'SELECT', rowCount: rows.length,
    });
  };
  try {
    const response = await me(request(token({})));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.clerkId, 'A');
    assert.equal(body.data.balance, '123456789012345678.90');
    assert.equal(body.data.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal('securityPin' in body.data, false);
    assert.equal(reads, 1);
    assert.equal((await me(request(token({ exp: 1 })))).status, 401);
    assert.equal(reads, 1);
  } finally {
    neonConfig.fetchFunction = previous;
    delete process.env.DATABASE_URL;
  }
});

test('verificador bloqueado termina en 401 con reloj simulado', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = requireSubject(request('blocked'), () => new Promise(() => {}));
  const rejection = assert.rejects(pending, { status: 401, code: 'UNAUTHORIZED' });
  t.mock.timers.tick(authenticationTimeoutMs);
  await rejection;
});

test('fallos 5xx registran correlación y categorías cerradas sin datos sensibles', async t => {
  const logger = t.mock.method(console, 'error', () => {});
  const sensitive = 'postgresql://private:password@secret.test/db Bearer token alice@example.test';
  for (const failure of [new Error(sensitive), new HttpError(503, 'DATABASE_UNAVAILABLE', sensitive), new HttpError(500, sensitive, sensitive)]) {
    const handler = apiHandler(() => { throw failure; });
    const response = await handler(new Request(`http://localhost/api?private=${encodeURIComponent(sensitive)}`, { headers: { Authorization: sensitive } }));
    const body = await response.json();
    const call = logger.mock.calls.at(-1)!;
    assert.equal(call.arguments.length, 1);
    const record = JSON.parse(call.arguments[0] as string);
    assert.deepEqual(Object.keys(record).sort(), ['category', 'event', 'requestId', 'status']);
    assert.equal(record.event, 'api_failure');
    assert.equal(record.status, response.status);
    assert.equal(record.requestId, body.error.requestId);
    assert.equal(record.requestId, response.headers.get('x-request-id'));
    assert.equal(record.category, failure instanceof HttpError && failure.code === 'DATABASE_UNAVAILABLE' ? 'database_unavailable' : 'internal_error');
    for (const privateValue of ['postgresql', 'password', 'secret.test', 'Bearer', 'token', 'alice@example.test']) {
      assert.equal(JSON.stringify(record).includes(privateValue), false);
    }
  }
  assert.equal(logger.mock.calls.length, 3);
});

test('driver real: selección y parámetro A; timeout cancela fetch y renueva signal por consulta', async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  process.env.DATABASE_TIMEOUT_MS = '15';
  const signals: AbortSignal[] = [];
  const queries: { query: string; params: unknown[] }[] = [];
  const previous = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const query = JSON.parse(init.body as string);
    queries.push(query);
    const signal = init.signal!;
    signals.push(signal);
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
  };
  // Mantiene el proceso vivo mientras AbortSignal.timeout usa timers unref.
  const keepAlive = setInterval(() => {}, 100);
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(() => findOwnProfile('A'));
    assert.equal(signals.length, 2);
    assert.equal(signals.every(signal => signal.aborted), true);
    assert.notEqual(signals[0], signals[1]);
    assert.deepEqual(queries[0].params, ['A', '1']);
    assert.equal(queries[0].query.includes('security_pin'), false);
    neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
      assert.match(JSON.parse(init.body as string).query, /select 1/i);
      return Response.json({ fields: [{ name: '?column?', dataTypeID: 23 }], rows: [['1']], command: 'SELECT', rowCount: 1 });
    };
    assert.equal((await ready(request())).status, 200);
  } finally {
    clearInterval(keepAlive);
    neonConfig.fetchFunction = previous;
    delete process.env.DATABASE_URL;
  }
});
