ALTER TABLE files ADD COLUMN validation_version integer NOT NULL DEFAULT 1;
ALTER TABLE files ADD COLUMN preview_status text NOT NULL DEFAULT 'pending';
ALTER TABLE files ADD COLUMN pixel_width integer;
ALTER TABLE files ADD COLUMN pixel_height integer;
ALTER TABLE file_upload_intents ADD COLUMN validation_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE file_object_copies ADD COLUMN byte_size bigint CHECK(byte_size>0);
ALTER TABLE file_object_copies ADD COLUMN retained boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE file_variants (
 file_id uuid NOT NULL REFERENCES files(id),
 variant text NOT NULL CHECK(variant IN ('display','thumbnail')),
 object_key text NOT NULL UNIQUE REFERENCES file_object_copies(object_key),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 2048),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 2048),
 sha256 text NOT NULL,
 PRIMARY KEY(file_id,variant)
);
--> statement-breakpoint
CREATE FUNCTION file_notify_readers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('memoria_files',json_build_object('schema',current_schema())::text);
 RETURN NULL;
END $$;
CREATE TRIGGER file_read_state AFTER UPDATE OF state,deleted_at,validation_version ON files FOR EACH STATEMENT EXECUTE FUNCTION file_notify_readers();
CREATE TRIGGER file_read_usage AFTER DELETE OR UPDATE ON file_usages FOR EACH STATEMENT EXECUTE FUNCTION file_notify_readers();
