import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// Configure postgres client for Supabase pooler compatibility
const client = postgres(connectionString, {
  idle_timeout: 20, // Close idle connections after 20 seconds
  max_lifetime: 60 * 5, // Max connection lifetime of 5 minutes
  connect_timeout: 10, // Connection timeout of 10 seconds
});

export const db = drizzle(client, { schema });

export * from "./schema";
