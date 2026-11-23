CREATE TABLE "auditor"."audit_blocks" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"block_hash" text NOT NULL,
	"info" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor"."audit_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_seq" numeric(20, 0) NOT NULL,
	"last_block" bigint,
	"last_block_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor"."exclusions" (
	"seq" numeric(20, 0) PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"reason" text NOT NULL,
	"verified_block" bigint NOT NULL,
	"evidence" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor"."fifo_entries" (
	"seq" numeric(20, 0) PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"received_at_ms" numeric(20, 0) NOT NULL,
	"forward_status" text NOT NULL,
	"pos_block" bigint,
	"pos_index" integer,
	"receipt" jsonb NOT NULL,
	"position" jsonb,
	"checks" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor"."violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identity" text NOT NULL,
	"check_code" text NOT NULL,
	"type" text NOT NULL,
	"seq_a" numeric(20, 0),
	"seq_b" numeric(20, 0),
	"tx_hash" text,
	"block_number" bigint,
	"detail" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violations_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
CREATE INDEX "violations_seq" ON "auditor"."violations" USING btree ("seq_a");--> statement-breakpoint
CREATE INDEX "violations_block" ON "auditor"."violations" USING btree ("block_number");