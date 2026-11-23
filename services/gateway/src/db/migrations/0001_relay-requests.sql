CREATE TABLE "gateway"."relay_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"vasp_id" integer NOT NULL,
	"request_from" "bytea" NOT NULL,
	"request_to" "bytea" NOT NULL,
	"selector" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gateway"."relay_requests" ADD CONSTRAINT "relay_requests_seq_log_entries_seq_fk" FOREIGN KEY ("seq") REFERENCES "gateway"."log_entries"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_requests_seq" ON "gateway"."relay_requests" USING btree ("seq");