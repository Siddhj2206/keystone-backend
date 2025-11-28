import { Hono } from "hono";
import { auth } from "../lib/auth";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

export const authRoutes = new Hono();

// Get current user info (extends Better Auth)
authRoutes.get("/me", async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
  });
});
