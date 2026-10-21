-- Prepared only; apply manually during the reviewed legacy-access cutover.
BEGIN;
ALTER TABLE prayers ADD COLUMN audience varchar(10) NOT NULL DEFAULT 'friends';
ALTER TABLE prayers ADD CONSTRAINT prayers_audience_check CHECK (audience IN ('friends', 'public'));
COMMIT;
