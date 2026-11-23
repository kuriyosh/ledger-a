CREATE TABLE "consortium"."approvals" (
	"proposal_id" text NOT NULL,
	"member_id" integer NOT NULL,
	"member_address" "bytea" NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"block_number" bigint NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_proposal_id_member_id_pk" PRIMARY KEY("proposal_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "consortium"."pending_actions" (
	"proposal_id" text PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"action" text NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"raw_tx" "bytea" NOT NULL,
	"first_block" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_actions_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "consortium"."proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"params" jsonb NOT NULL,
	"reason" text NOT NULL,
	"request_digest" "bytea",
	"requested_by_vasp_id" integer,
	"requested_by_member_id" integer,
	"to_address" "bytea" NOT NULL,
	"data" "bytea" NOT NULL,
	"safe_nonce" bigint NOT NULL,
	"safe_tx_hash" "bytea" NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_block" bigint NOT NULL,
	"executed_tx_hash" "bytea",
	"executed_block" bigint,
	"execution_finalized" boolean DEFAULT false NOT NULL,
	"failed_tx_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_request_digest_unique" UNIQUE("request_digest"),
	CONSTRAINT "proposals_safe_tx_hash_unique" UNIQUE("safe_tx_hash")
);
--> statement-breakpoint
ALTER TABLE "consortium"."approvals" ADD CONSTRAINT "approvals_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "consortium"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consortium"."pending_actions" ADD CONSTRAINT "pending_actions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "consortium"."proposals"("id") ON DELETE no action ON UPDATE no action;