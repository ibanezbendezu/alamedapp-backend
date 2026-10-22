import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { HttpError } from '../src/server/http.ts';
import { neonConfig } from '@neondatabase/serverless';
import { amountString, hashPin, matchesPin, communityOperation, createCommunityHandler } from '../src/server/community.ts';
const fixture = readFileSync(new URL('./fixtures/community-legacy.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/20261021_complete_api.sql', import.meta.url), 'utf8');
const key = '12345678-1234-4234-8234-123456789abc';
process.env.DATABASE_URL = 'postgresql://u:p@ep-community.us-east-2.aws.neon.tech/db?sslmode=require';
delete process.env.EXPO_PUBLIC_DATABASE_URL;
test('exact decimal normalization and salted slow credentials', async () => {
    assert.equal(amountString('0001.1'), '1.10');
    assert.equal(amountString('999999999999999999.99'), '999999999999999999.99');
    for (const value of [1, 0, '0', '-1', '1e2', '1.001', '1000000000000000000', 'NaN', ' 1'])
        assert.throws(() => amountString(value));
    const first = await hashPin('826104');
    const second = await hashPin('826104');
    assert.notEqual(first, second);
    assert.equal(await matchesPin('826104', first), true);
    assert.equal(await matchesPin('000000', first), false);
    assert.equal(await matchesPin('123456', null), false);
});
test('authentication precedes all dependencies and actor injection is rejected', async () => {
    let invoked = 0;
    const run = async () => { invoked++; };
    const unauth = createCommunityHandler('transfer', async () => { throw new HttpError(401, 'UNAUTHORIZED', 'Sesión requerida'); }, run);
    assert.equal((await unauth(new Request('http://local/api', { method: 'POST', body: '{}' }))).status, 401);
    assert.equal(invoked, 0);
    const handler = createCommunityHandler('transfer', async () => 'A', run);
    const oversized=await handler(new Request('http://local/api',{method:'POST',body:JSON.stringify({pin:'1'.repeat(32769)})}));
    assert.equal(oversized.status,413);
    assert.equal((await oversized.json()).error.code,'BODY_TOO_LARGE');
    assert.equal(invoked,0);

    assert.equal((await handler(new Request('http://local/api', { method: 'POST', body: JSON.stringify({ senderId: 'B' }) }))).status, 400);
    assert.equal(invoked, 0);
});
test('preflight preserves incompatible legacy data without automatic normalization', async () => {
    const pg = new PGlite();
    const setups = ["update users set balance='NaN' where clerk_id='A'", "update transactions set amount='NaN'", "update users set balance=-1 where clerk_id='A'", "insert into streaks(user_a_id,user_b_id) values('A','B'),('B','A')", "insert into streak_requests(sender_id,receiver_id) values('A','B'),('B','A')", "insert into streak_requests(sender_id,receiver_id) values('A','A')"];
    try {
        for (const setup of setups) {
            await pg.exec(fixture);
            await pg.exec(setup);
            const snapshot = async () => Promise.all(['users', 'transactions', 'streaks', 'streak_requests', 'prayers'].map(async (table) => (await pg.query<Record<string, unknown>>(`select * from ${table}`)).rows));
            const before = await snapshot();
            await assert.rejects(pg.exec(migration), /Preflight/);
            await pg.exec('rollback');
            assert.deepEqual(await snapshot(), before);
            assert.equal((await pg.query<{
                n: number;
            }>("select count(*)::integer n from information_schema.columns where table_name='users' and column_name='pin_hash'")).rows[0].n, 0);
            await pg.exec('drop schema public cascade; create schema public');
        }
    }
    finally {
        await pg.close();
    }
});
test('production SQL: ownership, PIN lockout, atomic money, receipts, rollback, follows and Chile calendar', async () => {
    const pg = new PGlite();
    const old = neonConfig.fetchFunction;
    await pg.exec(fixture);
    const balances = (await pg.query<Record<string, unknown>>('select clerk_id,balance from users order by clerk_id')).rows;
    const history = (await pg.query<Record<string, unknown>>('select * from transactions')).rows;
    const prayers = (await pg.query<Record<string, unknown>>('select * from prayers')).rows;
    await pg.exec(migration);
    assert.deepEqual((await pg.query<Record<string, unknown>>('select clerk_id,balance from users order by clerk_id')).rows, balances);
    assert.deepEqual((await pg.query<Record<string, unknown>>('select * from transactions')).rows, history);
    assert.deepEqual((await pg.query<Record<string, unknown>>('select * from prayers')).rows, prayers);
    assert.equal((await pg.query<Record<string, unknown>>('select security_pin from users limit 1')).rows[0].security_pin, null);
    let afterWalletRead:(()=>Promise<unknown>)|undefined;
    neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
        const { query, params } = JSON.parse(init.body as string);
        try {
            const r = await pg.query<Record<string, unknown>>(query, params);
            if(query.includes('jsonb_agg')&&afterWalletRead){const action=afterWalletRead;afterWalletRead=undefined;await action();}
            return Response.json({ fields: r.fields, rows: r.rows.map(row => r.fields.map(field => { const value = row[field.name]; return value == null ? null : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? value ? 't' : 'f' : String(value); })), command: 'SELECT', rowCount: r.rows.length });
        }
        catch {
            return new Response('fixture failure', { status: 503 });
        }
    };
    const call = (actor: string, op: string, body: Record<string, unknown> = {}, params: Record<string, string> = {}, k: string | null = null) => communityOperation(actor, op, body, new URLSearchParams(params), k);
    const snapshot = async () => ({ users: (await pg.query<Record<string, unknown>>('select * from users order by clerk_id')).rows, tx: (await pg.query<Record<string, unknown>>('select * from transactions order by id')).rows, notifications: (await pg.query<Record<string, unknown>>('select * from notifications order by id')).rows, receipts: (await pg.query<Record<string, unknown>>('select * from transfer_receipts order by key')).rows });
    try {
        const profile = await call('A', 'profile', {}, { target: 'B' }) as Record<string, unknown>;
        const initial=await snapshot();
        for(const [target,status] of [['A',400],['missing',404]] as const){
            await assert.rejects(call('A','follow',{target,enabled:true}),{status});
            await assert.rejects(call('A','streak-action',{action:'request',target}),{status});
            assert.deepEqual(await snapshot(),initial);
        }
        for (const privateField of ['email', 'balance', 'pin_hash', 'securityPin'])
            assert.equal(privateField in profile, false);
        assert.equal(((await call('A', 'search', {}, { q: 'b@fixture.invalid' })) as {
            items: unknown[];
        }).items.length, 0);
        await pg.exec("insert into users(clerk_id,username,email) select 'page-'||lpad(n::text,3,'0'),'person-'||n,'person-'||n||'@fixture.invalid' from generate_series(1,61) n");
        const page1 = await call('A', 'search', {}, { q: 'person-' }) as {
            items: {
                clerkId: string;
            }[];
            nextCursor: string;
        };
        assert.equal(page1.items.length, 50);
        const page2 = await call('A', 'search', {}, { q: 'person-', cursor: page1.nextCursor }) as {
            items: {
                clerkId: string;
            }[];
            nextCursor: null;
        };
        assert.equal(page2.items.length, 11);
        assert.equal(page2.nextCursor, null);
        assert.equal(new Set([...page1.items, ...page2.items].map(p => p.clerkId)).size, 61);
        const transfer = { receiverId: 'B', amount: '0.01', description: 'Exacta', pin: '826104' };
        await assert.rejects(call('A', 'transfer', transfer, {}, key), { code: 'PIN_REQUIRED' });
        await call('A', 'pin', { pin: '826104' });
        const hash = (await pg.query<Record<string, unknown>>("select pin_hash from users where clerk_id='A'")).rows[0].pin_hash;
        assert.match(String(hash), /^scrypt:/);
        const validPairState=await snapshot();
        for(const [receiverId,status] of [['A',400],['missing',404]] as const){await assert.rejects(call('A','transfer',{...transfer,receiverId},{},key),{status});assert.deepEqual(await snapshot(),validPairState);}
        for (let i = 0; i < 5; i++)
            await assert.rejects(call('A', 'transfer', { ...transfer, pin: '000000' }, {}, key), { code: 'INVALID_PIN' });
        await assert.rejects(call('A', 'transfer', transfer, {}, key), { code: 'PIN_LOCKED' });
        assert.equal((await pg.query<Record<string, unknown>>("select pin_locked_until>now() locked from users where clerk_id='A'")).rows[0].locked, true);
        await pg.exec("update users set pin_locked_until=null where clerk_id='A'");
        const before = await snapshot();
        afterWalletRead=()=>call('A','transfer',transfer,{},key);
        const earlierWallet=await call('A','wallet') as {balance:string;transactions:{type:string}[]};
        assert.equal(earlierWallet.balance,'100.01');assert.equal(earlierWallet.transactions.length,1);
        const currentWallet=await call('A','wallet') as {balance:string;transactions:{type:string}[]};
        assert.equal(currentWallet.balance,'100.00');assert.equal(currentWallet.transactions[0].type,'out');
        const receipt = await call('A', 'transfer', transfer, {}, key);
        assert.deepEqual(await call('A', 'transfer', transfer, {}, key), receipt);
        assert.deepEqual((await pg.query<Record<string, unknown>>("select balance::text from users where clerk_id in('A','B','C') order by clerk_id")).rows.map(r => r.balance), ['100.00', '0.03', '0.00']);
        assert.equal((await pg.query<Record<string, unknown>>('select count(*)::integer n from transactions')).rows[0].n, 3);
        assert.equal((await pg.query<Record<string, unknown>>('select sum(balance)::text total from users')).rows[0].total, '100.03');
        await assert.rejects(call('A', 'transfer', { ...transfer, amount: '0.02' }, {}, key), { code: 'IDEMPOTENCY_CONFLICT' });
        const stable = await snapshot();
        await assert.rejects(call('A', 'transfer', { ...transfer, amount: '100.01' }, {}, '22345678-1234-4234-8234-123456789abc'), { code: 'INSUFFICIENT_FUNDS' });
        const rejectedState=await snapshot();
        assert.deepEqual(rejectedState.users,stable.users);assert.deepEqual(rejectedState.tx,stable.tx);assert.deepEqual(rejectedState.notifications,stable.notifications);
        assert.equal(rejectedState.receipts.length,stable.receipts.length+1);
        await pg.exec("update users set balance=101 where clerk_id='A'");
        await assert.rejects(call('A','transfer',{...transfer,amount:'100.01'},{},'22345678-1234-4234-8234-123456789abc'),{code:'INSUFFICIENT_FUNDS',status:409});
        const rejection=(await pg.query<{fingerprint:string}>("select fingerprint from transfer_receipts where key='22345678-1234-4234-8234-123456789abc'")).rows[0];
        assert.equal((await pg.query<{data:{error:string}}>("select api_transfer('A','B',100.01,'Exacta','22345678-1234-4234-8234-123456789abc',$1,$2) data",[rejection.fingerprint,hash])).rows[0].data.error,'INSUFFICIENT_FUNDS');
        assert.equal((await pg.query<{balance:string}>("select balance::text from users where clerk_id='A'")).rows[0].balance,'101.00');
        await pg.exec("update users set balance=100 where clerk_id='A'; update users set balance=999999999999999999.99 where clerk_id='B'");
        const limitKey='42345678-1234-4234-8234-123456789abc';
        await assert.rejects(call('A','transfer',transfer,{},limitKey),{code:'BALANCE_LIMIT'});
        await pg.exec("update users set balance=0.03 where clerk_id='B'");
        await assert.rejects(call('A','transfer',transfer,{},limitKey),{code:'BALANCE_LIMIT'});
        assert.deepEqual((await snapshot()).tx,stable.tx);
        // Faults after debit, credit, either ledger insert, notice and receipt each abort the entire statement.
        for (const [table, condition] of [['users', "new.clerk_id='A'"], ['users', "new.clerk_id='B'"], ['transactions', "new.type='out'"], ['transactions', "new.type='in'"], ['notifications', 'true'], ['transfer_receipts', 'true']]) {
            await pg.exec(`create function fixture_fail() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'injected'; end if; return new; end $$;create trigger fixture_fail before insert or update on ${table} for each row execute function fixture_fail();`);
            const snapshotBefore = await snapshot();
            await assert.rejects(call('A', 'transfer', transfer, {}, '32345678-1234-4234-8234-123456789abc'));
            assert.deepEqual(await snapshot(), snapshotBefore);
            await pg.exec(`drop trigger fixture_fail on ${table};drop function fixture_fail();`);
        }
        assert.notDeepEqual(await snapshot(), before);
        await Promise.all([call('A', 'follow', { target: 'B', enabled: true }), call('A', 'follow', { target: 'B', enabled: true })]);
        await call('B', 'follow', { target: 'A', enabled: true });
        assert.equal((await pg.query<Record<string, unknown>>('select count(*)::integer n from follows')).rows[0].n, 2);
        await call('A', 'streak-action', { action: 'request', target: 'B' });
        await call('A', 'streak-action', { action: 'request', target: 'B' });
        const rid = (await pg.query<Record<string, unknown>>('select id from streak_requests')).rows[0].id;
        await assert.rejects(call('C', 'streak-action', { action: 'accept', id: rid }), { code: 'NOT_FOUND' });
        await call('B', 'streak-action', { action: 'accept', id: rid });
        await call('B', 'streak-action', { action: 'accept', id: rid });
        const sid = (await pg.query<Record<string, unknown>>('select id from streaks')).rows[0].id;
        assert.deepEqual(await call('A','streak-action',{action:'presence',id:sid}),{ok:true,success:false});
        await assert.rejects(call('C', 'streak-detail', {}, { id: String(sid) }), { code: 'NOT_FOUND' });
        await pg.exec("update streaks set user_b_stoke_at=timezone('UTC',clock_timestamp()-interval '6 seconds')");
        assert.equal((await call('A', 'streak-action', { action: 'presence', id: sid }) as {
            success: boolean;
        }).success, false);
        await call('A', 'streak-action', { action: 'presence', id: sid });
        await call('B', 'streak-action', { action: 'presence', id: sid });
        await call('A', 'streak-action', { action: 'presence', id: sid });
        assert.equal((await pg.query<Record<string, unknown>>('select count from streaks')).rows[0].count, 1);
        await pg.exec("update streaks set count=8,last_stoked_at=timezone('UTC',clock_timestamp()-interval '3 days')");
        assert.equal((await call('A', 'streak-detail', {}, { id: String(sid) }) as {
            count: number;
        }).count, 0);
        await call('A', 'streak-action', { action: 'presence', id: sid });
        assert.equal((await pg.query<Record<string, unknown>>('select count from streaks')).rows[0].count, 1);
        await pg.exec("update streaks set count=8,last_stoked_at=((timezone('America/Santiago',clock_timestamp())::date-1+time '12:00') at time zone 'America/Santiago') at time zone 'UTC',user_a_stoke_at=null,user_b_stoke_at=timezone('UTC',clock_timestamp()-interval '4 seconds')");
        assert.equal((await call('A', 'streak-detail', {}, { id: String(sid) }) as {
            count: number;
        }).count, 8);
        assert.equal((await call('A', 'streak-action', { action: 'presence', id: sid }) as {
            success: boolean;
        }).success, true);
        assert.equal((await pg.query<Record<string, unknown>>('select count from streaks')).rows[0].count, 9);
        // Exercise the SAME production count function used by reads and stoking across DST and grace.
        for (const [last, now, expected] of [
            ['2026-09-06 04:30', '2026-09-07 03:30Z', 8], // 23h day, next Chile date: preserve
            ['2026-09-06 03:30', '2026-09-07 03:30Z', 0], // 24h but two Chile dates: expired
            ['2026-09-06 04:30', '2026-09-08 02:59:59Z', 8], // final second of next local day
            ['2026-09-06 04:30', '2026-09-08 03:00:00Z', 0], // grace ended at local midnight
            ['2026-04-04 15:00', '2026-04-06 03:59:59Z', 8], // autumn DST, longer next day
            ['2026-04-04 15:00', '2026-04-06 04:00:00Z', 0],
        ] as const) {
            assert.equal((await pg.query<{
                count: number;
            }>('select api_streak_count($1::timestamp,8,$2::timestamptz) count', [last, now])).rows[0].count, expected);
        }
        const notice = (await pg.query<Record<string, unknown>>("select id from notifications where recipient_id='B' limit 1")).rows[0].id;
        await call('C', 'notification-dismiss', { id: notice });
        await call('C', 'notification-read', { maxId: notice });
        assert.deepEqual((await pg.query('select dismissed,is_read from notifications where id=$1', [notice])).rows[0], { dismissed: false, is_read: false });
        assert.equal((await call('C', 'notifications') as {
            items: unknown[];
        }).items.length, 0);
        await call('A', 'follow', { target: 'B', enabled: false });
        assert.equal((await pg.query<Record<string, unknown>>('select is_active from streaks')).rows[0].is_active, false);
        await assert.rejects(call('A','pin',{pin:'752013'}),{code:'INVALID_PIN'});
        assert.equal((await pg.query<{pin_hash:string}>("select pin_hash from users where clerk_id='A'")).rows[0].pin_hash,hash);
        await assert.rejects(call('A','pin',{pin:'752013',previousPin:'000000'}),{code:'INVALID_PIN'});
        assert.equal((await pg.query<{pin_hash:string}>("select pin_hash from users where clerk_id='A'")).rows[0].pin_hash,hash);
        await call('A','pin',{pin:'752013',previousPin:'826104'});
        const replacement=(await pg.query<{pin_hash:string}>("select pin_hash from users where clerk_id='A'")).rows[0].pin_hash;
        assert.notEqual(replacement,hash);assert.equal(await matchesPin('752013',replacement),true);
        await assert.rejects(call('A','transfer',transfer,{},'52345678-1234-4234-8234-123456789abc'),{code:'INVALID_PIN'});
        assert.equal((await pg.query<{data:{error:string}}>("select api_transfer('A','B',0.01,'old credential','62345678-1234-4234-8234-123456789abc','old',$1) data",[hash])).rows[0].data.error,'PIN_CHANGED');
        // Preserve stored legacy identifiers and exact hex strings; no migration/normalization.
        for(const color of ['slate','blue','green','red','purple','amber','#12aBcD']){
            await pg.query("update users set card_color=$1 where clerk_id='A'",[color]);
            assert.equal((await call('A','wallet') as {cardColor:string}).cardColor,color);
            await call('A','card-color',{color});
            assert.equal((await pg.query<{card_color:string}>("select card_color from users where clerk_id='A'")).rows[0].card_color,color);
            assert.equal((await pg.query<{card_color:string}>("select card_color from users where clerk_id='B'")).rows[0].card_color,'#1A1A1A');
        }
        for(const color of ['Slate','BLUE','orange',' blue ','#abc','#12345678','rgb(0,0,0)','__proto__',null,4]){
            const beforeInvalid=await snapshot();
            await assert.rejects(call('A','card-color',{color}),{status:400,code:'INVALID_COLOR'});
            assert.deepEqual(await snapshot(),beforeInvalid);
        }
    }
    finally {
        neonConfig.fetchFunction = old;
        await pg.close();
    }
});
