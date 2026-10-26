CREATE TABLE "invitation_pages" (
	"workspace_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "invitation_pages_invitation_id_page_id_pk" PRIMARY KEY("invitation_id","page_id"),
	CONSTRAINT "invitation_pages_level_ck" CHECK ("invitation_pages"."level" in ('read','edit'))
);
--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" DROP CONSTRAINT "auth_mail_kind_ck";--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" ADD COLUMN "invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "delivery_status" text DEFAULT 'not-sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "invitations_workspace_id_uq" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "invitation_pages" ADD CONSTRAINT "invitation_pages_workspace_id_invitation_id_workspace_invitations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invitation_id") REFERENCES "public"."workspace_invitations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_pages" ADD CONSTRAINT "invitation_pages_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" ADD CONSTRAINT "auth_mail_jobs_invitation_id_workspace_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."workspace_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_email_uq" ON "workspace_invitations" USING btree ("workspace_id",lower("email")) WHERE "workspace_invitations"."status"='pending';--> statement-breakpoint

ALTER TABLE "auth_mail_jobs" ADD CONSTRAINT "auth_mail_kind_ck" CHECK ("auth_mail_jobs"."kind" in ('password-request','verification-request','delivery','invitation'));
--> statement-breakpoint
CREATE FUNCTION invitation_terminal_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'pending' AND OLD.status='pending' THEN NEW.closed_at=clock_timestamp(); END IF;
 IF OLD.closed_at IS NOT NULL THEN NEW.closed_at=OLD.closed_at; END IF;
 NEW.updated_at=clock_timestamp(); RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invitation_terminal BEFORE UPDATE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION invitation_terminal_time();
--> statement-breakpoint
UPDATE workspace_invitations SET closed_at=updated_at WHERE status<>'pending' AND closed_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION invitation_revoke_inviter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE workspace_invitations SET status='canceled' WHERE workspace_id=OLD.workspace_id AND inviter_id=OLD.user_id AND status='pending';
 ELSIF NEW.role NOT IN ('owner','admin') OR NEW.role<>OLD.role THEN
  UPDATE workspace_invitations SET status='canceled' WHERE workspace_id=OLD.workspace_id AND inviter_id=OLD.user_id AND status='pending'
   AND (NEW.role NOT IN ('owner','admin') OR (NEW.role='admin' AND role NOT IN ('member','guest')));
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER invitation_revoke_inviter AFTER DELETE OR UPDATE OF role ON workspace_members FOR EACH ROW EXECUTE FUNCTION invitation_revoke_inviter();
