CREATE TABLE "operation_rsvp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"operation_id" uuid NOT NULL,
	"discord_id" text NOT NULL,
	"username" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "last_sample_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "rsvp_refreshed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "operation_rsvp_operation_idx" ON "operation_rsvp" ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_rsvp_operation_discord_idx" ON "operation_rsvp" ("operation_id","discord_id");--> statement-breakpoint
ALTER TABLE "operation_rsvp" ADD CONSTRAINT "operation_rsvp_operation_id_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation"("id") ON DELETE CASCADE;