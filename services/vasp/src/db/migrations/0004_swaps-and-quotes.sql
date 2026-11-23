CREATE TABLE "quotes_issued" (
	"nonce" numeric(78, 0) PRIMARY KEY NOT NULL,
	"quote" jsonb NOT NULL,
	"signature" "bytea" NOT NULL,
	"quote_hash" "bytea" NOT NULL,
	"request_digest" "bytea" NOT NULL,
	"requested_by_vasp_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"filled_tx_hash" "bytea",
	"filled_block_number" bigint,
	CONSTRAINT "quotes_issued_quote_hash_unique" UNIQUE("quote_hash"),
	CONSTRAINT "quotes_issued_request_digest_unique" UNIQUE("request_digest")
);
--> statement-breakpoint
CREATE TABLE "swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"quote_hash" "bytea" NOT NULL,
	"quote" jsonb NOT NULL,
	"maker_signature" "bytea" NOT NULL,
	"status" text NOT NULL,
	"allow_expired" boolean DEFAULT false NOT NULL,
	"tx_hash" "bytea",
	"gateway_tx_hash" "bytea",
	"block_number" bigint,
	"block_hash" "bytea",
	"gateway_seq" bigint,
	"first_gateway_seq" bigint,
	"forward_nonce" numeric(78, 0),
	"forward_first_block" bigint,
	"forward_requests" jsonb,
	"simulation_error" text,
	"error_code" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "swaps_quote_hash_unique" UNIQUE("quote_hash")
);
--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swaps_customer_date" ON "swaps" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "swaps_block" ON "swaps" USING btree ("block_number");--> statement-breakpoint
CREATE INDEX "swaps_pending" ON "swaps" USING btree ("id") WHERE "swaps"."status" = 'submitted';