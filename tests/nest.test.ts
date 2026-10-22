import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Route } from '../src/app.ts';
import { createPatchMeHandler, createReadyHandler } from '../src/server/handlers.ts';
import { apiHandler } from '../src/server/http.ts';

// Exercise emitted production code with a real HTTP socket, without loading .env.
const compiled = new URL('../dist/app.js', import.meta.url).href;
const { createApplication } = await import(compiled);
async function serve(endpoints: Route[] | undefined, run: (base: string) => Promise<void>) {
  const app = await createApplication(endpoints);
  try { await app.listen(0, '127.0.0.1'); await run(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`); }
  finally { await app.close(); }
}
function streamed(url: string, chunks: string[], headers: Record<string,string> = {}) {
  return new Promise<{status: number; body: string}>((resolve,reject) => {
    const req = httpRequest(url, {method: 'PATCH', headers}, response => {
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
    const missing = await fetch(base+'/api/unknown'); assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'NOT_FOUND');
    const malformed = await fetch(base+'/api/v1/prayers/%broken',{headers:{origin:'http://localhost:8081'}});
    assert.equal(malformed.status,400); assert.equal((await malformed.json()).error.code,'INVALID_PATH');
    assert.ok(malformed.headers.get('x-request-id'));assert.equal(malformed.headers.get('access-control-allow-origin'),'http://localhost:8081');
    const head = await fetch(base+'/api/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await streamed(base+'/api/v1/me',['x'.repeat(40000)])).status,401);
  });
});

test('compiled Nest streams body limits and injected failures through existing envelopes', async () => {
  let writes = 0; let target = '';
  const patch = createPatchMeHandler(async () => 'subject',async () => {writes++;throw new Error("Unexpected write");});
  const endpoints: Route[] = [
    {path:'/api/v1/me',methods:{PATCH:patch}},
    {path:'/api/ready',methods:{GET:createReadyHandler(async()=>{},()=>50)}},
    {path:'/api/failure',methods:{GET:apiHandler(()=>{throw new Error('private SQL secret');})}},
    {path:'/api/v1/users/:id/prayers',methods:{GET:async (_request,id)=>{target=id;return Response.json({data:[]});}}},
  ];
  await serve(endpoints, async base => {
    assert.equal((await fetch(base+'/api/ready')).status,200);
    assert.equal((await streamed(base+'/api/v1/me',['{'])).status,400);
    assert.equal((await streamed(base+'/api/v1/me',[' '.repeat(16384),' '.repeat(16384)])).status,400);
    assert.equal((await streamed(base+'/api/v1/me',[' '.repeat(16384),' '.repeat(16385)])).status,413);
    assert.equal((await fetch(base+'/api/v1/me',{method:'PATCH',body:' '.repeat(32769)})).status,413);
    assert.equal(writes,0);
    const failure = await fetch(base+'/api/failure'); assert.equal(failure.status,500);
    assert.ok(!(await failure.text()).includes('private SQL'));
    assert.equal((await fetch(base+'/api/v1/users/alice%40test/prayers')).status,200);assert.equal(target,'alice@test');
  });
});

