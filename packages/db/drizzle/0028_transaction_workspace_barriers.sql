-- Cache lock acquisition, never authorization. The marker and the locks have the
-- same PostgreSQL transaction/savepoint lifetime. Only trusted server SQL calls
-- this function; clients cannot access the backend-local temporary table.
CREATE OR REPLACE FUNCTION database_lock_workspace(w uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_relation_id oid := 'databases'::regclass::oid;
BEGIN
 IF to_regclass('pg_temp.memoria_database_barriers') IS NULL THEN
  CREATE TEMP TABLE memoria_database_barriers (
   relation_id oid NOT NULL,
   workspace_id uuid NOT NULL,
   PRIMARY KEY(relation_id,workspace_id)
  ) ON COMMIT DELETE ROWS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_temp.memoria_database_barriers b
           WHERE b.relation_id=v_relation_id AND b.workspace_id=w) THEN
  RETURN;
 END IF;

 -- Keep the original order and scope. Other transactions create containers and
 -- ordinary pages under the workspace mutex; our own new rows are uncommitted.
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text,0));
 PERFORM id FROM databases WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM pages WHERE workspace_id=w AND kind='page' ORDER BY id FOR NO KEY UPDATE;
 -- No marker on a partial acquisition, exception, or rollback to its savepoint.
 INSERT INTO pg_temp.memoria_database_barriers VALUES(v_relation_id,w);
END $$;
