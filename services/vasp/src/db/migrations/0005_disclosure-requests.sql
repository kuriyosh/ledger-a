CREATE TABLE "disclosure_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"address" "bytea" NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"disclosure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "disclosures_created" ON "disclosure_requests" USING btree ("created_at","id");