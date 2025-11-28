/**
 * Schedule Generation Service Client
 *
 * This module handles communication with the ML-based schedule generation service.
 * When the ML service is unavailable, it falls back to a simple round-robin scheduler.
 *
 * TODO: Replace with your custom ML model implementation
 */

import type { ScheduleGenerationRequest, GeneratedStudySession } from "../lib/types";

const SCHEDULE_SERVICE_URL = process.env.SCHEDULE_SERVICE_URL || "http://localhost:8000";

/**
 * Generate study sessions using the ML schedule service
 * Falls back to simple scheduler if ML service is unavailable
 */
export async function generateSchedule(
  request: ScheduleGenerationRequest
): Promise<GeneratedStudySession[]> {
  try {
    const response = await fetch(`${SCHEDULE_SERVICE_URL}/generate-schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Schedule service error: ${error}`);
    }

    return (await response.json()) as GeneratedStudySession[];
  } catch (error) {
    console.error("ML schedule service unavailable, using fallback:", error);
    return generateSimpleSchedule(request);
  }
}

/**
 * Simple fallback scheduler
 * Distributes topics across the week based on daily study hours
 */
function generateSimpleSchedule(request: ScheduleGenerationRequest): GeneratedStudySession[] {
  const sessions: GeneratedStudySession[] = [];
  const { subjects, studyHours } = request;

  // Collect all incomplete topics
  const allTopics: { id: string; estMinutes: number }[] = [];
  for (const subject of subjects) {
    if (subject.topics) {
      for (const topic of subject.topics) {
        if (topic.status !== "completed") {
          allTopics.push({ id: topic.id, estMinutes: topic.estMinutes });
        }
      }
    }
  }

  if (allTopics.length === 0) return sessions;

  // Generate sessions for next 7 days
  const startDate = new Date();
  startDate.setHours(9, 0, 0, 0); // Start at 9 AM

  let topicIndex = 0;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(currentDate.getDate() + dayOffset);

    const dayOfWeek = currentDate.getDay();
    const dailyMinutes = studyHours[dayOfWeek as keyof typeof studyHours] || 60;

    let remainingMinutes = dailyMinutes;
    let currentHour = 9;

    while (remainingMinutes > 0 && topicIndex < allTopics.length) {
      const topic = allTopics[topicIndex];
      if (!topic) break;

      // Max 60 min per session
      const sessionDuration = Math.min(topic.estMinutes, remainingMinutes, 60);

      const sessionStart = new Date(currentDate);
      sessionStart.setHours(currentHour, 0, 0, 0);

      const sessionEnd = new Date(sessionStart);
      sessionEnd.setMinutes(sessionEnd.getMinutes() + sessionDuration);

      sessions.push({
        topicId: topic.id,
        startTime: sessionStart.toISOString(),
        endTime: sessionEnd.toISOString(),
        sessionType: "learning",
      });

      remainingMinutes -= sessionDuration;
      currentHour += Math.ceil(sessionDuration / 60) + 0.25; // 15 min break

      // Move to next topic if fully scheduled
      if (sessionDuration >= topic.estMinutes) {
        topicIndex++;
      } else {
        topic.estMinutes -= sessionDuration;
      }

      // Don't schedule past 9 PM
      if (currentHour >= 21) break;
    }
  }

  return sessions;
}
