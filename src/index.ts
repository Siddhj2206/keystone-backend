import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { auth } from "./lib/auth";
import { authRoutes } from "./routes/auth";
import { semesterRoutes } from "./routes/semester";
import { subjectRoutes } from "./routes/subjects";
import { topicRoutes } from "./routes/topics";
import { assessmentRoutes } from "./routes/assessments";
import { scheduleRoutes } from "./routes/schedule";
import { eventRoutes } from "./routes/events";
import { syncRoutes } from "./routes/sync";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:8081",
      "http://localhost:3000",
      "keystonemobile://",
      "exp://",
    ],
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "keystone-backend" }));
app.get("/health", (c) => c.json({ status: "healthy" }));

// Better Auth handler - handles all /api/auth/* routes
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// API Routes
app.route("/api/auth", authRoutes);
app.route("/api/semester", semesterRoutes);
app.route("/api/subjects", subjectRoutes);
app.route("/api/topics", topicRoutes);
app.route("/api/assessments", assessmentRoutes);
app.route("/api/schedule", scheduleRoutes);
app.route("/api/study-sessions", scheduleRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/sync", syncRoutes);

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};

console.log(`Keystone backend running on port ${process.env.PORT || 3000}`);
