import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';
import { creationFingerprint, creationKey } from '../src/server/prayerCreation.ts';
import { createPrayersHandler } from '../src/server/prayers.ts';
import { preflight } from '../src/server/http.ts';

// Fixture transport executes the production Drizzle/Neon batch SQL, never a copy
// of its algorithm. PGlite serializes transactions; real multi-connection MVCC
// contention and Neon remain explicit deployment checks.
delete process.env.EXPO_PUBLIC_DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
process.env.PRAYERS_API_ENABLED = 'true';
const key = '12345678-1234-4234-8234-123456789abc';
const body = { content: 'Petición' };
const post = (payload: unknown = body, value: string | null = key) => new Request('http://localhost/api/v1/prayers', {
  method: 'POST', headers: value === null ? {} : { 'Idempotency-Key': value }, body: JSON.stringify(payload),
});

test('UUIDv4, canonical defaults and CORS header', () => {
  assert.equal(creationKey(key.toUpperCase()), key);
  for (const invalid of [null, '', 'uuid', key.replace('-4234-', '-1234-'), key + ', ' + key]) assert.throws(() => creationKey(invalid));
  assert.equal(creationFingerprint(body), creationFingerprint({ ...body, title: null, audience: 'friends', color: 'default', isAnswered: false }));
  assert.notEqual(creationFingerprint(body), creationFingerprint({ ...body, audience: 'public' }));
  process.env.API_ALLOWED_ORIGINS = 'http://localhost:8081';
  const response = preflight(new Request('http://localhost/api/v1/prayers', { headers: { Origin: 'http://localhost:8081' } }));
  assert.match(response.headers.get('Access-Control-Allow-Headers')!, /Idempotency-Key/);
});

test('real atomic batch: lost responses, competing requests, isolation, conflicts, edited/deleted replay and rollback', async () => {
  const pg = new PGlite();
  const previous = neonConfig.fetchFunction;
  let failAfter = 0;
  let requests = 0;
  await pg.exec(`create table users(clerk_id varchar(255) primary key);
    insert into users values ('A'),('B');
    create table prayers(id integer generated always as identity primary key, user_id text not null references users(clerk_id),
      title text, content text not null, color text not null default 'default', audience text not null default 'friends',
      is_answered boolean not null default false, position integer not null default 0,
      created_at timestamp not null default now(), updated_at timestamp not null default now());
    insert into prayers(user_id,content,position) values('A','Anterior',7);`);
  const before = (await pg.query('select * from prayers')).rows;
  await pg.exec(readFileSync(new URL('../migrations/20261020_prayer_creation_requests.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await pg.query('select * from prayers')).rows, before);
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    requests++;
    const { queries } = JSON.parse(init.body as string) as { queries: { query: string; params: unknown[] }[] };
    assert.equal(queries.length, 3);
    assert.equal(new Headers(init.headers).get('Neon-Batch-Isolation-Level'), 'ReadCommitted');
    assert.match(queries[0].query, /on conflict[\s\S]*do update/i);
    try {
      const results = await pg.transaction(async tx => {
        const results = [];
        for (let i = 0; i < queries.length; i++) {
          const q = queries[i];
          const result = await tx.query<Record<string, unknown>>(q.query, q.params);
          results.push({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
            const value = row[field.name];
            return value == null ? null : value instanceof Date ? value.toISOString().slice(0, -1).replace('T', ' ') : typeof value === 'boolean' ? value ? 't' : 'f' : String(value);
          })), command: 'SELECT', rowCount: result.rows.length });
          if (failAfter === i + 1) throw new Error('Injected failure');
        }
        return results;
      });
      return Response.json({ results });
    } catch { return new Response('Fixture failure', { status: 503 }); }
  };
  const handler = (subject = 'A') => createPrayersHandler('create', undefined, async () => subject);
  const count = async (table: string) => (await pg.query<{ n: number }>(`select count(*)::integer n from ${table}`)).rows[0].n;
  try {
    // All validation and gates run before even opening the transport.
    for (const value of [null, 'invalid', key.replace('-8234-', '-7234-')]) assert.equal((await handler()(post(body, value))).status, 400);
    for (const value of [{}, { content: '' }, { content: 'ok', userId: 'B' }]) assert.equal((await handler()(post(value))).status, 400);
    delete process.env.PRAYERS_API_ENABLED;
    assert.equal((await handler()(post())).status, 503);
    assert.equal((await createPrayersHandler('create')(post())).status, 401);
    process.env.PRAYERS_API_ENABLED = 'true';
    assert.equal(requests, 0);

    const first = await handler()(post()); assert.equal(first.status, 200);
    const original = (await first.json()).data;
    assert.equal(original.position, 8); assert.equal(original.userId, 'A');
    assert.equal(Object.keys(original).includes('fingerprint'), false);
    // The first response can be lost: same key/defaults recovers the same receipt.
    const repeat = await handler()(post({ ...body, title: null, color: 'default', audience: 'friends', isAnswered: false }));
    assert.deepEqual((await repeat.json()).data, original);
    assert.equal(await count('prayers'), 2); assert.equal(await count('prayer_creation_requests'), 1);
    const receiptBefore = (await pg.query('select * from prayer_creation_requests')).rows;
    const prayersBeforeConflict = (await pg.query('select * from prayers order by id')).rows;
    for (const change of [{ title: 'Distinto' }, { color: 'blue' }, { isAnswered: true }, { audience: 'public' }, { content: 'Distinta' }]) {
      const conflict = await handler()(post({ ...body, ...change })); assert.equal(conflict.status, 409);
      assert.deepEqual((await pg.query('select * from prayer_creation_requests')).rows, receiptBefore);
      assert.deepEqual((await pg.query('select * from prayers order by id')).rows, prayersBeforeConflict);
    }

    const ownB = await handler('B')(post()); assert.equal(ownB.status, 200);
    const b = (await ownB.json()).data;
    assert.notEqual(b.id, original.id); assert.equal(b.userId, 'B'); assert.equal(b.position, 0);

    await pg.query("update prayers set content='Editada',position=19,updated_at='2026-10-20' where id=$1", [original.id]);
    const edited = (await (await handler()(post())).json()).data;
    assert.equal(edited.content, 'Editada'); assert.equal(edited.position, 19);
    assert.equal(edited.createdAt, original.createdAt);
    await pg.query('delete from prayers where id=$1', [original.id]);
    assert.equal((await handler()(post())).status, 410);
    assert.equal(await count('prayers'), 2); assert.equal(await count('prayer_creation_requests'), 2);

    const concurrentKey = '23456789-1234-4234-8234-123456789abc';
    const competitors = await Promise.all([handler()(post(body, concurrentKey)), handler()(post(body, concurrentKey))]);
    const ids = await Promise.all(competitors.map(async r => { assert.equal(r.status, 200); return (await r.json()).data.id; }));
    assert.equal(ids[0], ids[1]); assert.equal(await count('prayers'), 3);

    const differentKey = '34567890-1234-4234-8234-123456789abc';
    const candidates = [{ content: 'Competidor primero' }, { content: 'Competidor segundo' }];
    const previousCount = await count('prayers');
    const different = await Promise.all(candidates.map(value => handler()(post(value, differentKey))));
    assert.deepEqual(different.map(r => r.status).sort(), [200, 409]);
    const winner = different.findIndex(r => r.status === 200);
    const winnerDto = (await different[winner].json()).data;
    assert.equal(winnerDto.content, candidates[winner].content);
    assert.equal(await count('prayers'), previousCount + 1);
    const winningReceipt = (await pg.query('select * from prayer_creation_requests where key=$1', [differentKey])).rows;
    assert.equal((winningReceipt[0] as { fingerprint: string }).fingerprint, creationFingerprint(candidates[winner]));
    assert.equal((winningReceipt[0] as { prayer_id: number }).prayer_id, winnerDto.id);
    const winningPrayer = (await pg.query('select * from prayers where id=$1', [winnerDto.id])).rows;
    assert.deepEqual((await (await handler()(post(candidates[winner], differentKey))).json()).data, winnerDto);
    assert.equal((await handler()(post(candidates[1 - winner], differentKey))).status, 409);
    assert.deepEqual((await pg.query('select * from prayer_creation_requests where key=$1', [differentKey])).rows, winningReceipt);
    assert.deepEqual((await pg.query('select * from prayers where id=$1', [winnerDto.id])).rows, winningPrayer);

    const custom = { title: 'Gracias', content: 'Oración pública respondida', color: '#12ABEF', audience: 'public', isAnswered: true };
    const customResponse = await handler()(post(custom, '45678901-1234-4234-8234-123456789abc'));
    assert.equal(customResponse.status, 200);
    const customDto = (await customResponse.json()).data;
    const customRow = (await pg.query<Record<string, unknown>>('select * from prayers where id=$1', [customDto.id])).rows[0];
    for (const field of ['title', 'content', 'color', 'audience', 'isAnswered'] as const) {
      assert.equal(customDto[field], custom[field]);
      assert.equal(customRow[field === 'isAnswered' ? 'is_answered' : field], custom[field]);
    }

    for (const stage of [1, 2, 3]) {
      const retryKey = `${stage}3456789-2345-4234-8234-123456789abc`;
      const beforeFailure = (await pg.query('select * from prayers order by id')).rows;
      const receiptsBeforeFailure = (await pg.query('select * from prayer_creation_requests order by user_id,key')).rows;
      const beforeCount = await count('prayers');
      failAfter = stage;
      assert.equal((await handler()(post(body, retryKey))).status, 503);
      assert.equal((await pg.query('select * from prayer_creation_requests where key=$1', [retryKey])).rows.length, 0);
      assert.deepEqual((await pg.query('select * from prayers order by id')).rows, beforeFailure);
      assert.deepEqual((await pg.query('select * from prayer_creation_requests order by user_id,key')).rows, receiptsBeforeFailure);
      failAfter = 0;
      const retry = await handler()(post(body, retryKey)); assert.equal(retry.status, 200);
      assert.equal(await count('prayers'), beforeCount + 1);
      assert.equal((await handler()(post(body, retryKey))).status, 200);
      assert.equal(await count('prayers'), beforeCount + 1);
    }
  } finally { neonConfig.fetchFunction = previous; await pg.close(); }
});
