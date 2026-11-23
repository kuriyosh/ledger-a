CREATE TABLE "demo"."mint_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"recipient" "bytea" NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"nonce" bigint NOT NULL,
	"first_block" bigint NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"raw_tx" "bytea" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"block_hash" "bytea",
	CONSTRAINT "mint_requests_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "mint_positive_amount" CHECK ("demo"."mint_requests"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "demo"."runs" (
	"run" integer PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"start_seq" bigint NOT NULL,
	"start_block" bigint NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mint_one_pending" ON "demo"."mint_requests" USING btree ("status") WHERE "demo"."mint_requests"."status" = 'pending';