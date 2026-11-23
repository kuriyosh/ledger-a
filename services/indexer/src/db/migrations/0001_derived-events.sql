CREATE TABLE "indexer"."balances_history" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"token" "bytea" NOT NULL,
	"account" "bytea" NOT NULL,
	"balance" numeric(78, 0) NOT NULL,
	CONSTRAINT "balances_history_token_account_block_number_log_index_pk" PRIMARY KEY("token","account","block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."receipt_commitments" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	CONSTRAINT "receipt_commitments_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."registry_account_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"account" "bytea" NOT NULL,
	"vasp_id" bigint NOT NULL,
	"kind" smallint NOT NULL,
	"status" smallint NOT NULL,
	"valid_until" numeric(20, 0) NOT NULL,
	"version" bigint NOT NULL,
	"actor" "bytea" NOT NULL,
	"reason" "bytea" NOT NULL,
	CONSTRAINT "registry_account_events_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."registry_checkpoints" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"enforcement_enabled" boolean NOT NULL,
	"registry_version" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer"."registry_vasp_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"vasp_id" bigint NOT NULL,
	CONSTRAINT "registry_vasp_events_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."safe_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"safe_tx_hash" "bytea" NOT NULL,
	CONSTRAINT "safe_events_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."swaps" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"maker" "bytea" NOT NULL,
	"taker" "bytea" NOT NULL,
	CONSTRAINT "swaps_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."token_admin_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"token" "bytea" NOT NULL,
	CONSTRAINT "token_admin_events_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."token_transfers" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"token" "bytea" NOT NULL,
	"from_address" "bytea" NOT NULL,
	"to_address" "bytea" NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"travel_rule_ref" "bytea",
	CONSTRAINT "token_transfers_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
CREATE TABLE "indexer"."travel_rule_attestations" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	"ref_id" "bytea" NOT NULL,
	CONSTRAINT "travel_rule_attestations_block_number_log_index_pk" PRIMARY KEY("block_number","log_index")
);
--> statement-breakpoint
ALTER TABLE "indexer"."chain_status" ADD COLUMN "derived_block" bigint;--> statement-breakpoint
ALTER TABLE "indexer"."balances_history" ADD CONSTRAINT "balances_history_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."receipt_commitments" ADD CONSTRAINT "receipt_commitments_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."receipt_commitments" ADD CONSTRAINT "receipt_commitments_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."registry_account_events" ADD CONSTRAINT "registry_account_events_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."registry_account_events" ADD CONSTRAINT "registry_account_events_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."registry_checkpoints" ADD CONSTRAINT "registry_checkpoints_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."registry_vasp_events" ADD CONSTRAINT "registry_vasp_events_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."registry_vasp_events" ADD CONSTRAINT "registry_vasp_events_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."safe_events" ADD CONSTRAINT "safe_events_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."safe_events" ADD CONSTRAINT "safe_events_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."swaps" ADD CONSTRAINT "swaps_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."swaps" ADD CONSTRAINT "swaps_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."token_admin_events" ADD CONSTRAINT "token_admin_events_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."token_admin_events" ADD CONSTRAINT "token_admin_events_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."token_transfers" ADD CONSTRAINT "token_transfers_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."token_transfers" ADD CONSTRAINT "token_transfers_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."travel_rule_attestations" ADD CONSTRAINT "travel_rule_attestations_block_number_blocks_number_fk" FOREIGN KEY ("block_number") REFERENCES "indexer"."blocks"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer"."travel_rule_attestations" ADD CONSTRAINT "travel_rule_attestations_tx_hash_transactions_hash_fk" FOREIGN KEY ("tx_hash") REFERENCES "indexer"."transactions"("hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balances_history_block" ON "indexer"."balances_history" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "registry_account_history" ON "indexer"."registry_account_events" USING btree ("account","block_number","log_index");--> statement-breakpoint
CREATE INDEX "registry_vasp_history" ON "indexer"."registry_vasp_events" USING btree ("vasp_id","block_number","log_index");--> statement-breakpoint
CREATE INDEX "safe_events_hash" ON "indexer"."safe_events" USING btree ("safe_tx_hash");--> statement-breakpoint
CREATE INDEX "swaps_maker" ON "indexer"."swaps" USING btree ("maker","block_number","log_index");--> statement-breakpoint
CREATE INDEX "swaps_taker" ON "indexer"."swaps" USING btree ("taker","block_number","log_index");--> statement-breakpoint
CREATE INDEX "token_transfers_sender" ON "indexer"."token_transfers" USING btree ("from_address","block_number","log_index");--> statement-breakpoint
CREATE INDEX "token_transfers_recipient" ON "indexer"."token_transfers" USING btree ("to_address","block_number","log_index");--> statement-breakpoint
CREATE INDEX "token_transfers_travel_rule" ON "indexer"."token_transfers" USING btree ("travel_rule_ref");--> statement-breakpoint
CREATE INDEX "travel_rule_attestations_ref" ON "indexer"."travel_rule_attestations" USING btree ("ref_id");