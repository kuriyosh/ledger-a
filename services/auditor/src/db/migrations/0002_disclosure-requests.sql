CREATE TABLE "auditor"."disclosures" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"vasp_id" integer NOT NULL,
	"vasp_request_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "disclosures_address" ON "auditor"."disclosures" USING btree ("address");