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

export interface ScoreMetadata {
  key_fifths: number;
  key_mode: string;
  time_signature: string;
  tempo: number;
}

export interface ScoreData {
  project_id: string;
  musicxml_url: string | null;
  midi_url: string | null;
  mp3_url: string | null;
  metadata?: ScoreMetadata;
  note_groups: NoteGroup[];
}

export interface DiffIssue {
  measure: number;
  beat: number;
  severity: string;
  feedback: string;
  color: string;
}

export interface CompareSegment {
  start: number;
  end: number;
  duration: number;
  note_count: number;
  bpm?: number;
}

export interface PitchChartPoint {
  time: number;
  midi: number;
  name?: string;
  confidence?: number | null;
}

export interface PitchComparisonChart {
  segment: CompareSegment;
  reference: PitchChartPoint[];
  detected: PitchChartPoint[];
  pitch_range: {
    min_midi: number;
    max_midi: number;
  };
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
  segment?: CompareSegment;
  pitch_chart?: PitchComparisonChart;
}

export interface PerformanceUploadResult {
  performance_id: string;
  status: string;
  audio_url?: string | null;
  audio_filename?: string | null;
  audio_info?: {
    duration_seconds?: number | null;
    sample_rate?: number | null;
    channels?: number | null;
    format?: string | null;
    subtype?: string | null;
  } | null;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  if (!res.ok) throw new Error("获取项目列表失败");
  return res.json();
}

export async function createProject(title: string, instrument: string = "violin"): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, instrument }),
  });
  if (!res.ok) throw new Error(await readError(res, "创建项目失败"));
  return res.json();
}

export async function updateProject(projectId: string, patch: Partial<Pick<Project, "instrument">>): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await readError(res, "更新项目失败"));
  return res.json();
}

export async function deleteProject(projectId: string): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "删除项目失败"));
  return res.json();
}

export async function fetchScore(projectId: string): Promise<ScoreData> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score`);
  if (!res.ok) throw new Error(await readError(res, "获取乐谱失败"));
  return res.json();
}

export async function uploadScoreFile(projectId: string, file: File): Promise<{ file_id: string; status: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score-file`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await readError(res, "上传谱面文件失败"));
  return res.json();
}

export interface ConvertResult {
  status: string;
  source: string;
  target: "midi" | "musicxml";
  musicxml_url: string | null;
  midi_url: string | null;
  mp3_url: string | null;
}

export async function runOcr(projectId: string): Promise<{ status: string; message: string; method?: string }> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/ocr`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "识别乐谱失败"));
  return res.json();
}

export async function convertScoreMedia(projectId: string, target: "midi" | "musicxml"): Promise<ConvertResult> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/convert?target=${target}`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "转换乐谱失败"));
  return res.json();
}

export async function updateScore(projectId: string, noteGroups: NoteGroup[]): Promise<ScoreData> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/score`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note_groups: noteGroups }),
  });
  if (!res.ok) throw new Error(await readError(res, "保存乐谱失败"));
  return res.json();
}

export async function uploadPerformance(projectId: string, file: File): Promise<PerformanceUploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/performances`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await readError(res, "上传录音失败"));
  return res.json();
}

function segmentQuery(segment?: Partial<Pick<CompareSegment, "start" | "end">>, mode?: "mock" | "real", bpm?: number): string {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (segment?.start !== undefined) params.set("segment_start", String(segment.start));
  if (segment?.end !== undefined) params.set("segment_end", String(segment.end));
  if (bpm !== undefined && Number.isFinite(bpm)) params.set("bpm", String(Math.round(bpm)));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function analyzePerformance(
  performanceId: string,
  segment?: Partial<Pick<CompareSegment, "start" | "end">>,
  mode: "mock" | "real" = "mock",
  bpm?: number,
): Promise<{ status: string; total_score: number; segment?: CompareSegment }> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/analyze${segmentQuery(segment, mode, bpm)}`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "分析演奏失败"));
  return res.json();
}

export async function fetchDiff(performanceId: string): Promise<DiffReport> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/diff`);
  if (!res.ok) throw new Error(await readError(res, "获取分析结果失败"));
  return res.json();
}

export async function parseScore(projectId: string): Promise<{ status: string; note_groups_count: number; source: string }> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/parse-score`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "解析乐谱失败"));
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
  if (!res.ok) throw new Error(await readError(res, "获取播放时间线失败"));
  return res.json();
}

export interface TaskProgress {
  task_id: string;
  status: string;
  progress: number;
  message: string;
}

export async function analyzePerformanceAsync(
  performanceId: string,
  segment?: Partial<Pick<CompareSegment, "start" | "end">>,
  mode: "mock" | "real" = "mock",
  bpm?: number,
): Promise<{ task_id: string; status: string }> {
  const res = await fetch(`${API_BASE}/api/performances/${performanceId}/analyze-async${segmentQuery(segment, mode, bpm)}`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res, "启动分析失败"));
  return res.json();
}

export async function fetchTaskProgress(taskId: string): Promise<TaskProgress> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/progress`);
  if (!res.ok) throw new Error(await readError(res, "获取任务进度失败"));
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
