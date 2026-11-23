CREATE TABLE "gateway"."log_entries" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"tx_hash" "bytea" NOT NULL,
	"sender" "bytea" NOT NULL,
	"tx_nonce" bigint NOT NULL,
	"raw_tx" "bytea" NOT NULL,
	"received_at_ms" bigint NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"entry_hash" "bytea" NOT NULL,
	"signature" "bytea" NOT NULL,
	"source" text NOT NULL,
	"vasp_id" integer,
	"forward_status" text DEFAULT 'queued' NOT NULL,
	"forward_error" text,
	"forwarded_at" timestamp with time zone,
	"included_block" bigint,
	"included_index" integer,
	CONSTRAINT "log_entries_tx_hash_unique" UNIQUE("tx_hash"),
	CONSTRAINT "log_entries_binary_sizes" CHECK (
      octet_length("gateway"."log_entries"."tx_hash") = 32 and octet_length("gateway"."log_entries"."sender") = 20
      and octet_length("gateway"."log_entries"."prev_hash") = 32 and octet_length("gateway"."log_entries"."entry_hash") = 32
      and octet_length("gateway"."log_entries"."signature") = 65
    )
);
--> statement-breakpoint
CREATE TABLE "gateway"."rejections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"sender" "bytea",
	"tx_hash" "bytea",
	"reason" text NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "log_entries_sender_nonce" ON "gateway"."log_entries" USING btree ("sender","tx_nonce");--> statement-breakpoint
CREATE INDEX "log_entries_status_seq" ON "gateway"."log_entries" USING btree ("forward_status","seq");
--> statement-breakpoint
CREATE FUNCTION "gateway"."protect_receipt_log"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Gateway receipts are append-only';
  END IF;
  IF ROW(OLD.seq, OLD.tx_hash, OLD.sender, OLD.tx_nonce, OLD.raw_tx,
         OLD.received_at_ms, OLD.prev_hash, OLD.entry_hash, OLD.signature, OLD.source, OLD.vasp_id)
     IS DISTINCT FROM
     ROW(NEW.seq, NEW.tx_hash, NEW.sender, NEW.tx_nonce, NEW.raw_tx,
         NEW.received_at_ms, NEW.prev_hash, NEW.entry_hash, NEW.signature, NEW.source, NEW.vasp_id) THEN
    RAISE EXCEPTION 'Gateway receipt fields are immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "protect_receipt_log_row"
  BEFORE UPDATE OR DELETE ON "gateway"."log_entries"
  FOR EACH ROW EXECUTE FUNCTION "gateway"."protect_receipt_log"();
--> statement-breakpoint
CREATE TRIGGER "protect_receipt_log_truncate"
  BEFORE TRUNCATE ON "gateway"."log_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "gateway"."protect_receipt_log"();
