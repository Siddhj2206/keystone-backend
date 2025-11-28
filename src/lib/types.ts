// TypeScript interfaces matching frontend types exactly
// These are the API response/request contracts

// ============================================================================
// Core Domain Types (match frontend lib/types.ts)
// ============================================================================

export interface Semester {
  id: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  createdAt: string;
  studyHours?: DailyStudyHours;
}

export interface DailyStudyHours {
  0: number; // Sunday
  1: number; // Monday
  2: number; // Tuesday
  3: number; // Wednesday
  4: number; // Thursday
  5: number; // Friday
  6: number; // Saturday
}

export interface Subject {
  id: string;
  name: string;
  colorHex: string;
  progress: number; // 0.0 to 1.0
  topics: Topic[];
  classSlots?: ClassSlot[];
}

export interface Topic {
  id: string;
  title: string;
  parentId: string | null;
  estMinutes: number;
  currentMastery: number; // 0.0 to 1.0
  status: "pending" | "completed" | "needs_revision";
  sortOrder?: number;
  children?: Topic[];
}

export interface ClassSlot {
  id: string;
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export interface Assessment {
  id: string;
  title: string;
  date: string; // ISO string
  weightage: number; // 0-100
  topicIds: string[];
  subjectId: string;
}

export interface StudySession {
  id: string;
  topicId: string;
  topicTitle: string; // hydrated from topic
  subjectColor: string; // hydrated from subject
  startTime: string; // ISO string
  endTime: string; // ISO string
  status: "scheduled" | "completed" | "missed";
  sessionType: "learning" | "revision";
}

// Unified Event type (replaces FixedEvent and ClassSlot in DB)
export interface Event {
  id: string;
  semesterId: string;
  subjectId: string | null;
  title: string;
  type: "class" | "fixed";
  dayOfWeek: number; // 0-6
  startTime: string; // "HH:MM"
  endTime: string;
  colorHex: string;
}

// FixedEvent for API compatibility (subset of Event)
export interface FixedEvent {
  id: string;
  title: string;
  dayOfWeek: number; // 0-6
  startTime: string; // "HH:MM"
  endTime: string;
  colorHex: string;
}

// ============================================================================
// API Input Types
// ============================================================================

export interface CreateSubjectInput {
  name: string;
  colorHex: string;
  classSlots?: Omit<ClassSlot, "id">[];
}

export interface UpdateSubjectInput {
  name?: string;
  colorHex?: string;
  progress?: number;
  classSlots?: Omit<ClassSlot, "id">[];
}

export interface CreateTopicInput {
  subjectId: string;
  parentId?: string | null;
  title: string;
  estMinutes?: number;
  sortOrder?: number;
}

export interface UpdateTopicInput {
  title?: string;
  estMinutes?: number;
  currentMastery?: number;
  status?: "pending" | "completed" | "needs_revision";
  sortOrder?: number;
}

export interface CreateAssessmentInput {
  subjectId: string;
  title: string;
  date: string;
  weightage: number;
  topicIds?: string[];
}

export interface UpdateAssessmentInput {
  title?: string;
  date?: string;
  weightage?: number;
  topicIds?: string[];
}

export interface CompleteSessionInput {
  actualMinutes: number;
  needsMoreTime: boolean;
  remainingMinutes?: number;
}

export interface CreateEventInput {
  subjectId?: string | null;
  title: string;
  type: "class" | "fixed";
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  colorHex: string;
}

export interface UpdateEventInput {
  subjectId?: string | null;
  title?: string;
  type?: "class" | "fixed";
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  colorHex?: string;
}

export interface InitializeSemesterInput {
  startDate: string;
  endDate: string;
  studyHours?: DailyStudyHours;
  subjects?: {
    name: string;
    colorHex: string;
    classSlots?: Omit<ClassSlot, "id">[];
  }[];
}

// ============================================================================
// API Response Types
// ============================================================================

export interface DailyAgenda {
  date: string;
  sessions: StudySession[];
  fixedEvents: FixedEvent[];
}

export interface ScheduleGenerationResult {
  message: string;
  sessionsCreated: number;
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncRequest {
  clientData: {
    semesters: any[];
    subjects: any[];
    topics: any[];
    assessments: any[];
    events: any[];
    studySessions: any[];
  };
  lastSyncedAt: number;
}

export interface SyncResponse {
  serverData: {
    semesters: any[];
    subjects: any[];
    topics: any[];
    assessments: any[];
    events: any[];
    studySessions: any[];
  };
  syncedAt: number;
}

// ============================================================================
// Parsed File Types (from AI parsing)
// ============================================================================

export interface ParsedTopic {
  title: string;
  estMinutes: number;
  children?: ParsedTopic[];
}

export interface ParsedScheduleEntry {
  subjectName: string;
  colorHex: string;
  classSlots: {
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }[];
}
