"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, MousePointer2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fileUrl,
  updateScore,
  type NoteGroup,
  type ScoreData,
} from "@/lib/api";

interface ScoreViewerProps {
  projectId?: string | null;
  musicxmlUrl?: string | null;
  noteGroups?: NoteGroup[];
  currentTime?: number;
  colorMap?: Record<string, string>;
  onScoreSaved?: (score: ScoreData) => void;
}

type ViewMode = "edit" | "print";
type OsmdNote = {
  sourceNote?: {
    noteheadColor?: string;
    stemColor?: string;
  };
};
type OsmdVoiceEntry = {
  notes: OsmdNote[];
};
type OsmdIterator = {
  endReached: boolean;
  currentVoiceEntries: OsmdVoiceEntry[];
  reset: () => void;
  moveToNext: () => void;
};
type OsmdInstance = {
  clear?: () => void;
  load: (url: string) => Promise<unknown>;
  render: () => void;
  cursor?: {
    iterator?: OsmdIterator;
  };
};

const BEAT_SECONDS = 0.5;
const STAFF_TOP = 58;
const STAFF_GAP = 12;
const MEASURES_PER_SYSTEM = 4;
const SYSTEM_HEIGHT = 172;
const MEASURE_WIDTH = 188;
const LEFT_PAD = 56;
const RIGHT_PAD = 40;
const NOTE_STEP = 3.4;

const DURATIONS = [
  { label: "16分", seconds: 0.125 },
  { label: "8分", seconds: 0.25 },
  { label: "4分", seconds: 0.5 },
  { label: "2分", seconds: 1 },
  { label: "全音", seconds: 2 },
];

export function ScoreViewer({
  projectId,
  musicxmlUrl,
  noteGroups = [],
  currentTime = 0,
  colorMap,
  onScoreSaved,
}: ScoreViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OsmdInstance | null>(null);
  const dragRef = useRef<{ index: number; startY: number; startPitch: number } | null>(null);
  const [mode, setMode] = useState<ViewMode>("edit");
  const [draft, setDraft] = useState<NoteGroup[]>(noteGroups);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(noteGroups.length ? 0 : null);
  const [loadingPrint, setLoadingPrint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "print" || !musicxmlUrl || !containerRef.current) return;

    let cancelled = false;

    async function loadScore() {
      setLoadingPrint(true);
      setError(null);

      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (cancelled) return;

        osmdRef.current?.clear?.();
        const osmd = new OpenSheetMusicDisplay(containerRef.current!, {
          autoResize: true,
          drawTitle: true,
          drawComposer: true,
          drawPartNames: true,
          drawMeasureNumbers: true,
          drawingParameters: "default",
        }) as unknown as OsmdInstance;

        osmdRef.current = osmd;
        const url = fileUrl(musicxmlUrl);
        if (!url) return;
        await osmd.load(url);
        if (cancelled) return;

        osmd.render();
        if (colorMap) applyColorMap(osmd, colorMap);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "谱面加载失败");
      } finally {
        if (!cancelled) setLoadingPrint(false);
      }
    }

    loadScore();

    return () => {
      cancelled = true;
    };
  }, [mode, musicxmlUrl, colorMap]);

  const measures = useMemo(() => {
    const nums = Array.from(new Set(draft.map((g) => g.measure || 1))).sort((a, b) => a - b);
    return nums.length ? nums : [1];
  }, [draft]);
  const systemCount = Math.max(1, Math.ceil(measures.length / MEASURES_PER_SYSTEM));
  const activeIndex = useMemo(() => {
    if (!draft.length) return -1;
    return draft.findIndex((group) => currentTime >= group.start && currentTime < group.end);
  }, [currentTime, draft]);

  const selected = selectedIndex !== null ? draft[selectedIndex] : null;
  const visibleColumns = Math.min(MEASURES_PER_SYSTEM, Math.max(1, measures.length));
  const svgWidth = Math.max(820, LEFT_PAD + visibleColumns * MEASURE_WIDTH + RIGHT_PAD);
  const svgHeight = systemCount * SYSTEM_HEIGHT + 24;
  const activePoint = activeIndex >= 0 ? notePoint(draft[activeIndex], measures) : null;

  function markDraft(next: NoteGroup[]) {
    setDraft(next);
    setDirty(true);
  }

  function updateGroup(index: number, patch: Partial<NoteGroup>) {
    markDraft(draft.map((group, i) => (i === index ? normalizeClientGroup({ ...group, ...patch }) : group)));
  }

  function updateSelected(patch: Partial<NoteGroup>) {
    if (selectedIndex === null) return;
    updateGroup(selectedIndex, patch);
  }

  function updatePitch(index: number, midi: number) {
    const safeMidi = Math.max(21, Math.min(108, midi));
    updateGroup(index, {
      target_pitches: [safeMidi],
      target_names: [midiToName(safeMidi)],
      type: "single_note",
    });
  }

  function shiftSelectedPitch(delta: number) {
    if (selectedIndex === null) return;
    const current = draft[selectedIndex]?.target_pitches[0] ?? 69;
    updatePitch(selectedIndex, current + delta);
  }

  function setSelectedDuration(seconds: number) {
    if (!selected) return;
    updateSelected({ end: Number((selected.start + seconds).toFixed(4)) });
  }

  function setSelectedMeasureBeat(measure: number, beat: number) {
    if (!selected) return;
    const duration = Math.max(0.125, selected.end - selected.start);
    const start = ((Math.max(1, measure) - 1) * 4 + (Math.max(1, beat) - 1)) * BEAT_SECONDS;
    updateSelected({
      measure: Math.max(1, measure),
      beat: Math.max(1, beat),
      start: Number(start.toFixed(4)),
      end: Number((start + duration).toFixed(4)),
    });
  }

  function addNote() {
    const last = draft[draft.length - 1];
    const start = last ? last.end : 0;
    const measure = Math.floor(start / (BEAT_SECONDS * 4)) + 1;
    const beat = (start / BEAT_SECONDS) % 4 + 1;
    const note: NoteGroup = normalizeClientGroup({
      note_group_id: `draft_${Date.now()}`,
      measure,
      beat,
      start,
      end: start + BEAT_SECONDS,
      target_pitches: [last?.target_pitches[0] ?? 69],
      target_names: [midiToName(last?.target_pitches[0] ?? 69)],
      type: "single_note",
    });
    markDraft([...draft, note]);
    setSelectedIndex(draft.length);
  }

  function deleteSelected() {
    if (selectedIndex === null) return;
    const next = draft.filter((_, i) => i !== selectedIndex);
    markDraft(next);
    setSelectedIndex(next.length ? Math.min(selectedIndex, next.length - 1) : null);
  }

  async function save() {
    if (!projectId || !draft.length) return;
    setSaving(true);
    setError(null);
    try {
      const score = await updateScore(projectId, draft);
      setDraft(score.note_groups);
      setDirty(false);
      onScoreSaved?.(score);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function handlePointerDown(event: React.PointerEvent<SVGGElement>, index: number) {
    const pitch = draft[index]?.target_pitches[0] ?? 69;
    dragRef.current = { index, startY: event.clientY, startPitch: pitch };
    setSelectedIndex(index);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const semitoneDelta = Math.round((drag.startY - event.clientY) / 7);
    updatePitch(drag.index, drag.startPitch + semitoneDelta);
  }

  function handlePointerUp(event: React.PointerEvent<SVGGElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!projectId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-muted/30">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">谱面工作区</p>
          <p className="text-sm mt-1">选择项目后可上传 PDF、MusicXML、MIDI 或 MP3</p>
        </div>
      </div>
    );
  }

  if (!draft.length && !musicxmlUrl) {
    return (
      <div className="flex-1 flex items-center justify-center bg-muted/30">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">暂无电子谱</p>
          <p className="text-sm mt-1">上传乐谱后会自动生成可编辑五线谱</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background">
      <div className="h-12 border-b border-border px-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted/50 p-0.5">
            <button
              type="button"
              aria-pressed={mode === "edit"}
              className={`h-7 px-3 rounded-sm text-xs transition-colors ${
                mode === "edit" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("edit")}
            >
              编辑谱
            </button>
            <button
              type="button"
              aria-pressed={mode === "print"}
              className={`h-7 px-3 rounded-sm text-xs transition-colors ${
                mode === "print" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("print")}
            >
              印刷谱
            </button>
          </div>
          {mode === "edit" && (
            <span className="hidden md:inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MousePointer2 className="size-3" />
              点选音符，纵向拖动改音高，播放时会跟随高亮
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700">有未保存修改</span>}
          <Button variant="ghost" size="sm" onClick={addNote} disabled={mode !== "edit"}>
            <Plus />
            添加
          </Button>
          <Button variant="ghost" size="sm" onClick={deleteSelected} disabled={mode !== "edit" || selectedIndex === null}>
            <Trash2 />
            删除
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving || !draft.length}>
            <Save />
            {saving ? "保存中" : "保存"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {mode === "print" ? (
        <div className="flex-1 min-h-0 overflow-auto">
          {loadingPrint && (
            <div className="p-3 text-sm text-muted-foreground text-center">加载谱面中...</div>
          )}
          <div ref={containerRef} className="min-h-full p-4" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-auto bg-muted/20">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="block min-h-full bg-white"
              role="img"
              aria-label="可编辑五线谱"
            >
              <rect x="0" y="0" width={svgWidth} height={svgHeight} fill="#ffffff" />
              {Array.from({ length: systemCount }).map((_, systemIndex) => {
                const rowMeasures = measures.slice(
                  systemIndex * MEASURES_PER_SYSTEM,
                  systemIndex * MEASURES_PER_SYSTEM + MEASURES_PER_SYSTEM,
                );
                const yTop = systemTop(systemIndex);
                const yBottom = systemBottom(systemIndex);
                const rowRight = LEFT_PAD + rowMeasures.length * MEASURE_WIDTH;
                return (
                  <g key={systemIndex}>
                    {Array.from({ length: 5 }).map((_, line) => (
                      <line
                        key={line}
                        x1={LEFT_PAD}
                        x2={rowRight}
                        y1={yTop + line * STAFF_GAP}
                        y2={yTop + line * STAFF_GAP}
                        stroke="#111827"
                        strokeWidth="1"
                      />
                    ))}
                    {rowMeasures.map((measure, columnIndex) => {
                      const x = LEFT_PAD + columnIndex * MEASURE_WIDTH;
                      return (
                        <g key={measure}>
                          <line x1={x} x2={x} y1={yTop} y2={yBottom} stroke="#111827" strokeWidth="1.5" />
                          <text x={x + 8} y={yTop - 18} fontSize="12" fill="#6b7280">
                            {measure}
                          </text>
                        </g>
                      );
                    })}
                    <line x1={rowRight} x2={rowRight} y1={yTop} y2={yBottom} stroke="#111827" strokeWidth="2" />
                  </g>
                );
              })}
              {activePoint && (
                <line
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={activePoint.staffTop - 14}
                  y2={activePoint.staffBottom + 50}
                  stroke="#0f766e"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                />
              )}

              {draft.map((group, index) => {
                const point = notePoint(group, measures);
                const selectedNote = index === selectedIndex;
                const activeNote = index === activeIndex;
                const color = colorToCss(colorMap?.[group.note_group_id] || (selectedNote ? "blue" : "black"));
                const isRest = group.type === "rest" || group.target_pitches.length === 0;
                return (
                  <g
                    key={`${group.note_group_id}-${index}`}
                    className="cursor-ns-resize outline-none"
                    tabIndex={0}
                    onPointerDown={(event) => handlePointerDown(event, index)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onFocus={() => setSelectedIndex(index)}
                  >
                    {activeNote && (
                      <circle cx={point.x} cy={point.y} r="21" fill="#ccfbf1" stroke="#0f766e" strokeWidth="2" />
                    )}
                    {selectedNote && (
                      <circle cx={point.x} cy={point.y} r="17" fill="#dbeafe" stroke="#2563eb" strokeWidth="1.5" />
                    )}
                    {ledgerLines(group, point).map((lineY) => (
                      <line
                        key={lineY}
                        x1={point.x - 15}
                        x2={point.x + 15}
                        y1={lineY}
                        y2={lineY}
                        stroke="#111827"
                        strokeWidth="1"
                      />
                    ))}
                    {isRest ? (
                      <rect x={point.x - 8} y={point.staffTop + STAFF_GAP * 1.5} width="16" height="8" fill={color} rx="1" />
                    ) : (
                      <>
                        <ellipse
                          cx={point.x}
                          cy={point.y}
                          rx="10"
                          ry="7"
                          transform={`rotate(-18 ${point.x} ${point.y})`}
                          fill={color}
                        />
                        <line x1={point.x + 8} x2={point.x + 8} y1={point.y} y2={point.y - 42} stroke={color} strokeWidth="2" />
                        <text x={point.x - 12} y={point.staffBottom + 34} fontSize="11" fill="#374151">
                          {group.target_names.join("/")}
                        </text>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="w-72 border-l border-border bg-background p-3 space-y-3 overflow-auto">
            <div>
              <h3 className="text-sm font-semibold">音符属性</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                修改后会重建 MusicXML 和 MIDI
              </p>
            </div>

            {selected ? (
              <>
                <label className="block text-xs font-medium text-muted-foreground">
                  音高
                  <div className="mt-1 flex items-center gap-2">
                    <Button variant="outline" size="icon-sm" onClick={() => shiftSelectedPitch(-1)}>
                      <Minus />
                    </Button>
                    <input
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      type="number"
                      min={21}
                      max={108}
                      value={selected.target_pitches[0] ?? 69}
                      onChange={(event) => selectedIndex !== null && updatePitch(selectedIndex, Number(event.target.value))}
                    />
                    <Button variant="outline" size="icon-sm" onClick={() => shiftSelectedPitch(1)}>
                      <Plus />
                    </Button>
                  </div>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    小节
                    <input
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      type="number"
                      min={1}
                      value={selected.measure}
                      onChange={(event) => setSelectedMeasureBeat(Number(event.target.value), selected.beat)}
                    />
                  </label>
                  <label className="text-xs font-medium text-muted-foreground">
                    拍
                    <input
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      type="number"
                      min={1}
                      step={0.25}
                      value={selected.beat}
                      onChange={(event) => setSelectedMeasureBeat(selected.measure, Number(event.target.value))}
                    />
                  </label>
                </div>

                <label className="block text-xs font-medium text-muted-foreground">
                  时值
                  <select
                    className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={closestDuration(selected.end - selected.start)}
                    onChange={(event) => setSelectedDuration(Number(event.target.value))}
                  >
                    {DURATIONS.map((duration) => (
                      <option key={duration.seconds} value={duration.seconds}>
                        {duration.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
                  当前: {selected.target_names.join(", ") || "休止符"}，第 {selected.measure} 小节第 {selected.beat} 拍
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">点选谱面上的音符开始编辑</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function notePoint(group: NoteGroup, measures: number[]) {
  const measureIndex = Math.max(0, measures.indexOf(group.measure));
  const systemIndex = Math.floor(measureIndex / MEASURES_PER_SYSTEM);
  const columnIndex = measureIndex % MEASURES_PER_SYSTEM;
  const measureStart = LEFT_PAD + columnIndex * MEASURE_WIDTH;
  const beatRatio = Math.max(0, Math.min(1, ((group.beat || 1) - 1) / 4));
  const x = measureStart + 28 + beatRatio * (MEASURE_WIDTH - 46);
  const staffTop = systemTop(systemIndex);
  const staffBottom = systemBottom(systemIndex);
  const pitch = group.target_pitches[0] ?? 71;
  const y = staffBottom - (pitch - 64) * NOTE_STEP;
  return {
    x,
    y: Math.max(staffTop - 52, Math.min(staffBottom + 64, y)),
    staffTop,
    staffBottom,
  };
}

function systemTop(systemIndex: number) {
  return STAFF_TOP + systemIndex * SYSTEM_HEIGHT;
}

function systemBottom(systemIndex: number) {
  return systemTop(systemIndex) + STAFF_GAP * 4;
}

function ledgerLines(group: NoteGroup, point: { x: number; y: number; staffTop: number; staffBottom: number }) {
  if (group.type === "rest" || !group.target_pitches.length) return [];
  const lines: number[] = [];
  if (point.y < point.staffTop) {
    for (let y = point.staffTop - STAFF_GAP; y >= point.y - 2; y -= STAFF_GAP) lines.push(y);
  }
  if (point.y > point.staffBottom) {
    for (let y = point.staffBottom + STAFF_GAP; y <= point.y + 2; y += STAFF_GAP) lines.push(y);
  }
  return lines;
}

function normalizeClientGroup(group: NoteGroup): NoteGroup {
  const measure = Math.max(1, Number(group.measure) || 1);
  const beat = Math.max(1, Number(group.beat) || 1);
  const start = Number(group.start) || ((measure - 1) * 4 + (beat - 1)) * BEAT_SECONDS;
  const end = Number(group.end) > start ? Number(group.end) : start + BEAT_SECONDS;
  const pitches = (group.target_pitches || []).map((p) => Math.max(21, Math.min(108, Number(p) || 69)));
  const names = pitches.length ? pitches.map(midiToName) : [];
  const type = pitches.length === 0 ? "rest" : pitches.length === 1 ? "single_note" : pitches.length === 2 ? "double_stop" : "chord";
  return {
    ...group,
    measure,
    beat,
    start: Number(start.toFixed(4)),
    end: Number(end.toFixed(4)),
    target_pitches: pitches,
    target_names: names,
    type,
  };
}

function midiToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[pitchClass]}${octave}`;
}

function closestDuration(seconds: number): number {
  return DURATIONS.reduce((best, current) => (
    Math.abs(current.seconds - seconds) < Math.abs(best.seconds - seconds) ? current : best
  )).seconds;
}

function applyColorMap(osmd: OsmdInstance, colorMap: Record<string, string>) {
  try {
    const iterator = osmd.cursor?.iterator;
    if (!iterator) return;

    iterator.reset();
    let idx = 0;
    while (!iterator.endReached) {
      const voices = iterator.currentVoiceEntries;
      for (const voice of voices) {
        for (const osmdNote of voice.notes) {
          const ngId = `ng_${String(idx).padStart(3, "0")}`;
          const color = colorMap[ngId];
          if (color && osmdNote.sourceNote?.noteheadColor !== undefined) {
            const cssColor = colorToCss(color);
            osmdNote.sourceNote.noteheadColor = cssColor;
            osmdNote.sourceNote.stemColor = cssColor;
          }
        }
      }
      iterator.moveToNext();
      idx++;
    }
    osmd.render();
  } catch {
    // Color overlay is best-effort.
  }
}

function colorToCss(color: string): string {
  const map: Record<string, string> = {
    black: "#111827",
    green: "#16a34a",
    yellow: "#ca8a04",
    red: "#dc2626",
    blue: "#2563eb",
    purple: "#9333ea",
    orange: "#ea580c",
    gray: "#6b7280",
  };
  return map[color] || color;
}
