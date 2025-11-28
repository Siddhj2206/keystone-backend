import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, desc } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { semesters, subjects, events } from "../db/schema";
import type { Semester, InitializeSemesterInput } from "../lib/types";

export const semesterRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Transform DB semester to API response format
function formatSemester(dbSemester: any): Semester {
  const createdAt = typeof dbSemester.createdAt === "number"
    ? new Date(dbSemester.createdAt).toISOString()
    : dbSemester.createdAt;
    
  return {
    id: dbSemester.id,
    startDate: dbSemester.startDate,
    endDate: dbSemester.endDate,
    isActive: dbSemester.isActive,
    createdAt,
    studyHours: dbSemester.studyHours ? JSON.parse(dbSemester.studyHours) : undefined,
  };
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/semester/current - Get current active semester
semesterRoutes.get("/current", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const semester = await db.query.semesters.findFirst({
    where: and(eq(semesters.userId, user.id), eq(semesters.isActive, true)),
  });

  if (!semester) {
    return c.json({ error: "No active semester found" }, 404);
  }

  return c.json(formatSemester(semester));
});

// POST /api/semester/initialize - Initialize new semester
const initializeSemesterSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  studyHours: z
    .object({
      0: z.number(),
      1: z.number(),
      2: z.number(),
      3: z.number(),
      4: z.number(),
      5: z.number(),
      6: z.number(),
    })
    .optional(),
  subjects: z
    .array(
      z.object({
        name: z.string(),
        colorHex: z.string(),
        classSlots: z
          .array(
            z.object({
              dayOfWeek: z.number().min(0).max(6),
              startTime: z.string(),
              endTime: z.string(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

semesterRoutes.post("/initialize", zValidator("json", initializeSemesterSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const input = c.req.valid("json") as InitializeSemesterInput;
  const now = Date.now();

  // Deactivate any existing active semesters
  await db
    .update(semesters)
    .set({ isActive: false, updatedAt: now })
    .where(and(eq(semesters.userId, user.id), eq(semesters.isActive, true)));

  // Create new semester
  const [newSemester] = await db
    .insert(semesters)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      startDate: input.startDate,
      endDate: input.endDate,
      isActive: true,
      studyHours: input.studyHours ? JSON.stringify(input.studyHours) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!newSemester) {
    return c.json({ error: "Failed to create semester" }, 500);
  }

  // Create subjects if provided
  if (input.subjects && input.subjects.length > 0) {
    for (const subjectInput of input.subjects) {
      const [newSubject] = await db
        .insert(subjects)
        .values({
          id: crypto.randomUUID(),
          userId: user.id,
          semesterId: newSemester.id,
          name: subjectInput.name,
          colorHex: subjectInput.colorHex,
          progress: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // Create class events if provided
      if (newSubject && subjectInput.classSlots && subjectInput.classSlots.length > 0) {
        await db.insert(events).values(
          subjectInput.classSlots.map((slot) => ({
            id: crypto.randomUUID(),
            userId: user.id,
            semesterId: newSemester.id,
            subjectId: newSubject.id,
            title: "",
            type: "class",
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
            colorHex: subjectInput.colorHex,
            createdAt: now,
            updatedAt: now,
          }))
        );
      }
    }
  }

  return c.json(formatSemester(newSemester), 201);
});

// POST /api/semester/archive - Archive current semester
semesterRoutes.post("/archive", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const now = Date.now();
  const result = await db
    .update(semesters)
    .set({ isActive: false, updatedAt: now })
    .where(and(eq(semesters.userId, user.id), eq(semesters.isActive, true)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "No active semester to archive" }, 404);
  }

  return c.json({ message: "Semester archived" });
});

// GET /api/semester/history - Get semester history
semesterRoutes.get("/history", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const allSemesters = await db.query.semesters.findMany({
    where: eq(semesters.userId, user.id),
    orderBy: [desc(semesters.createdAt)],
  });

  return c.json(allSemesters.map(formatSemester));
});
