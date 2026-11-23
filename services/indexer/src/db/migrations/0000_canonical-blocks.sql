CREATE TABLE "indexer"."blocks" (
	"number" bigint PRIMARY KEY NOT NULL,
	"hash" "bytea" NOT NULL,
	"parent_hash" "bytea" NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"tx_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer"."chain_status" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"start_block" bigint NOT NULL,
	"indexed_block" bigint NOT NULL,
	"unsafe_block" bigint,
	"safe_block" bigint,
	"finalized_block" bigint,
	"enforcement_enabled" boolean DEFAULT false NOT NULL,
	"registry_version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chain_status_singleton" CHECK ("indexer"."chain_status"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "indexer"."logs" (
	"block_number" bigint NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"log_index" integer NOT NULL,
	"address" "bytea" NOT NULL,
	"topic0" "bytea",
	"topic1" "bytea",
	"topic2" "bytea",
	"topic3" "bytea",
	"data" "bytea" NOT NULL,
	CONSTRAINT "logs_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."transactions" (
	"hash" "bytea" PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"tx_index" integer NOT NULL,
	"type" smallint NOT NULL,
	"from_address" "bytea" NOT NULL,
	"to_address" "bytea",
	"value" numeric(78, 0) NOT NULL,
	"nonce" bigint NOT NULL,
	"gas_limit" bigint NOT NULL,
	"gas_used" bigint NOT NULL,
	"status" smallint NOT NULL,
	"kind" text NOT NULL,
	"input" "bytea" NOT NULL,
	"decoded_call" jsonb,
	"failure_kind" text,
	"failure_detail" jsonb,
	"mint" numeric(78, 0)
);
--> statement-breakpoint
ALTER TABLE "indexer"."logs" ADD CONSTRAINT "logs_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."logs" ADD CONSTRAINT "logs_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."transactions" ADD CONSTRAINT "transactions_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logs_transaction" ON "indexer"."logs" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_position" ON "indexer"."transactions" USING btree ("block_number","tx_index");--> statement-breakpoint
CREATE INDEX "transactions_sender" ON "indexer"."transactions" USING btree ("from_address","block_number");--> statement-breakpoint
CREATE INDEX "transactions_recipient" ON "indexer"."transactions" USING btree ("to_address","block_number");