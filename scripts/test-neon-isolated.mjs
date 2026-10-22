import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Pool,neonConfig} from '@neondatabase/serverless';
// Never invoked by npm test. Requires a dedicated EMPTY database, never the application URL.
if(process.env.NEON_ISOLATED_TEST_CONFIRM!=='EMPTY_DISPOSABLE_DATABASE'||!process.env.NEON_ISOLATED_TEST_URL)throw new Error('Set NEON_ISOLATED_TEST_URL and NEON_ISOLATED_TEST_CONFIRM=EMPTY_DISPOSABLE_DATABASE explicitly.');
if(process.env.NEON_ISOLATED_TEST_URL===process.env.DATABASE_URL)throw new Error('Application database is prohibited.');
neonConfig.webSocketConstructor=WebSocket;
const pool=new Pool({connectionString:process.env.NEON_ISOLATED_TEST_URL,max:4});
const schema='api_fixture_'+randomUUID().replaceAll('-','');
const clients=await Promise.all([pool.connect(),pool.connect()]);
try{
 const existing=await clients[0].query("select count(*)::integer n from pg_tables where schemaname not in ('pg_catalog','information_schema')");
 if(existing.rows[0].n!==0)throw new Error('Refusing non-empty database. Use a dedicated disposable Neon branch/database.');
 await clients[0].query(`create schema ${schema}`);
 for(const client of clients)await client.query(`set search_path to ${schema},public`);
 await clients[0].query(readFileSync(new URL('../tests/fixtures/community-legacy.sql',import.meta.url),'utf8'));
 await clients[0].query(readFileSync(new URL('../migrations/20261021_complete_api.sql',import.meta.url),'utf8'));
 await clients[0].query("update users set pin_hash='isolated-fixture-hash' where clerk_id='A'");
 const key=randomUUID();const query="select api_transfer('A','B',60.01,'isolated',$1::uuid,'canonical','isolated-fixture-hash') data";
 const replay=await Promise.all(clients.map(c=>c.query(query,[key])));assert.deepEqual(replay[0].rows,replay[1].rows);
 // A now has 40.00: either 30.00 is affordable, both together are not.
 const contenderKeys=clients.map(()=>randomUUID());
 const attempts=await Promise.all(clients.map((c,i)=>c.query("select api_transfer('A','B',30.00,'isolated-race',$1::uuid,'race-canonical','isolated-fixture-hash') data",[contenderKeys[i]])));
 assert.equal(attempts.filter(r=>!r.rows[0].data.error).length,1);
 assert.equal(attempts.filter(r=>r.rows[0].data.error==='INSUFFICIENT_FUNDS').length,1);
 assert.deepEqual((await clients[0].query("select balance::text from users where clerk_id in('A','B') order by clerk_id")).rows.map(r=>r.balance),['10.00','90.03']);
 const ledger=await clients[0].query("select type,amount::text from transactions where description='isolated-race' order by type");
 assert.deepEqual(ledger.rows,[{type:'in',amount:'30.00'},{type:'out',amount:'30.00'}]);
 assert.equal((await clients[0].query('select count(*)::integer n from transactions')).rows[0].n,5);
 assert.equal((await clients[0].query('select count(*)::integer n from transfer_receipts')).rows[0].n,3);
 const receipts=await clients[0].query('select receipt from transfer_receipts where key in($1::uuid,$2::uuid)',contenderKeys);
 assert.equal(receipts.rows.filter(r=>r.receipt.amount==='30.00'&&r.receipt.outId&&r.receipt.inId).length,1);
 assert.deepEqual(receipts.rows.filter(r=>r.receipt.error).map(r=>r.receipt),[{error:'INSUFFICIENT_FUNDS',terminal:true}]);
 const conserved=await clients[0].query('select sum(balance)::text total,min(balance)::text minimum from users');assert.equal(conserved.rows[0].total,'100.03');assert.ok(Number(conserved.rows[0].minimum)>=0);
 const notifications=await clients[0].query("select count(*)::integer n from notifications where type='transfer'");assert.equal(notifications.rows[0].n,2);
 const follows=await Promise.all(clients.map(c=>c.query("select api_follow('A','B',true)")));assert.equal(follows.length,2);assert.equal((await clients[0].query('select count(*)::integer n from follows')).rows[0].n,1);
 await clients[0].query("select api_follow('B','A',true)");
 await clients[0].query("select api_streak('A','request','B',null)");
 const request=(await clients[0].query('select id from streak_requests')).rows[0].id;
 await clients[0].query("select api_streak('B','accept',null,$1)",[request]);
 const streak=(await clients[0].query('select id from streaks')).rows[0].id;
 await clients[0].query("update streaks set user_b_stoke_at=timezone('UTC',clock_timestamp())");
 await clients[0].query('begin');
 await clients[0].query("select clerk_id from users where clerk_id in('A','B') order by clerk_id for update");
 const waiting=clients[1].query("select api_streak('A','presence',null,$1) data",[streak]);
 await clients[0].query('select pg_sleep(6)');
 await clients[0].query('commit');
 assert.equal((await waiting).rows[0].data.success,false,'presence clock must be sampled after waiting for account locks');
 assert.equal((await clients[0].query('select count from streaks')).rows[0].count,0);
 await Promise.all(clients.map(c=>c.query("select api_pin_attempt('A','isolated-fixture-hash',false)")));
 await Promise.all(clients.map(c=>c.query("select api_pin_attempt('A','isolated-fixture-hash',false)")));
 const failures=await Promise.all(clients.map(c=>c.query("select api_pin_attempt('A','isolated-fixture-hash',false) data")));
 assert.ok(failures.some(r=>r.rows[0].data.error==='PIN_LOCKED'));
 console.log('Isolated Neon multi-connection replay, overdraft, conservation and follow checks passed.');
}finally{
 // The generated, validated identifier is the only removal target.
 await clients[0].query(`drop schema if exists ${schema} cascade`);
 for(const client of clients)client.release();await pool.end();
}
