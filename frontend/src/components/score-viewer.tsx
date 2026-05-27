"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Edit3, Minus, MousePointer2, Plus, Save, Trash2 } from "lucide-react";
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
type EditMode = "select" | "note-input";
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

const BEATS_PER_MEASURE = 4;
const BEAT_SECONDS = 0.5;
const STAFF_TOP = 76;
const STAFF_GAP = 15;
const MEASURES_PER_SYSTEM = 3;
const SYSTEM_HEIGHT = 238;
const MEASURE_WIDTH = 270;
const LEFT_PAD = 72;
const RIGHT_PAD = 64;
const NOTE_STEP = 4.35;

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
  const draftIdRef = useRef(0);
  const [mode, setMode] = useState<ViewMode>("edit");
  const [editMode, setEditMode] = useState<EditMode>("select");
  const [inputDuration, setInputDuration] = useState(BEAT_SECONDS);
  const [draft, setDraft] = useState<NoteGroup[]>(() => sortGroups(noteGroups.map(normalizeClientGroup)));
  const [selectedIndex, setSelectedIndex] = useState<number | null>(draft.length ? 0 : null);
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
  const svgWidth = Math.max(900, LEFT_PAD + visibleColumns * MEASURE_WIDTH + RIGHT_PAD);
  const svgHeight = systemCount * SYSTEM_HEIGHT + 32;
  const activePoint = activeIndex >= 0 ? notePoint(draft[activeIndex], measures) : null;

  function markDraft(next: NoteGroup[], nextSelectedId?: string | null) {
    const sorted = sortGroups(next.map(normalizeClientGroup));
    setDraft(sorted);
    if (nextSelectedId !== undefined) {
      const nextIndex = nextSelectedId ? sorted.findIndex((group) => group.note_group_id === nextSelectedId) : -1;
      setSelectedIndex(nextIndex >= 0 ? nextIndex : sorted.length ? 0 : null);
    }
    setDirty(true);
  }

  function updateGroup(index: number, patch: Partial<NoteGroup>) {
    const current = draft[index];
    if (!current) return;
    const updated = normalizeClientGroup({ ...current, ...patch });
    markDraft(draft.map((group, i) => (i === index ? updated : group)), updated.note_group_id);
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
    updateSelected({ end: noteEndFor(selected.measure, selected.start, seconds) });
  }

  function setSelectedMeasureBeat(measure: number, beat: number) {
    if (!selected) return;
    const safeMeasure = Math.max(1, Math.round(measure) || 1);
    const safeBeat = clampBeat(beat);
    const duration = noteDuration(selected);
    const start = startForPosition(safeMeasure, safeBeat);
    updateSelected({
      measure: safeMeasure,
      beat: safeBeat,
      start,
      end: noteEndFor(safeMeasure, start, duration),
    });
  }

  function addNote() {
    const anchor = selectedIndex !== null ? draft[selectedIndex] : draft[draft.length - 1];
    const start = anchor ? anchor.end : 0;
    const position = positionFromStart(start);
    const pitch = anchor?.target_pitches[0] ?? 69;
    const note: NoteGroup = normalizeClientGroup({
      note_group_id: nextDraftId(),
      measure: position.measure,
      beat: position.beat,
      start,
      end: noteEndFor(position.measure, startForPosition(position.measure, position.beat), inputDuration),
      target_pitches: [pitch],
      target_names: [midiToName(pitch)],
      type: "single_note",
    });
    insertDraftNote(note);
  }

  function deleteSelected() {
    if (selectedIndex === null) return;
    const next = draft.filter((_, i) => i !== selectedIndex);
    markDraft(next, next.length ? next[Math.min(selectedIndex, next.length - 1)].note_group_id : null);
  }

  function insertDraftNote(note: NoteGroup) {
    const normalized = normalizeClientGroup(note);
    markDraft([...draft, normalized], normalized.note_group_id);
  }

  function handleStaffPointerDown(event: ReactPointerEvent<SVGRectElement>, systemIndex: number) {
    if (editMode !== "note-input") return;
    event.preventDefault();
    event.stopPropagation();

    const point = svgPoint(event);
    const columnIndex = Math.max(0, Math.min(MEASURES_PER_SYSTEM - 1, Math.floor((point.x - LEFT_PAD) / MEASURE_WIDTH)));
    const measure = measures[systemIndex * MEASURES_PER_SYSTEM + columnIndex] ?? systemIndex * MEASURES_PER_SYSTEM + columnIndex + 1;
    const measureStart = LEFT_PAD + columnIndex * MEASURE_WIDTH;
    const beatRatio = Math.max(0, Math.min(1, (point.x - measureStart - 32) / (MEASURE_WIDTH - 58)));
    const beat = clampBeat(Math.round((beatRatio * BEATS_PER_MEASURE + 1) * 4) / 4);
    const staffBottom = systemBottom(systemIndex);
    const midi = Math.max(21, Math.min(108, Math.round(64 + (staffBottom - point.y) / NOTE_STEP)));
    const start = startForPosition(measure, beat);

    insertDraftNote({
      note_group_id: nextDraftId(),
      measure,
      beat,
      start,
      end: noteEndFor(measure, start, inputDuration),
      target_pitches: [midi],
      target_names: [midiToName(midi)],
      type: "single_note",
    });
  }

  async function save() {
    if (!projectId || !draft.length) return;
    setSaving(true);
    setError(null);
    try {
      const score = await updateScore(projectId, draft);
      setDraft(sortGroups(score.note_groups.map(normalizeClientGroup)));
      setDirty(false);
      onScoreSaved?.(score);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<SVGGElement>, index: number) {
    event.stopPropagation();
    if (editMode !== "select") {
      setSelectedIndex(index);
      return;
    }
    const pitch = draft[index]?.target_pitches[0] ?? 69;
    dragRef.current = { index, startY: event.clientY, startPitch: pitch };
    setSelectedIndex(index);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function nextDraftId() {
    draftIdRef.current += 1;
    return `draft_${draftIdRef.current}`;
  }

  function handlePointerMove(event: ReactPointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    if (!drag || editMode !== "select") return;
    const semitoneDelta = Math.round((drag.startY - event.clientY) / 7);
    updatePitch(drag.index, drag.startPitch + semitoneDelta);
  }

  function handlePointerUp(event: ReactPointerEvent<SVGGElement>) {
    if (dragRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setEditMode((current) => (current === "note-input" ? "select" : "note-input"));
      } else if (event.key === "Escape") {
        setEditMode("select");
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        shiftSelectedPitch(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        shiftSelectedPitch(-1);
      } else if (/^[1-5]$/.test(event.key)) {
        setInputDuration(DURATIONS[Number(event.key) - 1].seconds);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

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
      <div className="min-h-12 border-b border-border px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
              排版谱
            </button>
          </div>
          {mode === "edit" && (
            <div className="inline-flex rounded-md border border-border bg-background p-0.5">
              <button
                type="button"
                className={`h-7 px-2.5 rounded-sm text-xs ${editMode === "select" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setEditMode("select")}
              >
                <MousePointer2 className="mr-1 inline size-3" />
                选择
              </button>
              <button
                type="button"
                className={`h-7 px-2.5 rounded-sm text-xs ${editMode === "note-input" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setEditMode("note-input")}
              >
                <Edit3 className="mr-1 inline size-3" />
                输入
              </button>
            </div>
          )}
          {mode === "edit" && (
            <div className="hidden md:flex items-center gap-1">
              {DURATIONS.map((duration, index) => (
                <button
                  key={duration.seconds}
                  type="button"
                  className={`h-7 min-w-11 rounded-md border px-2 text-xs ${
                    inputDuration === duration.seconds
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setInputDuration(duration.seconds)}
                >
                  {index + 1}:{duration.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700">未保存</span>}
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
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-w-0 overflow-auto bg-muted/20">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="block min-h-full bg-white"
              style={{ cursor: editMode === "note-input" ? "crosshair" : "default" }}
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
                    <rect
                      x={LEFT_PAD}
                      y={yTop - 42}
                      width={Math.max(1, rowMeasures.length) * MEASURE_WIDTH}
                      height={STAFF_GAP * 4 + 108}
                      fill="transparent"
                      onPointerDown={(event) => handleStaffPointerDown(event, systemIndex)}
                    />
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
                          <text x={x + 8} y={yTop - 20} fontSize="12" fill="#6b7280">
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
                  y1={activePoint.staffTop - 18}
                  y2={activePoint.staffBottom + 58}
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
                const durationWidth = Math.max(10, (noteDuration(group) / (BEATS_PER_MEASURE * BEAT_SECONDS)) * (MEASURE_WIDTH - 58));
                return (
                  <g
                    key={`${group.note_group_id}-${index}`}
                    className={`${editMode === "select" ? "cursor-ns-resize" : "cursor-pointer"} outline-none`}
                    tabIndex={0}
                    onPointerDown={(event) => handlePointerDown(event, index)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onFocus={() => setSelectedIndex(index)}
                  >
                    <line
                      x1={point.x}
                      x2={Math.min(point.measureRight - 10, point.x + durationWidth)}
                      y1={point.staffBottom + 24}
                      y2={point.staffBottom + 24}
                      stroke={selectedNote ? "#93c5fd" : "#d1d5db"}
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    {activeNote && (
                      <circle cx={point.x} cy={point.y} r="22" fill="#ccfbf1" stroke="#0f766e" strokeWidth="2" />
                    )}
                    {selectedNote && (
                      <circle cx={point.x} cy={point.y} r="18" fill="#dbeafe" stroke="#2563eb" strokeWidth="1.5" />
                    )}
                    {ledgerLines(group, point).map((lineY) => (
                      <line
                        key={lineY}
                        x1={point.x - 16}
                        x2={point.x + 16}
                        y1={lineY}
                        y2={lineY}
                        stroke="#111827"
                        strokeWidth="1"
                      />
                    ))}
                    {isRest ? (
                      <rect x={point.x - 8} y={point.staffTop + STAFF_GAP * 1.5} width="16" height="8" fill={color} rx="1" />
                    ) : (
                      <NoteGlyph x={point.x} y={point.y} color={color} duration={noteDuration(group)} />
                    )}
                    <text x={point.x - 16} y={point.staffBottom + 42} fontSize="11" fill="#374151">
                      {isRest ? "休止" : group.target_names.join("/")}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="border-t border-border bg-background px-3 py-2">
            <div className="grid gap-2 xl:grid-cols-[auto_auto_1fr] xl:items-center">
              <div className="flex items-center gap-1">
                <Button
                  variant={editMode === "select" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditMode("select")}
                >
                  <MousePointer2 />
                  选择
                </Button>
                <Button
                  variant={editMode === "note-input" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEditMode("note-input")}
                >
                  <Edit3 />
                  输入
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {DURATIONS.map((duration, index) => (
                  <button
                    key={duration.seconds}
                    type="button"
                    className={`h-8 min-w-12 rounded-md border px-2 text-xs ${
                      inputDuration === duration.seconds
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setInputDuration(duration.seconds)}
                  >
                    {index + 1} {duration.label}
                  </button>
                ))}
              </div>

              {selected ? (
                <div className="grid gap-2 md:grid-cols-[minmax(150px,1fr)_90px_100px_110px] md:items-end">
                  <label className="text-xs font-medium text-muted-foreground">
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
                      max={4.75}
                      step={0.25}
                      value={selected.beat}
                      onChange={(event) => setSelectedMeasureBeat(selected.measure, Number(event.target.value))}
                    />
                  </label>
                  <label className="text-xs font-medium text-muted-foreground">
                    时值
                    <select
                      className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={closestDuration(noteDuration(selected))}
                      onChange={(event) => setSelectedDuration(Number(event.target.value))}
                    >
                      {DURATIONS.map((duration) => (
                        <option key={duration.seconds} value={duration.seconds}>
                          {duration.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">未选择音符</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NoteGlyph({ x, y, color, duration }: { x: number; y: number; color: string; duration: number }) {
  const beats = duration / BEAT_SECONDS;
  const whole = beats >= 3.5;
  const open = beats >= 1.5;
  const flags = beats <= 0.26 ? 2 : beats <= 0.55 ? 1 : 0;
  const stemTop = y - 42;

  return (
    <>
      <ellipse
        cx={x}
        cy={y}
        rx="10"
        ry="7"
        transform={`rotate(-18 ${x} ${y})`}
        fill={open ? "#ffffff" : color}
        stroke={color}
        strokeWidth={open ? 2 : 1}
      />
      {!whole && (
        <line x1={x + 8} x2={x + 8} y1={y} y2={stemTop} stroke={color} strokeWidth="2" />
      )}
      {flags >= 1 && (
        <path d={`M ${x + 8} ${stemTop} C ${x + 30} ${stemTop + 6}, ${x + 28} ${stemTop + 22}, ${x + 10} ${stemTop + 24}`} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      )}
      {flags >= 2 && (
        <path d={`M ${x + 8} ${stemTop + 10} C ${x + 28} ${stemTop + 16}, ${x + 26} ${stemTop + 30}, ${x + 10} ${stemTop + 32}`} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
      )}
    </>
  );
}

function notePoint(group: NoteGroup, measures: number[]) {
  const measureIndex = Math.max(0, measures.indexOf(group.measure));
  const systemIndex = Math.floor(measureIndex / MEASURES_PER_SYSTEM);
  const columnIndex = measureIndex % MEASURES_PER_SYSTEM;
  const measureStart = LEFT_PAD + columnIndex * MEASURE_WIDTH;
  const beatRatio = Math.max(0, Math.min(1, ((group.beat || 1) - 1) / BEATS_PER_MEASURE));
  const x = measureStart + 32 + beatRatio * (MEASURE_WIDTH - 58);
  const staffTop = systemTop(systemIndex);
  const staffBottom = systemBottom(systemIndex);
  const pitch = group.target_pitches[0] ?? 71;
  const y = staffBottom - (pitch - 64) * NOTE_STEP;
  return {
    x,
    y: Math.max(staffTop - 56, Math.min(staffBottom + 66, y)),
    staffTop,
    staffBottom,
    measureRight: measureStart + MEASURE_WIDTH,
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
  const measure = Math.max(1, Math.round(Number(group.measure) || 1));
  const beat = clampBeat(Number(group.beat) || 1);
  const start = startForPosition(measure, beat);
  const rawDuration = Math.max(0.125, Number(group.end) - Number(group.start) || BEAT_SECONDS);
  const end = noteEndFor(measure, start, rawDuration);
  const pitches = (group.target_pitches || []).map((p) => Math.max(21, Math.min(108, Number(p) || 69)));
  const names = pitches.length ? pitches.map(midiToName) : [];
  const type = pitches.length === 0 ? "rest" : pitches.length === 1 ? "single_note" : pitches.length === 2 ? "double_stop" : "chord";
  return {
    ...group,
    measure,
    beat,
    start,
    end,
    target_pitches: pitches,
    target_names: names,
    type,
  };
}

function sortGroups(groups: NoteGroup[]) {
  return [...groups].sort((a, b) => a.measure - b.measure || a.beat - b.beat || a.start - b.start);
}

function clampBeat(beat: number): number {
  return Math.max(1, Math.min(4.75, Math.round((Number(beat) || 1) * 4) / 4));
}

function startForPosition(measure: number, beat: number): number {
  return Number((((Math.max(1, measure) - 1) * BEATS_PER_MEASURE + (clampBeat(beat) - 1)) * BEAT_SECONDS).toFixed(4));
}

function noteEndFor(measure: number, start: number, duration: number): number {
  const measureEnd = ((Math.max(1, measure) - 1) * BEATS_PER_MEASURE + BEATS_PER_MEASURE) * BEAT_SECONDS;
  const safeDuration = Math.max(0.125, Number(duration) || BEAT_SECONDS);
  return Number(Math.min(start + safeDuration, measureEnd).toFixed(4));
}

function positionFromStart(start: number) {
  const safeStart = Math.max(0, Number(start) || 0);
  const absoluteBeat = safeStart / BEAT_SECONDS;
  const measure = Math.floor(absoluteBeat / BEATS_PER_MEASURE) + 1;
  const beat = clampBeat((absoluteBeat % BEATS_PER_MEASURE) + 1);
  return { measure, beat };
}

function noteDuration(group: NoteGroup): number {
  return Math.max(0.125, Number((group.end - group.start).toFixed(4)));
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

function svgPoint(event: ReactPointerEvent<SVGElement>) {
  const svg = event.currentTarget.ownerSVGElement;
  if (!svg) return { x: 0, y: 0 };
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  const width = viewBox.width || rect.width;
  const height = viewBox.height || rect.height;
  return {
    x: (event.clientX - rect.left) * (width / rect.width),
    y: (event.clientY - rect.top) * (height / rect.height),
  };
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
