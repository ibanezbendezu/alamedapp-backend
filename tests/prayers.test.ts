import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neonConfig } from '@neondatabase/serverless';
import { PGlite } from '@electric-sql/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createPrayersHandler, listPrayersQuery, listPrayers, patchPrayer, removePrayer, insertPrayer, orderPrayers, orderStatement, visiblePrayers, validatePrayer, validateOrder } from '../src/server/prayers.ts';
import { requireSubject } from '../src/server/auth.ts';
import { readFileSync } from 'node:fs';

test('prepared migration preserves prior rows and defaults friends in embedded PostgreSQL', async () => {
  const migration = readFileSync(new URL('../migrations/20261020_prayers_audience.sql', import.meta.url), 'utf8');
  const pg = new PGlite();
  try {
    await pg.exec("create table prayers(id integer primary key,content text,color text,position integer,created_at timestamp,updated_at timestamp); insert into prayers values (1,'Texto anterior','#FEFEFE',7,'2026-01-02','2026-02-03');");
    const before = (await pg.query('select * from prayers')).rows[0];
    await pg.exec(migration);
    const after = (await pg.query('select * from prayers')).rows[0] as Record<string, unknown>;
    assert.equal(after.audience, 'friends');
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'audience')), before);
    await pg.exec('insert into prayers(id) values (2)');
    assert.equal((await pg.query<{audience:string}>('select audience from prayers where id=2')).rows[0].audience,'friends');
    await assert.rejects(pg.exec("insert into prayers(id,audience) values (3,'private')"));
    await pg.exec("update prayers set audience='public' where id=1");
    assert.equal((await pg.query<{audience:string}>('select audience from prayers where id=1')).rows[0].audience,'public');
  } finally { await pg.close(); }
});

// All transports below are fixtures. No .env or live Clerk/Postgres access.
delete process.env.DATABASE_URL;
delete process.env.EXPO_PUBLIC_DATABASE_URL;
const fixture = (id = 1, audience: 'friends' | 'public' = 'friends') => ({ id, userId: 'A', title: null, content: 'Petición', color: '#F28B82',
  position: id - 1, isAnswered: false, audience, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') });
const request = (action = 'GET', value?: unknown, query = '') => new Request(`http://localhost/api/v1/prayers${query}`, {
  method: action, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
});
const auth = async () => 'A';
process.env.PRAYERS_API_ENABLED = 'true';
process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
const repo = { list: async () => [fixture()], insert: async () => fixture(), patch: async () => fixture(), remove: async () => fixture(), order: async () => true };

test('all prayer actions authenticate before reads, body validation or writes', async () => {
  let calls = 0;
  const r = { ...repo, list: async () => { calls++; return []; }, insert: async () => { calls++; return fixture(); },
    patch: async () => { calls++; return fixture(); }, remove: async () => { calls++; return fixture(); }, order: async () => { calls++; return true; } };
  for (const action of ['list', 'create', 'patch', 'delete', 'order'] as const) {
    assert.equal((await createPrayersHandler(action, '1', req => requireSubject(req), r)(request())).status, 401);
  }
  assert.equal(calls, 0);
});

test('closed input schema, field limits, audience, colors, ids and bounded body', async () => {
  for (const input of [null, [], {}, {content: ''}, {content: '   '}, {content: 1}, {content: 'a'.repeat(10001)},
    {content: 'a', userId: 'B'}, {content:'a', position: 8}, {content: 'a', createdAt: 'fake'}, {content: 'a', title:'x'.repeat(201)},
    {content: 'a', audience:'private'}, {content:'a', color:'url(secret)'}, {content:'a', isAnswered:'false'}]) {
    assert.equal((await createPrayersHandler('create', undefined, auth, repo)(request('POST', input))).status, 400);
  }
  for (const audience of ['friends', 'public'] as const) assert.equal(validatePrayer({ content: 'ok', audience }, true).audience, audience);
  assert.equal(validatePrayer({content:'ok',color:'#F28B82'}, true).color, '#F28B82');
  for (const id of ['0', '-1', '1.1', 'NaN', '2147483648', '01']) assert.equal((await createPrayersHandler('delete', id, auth, repo)(request('DELETE'))).status, 400);
  assert.equal((await createPrayersHandler('create', undefined, auth, repo)(request('POST', '{'))).status, 400);
  assert.equal((await createPrayersHandler('create', undefined, auth, repo)(request('POST', 'x'.repeat(33000)))).status, 413);
  for (const ids of [[1,1], [0], ['1'], [2147483648]]) assert.throws(() => validateOrder({ids}));
});

test('DTO, pagination and authorship are server controlled; failures do not become empty success', async () => {
  const h = createPrayersHandler('list', 'B', auth, { ...repo, list: async (subject, owner, offset) => {
    assert.equal(subject,'A'); assert.equal(owner,'B'); assert.equal(offset,100);
    return Array.from({length:101}, (_,i)=>fixture(i+101));
  } });
  const result = await h(request('GET', undefined, '?cursor=100'));
  const body = await result.json();
  assert.equal(body.data.items.length,100); assert.equal(body.data.nextCursor,200);
  assert.equal(body.data.items[0].createdAt,'2026-01-01T00:00:00.000Z');
  for (const action of ['patch', 'delete'] as const) {
    const r = { ...repo, patch: async (subject: string, id: number) => { assert.equal(subject,'A'); assert.equal(id,9); return undefined!; }, remove: async () => undefined! };
    assert.equal((await createPrayersHandler(action,'9',auth,r)(request(action === 'patch' ? 'PATCH' : 'DELETE', action === 'patch' ? {content:'ok'} : undefined))).status,404);
  }
  const failure = createPrayersHandler('list', undefined, auth, { ...repo, list: async () => {throw new Error('secret db');} });
  process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  assert.equal((await failure(request())).status,503);
  assert.equal((await createPrayersHandler('order',undefined,auth,{...repo,order:async()=>false})(request('PUT',{ids:[1]}))).status,409);
  delete process.env.DATABASE_URL;
});

test('SQL visibility expresses owner, public and both current follow directions with bound parameters', () => {
  const dialect = new PgDialect();
  for (const [reader,owner] of [['A','A'],['B','A'],['C','A']]) {
    const query = dialect.sqlToQuery(visiblePrayers(reader, owner));
    assert.match(query.sql,/audience[\s\S]*= 'public'/);
    assert.equal((query.sql.match(/exists\(select 1 from follows/g) ?? []).length,2);
    assert.match(query.sql,/follower_id = \$\d+ and following_id = \$\d+/);
    assert.deepEqual(query.params,[owner,reader,reader,owner,owner,reader]);
    assert.equal(query.sql.includes(`'${reader}'`),false);
  }
  const order = dialect.sqlToQuery(orderStatement('A',[2,1]));
  assert.match(order.sql,/for update/); assert.match(order.sql,/except select id from owned/);
  assert.match(order.sql,/from wanted w, valid/); assert.match(order.sql,/p.user_id =/);
  assert.deepEqual(order.params,['[2,1]','A',2,2,'A']);
});

test('real Drizzle/Neon transport generates bounded reads, owned writes and one atomic reorder query', async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  const previous = neonConfig.fetchFunction;
  const queries: {query:string;params:unknown[]}[] = [];
  neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
    const q = JSON.parse(init.body as string); queries.push(q);
    if (q.query.includes('with wanted')) return Response.json({ fields:[{name:'ok',dataTypeID:16},{name:'count',dataTypeID:23}], rows:[['t','2']], command:'SELECT',rowCount:1 });
    return Response.json({fields:[],rows:[],command:'SELECT',rowCount:0});
  };
  try {
    await listPrayers('B','A',100); await patchPrayer('A',99,{audience:'public'}); await removePrayer('A',99);
    await insertPrayer('A',{content:'ok'}); await orderPrayers('A',[2,1]);
    assert.equal(queries.length,5);
    assert.match(queries[0].query,/limit \$\d+/); assert.ok(queries[0].params.includes('101')); assert.ok(queries[0].params.includes('100'));
    for (const q of queries.slice(1,3)) { assert.match(q.query,/"prayers"\."id" =/); assert.match(q.query,/"prayers"\."user_id" =/); assert.ok(q.params.includes('A')); }
    assert.ok(queries[3].params.includes('friends')); assert.match(queries[4].query,/with wanted/);
  } finally { neonConfig.fetchFunction = previous; delete process.env.DATABASE_URL; }
});


test('default Next prayer routes verify real local RSA token and pass awaited path params to SQL', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { GET: ownGET, POST } = await import('../src/app/api/v1/prayers/route.ts');
  const { GET: userGET } = await import('../src/app/api/v1/users/[id]/prayers/route.ts');
  const { PATCH, DELETE } = await import('../src/app/api/v1/prayers/[id]/route.ts');
  const { PUT } = await import('../src/app/api/v1/prayers/order/route.ts');
  const { publicKey, privateKey } = generateKeyPairSync('rsa',{modulusLength:2048});
  process.env.CLERK_JWT_KEY=publicKey.export({type:'spki',format:'pem'}).toString();
  process.env.CLERK_AUTHORIZED_PARTIES='http://localhost:8081';
  process.env.DATABASE_URL='postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  const now=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'fixture'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({sub:'A',sid:'session',azp:'http://localhost:8081',iss:'https://fixture.clerk.accounts.dev',iat:now,nbf:now-5,exp:now+60})).toString('base64url');
  const token=`${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
  const req=(method='GET',value?:unknown)=>new Request('http://localhost/api/v1/prayers', {method,headers:{authorization:`Bearer ${token}`},...(value===undefined?{}:{body:JSON.stringify(value)})});
  const previous=neonConfig.fetchFunction;const queries:{query:string;params:unknown[]}[]=[];
  neonConfig.fetchFunction=async(_url:string,init:RequestInit)=>{
    const q=JSON.parse(init.body as string);queries.push(q);
    if(q.query.includes('with wanted')) return Response.json({fields:[{name:'ok',dataTypeID:16}],rows:[['t']],command:'SELECT',rowCount:1});
    return Response.json({fields:[],rows:[],command:'SELECT',rowCount:0});
  };
  try{
    assert.equal((await ownGET(req())).status,200);
    assert.equal((await userGET(req(),{params:Promise.resolve({id:'B'})})).status,200);
    assert.equal(queries[1].params[0],'B'); assert.ok(queries[1].params.includes('A'));
    assert.equal((await PATCH(req('PATCH',{audience:'public'}),{params:Promise.resolve({id:'42'})})).status,404);
    assert.equal((await DELETE(req('DELETE'),{params:Promise.resolve({id:'42'})})).status,404);
    for(const q of queries.slice(2,4)){assert.ok(q.params.includes('A'));assert.ok(q.params.includes('42'));}
    assert.equal((await PUT(req('PUT',{ids:[]}))).status,200);
    const before=queries.length;
    assert.equal((await POST(new Request('http://localhost/api/v1/prayers',{method:'POST',body:'{}'}))).status,401);
    assert.equal(queries.length,before);
  }finally{neonConfig.fetchFunction=previous;delete process.env.DATABASE_URL;}
});



test('flag defaults off after authentication and prevents every repository call',async()=>{
  let calls=0;
  const blocked={list:async()=>{calls++;return[];},insert:async()=>{calls++;return fixture();},patch:async()=>{calls++;return fixture();},remove:async()=>{calls++;return fixture();},order:async()=>{calls++;return true;}};
  delete process.env.PRAYERS_API_ENABLED;
  try{
    for(const action of ['list','create','patch','delete','order'] as const){
      const res=await createPrayersHandler(action,'1',auth,blocked)(request());
      assert.equal(res.status,503);assert.equal((await res.json()).error.code,'PRAYERS_NOT_ACTIVE');
    }
    assert.equal(calls,0);
    assert.equal((await createPrayersHandler('list',undefined,r=>requireSubject(r),blocked)(request())).status,401);
  }finally{process.env.PRAYERS_API_ENABLED='true';}
});

test('PostgreSQL embedded executes real visibility, revocation, immutable cursor and atomic complete ordering',async()=>{
  const pg=new PGlite();
  const dialect=new PgDialect();
  process.env.DATABASE_URL='postgresql://u:p@ep-fixture.us-east-2.aws.neon.tech/db?sslmode=require';
  await pg.exec(`create table prayers(id integer primary key, user_id text not null, title text, content text not null default 'Texto', color text default 'default', position integer not null default 0, is_answered boolean default false, audience text not null default 'friends',created_at timestamp default now(),updated_at timestamp default now());
    create table follows(follower_id text,following_id text,primary key(follower_id,following_id));
    insert into prayers(id,user_id,audience,position) values(1,'A','friends',1),(2,'A','public',0),(3,'B','friends',0),(4,'B','public',1);`);
  const read=async(reader:string,owner:string,cursor=0)=>{
    const q=listPrayersQuery(reader,owner,cursor).toSQL();
    return (await pg.query<{id:number}>(q.sql,q.params)).rows.map(row=>row.id);
  };
  const order=async(ids:number[])=>{const q=dialect.sqlToQuery(orderStatement('A',ids));return (await pg.query<{ok:boolean}>(q.sql,q.params)).rows[0].ok;};
  const positions=async()=> (await pg.query('select id,position from prayers order by id')).rows;
  try{
    assert.deepEqual(await read('A','A'),[1,2]);assert.deepEqual(await read('B','A'),[2]);
    await pg.exec("insert into follows values ('B','A')");assert.deepEqual(await read('B','A'),[2]);
    await pg.exec("insert into follows values ('A','B')");assert.deepEqual(await read('B','A'),[1,2]);
    await pg.exec("delete from follows where follower_id='A'");assert.deepEqual(await read('B','A'),[2]);
    const before=await positions();
    for(const ids of [[1],[1,3],[1,1],[1,2,3]]){assert.equal(await order(ids),false);assert.deepEqual(await positions(),before);}
    assert.equal(await order([1,2]),true);assert.deepEqual((await positions()).slice(0,2),[{id:1,position:0},{id:2,position:1}]);
    await pg.exec("insert into prayers(id,user_id,audience) select i,'A','public' from generate_series(5,106) i");
    const first=await read('A','A');assert.equal(first.length,101);const cursor=first[99];
    await pg.exec('delete from prayers where id=1');
    const second=await read('A','A',cursor);
    assert.deepEqual([...first.slice(0,100),...second].filter(id=>id!==1), [2,...Array.from({length:102},(_,i)=>i+5)]);
    assert.ok(second.includes(106));
    await pg.exec("delete from prayers; insert into prayers(id,user_id,position) select i,'A',i-1000000000 from generate_series(1000000000,1000004999) i");
    const ids=Array.from({length:5000},(_,i)=>1000004999-i);
    assert.equal(validateOrder({ids}).length,5000);
    const handler=createPrayersHandler('order',undefined,auth,{...repo,order:async(_subject,received)=>order(received)});
    assert.equal((await handler(request('PUT',{ids}))).status,200);
    const persisted=await positions();assert.equal(persisted.length,5000);
    assert.equal((persisted[0] as {position:number}).position,4999);assert.equal((persisted[4999] as {position:number}).position,0);
    assert.equal((await handler(request('PUT',' '.repeat(65537)))).status,413);
  }finally{await pg.close();delete process.env.DATABASE_URL;}
});
