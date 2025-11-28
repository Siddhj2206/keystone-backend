import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, desc, inArray } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { semesters, subjects, topics, assessments, events, studySessions } from "../db/schema";
import type {
  Semester,
  InitializeSemesterInput,
  UpdateSemesterInput,
  AppContext,
  DbSemester,
} from "../lib/types";

export const semesterRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Transform DB semester to API response format
function formatSemester(dbSemester: DbSemester): Semester {
  const createdAt = typeof dbSemester.createdAt === "number"
    ? new Date(dbSemester.createdAt).toISOString()
    : dbSemester.createdAt;
    
  return {
    id: dbSemester.id,
    name: dbSemester.name ?? undefined,
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
  name: z.string().optional(),
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
      name: input.name ?? null,
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
    // Batch insert all subjects at once
    const subjectValues = input.subjects.map((subjectInput) => ({
      id: crypto.randomUUID(),
      userId: user.id,
      semesterId: newSemester.id,
      name: subjectInput.name,
      colorHex: subjectInput.colorHex,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }));

    const newSubjects = await db.insert(subjects).values(subjectValues).returning();

    // Batch insert all class events at once
    const eventValues: Array<{
      id: string;
      userId: string;
      semesterId: string;
      subjectId: string;
      title: string;
      type: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      colorHex: string;
      createdAt: number;
      updatedAt: number;
    }> = [];

    for (let i = 0; i < input.subjects.length; i++) {
      const subjectInput = input.subjects[i]!;
      const newSubject = newSubjects[i];
      if (newSubject && subjectInput.classSlots && subjectInput.classSlots.length > 0) {
        for (const slot of subjectInput.classSlots) {
          eventValues.push({
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
          });
        }
      }
    }

    if (eventValues.length > 0) {
      await db.insert(events).values(eventValues);
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

// PATCH /api/semester/:id - Update semester
const updateSemesterSchema = z.object({
  name: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
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
});

semesterRoutes.patch("/:id", zValidator("json", updateSemesterSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const semesterId = c.req.param("id");
  const input = c.req.valid("json") as UpdateSemesterInput;
  const now = Date.now();

  // Verify semester belongs to user
  const existing = await db.query.semesters.findFirst({
    where: and(eq(semesters.id, semesterId), eq(semesters.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Semester not found" }, 404);
  }

  // Validate dates if both provided
  const newStartDate = input.startDate ?? existing.startDate;
  const newEndDate = input.endDate ?? existing.endDate;
  if (newStartDate >= newEndDate) {
    return c.json({ error: "End date must be after start date" }, 400);
  }

  // Build update object
  const updateData: Partial<DbSemester> = { updatedAt: now };
  if (input.name !== undefined) updateData.name = input.name || null;
  if (input.startDate !== undefined) updateData.startDate = input.startDate;
  if (input.endDate !== undefined) updateData.endDate = input.endDate;
  if (input.studyHours !== undefined) updateData.studyHours = JSON.stringify(input.studyHours);

  const [updated] = await db
    .update(semesters)
    .set(updateData)
    .where(eq(semesters.id, semesterId))
    .returning();

  if (!updated) {
    return c.json({ error: "Failed to update semester" }, 500);
  }

  return c.json(formatSemester(updated));
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

// GET /api/semester/archived - Get all archived (inactive) semesters
semesterRoutes.get("/archived", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const archivedSemesters = await db.query.semesters.findMany({
    where: and(eq(semesters.userId, user.id), eq(semesters.isActive, false)),
    orderBy: [desc(semesters.createdAt)],
  });

  return c.json(archivedSemesters.map(formatSemester));
});

// POST /api/semester/:id/restore - Restore an archived semester
semesterRoutes.post("/:id/restore", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const semesterId = c.req.param("id");
  const now = Date.now();

  // Verify semester belongs to user and is archived
  const existing = await db.query.semesters.findFirst({
    where: and(eq(semesters.id, semesterId), eq(semesters.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Semester not found" }, 404);
  }

  if (existing.isActive) {
    return c.json({ error: "Semester is already active" }, 400);
  }

  // Deactivate all other semesters for this user
  await db
    .update(semesters)
    .set({ isActive: false, updatedAt: now })
    .where(and(eq(semesters.userId, user.id), eq(semesters.isActive, true)));

  // Activate the target semester
  const [restored] = await db
    .update(semesters)
    .set({ isActive: true, updatedAt: now })
    .where(eq(semesters.id, semesterId))
    .returning();

  if (!restored) {
    return c.json({ error: "Failed to restore semester" }, 500);
  }

  return c.json(formatSemester(restored));
});

// DELETE /api/semester/:id - Permanently delete a semester and all related data
semesterRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const semesterId = c.req.param("id");

  // Verify semester belongs to user
  const existing = await db.query.semesters.findFirst({
    where: and(eq(semesters.id, semesterId), eq(semesters.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Semester not found" }, 404);
  }

  // Get all subjects for this semester to delete their related data
  const semesterSubjects = await db.query.subjects.findMany({
    where: eq(subjects.semesterId, semesterId),
  });

  const subjectIds = semesterSubjects.map((s) => s.id);

  if (subjectIds.length > 0) {
    // Get all topics for these subjects to delete study sessions
    const subjectTopics = await db.query.topics.findMany({
      where: inArray(topics.subjectId, subjectIds),
    });

    const topicIds = subjectTopics.map((t) => t.id);

    // Delete study sessions for these topics
    if (topicIds.length > 0) {
      await db.delete(studySessions).where(inArray(studySessions.topicId, topicIds));
    }

    // Delete topics for these subjects
    await db.delete(topics).where(inArray(topics.subjectId, subjectIds));

    // Delete assessments for these subjects
    await db.delete(assessments).where(inArray(assessments.subjectId, subjectIds));

    // Delete subjects
    await db.delete(subjects).where(inArray(subjects.id, subjectIds));
  }

  // Delete events for this semester
  await db.delete(events).where(eq(events.semesterId, semesterId));

  // Delete the semester itself
  await db.delete(semesters).where(eq(semesters.id, semesterId));

  return c.json({ message: "Semester deleted" });
});
