CREATE TABLE "gateway"."demo_reorder" (
	"id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"held_seq" bigint,
	"next_seq" bigint,
	"held_until" timestamp with time zone
);
