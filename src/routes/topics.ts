import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, inArray } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { topics, subjects, studySessions } from "../db/schema";
import type { Topic, AppContext, DbTopic } from "../lib/types";

export const topicRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Verify topic ownership through subject
async function verifyTopicOwnership(topicId: string, userId: string) {
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    with: { subject: true },
  });

  if (!topic) return null;
  if (topic.subject.userId !== userId) return null;
  return topic;
}

// Transform DB topic to API response format
function formatTopic(dbTopic: DbTopic): Topic {
  return {
    id: dbTopic.id,
    title: dbTopic.title,
    parentId: dbTopic.parentId,
    estMinutes: dbTopic.estMinutes,
    currentMastery: typeof dbTopic.currentMastery === "number" 
      ? dbTopic.currentMastery 
      : parseFloat(String(dbTopic.currentMastery)) || 0,
    status: dbTopic.status as Topic["status"],
    sortOrder: dbTopic.sortOrder,
  };
}

// Update subject progress based on completed topics
async function updateSubjectProgress(subjectId: string) {
  const allTopics = await db.query.topics.findMany({
    where: eq(topics.subjectId, subjectId),
  });

  if (allTopics.length === 0) return;

  const completedCount = allTopics.filter((t) => t.status === "completed").length;
  const progress = completedCount / allTopics.length;
  const now = Date.now();

  await db
    .update(subjects)
    .set({
      progress,
      updatedAt: now,
    })
    .where(eq(subjects.id, subjectId));
}

// ============================================================================
// Routes
// ============================================================================

// POST /api/topics - Create topic
const createTopicSchema = z.object({
  subjectId: z.string(),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1),
  estMinutes: z.number().positive().optional(),
  sortOrder: z.number().optional(),
});

topicRoutes.post("/", zValidator("json", createTopicSchema), async (c) => {
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

  const [newTopic] = await db
    .insert(topics)
    .values({
      id: crypto.randomUUID(),
      subjectId: input.subjectId,
      parentId: input.parentId || null,
      title: input.title,
      estMinutes: input.estMinutes || 30,
      currentMastery: 0,
      status: "pending",
      sortOrder: input.sortOrder || 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!newTopic) {
    return c.json({ error: "Failed to create topic" }, 500);
  }

  return c.json(formatTopic(newTopic), 201);
});

// PATCH /api/topics/:id - Update topic
const updateTopicSchema = z.object({
  title: z.string().min(1).optional(),
  estMinutes: z.number().positive().optional(),
  currentMastery: z.number().min(0).max(1).optional(),
  status: z.enum(["pending", "completed", "needs_revision"]).optional(),
  sortOrder: z.number().optional(),
});

topicRoutes.patch("/:id", zValidator("json", updateTopicSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const topicId = c.req.param("id");
  const input = c.req.valid("json");
  const now = Date.now();

  const topic = await verifyTopicOwnership(topicId, user.id);
  if (!topic) {
    return c.json({ error: "Topic not found" }, 404);
  }

  const updateData: Partial<DbTopic> = { updatedAt: now };
  if (input.title !== undefined) updateData.title = input.title;
  if (input.estMinutes !== undefined) updateData.estMinutes = input.estMinutes;
  if (input.currentMastery !== undefined) updateData.currentMastery = input.currentMastery;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;

  const [updated] = await db
    .update(topics)
    .set(updateData)
    .where(eq(topics.id, topicId))
    .returning();

  if (!updated) {
    return c.json({ error: "Failed to update topic" }, 500);
  }

  return c.json(formatTopic(updated));
});

// PATCH /api/topics/:id/mastery - Update topic mastery
const updateMasterySchema = z.object({
  mastery: z.number().min(0).max(1),
});

topicRoutes.patch("/:id/mastery", zValidator("json", updateMasterySchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const topicId = c.req.param("id");
  const { mastery } = c.req.valid("json");
  const now = Date.now();

  const topic = await verifyTopicOwnership(topicId, user.id);
  if (!topic) {
    return c.json({ error: "Topic not found" }, 404);
  }

  // Determine new status based on mastery
  let newStatus: "pending" | "completed" | "needs_revision" = "pending";
  if (mastery >= 0.8) {
    newStatus = "completed";
  } else if (mastery > 0 && mastery < 0.5) {
    newStatus = "needs_revision";
  }

  const [updated] = await db
    .update(topics)
    .set({
      currentMastery: mastery,
      status: newStatus,
      updatedAt: now,
    })
    .where(eq(topics.id, topicId))
    .returning();

  // Update subject progress
  await updateSubjectProgress(topic.subjectId);

  if (!updated) {
    return c.json({ error: "Failed to update topic mastery" }, 500);
  }

  return c.json(formatTopic(updated));
});

// PUT /api/topics/:id/reorder - Reorder topic
const reorderSchema = z.object({
  sortOrder: z.number(),
  parentId: z.string().nullable().optional(),
});

topicRoutes.put("/:id/reorder", zValidator("json", reorderSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const topicId = c.req.param("id");
  const { sortOrder, parentId } = c.req.valid("json");
  const now = Date.now();

  const topic = await verifyTopicOwnership(topicId, user.id);
  if (!topic) {
    return c.json({ error: "Topic not found" }, 404);
  }

  const [updated] = await db
    .update(topics)
    .set({
      sortOrder,
      parentId: parentId !== undefined ? parentId : topic.parentId,
      updatedAt: now,
    })
    .where(eq(topics.id, topicId))
    .returning();

  if (!updated) {
    return c.json({ error: "Failed to reorder topic" }, 500);
  }

  return c.json(formatTopic(updated));
});

// Recursively get all descendant topic IDs (optimized batch version)
async function getAllDescendantIds(topicId: string): Promise<string[]> {
  const descendantIds: string[] = [];
  let currentLevelIds = [topicId];

  // Iteratively fetch children level by level
  while (currentLevelIds.length > 0) {
    const children = await db.query.topics.findMany({
      where: inArray(topics.parentId, currentLevelIds),
      columns: { id: true },
    });

    const childIds = children.map((c) => c.id);
    descendantIds.push(...childIds);
    currentLevelIds = childIds;
  }

  return descendantIds;
}

// DELETE /api/topics/:id - Delete topic
topicRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const topicId = c.req.param("id");

  const topic = await verifyTopicOwnership(topicId, user.id);
  if (!topic) {
    return c.json({ error: "Topic not found" }, 404);
  }

  // Get all descendant IDs to delete (cascade at app level since self-referential FK can't cascade)
  const descendantIds = await getAllDescendantIds(topicId);
  const allIdsToDelete = [topicId, ...descendantIds];

  // Delete all study sessions for these topics first
  if (allIdsToDelete.length > 0) {
    await db.delete(studySessions).where(inArray(studySessions.topicId, allIdsToDelete));
  }

  // Delete all topics in one batch (must delete children first due to FK)
  // Since we can't easily order by depth, delete in reverse order of discovery
  // which naturally puts children before parents
  if (allIdsToDelete.length > 0) {
    // Delete descendants first, then the target topic
    if (descendantIds.length > 0) {
      await db.delete(topics).where(inArray(topics.id, descendantIds));
    }
    await db.delete(topics).where(eq(topics.id, topicId));
  }

  // Update subject progress
  await updateSubjectProgress(topic.subjectId);

  return c.json({ message: "Topic deleted" });
});
