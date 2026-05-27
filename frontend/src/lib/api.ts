const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface Project {
  id: string;
  title: string;
  instrument: string;
  source_type: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface NoteGroup {
  note_group_id: string;
  measure: number;
  beat: number;
  start: number;
  end: number;
  target_pitches: number[];
  target_names: string[];
  type: string;
}

export interface ScoreData {
  project_id: string;
  musicxml_url: string | null;
  midi_url: string | null;
  mp3_url: string | null;
  note_groups: NoteGroup[];
}

export interface DiffIssue {
  measure: number;
  beat: number;
  severity: string;
  feedback: string;
  color: string;
}

export interface DiffReport {
  summary: {
    total_score: number;
    pitch_score: number;
    rhythm_score: number;
    completeness_score: number;
    stability_score: number;
  };
  issues: DiffIssue[];
  measure_scores: Record<string, number>;
  weak_measures: number[];
  color_map: Record<string, string>;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function createProject(title: string, instrument: string = "violin"): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, instrument }),
  });
  if (!res.ok) throw new Error("Failed to create project");
  return res.json();
}

export async function fetchScore(projectId: string): Promise<ScoreData> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score`);
  if (!res.ok) throw new Error("Failed to fetch score");
  return res.json();
}

export async function uploadScoreFile(projectId: string, file: File): Promise<{ file_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score-file`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload score file");
  return res.json();
}

export interface ConvertResult {
  status: string;
  source: string;
  target: "midi" | "mp3";
  musicxml_url: string | null;
  midi_url: string | null;
  mp3_url: string | null;
}

export async function runOcr(projectId: string): Promise<{ status: string; message: string; method?: string }> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/ocr`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "Failed to run OMR"));
  return res.json();
}

export async function convertScoreMedia(projectId: string, target: "midi" | "mp3"): Promise<ConvertResult> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/convert?target=${target}`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "Failed to convert score media"));
  return res.json();
}

export async function updateScore(projectId: string, noteGroups: NoteGroup[]): Promise<ScoreData> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note_groups: noteGroups }),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to save score"));
  return res.json();
}

export async function uploadPerformance(projectId: string, file: File): Promise<{ performance_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/performances`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload performance");
  return res.json();
}

export async function analyzePerformance(performanceId: string): Promise<{ status: string; total_score: number }> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/analyze`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to analyze performance");
  return res.json();
}

export async function fetchDiff(performanceId: string): Promise<DiffReport> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/diff`);
  if (!res.ok) throw new Error("Failed to fetch diff");
  return res.json();
}

export async function parseScore(projectId: string): Promise<{ status: string; note_groups_count: number; source: string }> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/parse-score`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "Failed to parse score"));
  return res.json();
}

export interface PlaybackEvent {
  time: number;
  duration: number;
  note_group_id: string;
  pitches: number[];
  names: string[];
  type: string;
}

export interface PlaybackTimeline {
  bpm: number;
  total_duration: number;
  events: PlaybackEvent[];
}

export async function fetchPlaybackTimeline(projectId: string, bpm: number = 120): Promise<PlaybackTimeline> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/playback-timeline?bpm=${bpm}`);
  if (!res.ok) throw new Error("Failed to fetch playback timeline");
  return res.json();
}

export interface TaskProgress {
  task_id: string;
  status: string;
  progress: number;
  message: string;
}

export async function analyzePerformanceAsync(performanceId: string): Promise<{ task_id: string; status: string }> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/analyze-async`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to start analysis");
  return res.json();
}

export async function fetchTaskProgress(taskId: string): Promise<TaskProgress> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/progress`);
  if (!res.ok) throw new Error("Failed to fetch task progress");
  return res.json();
}

export function pollTaskProgress(
  taskId: string,
  onProgress: (progress: TaskProgress) => void,
  intervalMs: number = 500,
): () => void {
  let stopped = false;

  async function poll() {
    while (!stopped) {
      try {
        const progress = await fetchTaskProgress(taskId);
        onProgress(progress);
        if (progress.status === "completed" || progress.status === "failed") {
          break;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  poll();
  return () => { stopped = true; };
}

export function fileUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data.detail || fallback;
  } catch {
    return fallback;
  }
}
