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
  ScheduleGenerationRequest,
} from "../lib/types";
import { generateSchedule, dailyPlansToLegacySessions } from "../services/schedule-client";

export const scheduleRoutes = new Hono();

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

/**
 * Get the start of day (midnight) for a given date in a specific timezone.
 * Returns a UTC timestamp (milliseconds).
 */
function getStartOfDayInTimezone(date: Date, timezone: string): number {
  // Format the date in the target timezone to get the local date
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDateStr = formatter.format(date); // "YYYY-MM-DD"
  
  // Now we need to find the UTC timestamp for midnight of that local date
  const [year, month, day] = localDateStr.split('-').map(Number);
  
  // Create a formatter that includes time
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  
  // Start with midnight UTC and search for midnight in target timezone
  let testTime = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  
  for (let attempt = 0; attempt < 48; attempt++) {
    const testDate = new Date(testTime);
    const parts = timeFormatter.formatToParts(testDate);
    const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
    
    const testDay = getPart('day');
    const testHour = getPart('hour');
    
    if (testDay === day && testHour === 0) {
      return testTime;
    }
    
    // Adjust search
    if (testDay < day! || (testDay === day && testHour < 0)) {
      testTime += 3600000;
    } else if (testDay > day!) {
      testTime -= 3600000;
    } else if (testHour > 0) {
      testTime -= testHour * 3600000;
    } else {
      testTime += 3600000;
    }
  }
  
  // Fallback
  return Date.UTC(year!, month! - 1, day!, 0, 0, 0);
}

/**
 * Get the end of day (23:59:59.999) for a given date in a specific timezone.
 * Returns a UTC timestamp (milliseconds).
 */
function getEndOfDayInTimezone(date: Date, timezone: string): number {
  return getStartOfDayInTimezone(date, timezone) + (24 * 60 * 60 * 1000) - 1;
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
  const timezone = c.req.query("timezone") || "UTC";
  const targetDate = dateParam ? new Date(dateParam) : new Date();

  // Set date range for the day using the user's timezone
  const startOfDay = getStartOfDayInTimezone(targetDate, timezone);
  const endOfDay = getEndOfDayInTimezone(targetDate, timezone);

  // Get day of week (0 = Sunday) in user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const weekdayStr = formatter.format(targetDate);
  const weekdayMap: Record<string, number> = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
  const dayOfWeek = weekdayMap[weekdayStr] ?? targetDate.getDay();

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
        gte(studySessions.startTime, startOfDay),
        lte(studySessions.startTime, endOfDay)
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

  // Format the date in the user's timezone for the response
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const agenda: DailyAgenda = {
    date: dateFormatter.format(targetDate),
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
  difficulty: z.enum(["easy", "good", "hard", "forgot"]),
  needsMoreTime: z.boolean(),
  remainingMinutes: z.number().optional(),
});

/**
 * Calculate new mastery based on difficulty feedback.
 * 
 * Formula uses diminishing returns - harder to improve at high mastery levels.
 * 
 * - easy: +25% of remaining gap (learns quickly)
 * - good: +15% of remaining gap (normal progress)
 * - hard: +5% of remaining gap (struggled, minimal gain)
 * - forgot: -20% of current mastery (regression)
 */
function calculateNewMastery(
  currentMastery: number,
  difficulty: "easy" | "good" | "hard" | "forgot"
): number {
  const remaining = 1 - currentMastery;
  
  let change: number;
  switch (difficulty) {
    case "easy":
      change = 0.25 * remaining;
      break;
    case "good":
      change = 0.15 * remaining;
      break;
    case "hard":
      change = 0.05 * remaining;
      break;
    case "forgot":
      change = -0.20 * currentMastery;
      break;
  }
  
  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, currentMastery + change));
}

/**
 * Determine topic status based on mastery and difficulty.
 */
function determineTopicStatus(
  newMastery: number,
  difficulty: "easy" | "good" | "hard" | "forgot"
): "pending" | "completed" | "needs_revision" {
  if (newMastery >= 0.8) {
    return "completed";
  }
  if (difficulty === "forgot" || difficulty === "hard") {
    return "needs_revision";
  }
  return "pending";
}

scheduleRoutes.patch("/:id/complete", zValidator("json", completeSessionSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const { actualMinutes, difficulty, needsMoreTime, remainingMinutes } = c.req.valid("json");
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

  // Calculate new mastery based on difficulty feedback
  const currentMastery = session.topic.currentMastery || 0;
  const newMastery = calculateNewMastery(currentMastery, difficulty);
  const newStatus = determineTopicStatus(newMastery, difficulty);

  await db
    .update(topics)
    .set({
      currentMastery: newMastery,
      status: newStatus,
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

// POST /api/schedule/generate - Trigger schedule generation
const generateSchema = z.object({
  timezone: z.string().optional().default("UTC"),
});

scheduleRoutes.post("/generate", zValidator("json", generateSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { timezone } = c.req.valid("json");

  try {
    // Get active semester with all related data
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

    // Flatten all topics from all subjects
    const allTopics = semester.subjects.flatMap((subject) =>
      subject.topics.map((topic) => ({
        id: topic.id,
        subject_id: subject.id,
        title: topic.title,
        est_minutes: topic.estMinutes,
        current_mastery: topic.currentMastery ?? 0,
        status: topic.status as "pending" | "completed" | "needs_revision",
        sort_order: topic.sortOrder ?? 0,
        last_studied_at: topic.updatedAt ?? undefined,
      }))
    );

    // Flatten all assessments
    const allAssessments = semester.subjects.flatMap((subject) =>
      subject.assessments.map((assessment) => {
        // topicIds is stored as JSON string in DB, need to parse it
        let topicIdsParsed: string[] = [];
        if (assessment.topicIds) {
          try {
            topicIdsParsed = JSON.parse(assessment.topicIds as string) as string[];
          } catch {
            topicIdsParsed = [];
          }
        }
        return {
          id: assessment.id,
          subject_id: subject.id,
          title: assessment.title,
          date: assessment.date, // Already a Unix timestamp in ms
          weightage: assessment.weightage,
          topic_ids: topicIdsParsed,
        };
      })
    );

    // Parse study hours from semester (stored as JSON)
    const studyHours: Record<number, number> = semester.studyHours
      ? (JSON.parse(semester.studyHours as string) as Record<number, number>)
      : { 0: 120, 1: 120, 2: 120, 3: 120, 4: 120, 5: 120, 6: 120 }; // Default 2hrs/day

    // Calculate recent study time per subject (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const topicIds = allTopics.map((t) => t.id);
    
    let recentStudyTime: { subject_id: string; minutes_studied: number }[] = [];
    if (topicIds.length > 0) {
      const recentSessions = await db.query.studySessions.findMany({
        where: and(
          inArray(studySessions.topicId, topicIds),
          eq(studySessions.status, "completed"),
          gte(studySessions.createdAt, sevenDaysAgo)
        ),
        with: {
          topic: true,
        },
      });

      // Group by subject
      const subjectMinutes = new Map<string, number>();
      for (const session of recentSessions) {
        const subjectId = session.topic.subjectId;
        const mins = session.actualMinutes ?? 0;
        subjectMinutes.set(subjectId, (subjectMinutes.get(subjectId) ?? 0) + mins);
      }

      recentStudyTime = Array.from(subjectMinutes.entries()).map(
        ([subject_id, minutes_studied]) => ({ subject_id, minutes_studied })
      );
    }

    // Build request for Python scheduler
    // Use semester date range, but don't schedule in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split("T")[0]!;
    
    // Parse semester dates - they should be in YYYY-MM-DD format
    // If stored differently, normalize them
    const parseDate = (dateStr: string): Date => {
      // Try ISO format first (YYYY-MM-DD)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return new Date(dateStr + "T00:00:00");
      }
      // Try DD-MM-YY or DD-MM-YYYY format
      const ddmmMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
      if (ddmmMatch) {
        const day = parseInt(ddmmMatch[1]!, 10);
        const month = parseInt(ddmmMatch[2]!, 10) - 1; // JS months are 0-indexed
        let year = parseInt(ddmmMatch[3]!, 10);
        if (year < 100) year += 2000; // Convert YY to YYYY
        return new Date(year, month, day);
      }
      // Fallback to Date constructor
      return new Date(dateStr);
    };
    
    const semesterStartDate = parseDate(semester.startDate);
    const semesterEndDate = parseDate(semester.endDate);
    
    // Use the later of today or semester start
    const effectiveStart = today > semesterStartDate ? today : semesterStartDate;
    const startDate = effectiveStart.toISOString().split("T")[0]!;
    const endDate = semesterEndDate.toISOString().split("T")[0]!;
    
    console.log(`[DEBUG] Today: ${todayStr}, Semester: ${semester.startDate} -> ${semester.endDate}`);
    console.log(`[DEBUG] Parsed: ${semesterStartDate.toISOString()} -> ${semesterEndDate.toISOString()}`);
    console.log(`[DEBUG] Effective start: ${startDate}, End: ${endDate}`);

    const request: ScheduleGenerationRequest = {
      topics: allTopics,
      assessments: allAssessments,
      study_hours: studyHours,
      session_preferences: {
        min_minutes: 25,
        max_minutes: 90,
      },
      start_date: startDate,
      end_date: endDate,
      recent_study_time: recentStudyTime,
    };

    // Debug: Log schedule generation request
    const incompleteTopics = allTopics.filter((t) => t.status !== "completed");
    console.log("\n" + "=".repeat(60));
    console.log("SCHEDULE GENERATION REQUEST");
    console.log("=".repeat(60));
    console.log(`Semester:    ${semester.name || "Unnamed"}`);
    console.log(`Date Range:  ${startDate} -> ${endDate}`);
    console.log(`Topics:      ${allTopics.length} total, ${incompleteTopics.length} incomplete`);
    console.log(`Assessments: ${allAssessments.length}`);
    console.log(`Study Hours: ${Object.entries(studyHours).map(([d, m]) => `Day${d}:${m}min`).join(", ")}`);
    if (incompleteTopics.length > 0) {
      console.log("-".repeat(60));
      console.log("Incomplete Topics:");
      incompleteTopics.slice(0, 10).forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.title} (mastery: ${Math.round(t.current_mastery * 100)}%, est: ${t.est_minutes}min)`);
      });
      if (incompleteTopics.length > 10) {
        console.log(`  ... and ${incompleteTopics.length - 10} more`);
      }
    }
    if (allAssessments.length > 0) {
      console.log("-".repeat(60));
      console.log("Upcoming Assessments:");
      allAssessments.slice(0, 5).forEach((a, i) => {
        const date = new Date(a.date).toISOString().split("T")[0];
        console.log(`  ${i + 1}. ${a.title} (${date}, weight: ${a.weightage}%)`);
      });
      if (allAssessments.length > 5) {
        console.log(`  ... and ${allAssessments.length - 5} more`);
      }
    }
    console.log("-".repeat(60));

    // Call Python scheduler service
    const scheduleResponse = await generateSchedule(request);

    // Convert daily plans to study sessions and store in DB
    // Pass the user's timezone so sessions are created at the right time
    const legacySessions = dailyPlansToLegacySessions(scheduleResponse.daily_plans, timezone);

    // Debug: Log schedule generation result
    console.log("SCHEDULE GENERATION RESULT");
    console.log("-".repeat(60));
    console.log(`Timezone:      ${timezone}`);
    console.log(`Total Days:    ${scheduleResponse.total_days}`);
    console.log(`Study Time:    ${scheduleResponse.total_study_minutes} min (${(scheduleResponse.total_study_minutes / 60).toFixed(1)} hrs)`);
    console.log(`Topics Covered: ${scheduleResponse.topics_covered}`);
    console.log(`Sessions:      ${legacySessions.length}`);
    if (scheduleResponse.daily_plans.length > 0) {
      console.log("-".repeat(60));
      console.log("Sample Daily Plans (first 5 days):");
      scheduleResponse.daily_plans.slice(0, 5).forEach((plan) => {
        const taskSummary = plan.tasks.length > 0
          ? plan.tasks.map((t) => `${t.topic_title.slice(0, 20)}(${t.duration_minutes}m)`).join(", ")
          : "No tasks";
        console.log(`  ${plan.date}: ${plan.total_minutes}min - ${taskSummary}`);
      });
      if (scheduleResponse.daily_plans.length > 5) {
        console.log(`  ... and ${scheduleResponse.daily_plans.length - 5} more days`);
      }
    }
    console.log("=".repeat(60) + "\n");

    const now = Date.now();

    // Soft delete existing scheduled (not completed) sessions for this user's topics
    // This ensures sync will propagate deletions to the mobile app
    if (topicIds.length > 0) {
      await db
        .update(studySessions)
        .set({
          deletedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(studySessions.topicId, topicIds),
            eq(studySessions.status, "scheduled")
          )
        );
    }

    // Insert new sessions
    if (legacySessions.length > 0) {
      await db.insert(studySessions).values(
        legacySessions.map((session) => ({
          id: crypto.randomUUID(),
          topicId: session.topicId,
          startTime: session.startTime,
          endTime: session.endTime,
          status: "scheduled" as const,
          sessionType: session.sessionType,
          createdAt: now,
          updatedAt: now,
        }))
      );
    }

    return c.json({
      message: "Schedule generated successfully",
      sessionsCreated: legacySessions.length,
      totalDays: scheduleResponse.total_days,
      totalStudyMinutes: scheduleResponse.total_study_minutes,
      topicsCovered: scheduleResponse.topics_covered,
    });
  } catch (error) {
    console.error("Schedule generation error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: `Failed to generate schedule: ${message}` }, 500);
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
