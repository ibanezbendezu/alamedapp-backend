-- Apply manually after backup and preflight. Entire migration is atomic.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM users WHERE balance < 0 OR balance='NaN'::numeric)
 OR EXISTS(SELECT 1 FROM transactions WHERE amount <= 0 OR amount='NaN'::numeric) THEN
   RAISE EXCEPTION 'Preflight: incompatible legacy balance/amount; reconcile explicitly before migration'; END IF;
 IF EXISTS(SELECT 1 FROM streaks GROUP BY least(user_a_id,user_b_id),greatest(user_a_id,user_b_id) HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM streak_requests WHERE status='pending' GROUP BY least(sender_id,receiver_id),greatest(sender_id,receiver_id) HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM streaks WHERE user_a_id=user_b_id)
 OR EXISTS(SELECT 1 FROM streak_requests WHERE sender_id=receiver_id) THEN
   RAISE EXCEPTION 'Preflight: incompatible duplicate/self streak pairs; reconcile explicitly before migration'; END IF;
END $$;
ALTER TABLE users ALTER COLUMN security_pin DROP NOT NULL;
ALTER TABLE users ALTER COLUMN security_pin DROP DEFAULT;
UPDATE users SET security_pin=NULL;
ALTER TABLE users ADD COLUMN pin_hash text, ADD COLUMN pin_failures integer NOT NULL DEFAULT 0,
 ADD COLUMN pin_locked_until timestamptz;
ALTER TABLE users ADD CONSTRAINT users_nonnegative_balance CHECK(balance>=0 AND balance<>'NaN'::numeric);
ALTER TABLE transactions ADD CONSTRAINT transactions_positive_amount CHECK(amount>0 AND amount<>'NaN'::numeric);
CREATE UNIQUE INDEX streak_pair_unique ON streaks(least(user_a_id,user_b_id),greatest(user_a_id,user_b_id));
CREATE UNIQUE INDEX streak_pending_pair_unique ON streak_requests(least(sender_id,receiver_id),greatest(sender_id,receiver_id)) WHERE status='pending';
ALTER TABLE streaks ADD CONSTRAINT streak_distinct_members CHECK(user_a_id<>user_b_id);
ALTER TABLE streak_requests ADD CONSTRAINT streak_request_distinct_members CHECK(sender_id<>receiver_id);
CREATE TABLE transfer_receipts(actor_id varchar(255) NOT NULL REFERENCES users(clerk_id), key uuid NOT NULL,
 fingerprint text NOT NULL, receipt jsonb NOT NULL, PRIMARY KEY(actor_id,key));

-- Functions are SECURITY INVOKER. The backend is the only database credential owner.
-- Account locks always use the same order for transfers, follows and streak mutations.
CREATE FUNCTION api_pair_lock(a text,b text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM clerk_id FROM users WHERE clerk_id IN(a,b) ORDER BY clerk_id FOR UPDATE;
 IF a=b THEN RAISE EXCEPTION USING ERRCODE='PAP01',MESSAGE='INVALID_PAIR'; END IF;
 IF NOT EXISTS(SELECT 1 FROM users WHERE clerk_id=a) OR NOT EXISTS(SELECT 1 FROM users WHERE clerk_id=b) THEN
 RAISE EXCEPTION USING ERRCODE='PAP04',MESSAGE='NOT_FOUND'; END IF;
END $$;

CREATE FUNCTION api_follow(a text,b text,enabled boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 PERFORM api_pair_lock(a,b);
 IF enabled THEN
 INSERT INTO follows(follower_id,following_id) VALUES(a,b) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
 UPDATE users SET following_count=following_count+1 WHERE clerk_id=a;
 UPDATE users SET follower_count=follower_count+1 WHERE clerk_id=b;
 INSERT INTO notifications(recipient_id,actor_id,type) VALUES(b,a,'follow'); END IF;
 ELSE
 DELETE FROM follows WHERE follower_id=a AND following_id=b;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
 UPDATE users SET following_count=greatest(0,following_count-1) WHERE clerk_id=a;
 UPDATE users SET follower_count=greatest(0,follower_count-1) WHERE clerk_id=b;
 UPDATE streaks SET is_active=false WHERE least(user_a_id,user_b_id)=least(a,b) AND greatest(user_a_id,user_b_id)=greatest(a,b);
 UPDATE streak_requests SET status='rejected' WHERE status='pending' AND least(sender_id,receiver_id)=least(a,b) AND greatest(sender_id,receiver_id)=greatest(a,b);
 END IF; END IF;
 RETURN jsonb_build_object('ok',true);
EXCEPTION WHEN SQLSTATE 'PAP01' THEN RETURN jsonb_build_object('error','INVALID_PAIR');
 WHEN SQLSTATE 'PAP04' THEN RETURN jsonb_build_object('error','NOT_FOUND');
END $$;

CREATE FUNCTION api_streak_count(last_activation timestamp,previous_count integer,server_now timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN last_activation IS NULL
 OR timezone('America/Santiago',last_activation AT TIME ZONE 'UTC')::date < timezone('America/Santiago',server_now)::date-1
 THEN 0 ELSE previous_count END
$$;

CREATE FUNCTION api_streak(a text,action text,b text,rid integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE req streak_requests; s streaks; n timestamp; today date; updated_count integer;
BEGIN
 IF action IN('accept','reject') THEN
 SELECT * INTO req FROM streak_requests WHERE id=rid AND receiver_id=a;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 b:=req.sender_id;
 ELSIF action IN('presence','stoke') THEN
 SELECT * INTO s FROM streaks WHERE id=rid AND a IN(user_a_id,user_b_id);
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 b:=CASE WHEN a=s.user_a_id THEN s.user_b_id ELSE s.user_a_id END;
 END IF;
 PERFORM api_pair_lock(a,b);
 IF action='request' THEN
 IF NOT EXISTS(SELECT 1 FROM follows WHERE follower_id=a AND following_id=b) OR NOT EXISTS(SELECT 1 FROM follows WHERE follower_id=b AND following_id=a) THEN
 RETURN jsonb_build_object('error','MUTUAL_FOLLOW_REQUIRED'); END IF;
 IF EXISTS(SELECT 1 FROM streaks WHERE least(user_a_id,user_b_id)=least(a,b) AND greatest(user_a_id,user_b_id)=greatest(a,b) AND is_active) THEN RETURN jsonb_build_object('ok',true); END IF;
 INSERT INTO streak_requests(sender_id,receiver_id) VALUES(a,b) ON CONFLICT DO NOTHING;
 IF FOUND THEN INSERT INTO notifications(recipient_id,actor_id,type) VALUES(b,a,'streak_request'); END IF;
 ELSIF action IN('accept','reject') THEN
 SELECT * INTO req FROM streak_requests WHERE id=rid FOR UPDATE;
 IF req.status='pending' THEN
 UPDATE streak_requests SET status=CASE WHEN action='accept' THEN 'accepted'::streak_status ELSE 'rejected'::streak_status END WHERE id=rid;
 IF action='accept' THEN
 IF NOT EXISTS(SELECT 1 FROM follows WHERE follower_id=a AND following_id=b) OR NOT EXISTS(SELECT 1 FROM follows WHERE follower_id=b AND following_id=a) THEN RAISE EXCEPTION USING ERRCODE='PAP09',MESSAGE='MUTUAL_FOLLOW_REQUIRED'; END IF;
 INSERT INTO streaks(user_a_id,user_b_id,count) VALUES(least(a,b),greatest(a,b),0)
 ON CONFLICT (least(user_a_id,user_b_id),greatest(user_a_id,user_b_id)) DO UPDATE SET is_active=true,
 count=CASE WHEN streaks.is_active THEN streaks.count ELSE 0 END,
 last_stoked_at=CASE WHEN streaks.is_active THEN streaks.last_stoked_at ELSE NULL END,
 user_a_stoke_at=NULL,user_b_stoke_at=NULL;
 INSERT INTO notifications(recipient_id,actor_id,type) VALUES(b,a,'streak_accepted'); END IF; END IF;
 ELSE
 SELECT * INTO s FROM streaks WHERE id=rid FOR UPDATE;
 IF NOT s.is_active THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 -- Evaluate presence and calendar only after every potentially blocking lock.
 n:=timezone('UTC',clock_timestamp());
 today:=timezone('America/Santiago',n AT TIME ZONE 'UTC')::date;
 UPDATE streaks SET user_a_stoke_at=CASE WHEN user_a_id=a THEN n ELSE user_a_stoke_at END,
 user_b_stoke_at=CASE WHEN user_b_id=a THEN n ELSE user_b_stoke_at END WHERE id=rid RETURNING * INTO s;
 IF s.user_a_stoke_at>=n-interval '5 seconds' AND s.user_b_stoke_at>=n-interval '5 seconds'
 AND (s.last_stoked_at IS NULL OR timezone('America/Santiago',s.last_stoked_at AT TIME ZONE 'UTC')::date < today) THEN
 updated_count:=api_streak_count(s.last_stoked_at,s.count,n AT TIME ZONE 'UTC')+1;
 UPDATE streaks SET count=updated_count,last_stoked_at=n,last_interaction=n WHERE id=rid;
 END IF;
 RETURN jsonb_build_object('success',coalesce(s.user_a_stoke_at>=n-interval '5 seconds' AND s.user_b_stoke_at>=n-interval '5 seconds',false),'ok',true);
 END IF;
 RETURN jsonb_build_object('ok',true);
EXCEPTION WHEN SQLSTATE 'PAP01' THEN RETURN jsonb_build_object('error','INVALID_PAIR');
 WHEN SQLSTATE 'PAP04' THEN RETURN jsonb_build_object('error','NOT_FOUND');
 WHEN SQLSTATE 'PAP09' THEN RETURN jsonb_build_object('error','MUTUAL_FOLLOW_REQUIRED');
END $$;

CREATE FUNCTION api_pin_attempt(a text,expected text,valid boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
 SELECT * INTO u FROM users WHERE clerk_id=a FOR UPDATE;
 IF NOT FOUND OR u.pin_hash IS DISTINCT FROM expected THEN RETURN jsonb_build_object('error','PIN_CHANGED'); END IF;
 IF u.pin_locked_until>clock_timestamp() THEN RETURN jsonb_build_object('error','PIN_LOCKED'); END IF;
 IF NOT valid THEN
 UPDATE users SET pin_failures=CASE WHEN pin_failures>=4 THEN 0 ELSE pin_failures+1 END,
 pin_locked_until=CASE WHEN pin_failures>=4 THEN clock_timestamp()+interval '15 minutes' ELSE NULL END WHERE clerk_id=a;
 RETURN jsonb_build_object('error','INVALID_PIN'); END IF;
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE FUNCTION api_transfer(a text,b text,amount_value numeric,descr text,k uuid,fp text,expected text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE old transfer_receipts; u users; receipt_value jsonb; outid integer; inid integer;
BEGIN
 PERFORM api_pair_lock(a,b);
 SELECT * INTO old FROM transfer_receipts WHERE actor_id=a AND key=k FOR UPDATE;
 IF FOUND THEN
 IF old.fingerprint<>fp THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
 RETURN old.receipt; END IF;
 SELECT * INTO u FROM users WHERE clerk_id=a;
 IF expected IS NULL OR u.pin_hash IS DISTINCT FROM expected THEN RETURN jsonb_build_object('error','PIN_CHANGED'); END IF;
 IF u.pin_locked_until>clock_timestamp() THEN RETURN jsonb_build_object('error','PIN_LOCKED'); END IF;
 IF amount_value<=0 OR amount_value<>round(amount_value,2) OR amount_value>=1000000000000000000 THEN RETURN jsonb_build_object('error','INVALID_AMOUNT'); END IF;
 IF u.balance<amount_value THEN receipt_value:=jsonb_build_object('error','INSUFFICIENT_FUNDS','terminal',true);
 ELSIF (SELECT balance+amount_value>=1000000000000000000 FROM users WHERE clerk_id=b) THEN receipt_value:=jsonb_build_object('error','BALANCE_LIMIT','terminal',true); END IF;
 IF receipt_value IS NOT NULL THEN
 INSERT INTO transfer_receipts VALUES(a,k,fp,receipt_value);
 RETURN receipt_value;
 END IF;
 UPDATE users SET balance=balance-amount_value,pin_failures=0 WHERE clerk_id=a;
 UPDATE users SET balance=balance+amount_value WHERE clerk_id=b;
 INSERT INTO transactions(user_id,related_user_id,related_user_username,amount,type,description)
 SELECT a,b,username,amount_value,'out',descr FROM users WHERE clerk_id=b RETURNING id INTO outid;
 INSERT INTO transactions(user_id,related_user_id,related_user_username,amount,type,description)
 SELECT b,a,username,amount_value,'in',descr FROM users WHERE clerk_id=a RETURNING id INTO inid;
 INSERT INTO notifications(recipient_id,actor_id,type) VALUES(b,a,'transfer');
 receipt_value:=jsonb_build_object('id',k,'receiverId',b,'amount',amount_value::numeric(20,2)::text,'description',descr,'outId',outid,'inId',inid);
 INSERT INTO transfer_receipts VALUES(a,k,fp,receipt_value);
 RETURN receipt_value;
EXCEPTION WHEN SQLSTATE 'PAP01' THEN RETURN jsonb_build_object('error','INVALID_PAIR');
 WHEN SQLSTATE 'PAP04' THEN RETURN jsonb_build_object('error','NOT_FOUND');
END $$;
COMMIT;
