ALTER TABLE "assessments" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "semesters" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "deleted_at" bigint;