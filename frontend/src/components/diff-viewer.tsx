"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { type DiffReport } from "@/lib/api";

interface DiffViewerProps {
  diffReport: DiffReport | null;
  onClose?: () => void;
}

export function DiffViewer({ diffReport, onClose }: DiffViewerProps) {
  if (!diffReport) return null;

  const { summary, issues, measure_scores, weak_measures, color_map } = diffReport;

  const sortedMeasures = Object.entries(measure_scores)
    .map(([m, score]) => ({ measure: parseInt(m), score }))
    .sort((a, b) => a.measure - b.measure);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Diff 详情</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-4 border-b border-border">
          <div className="grid grid-cols-5 gap-3 text-center">
            <ScoreCard label="总分" value={summary.total_score} />
            <ScoreCard label="音准" value={summary.pitch_score} />
            <ScoreCard label="节奏" value={summary.rhythm_score} />
            <ScoreCard label="完整度" value={summary.completeness_score} />
            <ScoreCard label="稳定性" value={summary.stability_score} />
          </div>
        </div>

        <div className="p-4 border-b border-border">
          <h3 className="text-sm font-medium mb-2">小节得分热力图</h3>
          <div className="flex flex-wrap gap-1">
            {sortedMeasures.map(({ measure, score }) => (
              <div
                key={measure}
                className="w-8 h-8 rounded text-[10px] flex items-center justify-center font-mono"
                style={{ backgroundColor: scoreToColor(score) }}
                title={`第${measure}小节: ${score}分`}
              >
                {measure}
              </div>
            ))}
          </div>
          {weak_measures.length > 0 && (
            <p className="text-xs text-destructive mt-2">
              需要重点练习: 第 {weak_measures.join(", ")} 小节
            </p>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4">
            <h3 className="text-sm font-medium mb-2">
              问题详情 ({issues.length} 个)
            </h3>
            {issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">演奏完美，没有发现问题</p>
            ) : (
              <div className="space-y-2">
                {issues.map((issue, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-2 rounded border border-border"
                  >
                    <div
                      className="w-1 self-stretch rounded-full flex-shrink-0"
                      style={{ backgroundColor: issueColorToCss(issue.color) }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={issue.severity === "error" ? "destructive" : "secondary"}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {issue.severity === "error" ? "错误" : "警告"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          第{issue.measure}小节 · 第{issue.beat}拍
                        </span>
                      </div>
                      <p className="text-sm mt-1">{issue.feedback}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-4 border-t border-border">
          <h3 className="text-sm font-medium mb-2">音符着色图例</h3>
          <div className="flex flex-wrap gap-3 text-xs">
            <LegendItem color="#22c55e" label="正确" />
            <LegendItem color="#eab308" label="可接受/偏差" />
            <LegendItem color="#ef4444" label="错音" />
            <LegendItem color="#3b82f6" label="提前" />
            <LegendItem color="#a855f7" label="延后" />
            <LegendItem color="#6b7280" label="缺失" />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            共 {Object.keys(color_map).length} 个音符组已着色
          </p>
        </div>
      </div>
    </div>
  );
}

function ScoreCard({ label, value }: { label: string; value: number }) {
  const color =
    value >= 80 ? "text-green-600" : value >= 60 ? "text-yellow-600" : "text-red-600";
  return (
    <div className="space-y-0.5">
      <div className={`text-xl font-bold tabular-nums ${color}`}>
        {value.toFixed(0)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </div>
  );
}

function scoreToColor(score: number): string {
  if (score >= 90) return "rgba(34, 197, 94, 0.2)";
  if (score >= 75) return "rgba(34, 197, 94, 0.1)";
  if (score >= 60) return "rgba(234, 179, 8, 0.2)";
  if (score >= 40) return "rgba(234, 179, 8, 0.3)";
  return "rgba(239, 68, 68, 0.25)";
}

function issueColorToCss(color: string): string {
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
