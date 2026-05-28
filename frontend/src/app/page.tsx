"use client";

import { useCallback, useState } from "react";
import { ProjectSidebar } from "@/components/project-sidebar";
import { ScoreViewer } from "@/components/score-viewer";
import { IssuePanel } from "@/components/issue-panel";
import { PlaybackBar } from "@/components/playback-bar";
import { PracticeRecorder } from "@/components/practice-recorder";
import { DiffViewer } from "@/components/diff-viewer";
import { TaskProgressBar } from "@/components/task-progress-bar";
import {
  uploadPerformance,
  analyzePerformanceAsync,
  fetchDiff,
  fileUrl,
  pollTaskProgress,
  type CompareSegment,
  type DiffReport,
  type PerformanceUploadResult,
  type PlaybackTimeline,
  type Project,
  type ScoreData,
  type TaskProgress,
} from "@/lib/api";

export default function Home() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [scoreData, setScoreData] = useState<ScoreData | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [timeline, setTimeline] = useState<PlaybackTimeline | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [seekRequest, setSeekRequest] = useState({ time: 0, version: 0 });
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const [scoreRevision, setScoreRevision] = useState(0);
  const [compareRange, setCompareRange] = useState<[number, number]>([0, 0]);
  const [playbackBpm, setPlaybackBpm] = useState(120);
  const [projectPanelCollapsed, setProjectPanelCollapsed] = useState(false);
  const [practicePanelCollapsed, setPracticePanelCollapsed] = useState(false);
  const noteGroups = scoreData?.note_groups ?? [];
  const scoreTempo = normalizeBpm(scoreData?.metadata?.tempo);
  const scoreViewerKey = `${selectedProjectId ?? "none"}:${scoreRevision}`;


  const handleRecordingComplete = useCallback(
    async (
      blob: Blob,
      filename: string,
      segment: Pick<CompareSegment, "start" | "end">,
      onUploaded?: (result: PerformanceUploadResult) => void,
    ) => {
      if (!selectedProjectId) return;
      const file = new File([blob], filename, { type: blob.type });
      const uploadResult = await uploadPerformance(selectedProjectId, file);
      const { performance_id } = uploadResult;
      onUploaded?.({
        ...uploadResult,
        audio_url: fileUrl(uploadResult.audio_url),
      });

      const { task_id } = await analyzePerformanceAsync(performance_id, segment, "real", playbackBpm);
      setTaskProgress({ task_id, status: "pending", progress: 0, message: "准备分析..." });

      pollTaskProgress(task_id, async (progress) => {
        setTaskProgress(progress);
        if (progress.status === "completed") {
          const diff = await fetchDiff(performance_id);
          setDiffReport(diff);
          setShowDiffViewer(true);
          setTimeout(() => setTaskProgress(null), 2000);
        } else if (progress.status === "failed") {
          setTimeout(() => setTaskProgress(null), 3000);
        }
      });
    },
    [playbackBpm, selectedProjectId],
  );

  const handleTimelineReady = useCallback((nextTimeline: PlaybackTimeline | null) => {
    setTimeline(nextTimeline);
    const duration = Math.max(0, nextTimeline?.total_duration ?? 0);
    setCompareRange(duration > 0 ? [0, duration] : [0, 0]);
  }, []);

  return (
    <div className="h-full flex">
      <aside className={`${projectPanelCollapsed ? "w-12" : "w-64"} border-r border-border flex-shrink-0 h-full overflow-hidden transition-[width]`}>
        <div className="flex h-full min-h-0 flex-col">
          <button
            type="button"
            className="flex h-10 flex-shrink-0 items-center justify-center border-b border-border px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setProjectPanelCollapsed((collapsed) => !collapsed)}
          >
            {projectPanelCollapsed ? "项目" : "收起项目列表"}
          </button>
          {!projectPanelCollapsed && (
            <div className="min-h-0 flex-1">
              <ProjectSidebar
                onProjectSelect={(score, projectId, project) => {
                  setSelectedProjectId(projectId);
                  setSelectedProject(project ?? null);
                  setScoreData(score);
                  setScoreRevision((revision) => revision + 1);
                  setDiffReport(null);
                  setShowDiffViewer(false);
                  setTaskProgress(null);
                  setPlaybackTime(0);
                  setCompareRange([0, 0]);
                  setPlaybackBpm(normalizeBpm(score?.metadata?.tempo));
                  setSeekRequest((request) => ({ time: 0, version: request.version + 1 }));
                }}
                onDiffReady={(report) => {
                  setDiffReport(report);
                  if (report) setShowDiffViewer(true);
                }}
                onTimelineReady={handleTimelineReady}
              />
            </div>
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">
        <ScoreViewer
          key={scoreViewerKey}
          projectId={selectedProjectId}
          musicxmlUrl={scoreData?.musicxml_url}
          noteGroups={noteGroups}
          currentTime={playbackTime}
          colorMap={diffReport?.color_map}
          compareRange={compareRange}
          onSeek={(time) => {
            setPlaybackTime(time);
            setSeekRequest((request) => ({ time, version: request.version + 1 }));
          }}
          onCompareRangeChange={setCompareRange}
          onScoreSaved={(score) => {
            setScoreData(score);
            setPlaybackBpm(normalizeBpm(score.metadata?.tempo));
            setScoreRevision((revision) => revision + 1);
          }}
        />
        {taskProgress && <TaskProgressBar progress={taskProgress} />}
        <PlaybackBar
          key={`playback:${selectedProjectId ?? "none"}:${timeline?.total_duration ?? 0}`}
          timeline={timeline}
          instrument={selectedProject?.instrument ?? "violin"}
          seekRequest={seekRequest}
          onTimeUpdate={setPlaybackTime}
          compareRange={compareRange}
          bpm={playbackBpm}
          scoreBpm={scoreTempo}
          onBpmChange={setPlaybackBpm}
        />
      </main>
      <aside className={`${practicePanelCollapsed ? "w-12" : "w-80"} flex-shrink-0 border-l border-border bg-background flex flex-col transition-[width]`}>
        <button
          type="button"
          className="flex h-10 flex-shrink-0 items-center justify-center border-b border-border px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setPracticePanelCollapsed((collapsed) => !collapsed)}
        >
          {practicePanelCollapsed ? "检测" : "收起检测"}
        </button>
        {!practicePanelCollapsed && (
          <>
            <PracticeRecorder
              projectId={selectedProjectId}
              compareRange={compareRange}
              bpm={playbackBpm}
              scoreBpm={scoreTempo}
              onBpmChange={setPlaybackBpm}
              onRecordingComplete={handleRecordingComplete}
            />
            <div className="min-h-0 flex-1">
              <IssuePanel
                diffReport={diffReport}
                onViewDetails={() => setShowDiffViewer(true)}
              />
            </div>
          </>
        )}
      </aside>

      {showDiffViewer && (
        <DiffViewer
          diffReport={diffReport}
          onClose={() => setShowDiffViewer(false)}
        />
      )}
    </div>
  );
}

function normalizeBpm(value: number | null | undefined): number {
  const bpm = Math.round(Number(value) || 120);
  return Math.max(40, Math.min(240, bpm));
}
