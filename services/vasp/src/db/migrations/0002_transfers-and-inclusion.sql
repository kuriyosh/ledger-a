CREATE TABLE "processed_blocks" (
	"block_number" bigint PRIMARY KEY NOT NULL,
	"block_hash" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"direction" text NOT NULL,
	"counterparty_address" "bytea" NOT NULL,
	"counterparty_vasp_id" integer,
	"token" "bytea" NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"beneficiary_name" jsonb,
	"ref_id" "bytea",
	"tx_hash" "bytea",
	"block_number" bigint,
	"block_hash" "bytea",
	"log_index" integer,
	"gateway_seq" bigint,
	"revision" integer DEFAULT 0 NOT NULL,
	"forward_request" jsonb,
	"first_gateway_seq" bigint,
	"submit_on_revert" boolean DEFAULT false NOT NULL,
	"skip_checks" boolean DEFAULT false NOT NULL,
	"simulation_error" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfers_customer_created" ON "transfers" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "transfers_inclusion" ON "transfers" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "transfers_work_queue" ON "transfers" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_transfer_occurrence" ON "transfers" USING btree ("tx_hash","block_hash","log_index","customer_id") WHERE "transfers"."direction" = 'in';