"use client";

import { type TaskProgress } from "@/lib/api";

interface TaskProgressBarProps {
  progress: TaskProgress;
}

export function TaskProgressBar({ progress }: TaskProgressBarProps) {
  const percent = Math.round(progress.progress * 100);
  const isComplete = progress.status === "completed";
  const isFailed = progress.status === "failed";

  return (
    <div className="px-4 py-2 border-t border-border">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className={isFailed ? "text-destructive" : "text-muted-foreground"}>
          {progress.message || "处理中..."}
        </span>
        <span className="tabular-nums text-muted-foreground">{percent}%</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            isFailed
              ? "bg-destructive"
              : isComplete
                ? "bg-green-500"
                : "bg-primary"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
