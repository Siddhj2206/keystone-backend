import {
  pgTable,
  text,
  boolean,
  integer,
  bigint,
  real,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ============================================================================
// Auth Tables (Better Auth managed)
// ============================================================================

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================================
// App Tables
// ============================================================================

// Semesters - academic term boundaries
export const semesters = pgTable("semesters", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name"), // Optional semester name (e.g., "Fall 2024")
  startDate: text("start_date").notNull(), // ISO date "YYYY-MM-DD"
  endDate: text("end_date").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  studyHours: text("study_hours"), // JSON: {"0": 2, "1": 4, ...}
  createdAt: bigint("created_at", { mode: "number" }).notNull(), // Unix timestamp ms
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Subjects - courses
export const subjects = pgTable("subjects", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  semesterId: text("semester_id")
    .notNull()
    .references(() => semesters.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  colorHex: text("color_hex").notNull(), // "#RRGGBB"
  progress: real("progress").notNull().default(0), // 0.0 - 1.0
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Topics - hierarchical syllabus items
export const topics = pgTable("topics", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id")
    .notNull()
    .references(() => subjects.id, { onDelete: "cascade" }),
  parentId: text("parent_id"), // Self-referential FK for tree structure
  title: text("title").notNull(),
  estMinutes: integer("est_minutes").notNull().default(30),
  currentMastery: real("current_mastery").notNull().default(0), // 0.0 - 1.0
  status: text("status").notNull().default("pending"), // 'pending' | 'completed' | 'needs_revision'
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Assessments - exams/quizzes
export const assessments = pgTable("assessments", {
  id: text("id").primaryKey(),
  subjectId: text("subject_id")
    .notNull()
    .references(() => subjects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  date: bigint("date", { mode: "number" }).notNull(), // Unix timestamp ms
  weightage: integer("weightage").notNull().default(0), // 0-100
  topicIds: text("topic_ids"), // JSON array: ["topic-1", "topic-2"]
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Events - merged classSlots + fixedEvents
export const events = pgTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  semesterId: text("semester_id")
    .notNull()
    .references(() => semesters.id, { onDelete: "cascade" }),
  subjectId: text("subject_id").references(() => subjects.id, {
    onDelete: "cascade",
  }), // null for fixed events
  title: text("title").notNull().default(""), // For fixed events
  type: text("type").notNull(), // 'class' | 'fixed'
  dayOfWeek: integer("day_of_week").notNull(), // 0-6 (Sunday-Saturday)
  startTime: text("start_time").notNull(), // "HH:MM" 24h format
  endTime: text("end_time").notNull(),
  colorHex: text("color_hex").notNull(), // "#RRGGBB"
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Study Sessions - scheduled study blocks
export const studySessions = pgTable("study_sessions", {
  id: text("id").primaryKey(),
  topicId: text("topic_id")
    .notNull()
    .references(() => topics.id, { onDelete: "cascade" }),
  startTime: bigint("start_time", { mode: "number" }).notNull(), // Unix timestamp ms
  endTime: bigint("end_time", { mode: "number" }).notNull(),
  status: text("status").notNull().default("scheduled"), // 'scheduled' | 'completed' | 'missed'
  sessionType: text("session_type").notNull().default("learning"), // 'learning' | 'revision'
  actualMinutes: integer("actual_minutes"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ============================================================================
// Relations
// ============================================================================

export const usersRelations = relations(users, ({ many }) => ({
  semesters: many(semesters),
  subjects: many(subjects),
  events: many(events),
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const semestersRelations = relations(semesters, ({ one, many }) => ({
  user: one(users, {
    fields: [semesters.userId],
    references: [users.id],
  }),
  subjects: many(subjects),
  events: many(events),
}));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
  user: one(users, {
    fields: [subjects.userId],
    references: [users.id],
  }),
  semester: one(semesters, {
    fields: [subjects.semesterId],
    references: [semesters.id],
  }),
  topics: many(topics),
  assessments: many(assessments),
  events: many(events),
}));

export const topicsRelations = relations(topics, ({ one, many }) => ({
  subject: one(subjects, {
    fields: [topics.subjectId],
    references: [subjects.id],
  }),
  parent: one(topics, {
    fields: [topics.parentId],
    references: [topics.id],
    relationName: "topicHierarchy",
  }),
  children: many(topics, { relationName: "topicHierarchy" }),
  studySessions: many(studySessions),
}));

export const assessmentsRelations = relations(assessments, ({ one }) => ({
  subject: one(subjects, {
    fields: [assessments.subjectId],
    references: [subjects.id],
  }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  user: one(users, {
    fields: [events.userId],
    references: [users.id],
  }),
  semester: one(semesters, {
    fields: [events.semesterId],
    references: [semesters.id],
  }),
  subject: one(subjects, {
    fields: [events.subjectId],
    references: [subjects.id],
  }),
}));

export const studySessionsRelations = relations(studySessions, ({ one }) => ({
  topic: one(topics, {
    fields: [studySessions.topicId],
    references: [topics.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));
