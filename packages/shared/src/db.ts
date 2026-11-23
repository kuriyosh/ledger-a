import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { z } from "zod";

export const databaseUrl = z.url({ protocol: /^postgres(?:ql)?$/ });

export async function openDatabase(
  connectionString: string,
  schema: string,
  migrationsFolder: string,
) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("Invalid schema name");

  const pool = new Pool({
    connectionString: databaseUrl.parse(connectionString),
    options: `-c search_path=${schema}`,
  });
  const db = drizzle(pool);
  try {
    await db.execute(
      sql`create schema if not exists ${sql.identifier(schema)}`,
    );
    await migrate(db, { migrationsFolder, migrationsSchema: schema });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { db, close: () => pool.end() };
}
