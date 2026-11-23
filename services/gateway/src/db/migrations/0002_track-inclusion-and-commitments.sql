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
