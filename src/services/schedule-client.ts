/**
 * Schedule Generation Service Client
 *
 * This module handles communication with the Python schedule generation service.
 * The service uses a priority-based algorithm considering:
 * - Assessment urgency (exams/quizzes)
 * - Topic mastery levels
 * - Subject balance
 * - Spaced repetition
 */

import type {
  ScheduleGenerationRequest,
  ScheduleGenerationResponse,
  DailyPlan,
} from "../lib/types";

const SCHEDULE_SERVICE_URL =
  process.env.SCHEDULE_SERVICE_URL || "http://localhost:8000";

/**
 * Generate study schedule using the Python scheduler service.
 *
 * @param request - Schedule generation parameters
 * @returns Daily study plans with prioritized tasks
 */
export async function generateSchedule(
  request: ScheduleGenerationRequest
): Promise<ScheduleGenerationResponse> {
  // Use AbortController for timeout (2 minutes for large schedules)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${SCHEDULE_SERVICE_URL}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Schedule service error: ${error}`);
    }

    return (await response.json()) as ScheduleGenerationResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if the schedule service is healthy.
 */
export async function checkScheduleServiceHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${SCHEDULE_SERVICE_URL}/health`, {
      method: "GET",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get the start of day (midnight) for a given date string in a specific timezone.
 * Returns a UTC timestamp.
 */
function getStartOfDayInTimezone(dateStr: string, timezone: string): number {
  // Create a date formatter for the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Parse the date string (YYYY-MM-DD) and create midnight in that timezone
  const [year, month, day] = dateStr.split('-').map(Number);
  
  // Create a date object and find the UTC offset for midnight in the target timezone
  // We do this by creating a reference date and checking how it formats
  const refDate = new Date(Date.UTC(year!, month! - 1, day!, 12, 0, 0)); // noon UTC to avoid DST edge cases
  const parts = formatter.formatToParts(refDate);
  
  const getPart = (type: string) => parts.find(p => p.type === type)?.value;
  const tzYear = parseInt(getPart('year')!, 10);
  const tzMonth = parseInt(getPart('month')!, 10);
  const tzDay = parseInt(getPart('day')!, 10);
  
  // If the date in the timezone is different from what we want, adjust
  // This handles cases where noon UTC might be a different day in the target timezone
  const targetDate = new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0));
  
  // Use a binary search approach to find midnight in the target timezone
  // Start with midnight UTC and adjust based on the timezone offset
  let testTime = targetDate.getTime();
  
  // Format testTime in the target timezone and check if it's midnight of the target day
  for (let attempt = 0; attempt < 48; attempt++) {
    const testDate = new Date(testTime);
    const testParts = formatter.formatToParts(testDate);
    const testDay = parseInt(testParts.find(p => p.type === 'day')?.value!, 10);
    const testHour = parseInt(testParts.find(p => p.type === 'hour')?.value!, 10);
    
    if (testDay === day && testHour === 0) {
      return testTime;
    }
    
    // Adjust by 1 hour in the appropriate direction
    if (testDay < day! || (testDay === day && testHour < 0)) {
      testTime += 3600000; // +1 hour
    } else if (testDay > day!) {
      testTime -= 3600000; // -1 hour
    } else if (testHour > 0) {
      testTime -= testHour * 3600000; // Jump back to midnight
    } else {
      testTime += 3600000;
    }
  }
  
  // Fallback: return midnight UTC
  return targetDate.getTime();
}

/**
 * Convert daily plans to study sessions for database storage.
 *
 * Sessions are stored with times at the start of each day in the user's timezone.
 * This ensures sessions appear on the correct day regardless of server timezone.
 * 
 * @param dailyPlans - The daily plans from the scheduler
 * @param timezone - The user's timezone (e.g., "America/New_York")
 */
export function dailyPlansToLegacySessions(
  dailyPlans: DailyPlan[],
  timezone: string = "UTC"
): { topicId: string; startTime: number; endTime: number; sessionType: "learning" | "revision"; durationMinutes: number }[] {
  const sessions: {
    topicId: string;
    startTime: number;
    endTime: number;
    sessionType: "learning" | "revision";
    durationMinutes: number;
  }[] = [];

  for (const plan of dailyPlans) {
    // Get midnight in the user's timezone for this date
    const dayStartMs = getStartOfDayInTimezone(plan.date, timezone);
    
    // Schedule sessions starting from 8:00 AM in user's timezone
    // This puts study sessions at a reasonable time rather than midnight
    const baseTimeMs = dayStartMs + (8 * 60 * 60 * 1000); // 8:00 AM
    
    let offsetMs = 0;
    
    for (const task of plan.tasks) {
      const startTime = baseTimeMs + offsetMs;
      const durationMs = task.duration_minutes * 60 * 1000;
      const endTime = startTime + durationMs;

      sessions.push({
        topicId: task.topic_id,
        startTime,
        endTime,
        sessionType: task.session_type,
        durationMinutes: task.duration_minutes,
      });

      // Add a small gap between sessions (5 minutes) to maintain order
      offsetMs += durationMs + (5 * 60 * 1000);
    }
  }

  return sessions;
}
