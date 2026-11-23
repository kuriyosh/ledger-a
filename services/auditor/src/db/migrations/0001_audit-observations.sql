CREATE TABLE "auditor"."inclusion_decisions" (
	"seq" numeric(20, 0) PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"deadline_ms" numeric(20, 0) NOT NULL,
	"deadline_hash" text NOT NULL,
	"exclusion" jsonb
);
--> statement-breakpoint
ALTER TABLE "auditor"."violations" ADD COLUMN "observation_id" text;