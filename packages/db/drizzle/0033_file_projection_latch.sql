-- Same business exclusion as FileBoundary.lock; FK readers of the asynchronous projection
-- do not modify identity/state and may coexist. GC FOR UPDATE and state writers still wait.
CREATE OR REPLACE FUNCTION file_usage_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; f uuid; status text;
BEGIN
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 f=CASE WHEN TG_OP='DELETE' THEN OLD.file_id ELSE NEW.file_id END;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.file_id,NEW.page_id,NEW.slot_kind,NEW.slot_id) IS DISTINCT FROM (OLD.workspace_id,OLD.file_id,OLD.page_id,OLD.slot_kind,OLD.slot_id) THEN
  RAISE EXCEPTION 'Immutable usage identity' USING ERRCODE='23514';
 END IF;
 SELECT state INTO status FROM files WHERE workspace_id=w AND id=f FOR NO KEY UPDATE;
 IF TG_OP<>'DELETE' AND status IS DISTINCT FROM 'ready' THEN
  RAISE EXCEPTION 'Unavailable file' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
