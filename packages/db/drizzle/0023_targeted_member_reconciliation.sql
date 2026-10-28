ALTER TABLE "page_access_pending" ADD COLUMN "member_ids" uuid[];
--> statement-breakpoint
CREATE FUNCTION content_effective_access_scoped(w uuid, candidate_tree jsonb, targets uuid[])
RETURNS TABLE(member_id uuid,page_id uuid,level text) LANGUAGE sql STABLE AS $$
 WITH RECURSIVE tree AS MATERIALIZED (
  SELECT p.id,p.parent_id,p.deleted_at IS NOT NULL AS archived FROM pages p
  WHERE p.workspace_id=w AND p.kind='page' AND candidate_tree IS NULL
  UNION ALL
  SELECT c.id,c.parent_id,c.archived FROM jsonb_to_recordset(candidate_tree) c(id uuid,parent_id uuid,archived boolean)
  JOIN pages p ON p.id=c.id AND p.workspace_id=w AND p.kind='page' WHERE candidate_tree IS NOT NULL
 ), visible AS (
  SELECT t.id,ARRAY[t.id] AS path FROM tree t WHERE t.parent_id IS NULL AND NOT t.archived
  UNION ALL SELECT t.id,v.path||t.id FROM tree t JOIN visible v ON t.parent_id=v.id
  WHERE NOT t.archived AND cardinality(v.path)<50
 ), memberships AS MATERIALIZED (
  SELECT m.id,m.role FROM workspace_members m JOIN workspaces x ON x.id=m.workspace_id
  WHERE m.workspace_id=w AND x.deleted_at IS NULL AND (targets IS NULL OR m.id=ANY(targets))
 ), guest_access AS (
  SELECT m.id AS member_id,v.id AS page_id,max(CASE g.level WHEN 'edit' THEN 2 ELSE 1 END) AS rank
  FROM visible v CROSS JOIN LATERAL unnest(v.path) ancestor(id)
  JOIN access_grants g ON g.workspace_id=w AND g.resource_id=ancestor.id
   AND g.resource_type='page' AND g.deleted_at IS NULL AND (g.inherit OR g.resource_id=v.id)
  JOIN access_subjects s ON s.id=g.subject_id AND s.workspace_id=w AND s.kind='member' AND s.deleted_at IS NULL
  JOIN memberships m ON m.id=s.member_id AND m.role='guest'
  GROUP BY m.id,v.id
 ) SELECT m.id,v.id,'edit'::text FROM memberships m CROSS JOIN visible v WHERE m.role IN ('owner','admin','member')
 UNION ALL SELECT g.member_id,g.page_id,CASE g.rank WHEN 2 THEN 'edit' ELSE 'read' END FROM guest_access g;
$$;


--> statement-breakpoint
CREATE FUNCTION content_access_effects_scoped(w uuid,candidate_tree jsonb,stored_before boolean,targets uuid[])
RETURNS TABLE(member_id uuid,page_id uuid,before_level text,after_level text) LANGUAGE sql STABLE AS $$
 WITH before_access AS MATERIALIZED (
  SELECT a.member_id,a.page_id,a.level FROM page_access_state a WHERE stored_before AND a.workspace_id=w AND a.level<>'none' AND (targets IS NULL OR a.member_id=ANY(targets))
  UNION ALL SELECT * FROM content_effective_access_scoped(w,NULL,targets) WHERE NOT stored_before
 ), after_access AS MATERIALIZED (SELECT * FROM content_effective_access_scoped(w,candidate_tree,targets))
 SELECT coalesce(b.member_id,a.member_id),coalesce(b.page_id,a.page_id),coalesce(b.level,'none'),coalesce(a.level,'none')
 FROM before_access b FULL JOIN after_access a USING(member_id,page_id)
 WHERE b.level IS DISTINCT FROM a.level;
$$;

--> statement-breakpoint
-- Existing previews retain the exact full-workspace semantics, through the same engine.
CREATE OR REPLACE FUNCTION content_effective_access(w uuid,candidate_tree jsonb DEFAULT NULL)
RETURNS TABLE(member_id uuid,page_id uuid,level text) LANGUAGE sql STABLE AS $$
 SELECT * FROM content_effective_access_scoped(w,candidate_tree,NULL);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_access_effects(w uuid,candidate_tree jsonb DEFAULT NULL,stored_before boolean DEFAULT false)
RETURNS TABLE(member_id uuid,page_id uuid,before_level text,after_level text) LANGUAGE sql STABLE AS $$
 SELECT * FROM content_access_effects_scoped(w,candidate_tree,stored_before,NULL);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_queue_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; queued uuid; targets uuid[]; subjects uuid[]; matched integer; supported boolean;
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

 -- Only these changes have a proven person-local effect. Unknown/cascaded subjects
 -- fall back to the complete calculation; tree/workspace changes always stay global.
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

 INSERT INTO page_access_pending(workspace_id,member_ids) VALUES(w,targets)
 ON CONFLICT DO NOTHING RETURNING workspace_id INTO queued;
 IF queued IS NOT NULL THEN
  UPDATE workspaces SET access_version=access_version+1 WHERE id=w;
 ELSE
  UPDATE page_access_pending p SET member_ids=CASE WHEN p.member_ids IS NULL OR targets IS NULL THEN NULL
    ELSE ARRAY(SELECT DISTINCT id FROM unnest(p.member_ids||targets) id ORDER BY id) END
  WHERE p.workspace_id=w;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_reconcile_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer; targets uuid[];
BEGIN
 -- Read the FINAL coalesced scope, not NEW.member_ids from the first queued event.
 SELECT member_ids INTO targets FROM page_access_pending WHERE workspace_id=NEW.workspace_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT access_version INTO v FROM workspaces WHERE id=NEW.workspace_id;
 WITH changed AS MATERIALIZED (
  SELECT e.* FROM content_access_effects_scoped(NEW.workspace_id,NULL,true,targets) e
  JOIN workspace_members m ON m.id=e.member_id AND m.workspace_id=NEW.workspace_id
 ), applied AS (
  INSERT INTO page_access_state(workspace_id,member_id,page_id,level,version)
  SELECT NEW.workspace_id,member_id,page_id,after_level,v FROM changed
  ON CONFLICT (workspace_id,member_id,page_id) DO UPDATE SET level=excluded.level,version=excluded.version
  RETURNING member_id
 ) UPDATE workspace_members SET access_version=v WHERE id IN (SELECT member_id FROM applied);
 DELETE FROM page_access_pending WHERE workspace_id=NEW.workspace_id;
 PERFORM pg_notify('memoria_collaboration',json_build_object('schema',current_schema())::text);
 RETURN NULL;
END $$;
