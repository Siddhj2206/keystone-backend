import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, inArray, gte, and, or, sql } from "drizzle-orm";

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
import type {
  AppContext,
  DbTopic,
  DbAssessment,
  DbStudySession,
} from "../lib/types";

export const syncRoutes = new Hono();

// ============================================================================
// Types
// ============================================================================

interface SyncRecord {
  id: string;
  updatedAt: number;
  [key: string]: unknown;
}

// ============================================================================
// Helpers
// ============================================================================

async function getUser(c: AppContext) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

// Merge two arrays of records using last-write-wins
// Only returns records that were updated (for delta response)
function mergeRecords(
  clientRecords: SyncRecord[],
  serverRecords: SyncRecord[]
): { merged: SyncRecord[]; changed: SyncRecord[] } {
  const merged = new Map<string, SyncRecord>();
  const changed = new Map<string, SyncRecord>();

  // Add all server records
  for (const record of serverRecords) {
    merged.set(record.id, record);
  }

  // Merge client records (client wins if newer)
  for (const record of clientRecords) {
    const existing = merged.get(record.id);
    if (!existing || record.updatedAt > existing.updatedAt) {
      merged.set(record.id, record);
      changed.set(record.id, record); // Client had newer data
    }
  }

  // Also include server records that client didn't have
  for (const record of serverRecords) {
    const clientHas = clientRecords.some(c => c.id === record.id);
    if (!clientHas) {
      changed.set(record.id, record);
    }
  }

  return { 
    merged: Array.from(merged.values()), 
    changed: Array.from(changed.values()) 
  };
}

// ============================================================================
// POST /sync - Two-way sync (optimized)
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

  const { clientData, lastSyncedAt } = c.req.valid("json");
  const syncedAt = Date.now();

  try {
    // ========================================================================
    // 1. Fetch server data - OPTIMIZED with updatedAt filter
    // ========================================================================
    
    // For delta sync, only fetch records updated since lastSyncedAt
    // For full sync (lastSyncedAt = 0), fetch all
    const useFilter = lastSyncedAt > 0;
    
    // Collect all IDs from client data for fetching related server records
    const clientSubjectIds = (clientData.subjects as SyncRecord[]).map((s) => s.id);
    const clientTopicIds = (clientData.topics as SyncRecord[]).map((t) => t.id);

    // First batch: user-level data (parallel)
    // If delta sync, only fetch changed records + records client is sending
    const [serverSemesters, serverSubjects, serverEvents] = await Promise.all([
      useFilter 
        ? db.select().from(semesters).where(
            and(eq(semesters.userId, user.id), gte(semesters.updatedAt, lastSyncedAt))
          )
        : db.select().from(semesters).where(eq(semesters.userId, user.id)),
      useFilter
        ? db.select().from(subjects).where(
            and(eq(subjects.userId, user.id), gte(subjects.updatedAt, lastSyncedAt))
          )
        : db.select().from(subjects).where(eq(subjects.userId, user.id)),
      useFilter
        ? db.select().from(events).where(
            and(eq(events.userId, user.id), gte(events.updatedAt, lastSyncedAt))
          )
        : db.select().from(events).where(eq(events.userId, user.id)),
    ]);

    // Get all subject IDs (server + client) for dependent queries
    const serverSubjectIds = serverSubjects.map((s) => s.id);
    
    // For delta sync, we ALWAYS need ALL user's subject IDs to properly scope dependent tables
    // This is critical because sessions are created server-side and need to be fetched
    // even if no subjects were updated since lastSyncedAt
    let allUserSubjectIds: string[] = serverSubjectIds;
    if (useFilter) {
      // Fetch just the IDs of all user's subjects (lightweight query)
      const allSubjects = await db
        .select({ id: subjects.id })
        .from(subjects)
        .where(eq(subjects.userId, user.id));
      allUserSubjectIds = allSubjects.map(s => s.id);
    }
    
    const allSubjectIds = [...new Set([...allUserSubjectIds, ...clientSubjectIds])];

    // Second batch: subject-dependent data (parallel) - OPTIMIZED
    let serverTopics: DbTopic[] = [];
    let serverAssessments: DbAssessment[] = [];
    let serverStudySessions: DbStudySession[] = [];

    if (allSubjectIds.length > 0) {
      // For delta sync, we need ALL topic IDs to fetch sessions properly
      // (sessions may have been created server-side without updating topics)
      // First, get all topic IDs for this user's subjects
      const allTopicsQuery = await db
        .select({ id: topics.id })
        .from(topics)
        .where(inArray(topics.subjectId, allSubjectIds));
      const allUserTopicIds = allTopicsQuery.map(t => t.id);
      
      // Combine with client topic IDs for complete set
      const allTopicIdsForSessions = [...new Set([...allUserTopicIds, ...clientTopicIds])];
      
      // Fetch topics, assessments, AND study sessions in PARALLEL
      const [topicsResult, assessmentsResult, sessionsResult] = await Promise.all([
        useFilter
          ? db.select().from(topics).where(
              and(inArray(topics.subjectId, allSubjectIds), gte(topics.updatedAt, lastSyncedAt))
            )
          : db.select().from(topics).where(inArray(topics.subjectId, allSubjectIds)),
        useFilter
          ? db.select().from(assessments).where(
              and(inArray(assessments.subjectId, allSubjectIds), gte(assessments.updatedAt, lastSyncedAt))
            )
          : db.select().from(assessments).where(inArray(assessments.subjectId, allSubjectIds)),
        // Study sessions: Always fetch ALL for user's topics (NO updatedAt filter)
        // Server-generated sessions may have been created before lastSyncedAt,
        // so filtering by updatedAt would miss them. The mergeRecords function
        // handles deduplication and only returns changed records to the client.
        allTopicIdsForSessions.length > 0
          ? db.select().from(studySessions).where(inArray(studySessions.topicId, allTopicIdsForSessions))
          : Promise.resolve([]),
      ]);
      
      serverTopics = topicsResult;
      serverAssessments = assessmentsResult;
      serverStudySessions = sessionsResult;
    }

    // ========================================================================
    // 2. Merge client and server data (last-write-wins)
    // ========================================================================

    const semesterMerge = mergeRecords(clientData.semesters as SyncRecord[], serverSemesters as SyncRecord[]);
    const subjectMerge = mergeRecords(clientData.subjects as SyncRecord[], serverSubjects as SyncRecord[]);
    const topicMerge = mergeRecords(clientData.topics as SyncRecord[], serverTopics as SyncRecord[]);
    const assessmentMerge = mergeRecords(clientData.assessments as SyncRecord[], serverAssessments as SyncRecord[]);
    const eventMerge = mergeRecords(clientData.events as SyncRecord[], serverEvents as SyncRecord[]);
    const sessionMerge = mergeRecords(clientData.studySessions as SyncRecord[], serverStudySessions as SyncRecord[]);

    // ========================================================================
    // 3. Upsert merged data - OPTIMIZED with batch operations
    // ========================================================================

    // Build valid ID sets for FK validation
    const validSemesterIds = new Set(semesterMerge.merged.map((s) => s.id));
    const validSubjectIds = new Set(
      subjectMerge.merged
        .filter((s) => validSemesterIds.has(s.semesterId as string))
        .map((s) => s.id)
    );
    const validTopicIds = new Set(
      topicMerge.merged
        .filter((t) => validSubjectIds.has(t.subjectId as string))
        .map((t) => t.id)
    );

    // Only upsert records that actually changed (from client)
    const clientSemesterIds = new Set((clientData.semesters as SyncRecord[]).map(s => s.id));
    const clientSubjectIdSet = new Set(clientSubjectIds);
    const clientTopicIdSet = new Set(clientTopicIds);
    const clientAssessmentIds = new Set((clientData.assessments as SyncRecord[]).map(a => a.id));
    const clientEventIds = new Set((clientData.events as SyncRecord[]).map(e => e.id));
    const clientSessionIds = new Set((clientData.studySessions as SyncRecord[]).map(s => s.id));

    // Filter to only records that need upserting (client sent them)
    const semestersToUpsert = semesterMerge.merged.filter(s => clientSemesterIds.has(s.id));
    const subjectsToUpsert = subjectMerge.merged.filter(s => clientSubjectIdSet.has(s.id) && validSemesterIds.has(s.semesterId as string));
    const topicsToUpsert = topicMerge.merged.filter(t => clientTopicIdSet.has(t.id) && validSubjectIds.has(t.subjectId as string));
    const assessmentsToUpsert = assessmentMerge.merged.filter(a => clientAssessmentIds.has(a.id) && validSubjectIds.has(a.subjectId as string));
    const eventsToUpsert = eventMerge.merged.filter(e => clientEventIds.has(e.id) && validSemesterIds.has(e.semesterId as string));
    const sessionsToUpsert = sessionMerge.merged.filter(s => clientSessionIds.has(s.id) && validTopicIds.has(s.topicId as string));

    // Use db.transaction for batched writes
    await db.transaction(async (tx) => {
      // Batch upsert semesters
      for (const record of semestersToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
          })
          .onConflictDoUpdate({
            target: semesters.id,
            set: {
              startDate: data.startDate as string,
              endDate: data.endDate as string,
              isActive: data.isActive as boolean,
              studyHours: data.studyHours as string,
              updatedAt: data.updatedAt as number,
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }

      // Batch upsert subjects
      for (const record of subjectsToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
          })
          .onConflictDoUpdate({
            target: subjects.id,
            set: {
              semesterId: data.semesterId as string,
              name: data.name as string,
              colorHex: data.colorHex as string,
              progress: data.progress as number,
              updatedAt: data.updatedAt as number,
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }

      // Batch upsert topics
      for (const record of topicsToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
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
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }

      // Batch upsert assessments
      for (const record of assessmentsToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
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
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }

      // Batch upsert events
      for (const record of eventsToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
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
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }

      // Batch upsert study sessions
      for (const record of sessionsToUpsert) {
        const { id, ...data } = record;
        await tx
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
            deletedAt: (data.deletedAt as number) || null,
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
              deletedAt: (data.deletedAt as number) || null,
            },
          });
      }
    });

    // ========================================================================
    // 4. Return only CHANGED data to client (delta response)
    // ========================================================================

    // Remove server-only fields (userId) before sending to client
    const stripUserId = <T extends Record<string, unknown>>(records: T[]) =>
      records.map(({ userId, ...rest }) => rest);

    return c.json({
      serverData: {
        semesters: stripUserId(semesterMerge.changed),
        subjects: stripUserId(subjectMerge.changed),
        topics: topicMerge.changed,
        assessments: assessmentMerge.changed,
        events: stripUserId(eventMerge.changed),
        studySessions: sessionMerge.changed,
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
