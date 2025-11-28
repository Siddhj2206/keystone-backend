import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { events, semesters } from "../db/schema";
import type { AppContext, DbEvent, Event } from "../lib/types";

export const eventRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function getActiveSemester(userId: string) {
  return db.query.semesters.findFirst({
    where: and(eq(semesters.userId, userId), eq(semesters.isActive, true)),
  });
}

// Transform DB event to API response format
function formatEvent(dbEvent: DbEvent): Event {
  return {
    id: dbEvent.id,
    semesterId: dbEvent.semesterId,
    subjectId: dbEvent.subjectId,
    title: dbEvent.title,
    type: dbEvent.type as Event["type"],
    dayOfWeek: dbEvent.dayOfWeek,
    startTime: dbEvent.startTime,
    endTime: dbEvent.endTime,
    colorHex: dbEvent.colorHex,
  };
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/events - List all events for active semester
eventRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const activeSemester = await getActiveSemester(user.id);
  if (!activeSemester) {
    return c.json([]);
  }

  const allEvents = await db.query.events.findMany({
    where: and(eq(events.userId, user.id), eq(events.semesterId, activeSemester.id)),
  });

  return c.json(allEvents.map(formatEvent));
});

// GET /api/events/:id - Get single event
eventRoutes.get("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const eventId = c.req.param("id");

  const event = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, user.id)),
  });

  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }

  return c.json(formatEvent(event));
});

// POST /api/events - Create event
const createEventSchema = z.object({
  subjectId: z.string().nullable().optional(),
  title: z.string(),
  type: z.enum(["class", "fixed"]),
  dayOfWeek: z.number().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

eventRoutes.post("/", zValidator("json", createEventSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const input = c.req.valid("json");
  const now = Date.now();

  const activeSemester = await getActiveSemester(user.id);
  if (!activeSemester) {
    return c.json({ error: "No active semester found" }, 404);
  }

  const [newEvent] = await db
    .insert(events)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      semesterId: activeSemester.id,
      subjectId: input.subjectId || null,
      title: input.title,
      type: input.type,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      colorHex: input.colorHex,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!newEvent) {
    return c.json({ error: "Failed to create event" }, 500);
  }

  return c.json(formatEvent(newEvent), 201);
});

// PATCH /api/events/:id - Update event
const updateEventSchema = z.object({
  subjectId: z.string().nullable().optional(),
  title: z.string().optional(),
  type: z.enum(["class", "fixed"]).optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

eventRoutes.patch("/:id", zValidator("json", updateEventSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const eventId = c.req.param("id");
  const input = c.req.valid("json");
  const now = Date.now();

  // Verify ownership
  const existing = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Event not found" }, 404);
  }

  // Update event fields
  const updateData: any = { updatedAt: now };
  if (input.subjectId !== undefined) updateData.subjectId = input.subjectId;
  if (input.title !== undefined) updateData.title = input.title;
  if (input.type !== undefined) updateData.type = input.type;
  if (input.dayOfWeek !== undefined) updateData.dayOfWeek = input.dayOfWeek;
  if (input.startTime !== undefined) updateData.startTime = input.startTime;
  if (input.endTime !== undefined) updateData.endTime = input.endTime;
  if (input.colorHex !== undefined) updateData.colorHex = input.colorHex;

  const [updated] = await db
    .update(events)
    .set(updateData)
    .where(eq(events.id, eventId))
    .returning();

  if (!updated) {
    return c.json({ error: "Failed to update event" }, 500);
  }

  return c.json(formatEvent(updated));
});

// DELETE /api/events/:id - Delete event
eventRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const eventId = c.req.param("id");

  // Verify ownership
  const existing = await db.query.events.findFirst({
    where: and(eq(events.id, eventId), eq(events.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Event not found" }, 404);
  }

  await db.delete(events).where(eq(events.id, eventId));

  return c.json({ message: "Event deleted" });
});
