import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, gte, lte, inArray } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import { studySessions, topics, subjects, events, semesters } from "../db/schema";
import { parseScheduleFile } from "../services/pdf-parser";
import type {
  StudySession,
  FixedEvent,
  DailyAgenda,
  AppContext,
  DbEvent,
  DbStudySessionWithRelations,
} from "../lib/types";

export const scheduleRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Transform DB study session to API response format
function formatStudySession(dbSession: DbStudySessionWithRelations): StudySession {
  const startTime = new Date(dbSession.startTime).toISOString();
  const endTime = new Date(dbSession.endTime).toISOString();
    
  return {
    id: dbSession.id,
    topicId: dbSession.topicId,
    topicTitle: dbSession.topic?.title ?? "Unknown Topic",
    subjectColor: dbSession.topic?.subject?.colorHex ?? "#888888",
    startTime,
    endTime,
    status: dbSession.status as StudySession["status"],
    sessionType: dbSession.sessionType as StudySession["sessionType"],
  };
}

// Transform DB event to FixedEvent API response format
function formatFixedEvent(dbEvent: DbEvent): FixedEvent {
  return {
    id: dbEvent.id,
    title: dbEvent.title,
    dayOfWeek: dbEvent.dayOfWeek,
    startTime: dbEvent.startTime,
    endTime: dbEvent.endTime,
    colorHex: dbEvent.colorHex,
  };
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/schedule/agenda - Get daily agenda
scheduleRoutes.get("/agenda", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const dateParam = c.req.query("date");
  const targetDate = dateParam ? new Date(dateParam) : new Date();

  // Set date range for the day
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Get day of week (0 = Sunday)
  const dayOfWeek = targetDate.getDay();

  // Get user's subjects and their topics
  const userSubjects = await db.query.subjects.findMany({
    where: eq(subjects.userId, user.id),
    with: { topics: true },
  });

  const topicIds = userSubjects.flatMap((s) => s.topics.map((t) => t.id));

  // Get study sessions for this day
  let sessions: StudySession[] = [];
  if (topicIds.length > 0) {
    const dbSessions = await db.query.studySessions.findMany({
      where: and(
        inArray(studySessions.topicId, topicIds),
        gte(studySessions.startTime, startOfDay.getTime()),
        lte(studySessions.startTime, endOfDay.getTime())
      ),
      with: {
        topic: {
          with: { subject: true },
        },
      },
      orderBy: (studySessions, { asc }) => [asc(studySessions.startTime)],
    });
    sessions = dbSessions.map(formatStudySession);
  }

  // Get events for this day of week (both classes and fixed events)
  const dbEvents = await db.query.events.findMany({
    where: and(eq(events.userId, user.id), eq(events.dayOfWeek, dayOfWeek)),
  });

  const agenda: DailyAgenda = {
    date: targetDate.toISOString().split("T")[0]!,
    sessions,
    fixedEvents: dbEvents.map(formatFixedEvent),
  };

  return c.json(agenda);
});

// GET /api/schedule - Get study sessions in date range (also mounted at /api/study-sessions)
scheduleRoutes.get("/", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const startDate = c.req.query("startDate");
  const endDate = c.req.query("endDate");

  if (!startDate || !endDate) {
    return c.json({ error: "startDate and endDate are required" }, 400);
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Get user's topics
  const userSubjects = await db.query.subjects.findMany({
    where: eq(subjects.userId, user.id),
    with: { topics: true },
  });

  const topicIds = userSubjects.flatMap((s) => s.topics.map((t) => t.id));

  if (topicIds.length === 0) {
    return c.json([]);
  }

  const dbSessions = await db.query.studySessions.findMany({
    where: and(
      inArray(studySessions.topicId, topicIds),
      gte(studySessions.startTime, start.getTime()),
      lte(studySessions.startTime, end.getTime())
    ),
    with: {
      topic: {
        with: { subject: true },
      },
    },
    orderBy: (studySessions, { asc }) => [asc(studySessions.startTime)],
  });

  return c.json(dbSessions.map(formatStudySession));
});

// PATCH /api/schedule/:id/complete - Mark session complete (also at /api/study-sessions/:id/complete)
const completeSessionSchema = z.object({
  actualMinutes: z.number().positive(),
  needsMoreTime: z.boolean(),
  remainingMinutes: z.number().optional(),
});

scheduleRoutes.patch("/:id/complete", zValidator("json", completeSessionSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const { actualMinutes, needsMoreTime, remainingMinutes } = c.req.valid("json");
  const now = Date.now();

  // Verify ownership through topic -> subject
  const session = await db.query.studySessions.findFirst({
    where: eq(studySessions.id, sessionId),
    with: {
      topic: {
        with: { subject: true },
      },
    },
  });

  if (!session || session.topic.subject.userId !== user.id) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Update session
  await db
    .update(studySessions)
    .set({
      status: "completed",
      actualMinutes,
      updatedAt: now,
    })
    .where(eq(studySessions.id, sessionId));

  // Update topic mastery based on completion
  const currentMastery = session.topic.currentMastery || 0;
  const masteryIncrease = needsMoreTime ? 0.1 : 0.2;
  const newMastery = Math.min(1, currentMastery + masteryIncrease);

  await db
    .update(topics)
    .set({
      currentMastery: newMastery,
      status: newMastery >= 0.8 ? "completed" : needsMoreTime ? "needs_revision" : "pending",
      updatedAt: now,
    })
    .where(eq(topics.id, session.topicId));

  // If needs more time, schedule additional session
  if (needsMoreTime && remainingMinutes && remainingMinutes > 0) {
    const sessionEndTime = session.endTime as number;
    const nextStartTime = sessionEndTime + 15 * 60000; // 15 min break

    await db.insert(studySessions).values({
      id: crypto.randomUUID(),
      topicId: session.topicId,
      startTime: nextStartTime,
      endTime: nextStartTime + remainingMinutes * 60000,
      status: "scheduled",
      sessionType: "revision",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Refetch to get updated topic info
  const refreshed = await db.query.studySessions.findFirst({
    where: eq(studySessions.id, sessionId),
    with: {
      topic: {
        with: { subject: true },
      },
    },
  });

  if (!refreshed) {
    return c.json({ error: "Session not found after update" }, 500);
  }

  return c.json(formatStudySession(refreshed));
});

// POST /api/schedule/generate - Trigger schedule generation (placeholder)
scheduleRoutes.post("/generate", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    // Get active semester
    const semester = await db.query.semesters.findFirst({
      where: and(eq(semesters.userId, user.id), eq(semesters.isActive, true)),
      with: {
        subjects: {
          with: {
            topics: true,
            assessments: true,
          },
        },
      },
    });

    if (!semester) {
      return c.json({ error: "No active semester found" }, 404);
    }

    // Get events (classes and fixed events)
    const userEvents = await db.query.events.findMany({
      where: eq(events.userId, user.id),
    });

    // TODO: Call schedule generation service
    // For now, return placeholder response
    return c.json({
      message: "Schedule generation not yet implemented",
      sessionsCreated: 0,
    });
  } catch (error) {
    console.error("Schedule generation error:", error);
    return c.json({ error: "Failed to generate schedule" }, 500);
  }
});

// POST /api/schedule/parse - Parse schedule file (PDF or image)
scheduleRoutes.post("/parse", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    // Validate file type
    const validTypes = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp",
    ];
    if (!validTypes.includes(file.type)) {
      return c.json(
        { error: "Invalid file type. Supported: PDF, PNG, JPG, GIF, WEBP" },
        400
      );
    }

    // Parse the schedule file using AI
    const parsedSchedule = await parseScheduleFile(file, file.type);

    return c.json(parsedSchedule);
  } catch (error) {
    console.error("Schedule parsing error:", error);
    return c.json({ error: "Failed to parse schedule" }, 500);
  }
});
