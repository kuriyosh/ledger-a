CREATE TABLE "demo"."enforcement_deposits" (
  "id" text PRIMARY KEY NOT NULL,
  "action" text NOT NULL,
  "hash" text NOT NULL UNIQUE,
  "raw_tx" text NOT NULL,
  "probe_before" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
