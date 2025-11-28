import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, inArray } from "drizzle-orm";

import { auth } from "../lib/auth";
import { db } from "../db";
import {
  semesters,
  subjects,
  topics,
  assessments,
  events,
  studySessions,
} from "../db/schema";

export const syncRoutes = new Hono();

// ============================================================================
// Types
// ============================================================================

interface SyncRecord {
  id: string;
  updatedAt: number;
  [key: string]: unknown;
}

interface SyncTableData {
  semesters: SyncRecord[];
  subjects: SyncRecord[];
  topics: SyncRecord[];
  assessments: SyncRecord[];
  events: SyncRecord[];
  studySessions: SyncRecord[];
}

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: any) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Merge two arrays of records using last-write-wins
function mergeRecords(
  clientRecords: SyncRecord[],
  serverRecords: SyncRecord[]
): SyncRecord[] {
  const merged = new Map<string, SyncRecord>();

  // Add all server records
  for (const record of serverRecords) {
    merged.set(record.id, record);
  }

  // Merge client records (client wins if newer)
  for (const record of clientRecords) {
    const existing = merged.get(record.id);
    if (!existing || record.updatedAt > existing.updatedAt) {
      merged.set(record.id, record);
    }
  }

  return Array.from(merged.values());
}

// ============================================================================
// POST /sync - Two-way sync
// ============================================================================

const syncSchema = z.object({
  clientData: z.object({
    semesters: z.array(z.record(z.string(), z.unknown())).default([]),
    subjects: z.array(z.record(z.string(), z.unknown())).default([]),
    topics: z.array(z.record(z.string(), z.unknown())).default([]),
    assessments: z.array(z.record(z.string(), z.unknown())).default([]),
    events: z.array(z.record(z.string(), z.unknown())).default([]),
    studySessions: z.array(z.record(z.string(), z.unknown())).default([]),
  }),
  lastSyncedAt: z.number().default(0),
});

syncRoutes.post("/", zValidator("json", syncSchema), async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { clientData } = c.req.valid("json");
  const syncedAt = Date.now();

  try {
    // ========================================================================
    // 1. Fetch all server data for this user
    // ========================================================================

    const serverSemesters = await db
      .select()
      .from(semesters)
      .where(eq(semesters.userId, user.id));

    const serverSubjects = await db
      .select()
      .from(subjects)
      .where(eq(subjects.userId, user.id));

    const subjectIds = serverSubjects.map((s) => s.id);
    const clientSubjectIds = (clientData.subjects as SyncRecord[]).map(
      (s) => s.id
    );
    const allSubjectIds = [...new Set([...subjectIds, ...clientSubjectIds])];

    let serverTopics: any[] = [];
    let serverAssessments: any[] = [];
    let serverStudySessions: any[] = [];

    if (allSubjectIds.length > 0) {
      serverTopics = await db
        .select()
        .from(topics)
        .where(inArray(topics.subjectId, allSubjectIds));

      serverAssessments = await db
        .select()
        .from(assessments)
        .where(inArray(assessments.subjectId, allSubjectIds));

      const topicIds = serverTopics.map((t) => t.id);
      const clientTopicIds = (clientData.topics as SyncRecord[]).map(
        (t) => t.id
      );
      const allTopicIds = [...new Set([...topicIds, ...clientTopicIds])];

      if (allTopicIds.length > 0) {
        serverStudySessions = await db
          .select()
          .from(studySessions)
          .where(inArray(studySessions.topicId, allTopicIds));
      }
    }

    const serverEvents = await db
      .select()
      .from(events)
      .where(eq(events.userId, user.id));

    // ========================================================================
    // 2. Merge client and server data (last-write-wins)
    // ========================================================================

    const mergedSemesters = mergeRecords(
      clientData.semesters as SyncRecord[],
      serverSemesters as SyncRecord[]
    );

    const mergedSubjects = mergeRecords(
      clientData.subjects as SyncRecord[],
      serverSubjects as SyncRecord[]
    );

    const mergedTopics = mergeRecords(
      clientData.topics as SyncRecord[],
      serverTopics as SyncRecord[]
    );

    const mergedAssessments = mergeRecords(
      clientData.assessments as SyncRecord[],
      serverAssessments as SyncRecord[]
    );

    const mergedEvents = mergeRecords(
      clientData.events as SyncRecord[],
      serverEvents as SyncRecord[]
    );

    const mergedStudySessions = mergeRecords(
      clientData.studySessions as SyncRecord[],
      serverStudySessions as SyncRecord[]
    );

    // ========================================================================
    // 3. Upsert merged data to server
    // ========================================================================

    // Semesters
    for (const record of mergedSemesters) {
      const { id, ...data } = record;
      await db
        .insert(semesters)
        .values({
          id,
          userId: user.id,
          startDate: data.startDate as string,
          endDate: data.endDate as string,
          isActive: data.isActive as boolean,
          studyHours: data.studyHours as string,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: semesters.id,
          set: {
            startDate: data.startDate as string,
            endDate: data.endDate as string,
            isActive: data.isActive as boolean,
            studyHours: data.studyHours as string,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // Subjects
    for (const record of mergedSubjects) {
      const { id, ...data } = record;
      await db
        .insert(subjects)
        .values({
          id,
          userId: user.id,
          semesterId: data.semesterId as string,
          name: data.name as string,
          colorHex: data.colorHex as string,
          progress: data.progress as number,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: subjects.id,
          set: {
            semesterId: data.semesterId as string,
            name: data.name as string,
            colorHex: data.colorHex as string,
            progress: data.progress as number,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // Topics
    for (const record of mergedTopics) {
      const { id, ...data } = record;
      await db
        .insert(topics)
        .values({
          id,
          subjectId: data.subjectId as string,
          parentId: (data.parentId as string) || null,
          title: data.title as string,
          estMinutes: data.estMinutes as number,
          currentMastery: data.currentMastery as number,
          status: data.status as string,
          sortOrder: data.sortOrder as number,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: topics.id,
          set: {
            subjectId: data.subjectId as string,
            parentId: (data.parentId as string) || null,
            title: data.title as string,
            estMinutes: data.estMinutes as number,
            currentMastery: data.currentMastery as number,
            status: data.status as string,
            sortOrder: data.sortOrder as number,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // Assessments
    for (const record of mergedAssessments) {
      const { id, ...data } = record;
      await db
        .insert(assessments)
        .values({
          id,
          subjectId: data.subjectId as string,
          title: data.title as string,
          date: data.date as number,
          weightage: data.weightage as number,
          topicIds: data.topicIds as string,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: assessments.id,
          set: {
            subjectId: data.subjectId as string,
            title: data.title as string,
            date: data.date as number,
            weightage: data.weightage as number,
            topicIds: data.topicIds as string,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // Events
    for (const record of mergedEvents) {
      const { id, ...data } = record;
      await db
        .insert(events)
        .values({
          id,
          userId: user.id,
          semesterId: data.semesterId as string,
          subjectId: (data.subjectId as string) || null,
          title: data.title as string,
          type: data.type as string,
          dayOfWeek: data.dayOfWeek as number,
          startTime: data.startTime as string,
          endTime: data.endTime as string,
          colorHex: data.colorHex as string,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: events.id,
          set: {
            semesterId: data.semesterId as string,
            subjectId: (data.subjectId as string) || null,
            title: data.title as string,
            type: data.type as string,
            dayOfWeek: data.dayOfWeek as number,
            startTime: data.startTime as string,
            endTime: data.endTime as string,
            colorHex: data.colorHex as string,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // Study Sessions
    for (const record of mergedStudySessions) {
      const { id, ...data } = record;
      await db
        .insert(studySessions)
        .values({
          id,
          topicId: data.topicId as string,
          startTime: data.startTime as number,
          endTime: data.endTime as number,
          status: data.status as string,
          sessionType: data.sessionType as string,
          actualMinutes: (data.actualMinutes as number) || null,
          createdAt: data.createdAt as number,
          updatedAt: data.updatedAt as number,
        })
        .onConflictDoUpdate({
          target: studySessions.id,
          set: {
            topicId: data.topicId as string,
            startTime: data.startTime as number,
            endTime: data.endTime as number,
            status: data.status as string,
            sessionType: data.sessionType as string,
            actualMinutes: (data.actualMinutes as number) || null,
            updatedAt: data.updatedAt as number,
          },
        });
    }

    // ========================================================================
    // 4. Return merged data to client
    // ========================================================================

    // Remove server-only fields (userId) before sending to client
    const stripUserId = (records: any[]) =>
      records.map(({ userId, ...rest }) => rest);

    return c.json({
      serverData: {
        semesters: stripUserId(mergedSemesters),
        subjects: stripUserId(mergedSubjects),
        topics: mergedTopics,
        assessments: mergedAssessments,
        events: stripUserId(mergedEvents),
        studySessions: mergedStudySessions,
      },
      syncedAt,
    });
  } catch (error) {
    console.error("[Sync] Error:", error);
    console.error("[Sync] Error stack:", error instanceof Error ? error.stack : "No stack");
    return c.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      500
    );
  }
});

// ============================================================================
// DELETE /sync/reset - Clear all user data (for testing/debug)
// ============================================================================

syncRoutes.delete("/reset", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    // Delete in correct order to respect foreign keys
    // Study sessions -> Topics -> Assessments -> Events -> Subjects -> Semesters
    
    const userSubjects = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.userId, user.id));
    const subjectIds = userSubjects.map((s) => s.id);

    if (subjectIds.length > 0) {
      const userTopics = await db
        .select({ id: topics.id })
        .from(topics)
        .where(inArray(topics.subjectId, subjectIds));
      const topicIds = userTopics.map((t) => t.id);

      if (topicIds.length > 0) {
        await db.delete(studySessions).where(inArray(studySessions.topicId, topicIds));
      }
      
      await db.delete(topics).where(inArray(topics.subjectId, subjectIds));
      await db.delete(assessments).where(inArray(assessments.subjectId, subjectIds));
    }

    await db.delete(events).where(eq(events.userId, user.id));
    await db.delete(subjects).where(eq(subjects.userId, user.id));
    await db.delete(semesters).where(eq(semesters.userId, user.id));

    return c.json({ ok: true });
  } catch (error) {
    console.error("[Sync] Reset error:", error);
    return c.json({ error: "Failed to reset data" }, 500);
  }
});
