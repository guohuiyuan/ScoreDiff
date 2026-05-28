"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { type DiffReport, type PitchComparisonChart as PitchComparisonChartData } from "@/lib/api";

interface DiffViewerProps {
  diffReport: DiffReport | null;
  onClose?: () => void;
}

export function DiffViewer({ diffReport, onClose }: DiffViewerProps) {
  if (!diffReport) return null;

  const { summary, issues, measure_scores, weak_measures, color_map, segment, pitch_chart } = diffReport;

  const sortedMeasures = Object.entries(measure_scores)
    .map(([m, score]) => ({ measure: parseInt(m), score }))
    .sort((a, b) => a.measure - b.measure);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/80 p-3 backdrop-blur-sm sm:p-6">
      <div className="flex min-h-full items-start justify-center">
        <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg sm:max-h-[calc(100vh-3rem)]">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border p-4">
            <h2 className="text-lg font-semibold">差异详情</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-xl leading-none text-muted-foreground hover:text-foreground"
            >
              &times;
            </button>
          </div>

          <ScrollArea className="min-h-0 flex-1 touch-pan-y">
            <div className="border-b border-border p-4">
              <div className="grid grid-cols-5 gap-3 text-center">
                <ScoreCard label="总分" value={summary.total_score} />
                <ScoreCard label="音准" value={summary.pitch_score} />
                <ScoreCard label="节奏" value={summary.rhythm_score} />
                <ScoreCard label="完整度" value={summary.completeness_score} />
                <ScoreCard label="稳定性" value={summary.stability_score} />
              </div>
            </div>

            {segment && (
              <div className="border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">本次对比片段</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatTime(segment.start)} - {formatTime(segment.end)} · {segment.note_count} 个音符
                    {segment.bpm ? ` · ${Math.round(segment.bpm)} BPM` : ""}
                  </span>
                </div>
              </div>
            )}

            {pitch_chart && (
              <div className="border-b border-border p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium">音高走势对比</h3>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <LegendItem color="#2563eb" label="参考" />
                    <LegendItem color="#dc2626" label="实测" />
                  </div>
                </div>
                <PitchComparisonChart chart={pitch_chart} />
              </div>
            )}

            <div className="border-b border-border p-4">
              <h3 className="mb-2 text-sm font-medium">小节得分热力图</h3>
              <div className="flex flex-wrap gap-1">
                {sortedMeasures.map(({ measure, score }) => (
                  <div
                    key={measure}
                    className="flex h-8 w-8 items-center justify-center rounded font-mono text-[10px]"
                    style={{ backgroundColor: scoreToColor(score) }}
                    title={`第${measure}小节: ${score}分`}
                  >
                    {measure}
                  </div>
                ))}
              </div>
              {weak_measures.length > 0 && (
                <p className="mt-2 text-xs text-destructive">
                  需要重点练习: 第 {weak_measures.join(", ")} 小节
                </p>
              )}
            </div>

            <div className="border-b border-border p-4">
              <h3 className="mb-2 text-sm font-medium">
                问题详情 ({issues.length} 个)
              </h3>
              {issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">演奏完美，没有发现问题</p>
              ) : (
                <div className="space-y-2">
                  {issues.map((issue, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 rounded border border-border p-2"
                    >
                      <div
                        className="w-1 flex-shrink-0 self-stretch rounded-full"
                        style={{ backgroundColor: issueColorToCss(issue.color) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={issue.severity === "error" ? "destructive" : "secondary"}
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {issue.severity === "error" ? "错误" : "警告"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            第{issue.measure}小节 · 第{issue.beat}拍
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                          {issue.feedback}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4">
              <h3 className="mb-2 text-sm font-medium">音符着色图例</h3>
              <div className="flex flex-wrap gap-3 text-xs">
                <LegendItem color="#22c55e" label="正确" />
                <LegendItem color="#eab308" label="可接受/偏差" />
                <LegendItem color="#ef4444" label="错音" />
                <LegendItem color="#3b82f6" label="提前" />
                <LegendItem color="#a855f7" label="延后" />
                <LegendItem color="#6b7280" label="缺失" />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                共 {Object.keys(color_map).length} 个音符组已着色
              </p>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function PitchComparisonChart({ chart }: { chart: PitchComparisonChartData }) {
  const width = 640;
  const height = 220;
  const margin = { top: 12, right: 12, bottom: 28, left: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const duration = Math.max(0.1, chart.segment.duration);
  const minMidi = chart.pitch_range.min_midi;
  const maxMidi = Math.max(minMidi + 1, chart.pitch_range.max_midi);
  const ticks = buildPitchTicks(minMidi, maxMidi);

  const x = (time: number) => margin.left + (Math.max(0, Math.min(time, duration)) / duration) * plotWidth;
  const y = (midi: number) => margin.top + ((maxMidi - midi) / (maxMidi - minMidi)) * plotHeight;
  const detectedPoints = chart.detected
    .map((point) => `${x(point.time).toFixed(1)},${y(point.midi).toFixed(1)}`)
    .join(" ");

  return (
    <div className="relative h-56 w-full overflow-hidden rounded-md border border-border bg-muted/20">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="参考音高和实测音高曲线">
        <rect x={0} y={0} width={width} height={height} fill="transparent" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={margin.left}
              y1={y(tick)}
              x2={width - margin.right}
              y2={y(tick)}
              stroke="hsl(var(--border))"
              strokeWidth="1"
            />
            <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {midiToNoteLabel(tick)}
            </text>
          </g>
        ))}

        {chart.reference.map((point, index) => {
          if (index % 2 !== 0) return null;
          const next = chart.reference[index + 1];
          if (!next) return null;
          return (
            <line
              key={`${point.time}-${index}`}
              x1={x(point.time)}
              y1={y(point.midi)}
              x2={x(next.time)}
              y2={y(next.midi)}
              stroke="#2563eb"
              strokeWidth="3"
              strokeLinecap="round"
            />
          );
        })}

        {detectedPoints && (
          <polyline
            points={detectedPoints}
            fill="none"
            stroke="#dc2626"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.9"
          />
        )}

        <line
          x1={margin.left}
          y1={height - margin.bottom}
          x2={width - margin.right}
          y2={height - margin.bottom}
          stroke="hsl(var(--border))"
        />
        {[0, duration / 2, duration].map((time) => (
          <text
            key={time}
            x={x(time)}
            y={height - 8}
            textAnchor={time === 0 ? "start" : time === duration ? "end" : "middle"}
            className="fill-muted-foreground text-[10px]"
          >
            {formatTime(time)}
          </text>
        ))}
      </svg>
      {!detectedPoints && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          没有检测到可用实测音高
        </div>
      )}
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

function buildPitchTicks(minMidi: number, maxMidi: number): number[] {
  const min = Math.floor(minMidi);
  const max = Math.ceil(maxMidi);
  const span = Math.max(1, max - min);
  const step = span > 18 ? 6 : span > 9 ? 3 : 2;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push(value);
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function midiToNoteLabel(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const rounded = Math.round(midi);
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
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
