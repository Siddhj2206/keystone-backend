import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { subjects, topics, events, semesters } from "../db/schema";
import { parseSyllabusPdf } from "../services/pdf-parser";
import type { Subject, Topic, ClassSlot } from "../lib/types";

export const subjectRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function getActiveSemester(userId: string) {
  return db.query.semesters.findFirst({
    where: and(eq(semesters.userId, userId), eq(semesters.isActive, true)),
  });
}

// Build hierarchical topic tree from flat list
function buildTopicTree(flatTopics: any[]): Topic[] {
  const topicMap = new Map<string, Topic>();
  const rootTopics: Topic[] = [];

  // First pass: create all topic objects
  for (const t of flatTopics) {
    topicMap.set(t.id, {
      id: t.id,
      title: t.title,
      parentId: t.parentId,
      estMinutes: t.estMinutes,
      currentMastery: typeof t.currentMastery === "number" ? t.currentMastery : parseFloat(t.currentMastery) || 0,
      status: t.status,
      sortOrder: t.sortOrder,
      children: [],
    });
  }

  // Second pass: build tree structure
  for (const t of flatTopics) {
    const topic = topicMap.get(t.id)!;
    if (t.parentId && topicMap.has(t.parentId)) {
      topicMap.get(t.parentId)!.children!.push(topic);
    } else {
      rootTopics.push(topic);
    }
  }

  // Sort by sortOrder
  const sortByOrder = (a: Topic, b: Topic) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  rootTopics.sort(sortByOrder);
  for (const topic of topicMap.values()) {
    topic.children?.sort(sortByOrder);
  }

  return rootTopics;
}

// Transform DB subject to API response format
function formatSubject(dbSubject: any, classEvents: any[] = []): Subject {
  return {
    id: dbSubject.id,
    name: dbSubject.name,
    colorHex: dbSubject.colorHex,
    progress: typeof dbSubject.progress === "number" ? dbSubject.progress : parseFloat(dbSubject.progress) || 0,
    topics: buildTopicTree(dbSubject.topics || []),
    classSlots: classEvents
      .filter((e) => e.subjectId === dbSubject.id && e.type === "class")
      .map((e): ClassSlot => ({
        id: e.id,
        dayOfWeek: e.dayOfWeek,
        startTime: e.startTime,
        endTime: e.endTime,
      })),
  };
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/subjects - List all subjects for active semester
subjectRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const activeSemester = await getActiveSemester(user.id);
  if (!activeSemester) {
    return c.json([]);
  }

  const allSubjects = await db.query.subjects.findMany({
    where: eq(subjects.semesterId, activeSemester.id),
    with: {
      topics: true,
    },
  });

  // Fetch class events for this semester
  const classEvents = await db.query.events.findMany({
    where: and(
      eq(events.semesterId, activeSemester.id),
      eq(events.type, "class")
    ),
  });

  return c.json(allSubjects.map((s) => formatSubject(s, classEvents)));
});

// GET /api/subjects/:id - Get single subject
subjectRoutes.get("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const subjectId = c.req.param("id");

  const subject = await db.query.subjects.findFirst({
    where: and(eq(subjects.id, subjectId), eq(subjects.userId, user.id)),
    with: {
      topics: true,
    },
  });

  if (!subject) {
    return c.json({ error: "Subject not found" }, 404);
  }

  // Fetch class events for this subject
  const classEvents = await db.query.events.findMany({
    where: and(eq(events.subjectId, subjectId), eq(events.type, "class")),
  });

  return c.json(formatSubject(subject, classEvents));
});

// POST /api/subjects - Create subject
const createSubjectSchema = z.object({
  name: z.string().min(1),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  classSlots: z
    .array(
      z.object({
        dayOfWeek: z.number().min(0).max(6),
        startTime: z.string(),
        endTime: z.string(),
      })
    )
    .optional(),
});

subjectRoutes.post("/", zValidator("json", createSubjectSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const input = c.req.valid("json");
  const now = Date.now();

  const activeSemester = await getActiveSemester(user.id);
  if (!activeSemester) {
    return c.json({ error: "No active semester found" }, 404);
  }

  const [newSubject] = await db
    .insert(subjects)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      semesterId: activeSemester.id,
      name: input.name,
      colorHex: input.colorHex,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!newSubject) {
    return c.json({ error: "Failed to create subject" }, 500);
  }

  // Create class events if provided
  let classEvents: any[] = [];
  if (input.classSlots && input.classSlots.length > 0) {
    classEvents = await db
      .insert(events)
      .values(
        input.classSlots.map((slot) => ({
          id: crypto.randomUUID(),
          userId: user.id,
          semesterId: activeSemester.id,
          subjectId: newSubject.id,
          title: "",
          type: "class",
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          colorHex: input.colorHex,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .returning();
  }

  // Fetch complete subject with relations
  const completeSubject = await db.query.subjects.findFirst({
    where: eq(subjects.id, newSubject.id),
    with: {
      topics: true,
    },
  });

  return c.json(formatSubject(completeSubject, classEvents), 201);
});

// PATCH /api/subjects/:id - Update subject
const updateSubjectSchema = z.object({
  name: z.string().min(1).optional(),
  colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  progress: z.number().min(0).max(1).optional(),
  classSlots: z
    .array(
      z.object({
        dayOfWeek: z.number().min(0).max(6),
        startTime: z.string(),
        endTime: z.string(),
      })
    )
    .optional(),
});

subjectRoutes.patch("/:id", zValidator("json", updateSubjectSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const subjectId = c.req.param("id");
  const input = c.req.valid("json");
  const now = Date.now();

  // Verify ownership
  const existing = await db.query.subjects.findFirst({
    where: and(eq(subjects.id, subjectId), eq(subjects.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Subject not found" }, 404);
  }

  // Update subject fields
  const updateData: any = { updatedAt: now };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.colorHex !== undefined) updateData.colorHex = input.colorHex;
  if (input.progress !== undefined) updateData.progress = input.progress;

  await db.update(subjects).set(updateData).where(eq(subjects.id, subjectId));

  // Update class events if provided
  if (input.classSlots !== undefined) {
    // Delete existing class events for this subject
    await db.delete(events).where(
      and(eq(events.subjectId, subjectId), eq(events.type, "class"))
    );

    // Insert new class events
    if (input.classSlots.length > 0) {
      await db.insert(events).values(
        input.classSlots.map((slot) => ({
          id: crypto.randomUUID(),
          userId: user.id,
          semesterId: existing.semesterId,
          subjectId,
          title: "",
          type: "class",
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          colorHex: input.colorHex ?? existing.colorHex,
          createdAt: now,
          updatedAt: now,
        }))
      );
    }
  }

  // Fetch updated subject
  const updated = await db.query.subjects.findFirst({
    where: eq(subjects.id, subjectId),
    with: {
      topics: true,
    },
  });

  const classEvents = await db.query.events.findMany({
    where: and(eq(events.subjectId, subjectId), eq(events.type, "class")),
  });

  return c.json(formatSubject(updated, classEvents));
});

// DELETE /api/subjects/:id - Delete subject
subjectRoutes.delete("/:id", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const subjectId = c.req.param("id");

  // Verify ownership
  const existing = await db.query.subjects.findFirst({
    where: and(eq(subjects.id, subjectId), eq(subjects.userId, user.id)),
  });

  if (!existing) {
    return c.json({ error: "Subject not found" }, 404);
  }

  // Delete subject (cascades to topics, assessments, events)
  await db.delete(subjects).where(eq(subjects.id, subjectId));

  return c.json({ message: "Subject deleted" });
});

// POST /api/subjects/:id/syllabus - Upload and parse syllabus PDF
subjectRoutes.post("/:id/syllabus", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const subjectId = c.req.param("id");

  // Verify ownership
  const subject = await db.query.subjects.findFirst({
    where: and(eq(subjects.id, subjectId), eq(subjects.userId, user.id)),
  });

  if (!subject) {
    return c.json({ error: "Subject not found" }, 404);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Parse PDF with Gemini
    const parsedTopics = await parseSyllabusPdf(file);

    // Insert topics into database
    let sortOrder = 0;
    for (const topicData of parsedTopics) {
      await insertTopicRecursively(subjectId, topicData, null, sortOrder++);
    }

    // Fetch updated subject with topics
    const updatedSubject = await db.query.subjects.findFirst({
      where: eq(subjects.id, subjectId),
      with: {
        topics: true,
      },
    });

    const classEvents = await db.query.events.findMany({
      where: and(eq(events.subjectId, subjectId), eq(events.type, "class")),
    });

    return c.json(formatSubject(updatedSubject, classEvents));
  } catch (error) {
    console.error("Syllabus parsing error:", error);
    return c.json({ error: "Failed to parse syllabus" }, 500);
  }
});

// POST /api/subjects/parse-syllabus - Parse syllabus PDF without auth (returns topics only)
// This is used for local-first mode where we don't need to store on server
subjectRoutes.post("/parse-syllabus", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Parse PDF with Gemini
    const parsedTopics = await parseSyllabusPdf(file);

    return c.json({ topics: parsedTopics });
  } catch (error) {
    console.error("Syllabus parsing error:", error);
    return c.json({ error: "Failed to parse syllabus" }, 500);
  }
});

// Helper: Insert topics recursively
interface ParsedTopic {
  title: string;
  estMinutes?: number;
  children?: ParsedTopic[];
}

async function insertTopicRecursively(
  subjectId: string,
  topicData: ParsedTopic,
  parentId: string | null,
  sortOrder: number
): Promise<void> {
  const now = Date.now();
  const [newTopic] = await db
    .insert(topics)
    .values({
      id: crypto.randomUUID(),
      subjectId,
      parentId,
      title: topicData.title,
      estMinutes: topicData.estMinutes || 30,
      currentMastery: 0,
      status: "pending",
      sortOrder,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (newTopic && topicData.children && topicData.children.length > 0) {
    let childSortOrder = 0;
    for (const child of topicData.children) {
      await insertTopicRecursively(subjectId, child, newTopic.id, childSortOrder++);
    }
  }
}
