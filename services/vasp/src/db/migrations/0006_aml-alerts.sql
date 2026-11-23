CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"transfer_id" text NOT NULL,
	"address" "bytea" NOT NULL,
	"rule" text NOT NULL,
	"detail" jsonb NOT NULL,
	"status" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" "bytea" NOT NULL,
	"reason_id" "bytea",
	"request_timestamp" bigint,
	"proposal_id" text,
	"evidence_reorged" boolean DEFAULT false NOT NULL,
	"withdrawal_sent_at" timestamp with time zone,
	"proposal_settled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_reason_id_unique" UNIQUE("reason_id")
);
--> statement-breakpoint
CREATE TABLE "aml_checked_transfers" (
	"transfer_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aml_checked_transfers" ADD CONSTRAINT "aml_checked_transfers_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_transfer_rule" ON "alerts" USING btree ("transfer_id","rule");--> statement-breakpoint
CREATE INDEX "alerts_status" ON "alerts" USING btree ("status","id");