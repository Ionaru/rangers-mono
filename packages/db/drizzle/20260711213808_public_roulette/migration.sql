CREATE TABLE "assignable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"discord_role_id" text NOT NULL,
	"ts_sgid" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assignable_discord_role_id_unique" UNIQUE("discord_role_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"member_id" uuid,
	"ts_uid" text NOT NULL,
	"ts_nickname" text,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "link_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"member_id" uuid NOT NULL,
	"target_ts_uid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_id" text NOT NULL,
	"display_name" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"ts_uid" text,
	"ts_nickname" text,
	"ts_verified_at" timestamp with time zone,
	"ts_link_method" text,
	"steam_id" text,
	"steam_verified_at" timestamp with time zone,
	"steam_link_method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "member_ts_uid_unique" UNIQUE("ts_uid"),
	CONSTRAINT "member_steam_id_unique" UNIQUE("steam_id")
);
--> statement-breakpoint
CREATE TABLE "operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"attendance_start" timestamp with time zone NOT NULL,
	"attendance_end" timestamp with time zone NOT NULL,
	"event_end" timestamp with time zone NOT NULL,
	"discord_event_id" text,
	"name" text,
	"source" text DEFAULT 'auto_weekly' NOT NULL,
	CONSTRAINT "operation_date_unique" UNIQUE("date")
);
--> statement-breakpoint
ALTER TABLE "attendance_session" ADD CONSTRAINT "attendance_session_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_session" ADD CONSTRAINT "attendance_session_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_code" ADD CONSTRAINT "link_code_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_session_operation_idx" ON "attendance_session" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "attendance_session_ts_uid_idx" ON "attendance_session" USING btree ("ts_uid");--> statement-breakpoint
CREATE INDEX "link_code_code_idx" ON "link_code" USING btree ("code");