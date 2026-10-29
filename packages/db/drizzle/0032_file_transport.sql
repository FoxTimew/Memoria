ALTER TABLE file_upload_intents ADD COLUMN transport_mode text CHECK(transport_mode IN ('post','multipart'));
ALTER TABLE file_upload_intents ADD COLUMN staging_key text;
ALTER TABLE file_upload_intents ADD COLUMN final_key text UNIQUE;
ALTER TABLE file_upload_intents ADD COLUMN upload_id text;
ALTER TABLE file_upload_intents ADD COLUMN session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL;
ALTER TABLE file_upload_intents ADD COLUMN whole_checksum text;
ALTER TABLE file_upload_intents ADD COLUMN bytes_verified_at timestamptz;
ALTER TABLE file_upload_intents ADD COLUMN staging_cleaned_at timestamptz;
ALTER TABLE file_upload_intents ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE file_upload_intents ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE file_upload_intents ADD COLUMN last_error text;
ALTER TABLE file_upload_intents ADD COLUMN job_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE file_part_leases ADD COLUMN reconciled_at timestamptz;
--> statement-breakpoint
CREATE TABLE file_part_plans (
 file_id uuid NOT NULL REFERENCES file_upload_intents(file_id), part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
 bytes bigint NOT NULL CHECK(bytes>0), checksum text NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
ALTER TABLE files ADD COLUMN ever_attached boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN orphaned_at timestamptz;
ALTER TABLE files ADD COLUMN storage_deleted_at timestamptz;
--> statement-breakpoint
CREATE FUNCTION file_usage_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE files SET ever_attached=true,orphaned_at=NULL WHERE id=NEW.file_id;
 ELSE
  UPDATE files SET orphaned_at=coalesce(orphaned_at,clock_timestamp()) WHERE id=OLD.file_id
   AND NOT EXISTS(SELECT 1 FROM file_usages WHERE file_id=OLD.file_id);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER file_usage_lifecycle AFTER INSERT OR DELETE ON file_usages FOR EACH ROW EXECUTE FUNCTION file_usage_lifecycle();
UPDATE files f SET ever_attached=true WHERE EXISTS(SELECT 1 FROM file_usages u WHERE u.file_id=f.id);
CREATE INDEX file_transport_job_idx ON file_upload_intents(next_attempt_at);
--> statement-breakpoint
CREATE TABLE file_object_copies (
 object_key text PRIMARY KEY, file_id uuid NOT NULL REFERENCES file_upload_intents(file_id),
 epoch bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz
);
