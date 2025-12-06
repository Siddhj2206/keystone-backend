import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";

import { auth } from "./lib/auth";
import { apiRateLimiter, authRateLimiter } from "./lib/rate-limit";
import { authRoutes } from "./routes/auth";
import { semesterRoutes } from "./routes/semester";
import { subjectRoutes } from "./routes/subjects";
import { topicRoutes } from "./routes/topics";
import { assessmentRoutes } from "./routes/assessments";
import { scheduleRoutes } from "./routes/schedule";
import { eventRoutes } from "./routes/events";
import { syncRoutes } from "./routes/sync";

const app = new Hono();

// Global error handler - catches all unhandled errors
app.onError((err, c) => {
  console.error(`[ERROR] ${c.req.method} ${c.req.path}:`, err);

  // Handle known HTTP exceptions
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  // Handle Zod validation errors
  if (err.name === "ZodError") {
    return c.json({ error: "Validation failed", details: err }, 400);
  }

  // Don't leak internal error details in production
  const isDev = process.env.NODE_ENV !== "production";
  return c.json(
    {
      error: isDev ? err.message : "Internal server error",
      ...(isDev && { stack: err.stack }),
    },
    500
  );
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

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

// Health check (no rate limit)
app.get("/", (c) => c.json({ status: "ok", service: "keystone-backend" }));
app.get("/health", (c) => c.json({ status: "healthy" }));

// Rate limiting for auth endpoints (stricter)
app.use("/api/auth/*", authRateLimiter);

// Better Auth handler - handles all /api/auth/* routes
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Rate limiting for API endpoints
app.use("/api/*", apiRateLimiter);

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
  idleTimeout: 120, // 2 minutes for long-running requests like schedule generation
};

console.log(`Keystone backend running on port ${process.env.PORT || 3000}`);
