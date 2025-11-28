# Backend Specification: Keystone

**Project:** Keystone Backend API  
**Framework:** Hono  
**Runtime:** Bun  
**Language:** TypeScript  
**Database:** PostgreSQL + Drizzle ORM  
**Auth:** Better Auth

---

## 1. Tech Stack

| Category | Library | Purpose |
|----------|---------|---------|
| **Framework** | `hono` | Lightweight, fast HTTP framework |
| **Runtime** | `bun` | Fast JS runtime |
| **ORM** | `drizzle-orm` | Type-safe database access |
| **Database** | `postgres` | PostgreSQL driver |
| **Auth** | `better-auth` | Authentication |
| **AI** | `@ai-sdk/google` | Gemini for PDF parsing |
| **Validation** | `zod` | Request validation |

---

## 2. Directory Structure

```text
keystone-backend/
├── src/
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── subjects.ts
│   │   ├── topics.ts
│   │   ├── assessments.ts
│   │   ├── schedule.ts
│   │   ├── semester.ts
│   │   ├── fixed-events.ts
│   │   └── sync.ts
│   ├── services/
│   │   ├── pdf-parser.ts
│   │   └── schedule-client.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── migrations/
│   │   └── index.ts
│   ├── lib/
│   │   ├── auth.ts
│   │   └── types.ts
│   └── index.ts
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── .env
└── Dockerfile
```

---

## 3. Database Schema

Matches the frontend WatermelonDB schema for sync compatibility.

### Tables

**semesters**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK -> users |
| start_date | date | |
| end_date | date | |
| is_active | boolean | |
| study_hours | jsonb | `{ "0": 60, "1": 120, ... }` |
| created_at | timestamp | |
| updated_at | timestamp | |

**subjects**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK -> users |
| semester_id | uuid | FK -> semesters |
| name | varchar | |
| color_hex | varchar(7) | |
| progress | decimal | 0.0 - 1.0 |
| created_at | timestamp | |
| updated_at | timestamp | |

**topics**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| subject_id | uuid | FK -> subjects |
| parent_id | uuid | FK -> topics (nullable) |
| title | varchar | |
| est_minutes | integer | |
| current_mastery | decimal | 0.0 - 1.0 |
| status | varchar | 'pending' \| 'completed' \| 'needs_revision' |
| sort_order | integer | |
| created_at | timestamp | |
| updated_at | timestamp | |

**class_slots**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| subject_id | uuid | FK -> subjects |
| day_of_week | integer | 0-6 |
| start_time | time | |
| end_time | time | |
| created_at | timestamp | |
| updated_at | timestamp | |

**assessments**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| subject_id | uuid | FK -> subjects |
| title | varchar | |
| date | timestamp | |
| weightage | integer | 0-100 |
| created_at | timestamp | |
| updated_at | timestamp | |

**assessment_topics**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| assessment_id | uuid | FK -> assessments |
| topic_id | uuid | FK -> topics |

**study_sessions**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| topic_id | uuid | FK -> topics |
| start_time | timestamp | |
| end_time | timestamp | |
| status | varchar | 'scheduled' \| 'completed' \| 'missed' |
| session_type | varchar | 'learning' \| 'revision' |
| actual_minutes | integer | nullable |
| created_at | timestamp | |
| updated_at | timestamp | |

**fixed_events**
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK -> users |
| title | varchar | |
| day_of_week | integer | 0-6 |
| start_time | time | |
| end_time | time | |
| color_hex | varchar(7) | |
| created_at | timestamp | |
| updated_at | timestamp | |

---

## 4. API Endpoints

### Authentication

Better Auth handles these automatically at `/api/auth/*`

### Subjects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/subjects` | List all subjects with topics |
| GET | `/api/subjects/:id` | Get single subject |
| POST | `/api/subjects` | Create subject |
| PATCH | `/api/subjects/:id` | Update subject |
| DELETE | `/api/subjects/:id` | Delete subject |
| POST | `/api/subjects/:id/syllabus` | Upload & parse syllabus PDF |

**POST /api/subjects**
```json
{
  "name": "string",
  "colorHex": "#FF0000",
  "classSlots": [
    { "dayOfWeek": 1, "startTime": "09:00", "endTime": "10:30" }
  ]
}
```

**POST /api/subjects/:id/syllabus**
- Content-Type: `multipart/form-data`
- Body: `file` (PDF)
- Returns: Subject with parsed topics

### Topics

| Method | Path | Description |
|--------|------|-------------|
| PATCH | `/api/topics/:id` | Update topic |
| PATCH | `/api/topics/:id/mastery` | Update mastery |
| PUT | `/api/topics/:id/reorder` | Reorder topics |

**PATCH /api/topics/:id/mastery**
```json
{ "mastery": 0.75 }
```

### Assessments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/assessments` | List all assessments |
| GET | `/api/assessments/:id` | Get single assessment |
| POST | `/api/assessments` | Create assessment |
| PATCH | `/api/assessments/:id` | Update assessment |
| DELETE | `/api/assessments/:id` | Delete assessment |

**POST /api/assessments**
```json
{
  "title": "Midterm Exam",
  "date": "2025-02-15T09:00:00Z",
  "weightage": 30,
  "subjectId": "uuid",
  "topicIds": ["uuid", "uuid"]
}
```

### Schedule

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/schedule/agenda` | Get daily agenda |
| GET | `/api/study-sessions` | Get sessions in range |
| PATCH | `/api/study-sessions/:id/complete` | Mark session complete |
| POST | `/api/schedule/generate` | Trigger schedule regeneration |

**GET /api/schedule/agenda**
- Query: `date=YYYY-MM-DD`
- Returns: `{ sessions: StudySession[], fixedEvents: FixedEvent[] }`

**PATCH /api/study-sessions/:id/complete**
```json
{
  "actualMinutes": 45,
  "needsMoreTime": false
}
```

### Fixed Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fixed-events` | List fixed events |
| POST | `/api/fixed-events` | Create fixed event |
| PATCH | `/api/fixed-events/:id` | Update fixed event |
| DELETE | `/api/fixed-events/:id` | Delete fixed event |

### Semester

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/semester/current` | Get active semester |
| POST | `/api/semester/initialize` | Initialize new semester |
| POST | `/api/semester/archive` | Archive current semester |

**POST /api/semester/initialize**
```json
{
  "startDate": "2025-01-15",
  "endDate": "2025-05-15",
  "studyHours": { "0": 60, "1": 120, "2": 120, "3": 120, "4": 120, "5": 120, "6": 90 },
  "subjects": [
    {
      "name": "Mathematics",
      "colorHex": "#FF0000",
      "classSlots": [...]
    }
  ]
}
```

### Sync (WatermelonDB)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sync/pull` | Pull changes from server |
| POST | `/sync/push` | Push changes to server |

**GET /sync/pull**
- Query: `lastPulledAt=timestamp`
- Returns:
```json
{
  "changes": {
    "semesters": { "created": [], "updated": [], "deleted": [] },
    "subjects": { "created": [], "updated": [], "deleted": [] },
    "topics": { "created": [], "updated": [], "deleted": [] },
    "class_slots": { "created": [], "updated": [], "deleted": [] },
    "study_sessions": { "created": [], "updated": [], "deleted": [] },
    "assessments": { "created": [], "updated": [], "deleted": [] },
    "assessment_topics": { "created": [], "updated": [], "deleted": [] },
    "fixed_events": { "created": [], "updated": [], "deleted": [] }
  },
  "timestamp": 1234567890
}
```

**POST /sync/push**
```json
{
  "changes": { ... },
  "lastPulledAt": 1234567890
}
```

---

## 5. External Services

### Python Schedule Service

Internal HTTP call to generate study sessions.

**POST http://localhost:8000/generate-schedule**
```json
{
  "semester": { "startDate": "...", "endDate": "..." },
  "subjects": [...],
  "assessments": [...],
  "fixedEvents": [...],
  "classSlots": [...],
  "studyHours": { "0": 60, "1": 120, ... }
}
```
Returns: `StudySession[]`

### Gemini (PDF Parsing)

Used via Vercel AI SDK for:
- Syllabus PDF -> Topic tree extraction
- Returns hierarchical `Topic[]`

---

## 6. Environment Variables

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/keystone
BETTER_AUTH_SECRET=your-secret-key
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
SCHEDULE_SERVICE_URL=http://localhost:8000
```

---

## 7. TypeScript Interfaces

Shared types that match frontend `lib/types.ts`:

```typescript
export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Semester {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  studyHours?: DailyStudyHours;
  createdAt: string;
  updatedAt: string;
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
  userId: string;
  semesterId: string;
  name: string;
  colorHex: string;
  progress: number;
  topics?: Topic[];
  classSlots?: ClassSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface Topic {
  id: string;
  subjectId: string;
  parentId: string | null;
  title: string;
  estMinutes: number;
  currentMastery: number;
  status: 'pending' | 'completed' | 'needs_revision';
  sortOrder: number;
  children?: Topic[];
  createdAt: string;
  updatedAt: string;
}

export interface ClassSlot {
  id: string;
  subjectId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface Assessment {
  id: string;
  subjectId: string;
  title: string;
  date: string;
  weightage: number;
  topicIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StudySession {
  id: string;
  topicId: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'completed' | 'missed';
  sessionType: 'learning' | 'revision';
  actualMinutes?: number;
  // Hydrated fields for API responses
  topicTitle?: string;
  subjectColor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FixedEvent {
  id: string;
  userId: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  colorHex: string;
  createdAt: string;
  updatedAt: string;
}
```

---

## 8. Implementation Status

### Completed
- [x] Project setup
- [x] Database schema & migrations
- [x] Better Auth integration
- [x] Subject CRUD endpoints
- [x] Topic endpoints
- [x] Assessment CRUD endpoints
- [x] Schedule endpoints
- [x] Fixed events endpoints
- [x] Semester endpoints
- [x] WatermelonDB sync endpoints
- [x] PDF parsing with Gemini
- [x] Schedule service client
