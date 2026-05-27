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
  pollTaskProgress,
  type DiffReport,
  type PlaybackTimeline,
  type ScoreData,
  type TaskProgress,
} from "@/lib/api";

export default function Home() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [scoreData, setScoreData] = useState<ScoreData | null>(null);
  const [diffReport, setDiffReport] = useState<DiffReport | null>(null);
  const [timeline, setTimeline] = useState<PlaybackTimeline | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  const handleRecordingComplete = useCallback(
    async (blob: Blob, filename: string) => {
      if (!selectedProjectId) return;
      const file = new File([blob], filename, { type: blob.type });
      const { performance_id } = await uploadPerformance(selectedProjectId, file);

      const { task_id } = await analyzePerformanceAsync(performance_id);
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
    [selectedProjectId],
  );

  return (
    <div className="h-full flex">
      <aside className="w-64 border-r border-border flex-shrink-0">
        <ProjectSidebar
          onProjectSelect={(score, projectId) => {
            setSelectedProjectId(projectId);
            setScoreData(score);
            setDiffReport(null);
            setShowDiffViewer(false);
            setTaskProgress(null);
            setPlaybackTime(0);
          }}
          onDiffReady={(report) => {
            setDiffReport(report);
            if (report) setShowDiffViewer(true);
          }}
          onTimelineReady={setTimeline}
        />
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">
        <ScoreViewer
          key={`${selectedProjectId ?? "none"}:${scoreData?.note_groups.map((g) => g.note_group_id).join(",") ?? "empty"}`}
          projectId={selectedProjectId}
          musicxmlUrl={scoreData?.musicxml_url}
          noteGroups={scoreData?.note_groups ?? []}
          currentTime={playbackTime}
          colorMap={diffReport?.color_map}
          onScoreSaved={setScoreData}
        />
        {taskProgress && <TaskProgressBar progress={taskProgress} />}
        <PracticeRecorder
          projectId={selectedProjectId}
          onRecordingComplete={handleRecordingComplete}
        />
        <PlaybackBar
          key={`${selectedProjectId ?? "none"}:${timeline?.total_duration ?? 0}`}
          timeline={timeline}
          onTimeUpdate={setPlaybackTime}
        />
      </main>
      {diffReport && (
        <aside className="hidden w-72 flex-shrink-0 border-l border-border xl:block 2xl:w-80">
          <IssuePanel
            diffReport={diffReport}
            onViewDetails={() => setShowDiffViewer(true)}
          />
        </aside>
      )}

      {showDiffViewer && (
        <DiffViewer
          diffReport={diffReport}
          onClose={() => setShowDiffViewer(false)}
        />
      )}
    </div>
  );
}
