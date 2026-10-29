ALTER TABLE files DROP CONSTRAINT files_state_ck;
ALTER TABLE files ADD CONSTRAINT files_state_ck CHECK(state IN ('pending','reserved','uploading','completing','validating','ready','rejected','deleting','deleted'));
--> statement-breakpoint
CREATE TABLE file_usages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 file_id uuid NOT NULL, page_id uuid NOT NULL, slot_kind text NOT NULL CHECK(slot_kind IN ('block','cell')),
 slot_id uuid NOT NULL, generation uuid, revision bigint NOT NULL CHECK(revision>=0),
 UNIQUE(workspace_id,page_id,slot_kind,slot_id,file_id),
 FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id) ON DELETE CASCADE,
 CHECK((slot_kind='block')=(generation IS NOT NULL))
);
CREATE INDEX file_usages_source_idx ON file_usages(workspace_id,file_id,page_id);
--> statement-breakpoint
CREATE TABLE file_ledger_states (
 page_id uuid PRIMARY KEY REFERENCES collaboration_documents(page_id) ON DELETE CASCADE,
 generation uuid NOT NULL, revision bigint NOT NULL CHECK(revision>=0)
);
--> statement-breakpoint
CREATE TABLE file_workspace_usage (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 files_count integer NOT NULL DEFAULT 0 CHECK(files_count>=0)
);
INSERT INTO file_workspace_usage SELECT workspace_id,coalesce(sum(byte_size),0),count(*) FROM files WHERE state<>'deleted' GROUP BY workspace_id;
--> statement-breakpoint
CREATE TABLE file_upload_intents (
 file_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES auth_users(id),
 page_id uuid NOT NULL, idempotency_key uuid NOT NULL, requested_bytes bigint NOT NULL CHECK(requested_bytes>0),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=requested_bytes),
 request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
 attach_until timestamptz, closed_at timestamptz,
 UNIQUE(user_id,idempotency_key),
 FOREIGN KEY(workspace_id,file_id) REFERENCES files(workspace_id,id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES pages(workspace_id,id)
);
CREATE INDEX file_uploads_active_idx ON file_upload_intents(user_id,expires_at) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE TABLE file_admission_buckets (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 tokens numeric NOT NULL CHECK(tokens>=0), updated_at timestamptz NOT NULL
);
CREATE TABLE file_part_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth_users(id),
 file_id uuid NOT NULL REFERENCES file_upload_intents(file_id), request_id uuid NOT NULL,
 part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000), bytes bigint NOT NULL CHECK(bytes>0),
 checksum text NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE(user_id,request_id,part_number)
);
CREATE INDEX file_part_leases_expiry_idx ON file_part_leases(expires_at);
--> statement-breakpoint
-- Same latch for insertion/removal and GC, including trusted direct SQL jobs.
CREATE FUNCTION file_usage_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; f uuid; status text;
BEGIN
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 f=CASE WHEN TG_OP='DELETE' THEN OLD.file_id ELSE NEW.file_id END;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.file_id,NEW.page_id,NEW.slot_kind,NEW.slot_id) IS DISTINCT FROM (OLD.workspace_id,OLD.file_id,OLD.page_id,OLD.slot_kind,OLD.slot_id) THEN
  RAISE EXCEPTION 'Immutable usage identity' USING ERRCODE='23514';
 END IF;
 SELECT state INTO status FROM files WHERE workspace_id=w AND id=f FOR UPDATE;
 IF TG_OP<>'DELETE' AND status IS DISTINCT FROM 'ready' THEN
  RAISE EXCEPTION 'Unavailable file' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER file_usage_fence BEFORE INSERT OR UPDATE OR DELETE ON file_usages FOR EACH ROW EXECUTE FUNCTION file_usage_fence();
