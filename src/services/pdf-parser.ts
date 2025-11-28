import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

export interface ParsedTopic {
  title: string;
  estMinutes: number;
  children?: ParsedTopic[];
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

// Flexible schema that accepts either objects or strings for children
// (Gemini sometimes returns strings instead of objects)
const flexibleTopicSchema: z.ZodType<any> = z.object({
  title: z.string(),
  estMinutes: z.number().default(30),
  children: z.lazy(() => z.array(
    z.union([
      flexibleTopicSchema,
      z.string() // Allow strings, we'll convert them later
    ])
  )).optional(),
});

const syllabusSchema = z.object({
  topics: z.array(flexibleTopicSchema),
});

// Post-process to ensure all children are proper objects
function normalizeTopics(topics: any[]): ParsedTopic[] {
  return topics.map((topic) => {
    const normalized: ParsedTopic = {
      title: String(topic.title || "Untitled"),
      estMinutes: typeof topic.estMinutes === "number" ? topic.estMinutes : 30,
    };

    if (topic.children && Array.isArray(topic.children) && topic.children.length > 0) {
      normalized.children = topic.children.map((child: any) => {
        // If child is a string, convert to topic object
        if (typeof child === "string") {
          return { title: child, estMinutes: 30 };
        }
        // Recursively normalize nested children
        return normalizeTopics([child])[0];
      });
    }

    return normalized;
  });
}

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

IMPORTANT: Return ONLY objects in the children array, never strings.

For each topic object:
- "title": string - the topic name
- "estMinutes": number - estimated study time (15-90 minutes)
- "children": array of topic objects (optional) - subtopics

Return topics in syllabus order. Group subtopics under parent topics.

Example:
{
  "topics": [
    {
      "title": "Chapter 1: Introduction",
      "estMinutes": 30,
      "children": [
        { "title": "1.1 Background", "estMinutes": 20 },
        { "title": "1.2 Key Concepts", "estMinutes": 25 }
      ]
    },
    {
      "title": "Chapter 2: Core Theory",
      "estMinutes": 45
    }
  ]
}`,
          },
        ],
      },
    ],
  });

  // Normalize the response to handle any edge cases
  return normalizeTopics(result.object.topics);
}

// Simpler text-based parsing for testing without API
export async function parseSyllabusText(text: string): Promise<ParsedTopic[]> {
  const model = google("gemini-flash-latest");

  const result = await generateObject({
    model,
    schema: syllabusSchema,
    prompt: `Analyze this syllabus text and extract a hierarchical list of topics to study.

IMPORTANT: Return ONLY objects in the children array, never strings.

For each topic object:
- "title": string - the topic name
- "estMinutes": number - estimated study time (15-90 minutes)
- "children": array of topic objects (optional) - subtopics

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
