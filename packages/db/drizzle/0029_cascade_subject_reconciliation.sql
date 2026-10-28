CREATE OR REPLACE FUNCTION content_queue_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; queued uuid; targets uuid[]; subjects uuid[]; matched integer; supported boolean; resources uuid[];
BEGIN
 IF TG_TABLE_NAME='pages' THEN
  IF (CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END)='database_row' THEN RETURN NULL; END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='pages' THEN
   IF OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='workspace_members' THEN
   IF OLD.role=NEW.role THEN RETURN NULL; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='workspaces' THEN w=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=w) THEN RETURN NULL; END IF;

 -- A missing parent on DELETE can only come from the immediate FK cascade.
 -- Its own AFTER trigger retains OLD.kind/member_id and queues the complete
 -- subject effect, including unsupported kinds (global fallback). Do not turn
 -- that known scope global merely because the child outlives the parent during
 -- cascade execution. All grant locks/notifications and the deferred commit
 -- check still run; this skips only a redundant reconciliation request.
 IF TG_TABLE_NAME='access_grants' AND TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM access_subjects s
                WHERE s.workspace_id=w AND s.id=OLD.subject_id) THEN
   RETURN NULL;
  END IF;
 END IF;

 -- A global scope cannot shrink, and needs no repeated subtree walk during bulk setup.
 IF EXISTS(SELECT 1 FROM page_access_pending WHERE workspace_id=w AND member_ids IS NULL AND page_ids IS NULL) THEN RETURN NULL; END IF;
 -- Capture descendants after EACH mutation, including archived nodes. The union retains
 -- nodes moved away by a later mutation. Deletes/cascades safely fall back to all pages.
 IF TG_TABLE_NAME='pages' AND TG_OP<>'DELETE' THEN
  WITH RECURSIVE subtree AS (
   SELECT id FROM pages WHERE workspace_id=w AND id=NEW.id AND kind='page'
   UNION SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id WHERE p.workspace_id=w AND p.kind='page'
  ) SELECT array_agg(id) INTO resources FROM subtree;
 END IF;

 -- Only these changes have a proven person-local effect. Unknown subjects
 -- fall back to the complete calculation. Tree changes have a resource scope,
 -- and workspace changes remain global on both axes.
 IF TG_TABLE_NAME='workspace_members' THEN
  targets=ARRAY[CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END];
 ELSIF TG_TABLE_NAME='access_subjects' THEN
  IF TG_OP='DELETE' THEN
   IF OLD.kind='member' AND OLD.member_id IS NOT NULL THEN targets=ARRAY[OLD.member_id]; END IF;
  ELSIF TG_OP='INSERT' THEN
   IF NEW.kind='member' AND NEW.member_id IS NOT NULL THEN targets=ARRAY[NEW.member_id]; END IF;
  ELSE
   IF OLD.kind='member' AND NEW.kind='member' AND OLD.member_id IS NOT NULL AND NEW.member_id IS NOT NULL THEN targets=ARRAY[OLD.member_id,NEW.member_id]; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='access_grants' THEN
  IF TG_OP='INSERT' THEN subjects=ARRAY[NEW.subject_id];
  ELSIF TG_OP='DELETE' THEN subjects=ARRAY[OLD.subject_id];
  ELSE subjects=ARRAY[OLD.subject_id,NEW.subject_id]; END IF;
  subjects=ARRAY(SELECT DISTINCT id FROM unnest(subjects) id);
  SELECT array_agg(DISTINCT s.member_id),count(*),bool_and(s.kind='member' AND s.member_id IS NOT NULL)
   INTO targets,matched,supported FROM access_subjects s WHERE s.workspace_id=w AND s.id=ANY(subjects);
  IF matched<>cardinality(subjects) OR NOT coalesce(supported,false) THEN targets=NULL; END IF;
 END IF;

 INSERT INTO page_access_pending(workspace_id,member_ids,page_ids) VALUES(w,targets,resources)
 ON CONFLICT DO NOTHING RETURNING workspace_id INTO queued;
 IF queued IS NOT NULL THEN
  UPDATE workspaces SET access_version=access_version+1 WHERE id=w;
 ELSE
  UPDATE page_access_pending p SET member_ids=CASE WHEN p.member_ids IS NULL OR targets IS NULL THEN NULL
    ELSE ARRAY(SELECT DISTINCT id FROM unnest(p.member_ids||targets) id ORDER BY id) END
  , page_ids=CASE WHEN p.page_ids IS NULL OR resources IS NULL THEN NULL
    ELSE ARRAY(SELECT DISTINCT id FROM unnest(p.page_ids||resources) id ORDER BY id) END
  WHERE p.workspace_id=w;
 END IF;
 RETURN NULL;
END $$;
