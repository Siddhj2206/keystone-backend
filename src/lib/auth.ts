import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { db } from "../db";
import * as schema from "../db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [expo(), bearer()],
  trustedOrigins: [
    "keystonemobile://",
    "exp://",
    "http://localhost:8081",
  ],
  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
});

export type Auth = typeof auth;
