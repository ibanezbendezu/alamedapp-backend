import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderOverride } from '../src/app.ts';

// Exercise emitted production code with a real HTTP socket, without loading .env.
const compiled = new URL('../dist/app.js', import.meta.url).href;
const { createApplication, declaredRoutes } = await import(compiled);
const { AuthService } = await import(new URL('../dist/nest/http.js',import.meta.url).href);
const { ProfilesService, PrayersService, HealthService, CommunityService, StreaksService, WalletService } = await import(new URL('../dist/nest/services.js',import.meta.url).href);
const { DatabaseService } = await import(new URL('../dist/nest/database.js',import.meta.url).href);
async function serve(overrides: ProviderOverride[] | undefined, run: (base: string) => Promise<void>) {
  const app = await createApplication(overrides);
  try { await app.listen(0, '127.0.0.1'); await run(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`); }
  finally { await app.close(); }
}
function streamed(url: string, chunks: string[], headers: Record<string,string> = {}, method = 'PATCH') {
  return new Promise<{status: number; body: string}>((resolve,reject) => {
    const req = httpRequest(url, {method, headers}, response => {
      let body = ''; response.on('data', chunk => {body += chunk;});
      response.on('end', () => resolve({status: response.statusCode!, body}));
    });
    req.on('error',reject); for (const chunk of chunks) req.write(chunk); req.end();
  });
}

test('compiled Nest preserves routing, auth before dependencies, CORS and safe errors', async () => {
  delete process.env.DATABASE_URL; delete process.env.CLERK_SECRET_KEY; delete process.env.CLERK_JWT_KEY;
  process.env.API_ALLOWED_ORIGINS = 'http://localhost:8081';
  await serve(undefined, async base => {
    assert.deepEqual(await (await fetch(base+'/api/health')).json(), {status:'ok'});
    const ready = await fetch(base+'/api/ready'); assert.equal(ready.status,503);
    const error = await ready.json(); assert.equal(error.error.code,'DATABASE_UNAVAILABLE');
    assert.equal(error.error.requestId,ready.headers.get('x-request-id'));
    const protectedRoutes = [
      ['GET','/api/v1/me'],['PATCH','/api/v1/me'],['POST','/api/v1/me/sync'],
      ['GET','/api/v1/me/medals'],['GET','/api/v1/medals'],['GET','/api/v1/prayers'],
      ['POST','/api/v1/prayers'],['PUT','/api/v1/prayers/order'],['PATCH','/api/v1/prayers/42'],
      ['DELETE','/api/v1/prayers/42'],['GET','/api/v1/users/alice/prayers'],
      ['GET','/api/v1/community/wallet'],['POST','/api/v1/community/transfer'],
    ];
    for (const [method,path] of protectedRoutes) {
      const response = await fetch(base+path,{method,...(['POST','PUT','PATCH'].includes(method)?{body:'invalid json'}:{})});
      assert.equal(response.status,401,method+' '+path); assert.equal(response.headers.get('cache-control'),'no-store');
      for (const origin of ['http://localhost:8081','http://untrusted.test']) {
        const preflight = await fetch(base+path,{method:'OPTIONS',headers:{origin}});
        assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin.includes('localhost')?origin:null);
      }
    }
    assert.equal((await fetch(base+'/api/v1/me',{method:'POST'})).status,405);
    for (const method of ['GET','PATCH','DELETE']) assert.equal((await fetch(base+'/api/v1/prayers/order',{method})).status,405);
    const missing = await fetch(base+'/api/unknown'); assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'NOT_FOUND');
    const malformed = await fetch(base+'/api/v1/prayers/%broken',{headers:{origin:'http://localhost:8081'}});
    assert.equal(malformed.status,400); assert.equal((await malformed.json()).error.code,'INVALID_PATH');
    assert.ok(malformed.headers.get('x-request-id'));assert.equal(malformed.headers.get('access-control-allow-origin'),'http://localhost:8081');
    const head = await fetch(base+'/api/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await streamed(base+'/api/v1/me',['x'.repeat(40000)])).status,401);
  });
});

test('compiled native controllers run auth once, pipes and injected services without DB', async () => {
  let calls = 0; let authentications = 0; let databaseCalls = 0;
  const actions: string[] = [];
  const record = (action: string) => async (...args: unknown[]) => { calls++; actions.push(action); return {data: args}; };
  const overrides = [
    {provide: AuthService,useValue:{authenticate: async () => {authentications++;return 'token-actor';}}},
    {provide: DatabaseService,useValue:{get:()=>{databaseCalls++;throw new Error('unexpected DB');}}},
    {provide: ProfilesService,useValue:{me:record('me'),patch:record('patch'),sync:record('sync'),medals:record('medals'),profile:record('profile'),search:record('search')}},
    {provide: PrayersService,useValue:{list:record('list'),create:record('create'),patch:record('prayer-patch'),remove:record('remove'),order:record('order')}},
    {provide: CommunityService,useValue:{follow:record('follow'),notifications:record('notifications'),readNotification:record('read'),dismissNotification:record('dismiss')}},
    {provide: StreaksService,useValue:{list:record('streaks'),detail:record('detail'),requests:record('requests'),action:record('action')}},
    {provide: WalletService,useValue:{wallet:record('wallet'),cardColor:record('color'),pin:record('pin'),transfer:record('transfer')}},
    {provide: HealthService,useValue:{health:()=>({status:'ok'}),ready:()=>{throw new Error('private SQL secret');}}},
  ];
  process.env.PRAYERS_API_ENABLED = 'true';
  await serve(overrides, async base => {
    assert.equal(declaredRoutes().length,27);
    assert.equal((await streamed(base+'/api/v1/me',['{'])).status,400);
    assert.equal((await streamed(base+'/api/v1/me',[' '.repeat(16384),' '.repeat(16384)])).status,400);
    assert.equal((await streamed(base+'/api/v1/me',[' '.repeat(16384),' '.repeat(16385)])).status,413);
    assert.equal((await fetch(base+'/api/v1/me',{method:'PATCH',body:' '.repeat(32769)})).status,413);
    assert.equal((await fetch(base+'/api/v1/me',{method:'PATCH',body:JSON.stringify({clerkId:'spoof'})})).status,400);
    assert.equal(calls,0);
    const good = await fetch(base+'/api/v1/me',{method:'PATCH',body:JSON.stringify({displayName:'Name'})});
    assert.equal(good.status,200);assert.deepEqual((await good.json()).data,['token-actor',{displayName:'Name'}]);
    const before = authentications;
    for (const [method,path,body] of [
      ['POST','/api/v1/me/sync','{}'],['POST','/api/v1/community/follow','{"target":"friend","enabled":true}'],
      ['GET','/api/v1/community/wallet',undefined],['GET','/api/v1/community/streaks',undefined],
      ['GET','/api/v1/community/profile?target=friend',undefined],['GET','/api/v1/community/search?q=friend',undefined],
      ['GET','/api/v1/users/alice/prayers',undefined],
    ]) assert.equal((await fetch(base+path,{method,body})).status,200);
    assert.equal(authentications-before,7);
    assert.deepEqual(actions,['patch','sync','follow','wallet','streaks','profile','search','list']);
    assert.equal((await fetch(base+'/api/v1/users/alice%40test/prayers')).status,400);
    assert.equal((await fetch(base+'/api/v1/prayers?unexpected=true')).status,400);
    const count = calls;
    assert.equal((await streamed(base+'/api/v1/prayers/order',[' '.repeat(32768),' '.repeat(32768)],{},'PUT')).status,400);
    assert.equal((await streamed(base+'/api/v1/prayers/order',[' '.repeat(32768),' '.repeat(32769)],{},'PUT')).status,413);
    assert.equal((await fetch(base+'/api/v1/prayers/order',{method:'PUT',body:'{"ids":[1,1]}'})).status,400);
    assert.equal(calls,count);
    assert.equal((await fetch(base+'/api/v1/prayers/order',{method:'PUT',body:'{"ids":[1,2]}'})).status,200);
    process.env.PRAYERS_API_ENABLED = 'false';
    assert.equal((await streamed(base+'/api/v1/prayers',['x'.repeat(70000)],{},'POST')).status,503);
    const failure = await fetch(base+'/api/ready');assert.equal(failure.status,500);assert.ok(!(await failure.text()).includes('private SQL'));
    assert.equal((await fetch(base+'/api/health')).status,200);
    assert.equal(databaseCalls,0);
  });
  delete process.env.PRAYERS_API_ENABLED;
});

test('DatabaseModule supplies the live lazy dependency to a native service', async () => {
  let probes = 0;
  process.env.DATABASE_URL = 'postgresql://test:test@fixture.neon.tech/test?sslmode=require';
  await serve([{provide:DatabaseService,useValue:{get:()=>({execute:async()=>{probes++;}})}}],async base => {
    assert.equal((await fetch(base+'/api/health')).status,200);assert.equal(probes,0);
    assert.equal((await fetch(base+'/api/ready')).status,200);assert.equal(probes,1);
  });
  delete process.env.DATABASE_URL;
});

test('legacy community HEAD authenticates before method policy without services or DB', async () => {
  const { HttpError } = await import(new URL('../dist/server/http.js',import.meta.url).href);
  let authentications = 0; let serviceCalls = 0; let databaseCalls = 0;
  const read = () => {serviceCalls++;return {data:[]};};
  await serve([
    {provide:AuthService,useValue:{authenticate:async (request: Request)=>{
      authentications++;
      if (request.headers.get('authorization') !== 'Bearer test') throw new HttpError(401,'UNAUTHORIZED','Sesión requerida.');
      return 'token-actor';
    }}},
    {provide:DatabaseService,useValue:{get:()=>{databaseCalls++;throw new Error('unexpected DB');}}},
    {provide:ProfilesService,useValue:{profile:read,search:read,me:read}},
    {provide:CommunityService,useValue:{notifications:read}},
    {provide:StreaksService,useValue:{list:read,detail:read,requests:read}},
    {provide:WalletService,useValue:{wallet:read}},
  ],async base=>{
    for (const operation of ['profile','search','notifications','streaks','streak-detail','streak-requests','wallet']) {
      for (const authenticated of [false,true]) {
        const before = authentications;
        const response = await fetch(base+'/api/v1/community/'+operation,{method:'HEAD',headers:authenticated?{authorization:'Bearer test'}:{}});
        assert.equal(response.status,authenticated?405:401,operation);
        assert.equal(await response.text(),'');
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.ok(response.headers.get('x-request-id'));
        assert.equal(authentications,before+1);
      }
    }
    assert.equal(serviceCalls,0);assert.equal(databaseCalls,0);
    const health = await fetch(base+'/api/health',{method:'HEAD'});
    assert.equal(health.status,200);assert.equal(await health.text(),'');
    const own = await fetch(base+'/api/v1/me',{method:'HEAD',headers:{authorization:'Bearer test'}});
    assert.equal(own.status,200);assert.equal(await own.text(),'');assert.equal(serviceCalls,1);
    assert.equal(databaseCalls,0);
  });
});
