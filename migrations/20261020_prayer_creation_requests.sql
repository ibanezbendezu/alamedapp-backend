-- Apply after 20261020_prayers_audience.sql. Prepared only; never run by application startup.
BEGIN;
CREATE TABLE prayer_creation_requests (
  user_id varchar(255) NOT NULL REFERENCES users(clerk_id) ON DELETE CASCADE,
  key varchar(36) NOT NULL,
  fingerprint varchar(64) NOT NULL,
  prayer_id integer,
  PRIMARY KEY (user_id, key)
);
-- No FK to prayers: prayer_id remains a tombstone after prayer deletion.
COMMIT;
