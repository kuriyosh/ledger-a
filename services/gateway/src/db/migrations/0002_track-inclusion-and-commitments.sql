CREATE TABLE "gateway"."commitments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"head_hash" "bytea" NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"block_number" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "gateway"."tracked_blocks" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"block_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "log_entries_included_block" ON "gateway"."log_entries" USING btree ("included_block");--> statement-breakpoint
CREATE INDEX "log_entries_forwarded_unobserved" ON "gateway"."log_entries" USING btree ("seq") WHERE "gateway"."log_entries"."included_block" is null and "gateway"."log_entries"."forward_status" = 'forwarded';