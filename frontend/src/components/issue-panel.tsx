"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { type DiffReport } from "@/lib/api";

interface IssuePanelProps {
  diffReport?: DiffReport | null;
  onViewDetails?: () => void;
}

export function IssuePanel({ diffReport, onViewDetails }: IssuePanelProps) {
  if (!diffReport) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-3 border-b border-border">
          <h2 className="text-sm font-semibold">问题列表</h2>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-3 text-sm text-muted-foreground">
            <p>完成录音分析后，问题将在此显示</p>
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="destructive" className="text-xs">错音</Badge>
                <span className="text-xs">音高偏差 &gt; 50 音分</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-800">偏差</Badge>
                <span className="text-xs">音高偏差 30-50 音分</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800">节奏</Badge>
                <span className="text-xs">进入时间偏差 &gt; 150ms</span>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    );
  }

  const { summary, issues, weak_measures, segment } = diffReport;

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">分析结果</h2>
        {onViewDetails && (
          <button
            onClick={onViewDetails}
            className="text-xs text-primary hover:underline"
          >
            查看详情
          </button>
        )}
      </div>
      <div className="p-3 border-b border-border space-y-1">
        <div className="flex justify-between text-sm">
          <span>总分</span>
          <span className="font-semibold">{summary.total_score.toFixed(1)}</span>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>音准 {summary.pitch_score.toFixed(0)}</span>
          <span>节奏 {summary.rhythm_score.toFixed(0)}</span>
          <span>完整 {summary.completeness_score.toFixed(0)}</span>
        </div>
        {segment && (
          <p className="text-xs text-muted-foreground tabular-nums">
            片段 {formatTime(segment.start)} - {formatTime(segment.end)} · {segment.note_count} 个音符
          </p>
        )}
        {weak_measures.length > 0 && (
          <p className="text-xs text-destructive mt-1">
            薄弱小节: {weak_measures.join(", ")}
          </p>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {issues.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">没有发现问题</p>
          ) : (
            issues.map((issue, i) => (
              <div
                key={i}
                className="px-2 py-1.5 rounded text-xs border-l-2"
                style={{ borderLeftColor: colorToCss(issue.color) }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={issue.severity === "error" ? "destructive" : "secondary"}
                    className="text-[10px] px-1 py-0"
                  >
                    {issue.severity === "error" ? "错误" : "警告"}
                  </Badge>
                  <span className="text-muted-foreground">
                    第{issue.measure}小节 第{issue.beat}拍
                  </span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed">{issue.feedback}</p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function colorToCss(color: string): string {
  const map: Record<string, string> = {
    green: "#22c55e",
    yellow: "#eab308",
    red: "#ef4444",
    blue: "#3b82f6",
    purple: "#a855f7",
    orange: "#f97316",
    gray: "#6b7280",
  };
  return map[color] || color;
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const m = Math.floor(safeSeconds / 60);
  const s = Math.floor(safeSeconds % 60);
  const tenths = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 10);
  return tenths > 0
    ? `${m}:${s.toString().padStart(2, "0")}.${tenths}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}
