import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, inArray } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { assessments, subjects } from "../db/schema";
import type { Assessment, AppContext, DbAssessment } from "../lib/types";

export const assessmentRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Parse topicIds JSON safely
function parseTopicIds(topicIds: string | null): string[] {
  if (!topicIds) return [];
  try {
    return JSON.parse(topicIds);
  } catch {
    return [];
  }
}

// Transform DB assessment to API response format
function formatAssessment(dbAssessment: DbAssessment): Assessment {
  return {
    id: dbAssessment.id,
    title: dbAssessment.title,
    date: typeof dbAssessment.date === "number" 
      ? new Date(dbAssessment.date).toISOString()
      : String(dbAssessment.date),
    weightage: dbAssessment.weightage,
    subjectId: dbAssessment.subjectId,
    topicIds: parseTopicIds(dbAssessment.topicIds),
  };
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/assessments - List all assessments
assessmentRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Get user's subjects
  const userSubjects = await db.query.subjects.findMany({
    where: eq(subjects.userId, user.id),
  });

  const subjectIds = userSubjects.map((s) => s.id);

  if (subjectIds.length === 0) {
    return c.json([]);
  }

  const allAssessments = await db.query.assessments.findMany({
    where: inArray(assessments.subjectId, subjectIds),
    orderBy: (assessments, { asc }) => [asc(assessments.date)],
  });

  return c.json(allAssessments.map(formatAssessment));
});

// GET /api/assessments/:id - Get single assessment
assessmentRoutes.get("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const assessmentId = c.req.param("id");

  const assessment = await db.query.assessments.findFirst({
    where: eq(assessments.id, assessmentId),
    with: {
      subject: true,
    },
  });

  if (!assessment) {
    return c.json({ error: "Assessment not found" }, 404);
  }

  // Verify ownership through subject
  if (assessment.subject.userId !== user.id) {
    return c.json({ error: "Assessment not found" }, 404);
  }

  return c.json(formatAssessment(assessment));
});

// POST /api/assessments - Create assessment
const createAssessmentSchema = z.object({
  subjectId: z.string(),
  title: z.string().min(1),
  date: z.string(),
  weightage: z.number().min(0).max(100),
  topicIds: z.array(z.string()).optional(),
});

assessmentRoutes.post("/", zValidator("json", createAssessmentSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const input = c.req.valid("json");
  const now = Date.now();

  // Verify subject ownership
  const subject = await db.query.subjects.findFirst({
    where: and(eq(subjects.id, input.subjectId), eq(subjects.userId, user.id)),
  });

  if (!subject) {
    return c.json({ error: "Subject not found" }, 404);
  }

  const [newAssessment] = await db
    .insert(assessments)
    .values({
      id: crypto.randomUUID(),
      subjectId: input.subjectId,
      title: input.title,
      date: new Date(input.date).getTime(),
      weightage: input.weightage,
      topicIds: JSON.stringify(input.topicIds || []),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!newAssessment) {
    return c.json({ error: "Failed to create assessment" }, 500);
  }

  return c.json(formatAssessment(newAssessment), 201);
});

// PATCH /api/assessments/:id - Update assessment
const updateAssessmentSchema = z.object({
  title: z.string().min(1).optional(),
  date: z.string().optional(),
  weightage: z.number().min(0).max(100).optional(),
  topicIds: z.array(z.string()).optional(),
});

assessmentRoutes.patch("/:id", zValidator("json", updateAssessmentSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const assessmentId = c.req.param("id");
  const input = c.req.valid("json");
  const now = Date.now();

  // Verify ownership through subject
  const existing = await db.query.assessments.findFirst({
    where: eq(assessments.id, assessmentId),
    with: { subject: true },
  });

  if (!existing || existing.subject.userId !== user.id) {
    return c.json({ error: "Assessment not found" }, 404);
  }

  // Update assessment fields
  const updateData: Partial<DbAssessment> = { updatedAt: now };
  if (input.title !== undefined) updateData.title = input.title;
  if (input.date !== undefined) updateData.date = new Date(input.date).getTime();
  if (input.weightage !== undefined) updateData.weightage = input.weightage;
  if (input.topicIds !== undefined) updateData.topicIds = JSON.stringify(input.topicIds);

  const [updated] = await db
    .update(assessments)
    .set(updateData)
    .where(eq(assessments.id, assessmentId))
    .returning();

  if (!updated) {
    return c.json({ error: "Failed to update assessment" }, 500);
  }

  return c.json(formatAssessment(updated));
});

// DELETE /api/assessments/:id - Delete assessment
assessmentRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const assessmentId = c.req.param("id");

  // Verify ownership through subject
  const existing = await db.query.assessments.findFirst({
    where: eq(assessments.id, assessmentId),
    with: { subject: true },
  });

  if (!existing || existing.subject.userId !== user.id) {
    return c.json({ error: "Assessment not found" }, 404);
  }

  await db.delete(assessments).where(eq(assessments.id, assessmentId));

  return c.json({ message: "Assessment deleted" });
});
