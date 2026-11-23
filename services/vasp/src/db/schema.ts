import {
  bigint,
  customType,
  date,
  index,
  pgSequence,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const instant = (name: string) => timestamp(name, { withTimezone: true });
export const customerNumber = pgSequence("customer_number_seq");

export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  familyName: text("family_name").notNull(),
  givenName: text("given_name").notNull(),
  dateOfBirth: date("date_of_birth").notNull(),
  country: text("country").notNull(),
  addressLine: text("address_line").notNull(),
  email: text("email").notNull().unique(),
  kycStatus: text("kyc_status", {
    enum: ["pending", "approved", "rejected", "error"],
  })
    .notNull()
    .default("pending"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

export const wallets = pgTable("wallets", {
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.id),
  address: bytes("address").notNull().unique(),
  encryptedPrivateKey: bytes("encrypted_private_key").notNull(),
  registeredTxHash: bytes("registered_tx_hash"),
  registeredBlockNumber: bigint("registered_block_number", { mode: "bigint" }),
  registeredBlockHash: bytes("registered_block_hash"),
  validUntil: instant("valid_until").notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: bytes("token_hash").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    expiresAt: instant("expires_at").notNull(),
  },
  (row) => [index("sessions_expiry").on(row.expiresAt)],
);

export const registryRequests = pgTable("registry_requests", {
  customerId: text("customer_id")
    .primaryKey()
    .references(() => customers.id),
  action: text("action", {
    enum: ["register", "suspend", "reinstate"],
  }).notNull(),
  txHash: bytes("tx_hash").notNull().unique(),
  rawTx: bytes("raw_tx").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
});
