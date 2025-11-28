CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"semester_id" text NOT NULL,
	"subject_id" text,
	"title" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"color_hex" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_topics" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "class_slots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fixed_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "assessment_topics" CASCADE;--> statement-breakpoint
DROP TABLE "class_slots" CASCADE;--> statement-breakpoint
DROP TABLE "fixed_events" CASCADE;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "date" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "assessments" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "start_date" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "end_date" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "study_hours" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "semesters" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "start_time" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "end_time" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "status" SET DEFAULT 'scheduled';--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "session_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "session_type" SET DEFAULT 'learning';--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "study_sessions" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "color_hex" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "progress" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "current_mastery" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "updated_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "topics" ALTER COLUMN "updated_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "topic_ids" text;--> statement-breakpoint
ALTER TABLE "semesters" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_semester_id_semesters_id_fk" FOREIGN KEY ("semester_id") REFERENCES "public"."semesters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_user_id_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_semester_id_idx" ON "events" USING btree ("semester_id");--> statement-breakpoint
CREATE INDEX "events_day_of_week_idx" ON "events" USING btree ("day_of_week");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "assessments_subject_id_idx" ON "assessments" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "assessments_date_idx" ON "assessments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "semesters_user_id_idx" ON "semesters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "semesters_user_active_idx" ON "semesters" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "study_sessions_topic_id_idx" ON "study_sessions" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "study_sessions_start_time_idx" ON "study_sessions" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "subjects_user_id_idx" ON "subjects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subjects_semester_id_idx" ON "subjects" USING btree ("semester_id");--> statement-breakpoint
CREATE INDEX "topics_subject_id_idx" ON "topics" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "topics_parent_id_idx" ON "topics" USING btree ("parent_id");