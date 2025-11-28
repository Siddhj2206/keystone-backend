import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

export interface ParsedSubtopic {
  title: string;
  estMinutes: number;
}

export interface ParsedTopic {
  title: string;
  estMinutes: number;
  children?: ParsedSubtopic[];
}

export interface ParsedClassSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ParsedScheduleEntry {
  subjectName: string;
  colorHex: string;
  classSlots: ParsedClassSlot[];
}

// Subtopic schema (leaf level - no children)
const subtopicSchema = z.object({
  title: z.string(),
  estMinutes: z.number().min(15).max(90),
});

// Topic schema (root level - can have subtopics, max depth 2)
const topicSchema = z.object({
  title: z.string(),
  estMinutes: z.number().min(15).max(90),
  children: z.array(subtopicSchema).optional(),
});

const syllabusSchema = z.object({
  topics: z.array(topicSchema),
});

const classSlotSchema = z.object({
  dayOfWeek: z.number().min(0).max(6),
  startTime: z.string(),
  endTime: z.string(),
});

const scheduleEntrySchema = z.object({
  subjectName: z.string(),
  classSlots: z.array(classSlotSchema),
});

const scheduleSchema = z.object({
  subjects: z.array(scheduleEntrySchema),
});

// Subject colors to assign
const SUBJECT_COLORS = [
  "#0000FF", // Blue
  "#FF6600", // Orange
  "#00AA00", // Green
  "#AA00AA", // Purple
  "#FF0000", // Red
  "#00AAAA", // Cyan
  "#AAAA00", // Yellow
  "#FF00AA", // Pink
];

// Clamp estMinutes to valid range (15-90)
function clampEstMinutes(value: number): number {
  return Math.max(15, Math.min(90, value));
}

// Post-process topics to ensure all estMinutes are within valid range
function normalizeTopics(topics: ParsedTopic[]): ParsedTopic[] {
  return topics.map((topic) => ({
    ...topic,
    estMinutes: clampEstMinutes(topic.estMinutes),
    children: topic.children?.map((child) => ({
      ...child,
      estMinutes: clampEstMinutes(child.estMinutes),
    })),
  }));
}

export async function parseSyllabusPdf(
  fileOrBuffer: File | Buffer,
  mediaType: string = "application/pdf",
): Promise<ParsedTopic[]> {
  // Convert to base64
  let base64: string;
  if (Buffer.isBuffer(fileOrBuffer)) {
    base64 = fileOrBuffer.toString("base64");
  } else {
    const arrayBuffer = await fileOrBuffer.arrayBuffer();
    base64 = Buffer.from(arrayBuffer).toString("base64");
  }

  const model = google("gemini-flash-latest");

  const result = await generateObject({
    model,
    schema: syllabusSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file" as const,
            data: base64,
            mediaType: mediaType as
              | "application/pdf"
              | "image/png"
              | "image/jpeg",
          },
          {
            type: "text" as const,
            text: `Analyze this syllabus document and extract a hierarchical list of topics to study.

For each topic, return an object with:
- "title": the topic name (string)
- "estMinutes": estimated study time in minutes, MUST be between 15-90 inclusive (number). Use 15 as minimum even for short topics.
- "children": optional array of subtopics, where each subtopic has "title" and "estMinutes" (also 15-90)

IMPORTANT: All estMinutes values MUST be at least 15 and at most 90. Never use values outside this range.

Maximum depth is 2 levels (topics with optional subtopics, no deeper nesting).
Return topics in syllabus order.`,
          },
        ],
      },
    ],
  });

  return normalizeTopics(result.object.topics);
}

// Simpler text-based parsing for testing without API
export async function parseSyllabusText(text: string): Promise<ParsedTopic[]> {
  const model = google("gemini-flash-latest");

  const result = await generateObject({
    model,
    schema: syllabusSchema,
    prompt: `Analyze this syllabus text and extract a hierarchical list of topics to study.

For each topic, return an object with:
- "title": the topic name (string)
- "estMinutes": estimated study time in minutes, MUST be between 15-90 inclusive (number). Use 15 as minimum even for short topics.
- "children": optional array of subtopics, where each subtopic has "title" and "estMinutes" (also 15-90)

IMPORTANT: All estMinutes values MUST be at least 15 and at most 90. Never use values outside this range.

Maximum depth is 2 levels (topics with optional subtopics, no deeper nesting).

Syllabus:
${text}`,
  });

  return normalizeTopics(result.object.topics);
}

// Parse a class schedule file (PDF or image) to extract subjects and class times
export async function parseScheduleFile(
  file: File,
  mediaType: string,
): Promise<ParsedScheduleEntry[]> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  const model = google("gemini-flash-latest");

  const result = await generateObject({
    model,
    schema: scheduleSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file" as const,
            data: base64,
            mediaType: mediaType as
              | "application/pdf"
              | "image/png"
              | "image/jpeg"
              | "image/gif"
              | "image/webp",
          },
          {
            type: "text" as const,
            text: `Analyze this class schedule document and extract all subjects with their class times.

For each subject found:
1. Extract the subject/course name (e.g., "Linear Algebra", "Physics 101")
2. Extract all class times including:
   - Day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
   - Start time in 24h format (e.g., "09:00")
   - End time in 24h format (e.g., "10:30")

Return ALL subjects and ALL their class sessions found in the schedule.

Example output:
{
  "subjects": [
    {
      "subjectName": "Linear Algebra",
      "classSlots": [
        { "dayOfWeek": 1, "startTime": "09:00", "endTime": "10:30" },
        { "dayOfWeek": 3, "startTime": "09:00", "endTime": "10:30" }
      ]
    },
    {
      "subjectName": "Physics",
      "classSlots": [
        { "dayOfWeek": 2, "startTime": "14:00", "endTime": "15:30" }
      ]
    }
  ]
}`,
          },
        ],
      },
    ],
  });

  // Assign colors to each subject
  return result.object.subjects.map((subject, index) => ({
    subjectName: subject.subjectName.toUpperCase(),
    colorHex: SUBJECT_COLORS[index % SUBJECT_COLORS.length] ?? "#0000FF",
    classSlots: subject.classSlots.map((slot, slotIndex) => ({
      id: `slot-${index}-${slotIndex}`,
      dayOfWeek: slot.dayOfWeek,
      startTime: slot.startTime,
      endTime: slot.endTime,
    })),
  }));
}
