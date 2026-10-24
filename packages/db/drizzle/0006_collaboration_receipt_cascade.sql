-- Workspace deletion cascades through both actors and pages; validate the receipt actor FK after both cascades.
ALTER TABLE collaboration_receipts ALTER CONSTRAINT collaboration_receipts_workspace_id_actor_id_actors_workspace_i DEFERRABLE INITIALLY DEFERRED;
