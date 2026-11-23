CREATE TABLE "travel_rule_messages" (
	"ref_id" "bytea" PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"counterparty_vasp_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"name_match" boolean,
	"attestation" jsonb,
	"signature" "bytea",
	"tx_hash" "bytea",
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "travel_rule_direction_status" ON "travel_rule_messages" USING btree ("direction","status","created_at");