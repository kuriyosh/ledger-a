ALTER TABLE "consortium"."approvals" ADD COLUMN "kind" text DEFAULT 'execute' NOT NULL;--> statement-breakpoint
ALTER TABLE "consortium"."approvals" DROP CONSTRAINT "approvals_proposal_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "consortium"."approvals" ADD CONSTRAINT "approvals_proposal_id_member_id_kind_pk" PRIMARY KEY("proposal_id","member_id","kind");--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancel_safe_tx_hash" "bytea";--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancel_executed_tx_hash" "bytea";--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancel_executed_block" bigint;--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancel_execution_prepared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancelled_locally" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "original_approval_prepared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "cancel_failed_tx_hash" "bytea";--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "withdrawal_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consortium"."proposals" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
UPDATE "consortium"."proposals" SET "original_approval_prepared" = true;
