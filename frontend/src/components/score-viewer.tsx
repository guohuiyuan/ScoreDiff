"use client";

import { useEffect, useRef, useState } from "react";
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
  onSeek?: (time: number) => void;
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
    show?: () => void;
    hide?: () => void;
    update?: () => void;
  };
};
type ScoreDisplayMetadata = {
  keyFifths: number;
  keyMode: string;
  timeSignature: string;
  tempo: number | null;
};

const BEATS_PER_MEASURE = 4;
const BEAT_SECONDS = 0.5;
const STAFF_TOP = 104;
const STAFF_GAP = 14;
const MEASURES_PER_SYSTEM = 3;
const SYSTEM_HEIGHT = 264;
const MEASURE_WIDTH = 306;
const LEFT_PAD = 190;
const RIGHT_PAD = 72;
const NOTE_STEP = 4.15;
const MEASURE_INSET = 46;
const STAFF_LINE_COLOR = "#111827";
const CLEF_X = LEFT_PAD - 148;
const KEY_SIGNATURE_X = LEFT_PAD - 104;
const TIME_SIGNATURE_X = LEFT_PAD - 24;
const DEFAULT_SCORE_METADATA: ScoreDisplayMetadata = {
  keyFifths: 0,
  keyMode: "major",
  timeSignature: "4/4",
  tempo: null,
};
const SHARP_KEY_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_KEY_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
const SHARP_KEY_MIDIS = [77, 72, 79, 74, 69, 76, 71];
const FLAT_KEY_MIDIS = [71, 76, 69, 74, 67, 72, 65];

const DURATIONS = [
  { label: "32分", seconds: 0.0625 },
  { label: "16分", seconds: 0.125 },
  { label: "8分三连", seconds: 1 / 6, modifiers: ["tuplet3"] },
  { label: "8分", seconds: 0.25 },
  { label: "附点8分", seconds: 0.375, modifiers: ["dotted"] },
  { label: "4分三连", seconds: 1 / 3, modifiers: ["tuplet3"] },
  { label: "4分", seconds: 0.5 },
  { label: "附点4分", seconds: 0.75, modifiers: ["dotted"] },
  { label: "2分", seconds: 1 },
  { label: "附点2分", seconds: 1.5, modifiers: ["dotted"] },
  { label: "全音", seconds: 2 },
];

const ADVANCED_MODIFIERS = [
  { key: "tuplet3", label: "三连音", mark: "3" },
  { key: "dotted", label: "附点", mark: "·" },
  { key: "grace", label: "倚音", mark: "小" },
  { key: "trill", label: "颤音", mark: "tr" },
  { key: "turn", label: "回音", mark: "𝆗" },
  { key: "fermata", label: "延长", mark: "𝄐" },
  { key: "cadenza", label: "华彩", mark: "自由" },
];

export function ScoreViewer({
  projectId,
  musicxmlUrl,
  noteGroups = [],
  currentTime = 0,
  colorMap,
  onSeek,
  onScoreSaved,
}: ScoreViewerProps) {
  const printScrollRef = useRef<HTMLDivElement>(null);
  const printContainerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OsmdInstance | null>(null);
  const dragRef = useRef<{ index: number; startY: number; startPitch: number } | null>(null);
  const draftIdRef = useRef(0);
  const lastPrintActiveIndexRef = useRef(-1);
  const [mode, setMode] = useState<ViewMode>("edit");
  const [editMode, setEditMode] = useState<EditMode>("select");
  const [inputDuration, setInputDuration] = useState(BEAT_SECONDS);
  const [draft, setDraft] = useState<NoteGroup[]>(() => sortGroups(noteGroups.map(normalizeClientGroup)));
  const [selectedIndex, setSelectedIndex] = useState<number | null>(draft.length ? 0 : null);
  const [printRevision, setPrintRevision] = useState(0);
  const [printReadyRevision, setPrintReadyRevision] = useState(0);
  const [loadingPrint, setLoadingPrint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scoreMetadata, setScoreMetadata] = useState<ScoreDisplayMetadata>(DEFAULT_SCORE_METADATA);
  const viewMode = musicxmlUrl ? mode : "edit";

  const measureNums = Array.from(new Set(draft.map((g) => g.measure || 1))).sort((a, b) => a - b);
  const measures = measureNums.length ? measureNums : [1];
  const systemCount = Math.max(1, Math.ceil(measures.length / MEASURES_PER_SYSTEM));
  const activeIndex = draft.findIndex((group) => currentTime >= group.start && currentTime < group.end);
  const activeGroup = activeIndex >= 0 ? draft[activeIndex] : null;

  const selected = selectedIndex !== null ? draft[selectedIndex] : null;
  const visibleColumns = Math.min(MEASURES_PER_SYSTEM, Math.max(1, measures.length));
  const svgWidth = Math.max(900, LEFT_PAD + visibleColumns * MEASURE_WIDTH + RIGHT_PAD);
  const svgHeight = systemCount * SYSTEM_HEIGHT + 32;
  const activePoint = activeIndex >= 0 ? notePoint(draft[activeIndex], measures) : null;
  const timeSignatureParts = splitTimeSignature(scoreMetadata.timeSignature);
  const keySignatureText = keySignatureLabel(scoreMetadata.keyFifths, scoreMetadata.keyMode);

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
    const current = draft[index];
    const modifiers = current ? noteModifiers(current.type) : new Set<string>();
    updateGroup(index, {
      target_pitches: [safeMidi],
      target_names: [midiToName(safeMidi)],
      type: composeNoteType("single_note", modifiers),
    });
  }

  function shiftSelectedPitch(delta: number) {
    if (selectedIndex === null) return;
    const current = draft[selectedIndex]?.target_pitches[0] ?? 69;
    updatePitch(selectedIndex, current + delta);
  }

  function setSelectedDuration(seconds: number) {
    if (!selected) return;
    const durationPreset = closestDurationPreset(seconds);
    const modifiers = noteModifiers(selected.type);
    modifiers.delete("dotted");
    modifiers.delete("tuplet3");
    durationPreset.modifiers?.forEach((modifier) => modifiers.add(modifier));
    updateSelected({
      end: noteEndFor(selected.measure, selected.start, seconds),
      type: composeNoteType(noteBaseType(selected.type), modifiers),
    });
  }

  function toggleSelectedModifier(modifier: string) {
    if (!selected) return;
    const modifiers = noteModifiers(selected.type);
    if (modifiers.has(modifier)) {
      modifiers.delete(modifier);
    } else {
      modifiers.add(modifier);
      if (modifier === "grace") modifiers.delete("cadenza");
      if (modifier === "cadenza") modifiers.delete("grace");
    }
    updateSelected({ type: composeNoteType(noteBaseType(selected.type), modifiers) });
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
      type: composeNoteType("single_note", inputModifiers(inputDuration)),
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
    const beatRatio = Math.max(0, Math.min(1, (point.x - measureStart - MEASURE_INSET) / (MEASURE_WIDTH - 82)));
    const beat = clampBeat(Math.round((beatRatio * BEATS_PER_MEASURE + 1) * 24) / 24);
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
      type: composeNoteType("single_note", inputModifiers(inputDuration)),
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
      setPrintRevision((current) => current + 1);
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

  function handlePrintPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draft.length) return;
    const index = nearestPrintIndex(event);
    const group = draft[index];
    if (!group) return;
    setEditMode("select");
    setSelectedIndex(index);
    onSeek?.(group.start);
    syncPrintCursor(index);
    scrollPrintToIndex(index, "smooth");
  }

  function nearestPrintIndex(event: ReactPointerEvent<HTMLDivElement>) {
    const scroller = printScrollRef.current;
    if (!scroller) return selectedIndex ?? 0;
    const rect = scroller.getBoundingClientRect();
    const y = event.clientY - rect.top + scroller.scrollTop;
    const x = event.clientX - rect.left + scroller.scrollLeft;
    const yRatio = Math.max(0, Math.min(1, y / Math.max(1, scroller.scrollHeight)));
    const xRatio = Math.max(0, Math.min(1, (x - 80) / Math.max(1, scroller.scrollWidth - 160)));
    const measure = measures[Math.min(measures.length - 1, Math.round(yRatio * (measures.length - 1)))] ?? 1;
    const beat = clampBeat(1 + xRatio * BEATS_PER_MEASURE);
    let bestIndex = selectedIndex ?? 0;
    let bestScore = Number.POSITIVE_INFINITY;
    draft.forEach((group, index) => {
      const score = Math.abs(group.measure - measure) * 8 + Math.abs(group.beat - beat);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function syncPrintCursor(index: number) {
    const cursor = osmdRef.current?.cursor;
    const iterator = cursor?.iterator;
    if (!cursor || !iterator || index < 0) {
      cursor?.hide?.();
      return;
    }
    try {
      iterator.reset();
      for (let i = 0; i < index && !iterator.endReached; i++) {
        iterator.moveToNext();
      }
      cursor.show?.();
      cursor.update?.();
    } catch {
    }
  }

  function scrollPrintToIndex(index: number, behavior: ScrollBehavior) {
    const scroller = printScrollRef.current;
    const group = draft[index];
    if (!scroller || !group || measures.length <= 1) return;
    const measureIndex = Math.max(0, measures.indexOf(group.measure));
    const ratio = measureIndex / Math.max(1, measures.length - 1);
    const top = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: Math.max(0, top - 80), behavior });
  }

  useEffect(() => {
    let cancelled = false;
    const url = fileUrl(musicxmlUrl);
    if (!url) {
      return;
    }
    const metadataUrl = url;

    async function loadScoreMetadata() {
      try {
        const response = await fetch(metadataUrl, { cache: "no-store" });
        if (!response.ok) throw new Error("metadata fetch failed");
        const text = await response.text();
        if (!cancelled) setScoreMetadata(parseMusicXmlMetadata(text));
      } catch {
        if (!cancelled) setScoreMetadata(DEFAULT_SCORE_METADATA);
      }
    }

    void loadScoreMetadata();
    return () => {
      cancelled = true;
    };
  }, [musicxmlUrl, printRevision]);

  useEffect(() => {
    if (viewMode !== "print") {
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current = null;
      }
      return;
    }
    if (!musicxmlUrl || !printContainerRef.current) return;

    let cancelled = false;

    async function loadScore() {
      setLoadingPrint(true);
      setError(null);

      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (cancelled) return;

        osmdRef.current?.clear?.();
        const container = printContainerRef.current;
        if (!container) return;
        const osmd = new OpenSheetMusicDisplay(container, {
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
        setPrintReadyRevision((current) => current + 1);
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
  }, [viewMode, musicxmlUrl, printRevision]);

  useEffect(() => {
    if (viewMode !== "print" || !colorMap || !osmdRef.current) return;
    applyColorMap(osmdRef.current, colorMap);
  }, [viewMode, colorMap, printReadyRevision]);

  useEffect(() => {
    if (viewMode !== "print") return;
    if (activeIndex === lastPrintActiveIndexRef.current && printReadyRevision > 0) return;
    lastPrintActiveIndexRef.current = activeIndex;
    const cursor = osmdRef.current?.cursor;
    const iterator = cursor?.iterator;
    if (!cursor || !iterator || activeIndex < 0) {
      cursor?.hide?.();
      return;
    }
    try {
      iterator.reset();
      for (let i = 0; i < activeIndex && !iterator.endReached; i++) {
        iterator.moveToNext();
      }
      cursor.show?.();
      cursor.update?.();
    } catch {
    }

    const scroller = printScrollRef.current;
    const group = draft[activeIndex];
    if (!scroller || !group) return;
    const localMeasures = Array.from(new Set(draft.map((item) => item.measure || 1))).sort((a, b) => a - b);
    if (localMeasures.length <= 1) return;
    const measureIndex = Math.max(0, localMeasures.indexOf(group.measure));
    const ratio = measureIndex / Math.max(1, localMeasures.length - 1);
    const top = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: Math.max(0, top - 80), behavior: "auto" });
  }, [viewMode, activeIndex, printReadyRevision, draft]);

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
      } else if (/^[1-9]$/.test(event.key)) {
        const duration = DURATIONS[Number(event.key) - 1];
        if (duration) setInputDuration(duration.seconds);
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
          <p className="text-sm mt-1">选择项目后可上传 PDF、MusicXML 或 MIDI</p>
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
              aria-pressed={viewMode === "edit"}
              className={`h-7 px-3 rounded-sm text-xs transition-colors ${
                viewMode === "edit" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("edit")}
            >
              编辑谱
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "print"}
              className={`h-7 px-3 rounded-sm text-xs transition-colors ${
                viewMode === "print" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setMode("print")}
              disabled={!musicxmlUrl}
            >
              排版谱
            </button>
          </div>
          {viewMode === "edit" && (
            <div className="inline-flex rounded-md border border-border bg-background p-0.5 shadow-sm">
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
          {viewMode === "edit" && (
            <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700">
              <span>调号 {keySignatureText}</span>
              <span className="text-slate-400">·</span>
              <span>拍号 {scoreMetadata.timeSignature}</span>
              {scoreMetadata.tempo && (
                <>
                  <span className="text-slate-400">·</span>
                  <span>原速 {Math.round(scoreMetadata.tempo)} BPM</span>
                </>
              )}
            </div>
          )}
          {viewMode === "edit" && (
            <div className="hidden md:flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50/70 px-2 py-1 text-[11px] text-amber-900">
              <span>{editMode === "note-input" ? "点击五线谱输入音符" : "拖动音符上下改变音高"}</span>
              <span className="text-amber-700">·</span>
              {DURATIONS.map((duration, index) => (
                <button
                  key={duration.seconds}
                  type="button"
                  className={`h-6 min-w-10 rounded-full border px-2 text-xs ${
                    inputDuration === duration.seconds
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-amber-200 bg-white/80 text-amber-800 hover:text-foreground"
                  }`}
                  onClick={() => setInputDuration(duration.seconds)}
                >
                  {index + 1}:{durationSymbol(duration.seconds)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {selected && viewMode === "edit" && (
            <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 md:inline">
              第 {selected.measure} 小节 · 第 {selected.beat} 拍 · {formatTargetNames(selected)}
            </span>
          )}
          {dirty && <span className="text-xs font-medium text-amber-700">未保存</span>}
          <Button variant="ghost" size="sm" onClick={addNote} disabled={!draft.length}>
            <Plus />
            添加
          </Button>
          <Button variant="ghost" size="sm" onClick={deleteSelected} disabled={selectedIndex === null}>
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

      <div
        ref={printScrollRef}
        className="flex-1 min-h-0 overflow-auto cursor-pointer"
        style={{ display: viewMode === "print" ? "block" : "none" }}
        onPointerDown={handlePrintPointerDown}
      >
        {loadingPrint && (
          <div className="p-3 text-sm text-muted-foreground text-center">加载谱面中...</div>
        )}
        {activeGroup && (
          <div className="sticky top-3 z-10 mx-auto mt-3 w-fit rounded-full border border-teal-500/40 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800 shadow-sm">
            正在播放：第 {activeGroup.measure} 小节 第 {activeGroup.beat} 拍 · {formatTargetNames(activeGroup)}
          </div>
        )}
        <div ref={printContainerRef} className="min-h-full p-4" />
      </div>
      {viewMode === "edit" && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-w-0 overflow-auto bg-[#d9d1c2]/40 p-5">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="block min-h-full rounded-xl bg-[#fffdf7] shadow-[0_22px_70px_rgba(65,52,33,0.20)]"
              style={{ cursor: editMode === "note-input" ? "crosshair" : "default" }}
              role="img"
              aria-label="可编辑五线谱"
            >
              <defs>
                <pattern id="score-paper-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#eadfca" strokeWidth="0.55" opacity="0.45" />
                </pattern>
                <filter id="note-shadow" x="-30%" y="-30%" width="160%" height="160%">
                  <feDropShadow dx="0" dy="1.2" stdDeviation="1.1" floodColor="#111827" floodOpacity="0.18" />
                </filter>
              </defs>
              <rect x="0" y="0" width={svgWidth} height={svgHeight} fill="#fffdf7" />
              <rect x="0" y="0" width={svgWidth} height={svgHeight} fill="url(#score-paper-grid)" />
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
                      x={LEFT_PAD - 22}
                      y={yTop - 56}
                      width={Math.max(1, rowMeasures.length) * MEASURE_WIDTH + 44}
                      height={STAFF_GAP * 4 + 112}
                      rx="16"
                      fill={systemIndex % 2 === 0 ? "#fffaf0" : "#fffdf7"}
                      opacity="0.72"
                    />
                    <rect
                      x={LEFT_PAD}
                      y={yTop - 42}
                      width={Math.max(1, rowMeasures.length) * MEASURE_WIDTH}
                      height={STAFF_GAP * 4 + 108}
                      fill="transparent"
                      onPointerDown={(event) => handleStaffPointerDown(event, systemIndex)}
                    />
                    <text x={CLEF_X} y={yTop + 43} fontSize="82" fill="#111827" fontFamily="Georgia, serif">
                      𝄞
                    </text>
                    <KeySignatureGlyphs x={KEY_SIGNATURE_X} yTop={yTop} fifths={scoreMetadata.keyFifths} />
                    <text x={TIME_SIGNATURE_X} y={yTop + 20} fontSize="24" fontWeight="700" fill="#111827">
                      {timeSignatureParts[0]}
                    </text>
                    <text x={TIME_SIGNATURE_X} y={yTop + 48} fontSize="24" fontWeight="700" fill="#111827">
                      {timeSignatureParts[1]}
                    </text>
                    {Array.from({ length: 5 }).map((_, line) => (
                      <line
                        key={line}
                        x1={LEFT_PAD}
                        x2={rowRight}
                        y1={yTop + line * STAFF_GAP}
                        y2={yTop + line * STAFF_GAP}
                        stroke={STAFF_LINE_COLOR}
                        strokeWidth={line === 0 || line === 4 ? "1.25" : "1"}
                      />
                    ))}
                    {rowMeasures.map((measure, columnIndex) => {
                      const x = LEFT_PAD + columnIndex * MEASURE_WIDTH;
                      return (
                        <g key={measure}>
                          <rect
                            x={x + 10}
                            y={yTop - 36}
                            width={MEASURE_WIDTH - 20}
                            height={STAFF_GAP * 4 + 96}
                            rx="10"
                            fill={selected?.measure === measure ? "#dbeafe" : "transparent"}
                            opacity={selected?.measure === measure ? 0.34 : 1}
                          />
                          <line x1={x} x2={x} y1={yTop - 2} y2={yBottom + 2} stroke="#111827" strokeWidth="1.6" />
                          <text x={x + 8} y={yTop - 20} fontSize="12" fill="#6b7280">
                            {measure}
                          </text>
                          {Array.from({ length: BEATS_PER_MEASURE }).map((_, beatIndex) => {
                            const beatX = x + MEASURE_INSET + (beatIndex / BEATS_PER_MEASURE) * (MEASURE_WIDTH - 82);
                            return (
                              <g key={beatIndex}>
                                <line
                                  x1={beatX}
                                  x2={beatX}
                                  y1={yTop - 28}
                                  y2={yBottom + 44}
                                  stroke={beatIndex === 0 ? "#c7bda9" : "#e5dccd"}
                                  strokeWidth={beatIndex === 0 ? "1.1" : "0.8"}
                                  strokeDasharray={beatIndex === 0 ? undefined : "2 5"}
                                />
                                <text x={beatX - 3} y={yBottom + 62} fontSize="9" fill="#9ca3af">
                                  {beatIndex + 1}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      );
                    })}
                    <line x1={rowRight} x2={rowRight} y1={yTop - 2} y2={yBottom + 2} stroke="#111827" strokeWidth="2.4" />
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
                const modifiers = noteModifiers(group.type);
                const isRest = noteBaseType(group.type) === "rest" || group.target_pitches.length === 0;
                const duration = noteDuration(group);
                const durationWidth = Math.max(18, (duration / (BEATS_PER_MEASURE * BEAT_SECONDS)) * (MEASURE_WIDTH - 82));
                const accidentals = group.target_names.map((name, pitchIndex) => ({
                  accidental: accidentalForPitchName(name, scoreMetadata.keyFifths),
                  pitch: group.target_pitches[pitchIndex] ?? group.target_pitches[0] ?? 64,
                }));
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
                    {selectedNote && (
                      <rect
                        x={point.x - 28}
                        y={point.staffTop - 34}
                        width={Math.min(point.measureRight - point.x + 14, Math.max(56, durationWidth + 36))}
                        height={STAFF_GAP * 4 + 92}
                        rx="12"
                        fill="#eff6ff"
                        stroke="#2563eb"
                        strokeWidth="1.25"
                        strokeDasharray="5 4"
                      />
                    )}
                    <line
                      x1={point.x}
                      x2={Math.min(point.measureRight - 10, point.x + durationWidth)}
                      y1={point.staffBottom + 30}
                      y2={point.staffBottom + 30}
                      stroke={activeNote ? "#14b8a6" : selectedNote ? "#93c5fd" : "#ddd6c6"}
                      strokeWidth={selectedNote || activeNote ? "5" : "3"}
                      strokeLinecap="round"
                    />
                    {activeNote && (
                      <g>
                        <circle cx={point.x} cy={point.y} r="25" fill="#ccfbf1" stroke="#0f766e" strokeWidth="2" opacity="0.82" />
                        <line x1={point.x} x2={point.x} y1={point.staffTop - 34} y2={point.staffBottom + 74} stroke="#0f766e" strokeWidth="2.4" />
                      </g>
                    )}
                    {ledgerLines(group, point).map((lineY) => (
                      <line
                        key={lineY}
                        x1={point.x - 16}
                        x2={point.x + 16}
                        y1={lineY}
                        y2={lineY}
                        stroke={STAFF_LINE_COLOR}
                        strokeWidth="1.2"
                      />
                    ))}
                    {!isRest && accidentals.map(({ accidental, pitch }, pitchIndex) => (
                      accidental ? (
                        <AccidentalGlyph
                          key={`${group.note_group_id}-accidental-${pitchIndex}`}
                          x={point.x - 32 - pitchIndex * 6}
                          y={noteYForPitch(pitch, point.staffTop, point.staffBottom)}
                          accidental={accidental}
                          color={color}
                        />
                      ) : null
                    ))}
                    {isRest ? (
                      <RestGlyph x={point.x} y={point.staffTop + STAFF_GAP * 2} color={color} duration={duration} />
                    ) : (
                      <NoteGlyph
                        x={point.x}
                        y={point.y}
                        color={color}
                        duration={duration}
                        stemDirection={point.y < point.staffTop + STAFF_GAP * 2 ? "down" : "up"}
                      />
                    )}
                    {modifiers.size > 0 && (
                      <ModifierGlyphs
                        x={point.x}
                        y={point.y}
                        staffTop={point.staffTop}
                        staffBottom={point.staffBottom}
                        measureRight={point.measureRight}
                        durationWidth={durationWidth}
                        modifiers={modifiers}
                        isRest={isRest}
                      />
                    )}
                    <text
                      x={point.x - 20}
                      y={point.staffBottom + 52}
                      fontSize="10"
                      fill={selectedNote ? "#1d4ed8" : "#6b7280"}
                      fontWeight={selectedNote ? "700" : "500"}
                    >
                      {formatTargetNames(group)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      )}
      {draft.length > 0 && (
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
                      max={4.958}
                      step={1 / 24}
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
                  <div className="md:col-span-4">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">高级记谱</div>
                    <div className="flex flex-wrap gap-1">
                      {ADVANCED_MODIFIERS.map((modifier) => {
                        const active = noteModifiers(selected.type).has(modifier.key);
                        return (
                          <button
                            key={modifier.key}
                            type="button"
                            className={`h-8 rounded-md border px-2 text-xs ${
                              active
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background text-muted-foreground hover:text-foreground"
                            }`}
                            onClick={() => toggleSelectedModifier(modifier.key)}
                          >
                            {modifier.mark} {modifier.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">未选择音符</div>
              )}
            </div>
          </div>
      )}
    </div>
  );
}

function KeySignatureGlyphs({ x, yTop, fifths }: { x: number; yTop: number; fifths: number }) {
  const accidentals = keySignatureAccidentals(fifths);
  if (!accidentals.length) return null;

  return (
    <g aria-label="调号">
      {accidentals.map((accidental, index) => (
        <text
          key={`${accidental.step}-${index}`}
          x={x + index * 9}
          y={noteYForPitch(accidental.midi, yTop, yTop + STAFF_GAP * 4) + 7}
          fontSize="25"
          fontFamily="Georgia, serif"
          fontWeight="700"
          fill="#111827"
        >
          {accidental.symbol}
        </text>
      ))}
    </g>
  );
}

function AccidentalGlyph({
  x,
  y,
  accidental,
  color,
}: {
  x: number;
  y: number;
  accidental: string;
  color: string;
}) {
  return (
    <text
      x={x}
      y={y + 7}
      fontSize="24"
      fontFamily="Georgia, serif"
      fontWeight="700"
      fill={color}
      pointerEvents="none"
    >
      {accidental}
    </text>
  );
}

function NoteGlyph({
  x,
  y,
  color,
  duration,
  stemDirection,
}: {
  x: number;
  y: number;
  color: string;
  duration: number;
  stemDirection: "up" | "down";
}) {
  const beats = duration / BEAT_SECONDS;
  const whole = beats >= 3.75;
  const open = beats >= 1.75;
  const flags = beats <= 0.28 ? 2 : beats <= 0.58 ? 1 : 0;
  const stemX = stemDirection === "up" ? x + 8.5 : x - 8.5;
  const stemEndY = stemDirection === "up" ? y - 48 : y + 48;
  const flagSign = stemDirection === "up" ? 1 : -1;

  return (
    <g filter="url(#note-shadow)">
      <ellipse
        cx={x}
        cy={y}
        rx="10.5"
        ry="7.2"
        transform={`rotate(-18 ${x} ${y})`}
        fill={open ? "#ffffff" : color}
        stroke={color}
        strokeWidth={open ? 2.2 : 1.2}
      />
      {whole && (
        <ellipse
          cx={x}
          cy={y}
          rx="5.2"
          ry="2.8"
          transform={`rotate(-18 ${x} ${y})`}
          fill="none"
          stroke={color}
          strokeWidth="1.8"
        />
      )}
      {!whole && (
        <line x1={stemX} x2={stemX} y1={y} y2={stemEndY} stroke={color} strokeWidth="2.4" strokeLinecap="round" />
      )}
      {flags >= 1 && (
        <path
          d={
            stemDirection === "up"
              ? `M ${stemX} ${stemEndY} C ${stemX + 25} ${stemEndY + 7}, ${stemX + 24} ${stemEndY + 25}, ${stemX + 4} ${stemEndY + 30}`
              : `M ${stemX} ${stemEndY} C ${stemX - 25} ${stemEndY - 7}, ${stemX - 24} ${stemEndY - 25}, ${stemX - 4} ${stemEndY - 30}`
          }
          fill="none"
          stroke={color}
          strokeWidth="2.35"
          strokeLinecap="round"
        />
      )}
      {flags >= 2 && (
        <path
          d={
            stemDirection === "up"
              ? `M ${stemX} ${stemEndY + 10 * flagSign} C ${stemX + 22} ${stemEndY + 17}, ${stemX + 22} ${stemEndY + 31}, ${stemX + 5} ${stemEndY + 36}`
              : `M ${stemX} ${stemEndY + 10 * flagSign} C ${stemX - 22} ${stemEndY - 17}, ${stemX - 22} ${stemEndY - 31}, ${stemX - 5} ${stemEndY - 36}`
          }
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

function RestGlyph({ x, y, color, duration }: { x: number; y: number; color: string; duration: number }) {
  const beats = duration / BEAT_SECONDS;
  if (beats >= 3.75) {
    return <rect x={x - 12} y={y - STAFF_GAP + 1} width="24" height="7" fill={color} rx="1.5" />;
  }
  if (beats >= 1.75) {
    return <rect x={x - 12} y={y - 1} width="24" height="7" fill={color} rx="1.5" />;
  }
  if (beats <= 0.58) {
    return (
      <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" filter="url(#note-shadow)">
        <path d={`M ${x - 4} ${y - 28} C ${x + 10} ${y - 22}, ${x + 8} ${y - 9}, ${x - 4} ${y - 2} C ${x + 10} ${y + 5}, ${x + 8} ${y + 19}, ${x - 8} ${y + 28}`} />
        <circle cx={x - 5} cy={y - 29} r="3.4" fill={color} stroke="none" />
        {beats <= 0.28 && <circle cx={x - 1} cy={y - 5} r="3.2" fill={color} stroke="none" />}
      </g>
    );
  }
  return (
    <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" filter="url(#note-shadow)">
      <path d={`M ${x - 5} ${y - 22} C ${x + 12} ${y - 13}, ${x + 10} ${y + 3}, ${x - 7} ${y + 12} C ${x + 6} ${y + 17}, ${x + 4} ${y + 26}, ${x - 7} ${y + 32}`} />
      <circle cx={x - 5} cy={y - 22} r="3.6" fill={color} stroke="none" />
    </g>
  );
}

function ModifierGlyphs({
  x,
  y,
  staffTop,
  staffBottom,
  measureRight,
  durationWidth,
  modifiers,
  isRest,
}: {
  x: number;
  y: number;
  staffTop: number;
  staffBottom: number;
  measureRight: number;
  durationWidth: number;
  modifiers: Set<string>;
  isRest: boolean;
}) {
  const tupletRight = Math.min(measureRight - 10, x + Math.max(34, durationWidth));
  return (
    <g>
      {modifiers.has("dotted") && !isRest && (
        <circle cx={x + 18} cy={y - 1} r="2.4" fill="#111827" />
      )}
      {modifiers.has("tuplet3") && (
        <g>
          <path
            d={`M ${x - 12} ${staffTop - 30} L ${x - 12} ${staffTop - 38} L ${tupletRight} ${staffTop - 38} L ${tupletRight} ${staffTop - 30}`}
            fill="none"
            stroke="#111827"
            strokeWidth="1.3"
          />
          <rect x={(x + tupletRight) / 2 - 8} y={staffTop - 47} width="16" height="14" rx="7" fill="#fffdf7" />
          <text x={(x + tupletRight) / 2 - 3.5} y={staffTop - 36.5} fontSize="12" fontWeight="700" fill="#111827">
            3
          </text>
        </g>
      )}
      {modifiers.has("grace") && !isRest && (
        <g opacity="0.88">
          <ellipse cx={x - 22} cy={y - 10} rx="6.2" ry="4.2" transform={`rotate(-18 ${x - 22} ${y - 10})`} fill="#ffffff" stroke="#111827" strokeWidth="1.5" />
          <line x1={x - 17} x2={x - 17} y1={y - 10} y2={y - 39} stroke="#111827" strokeWidth="1.4" />
          <line x1={x - 29} x2={x - 10} y1={y + 2} y2={y - 36} stroke="#b91c1c" strokeWidth="1.4" />
        </g>
      )}
      {modifiers.has("trill") && !isRest && (
        <text x={x - 7} y={staffTop - 46} fontSize="15" fontStyle="italic" fontWeight="700" fill="#111827">
          tr
        </text>
      )}
      {modifiers.has("turn") && !isRest && (
        <text x={x - 8} y={staffTop - 43} fontSize="18" fill="#111827">
          𝆗
        </text>
      )}
      {modifiers.has("fermata") && (
        <text x={x - 10} y={staffTop - 48} fontSize="20" fill="#111827">
          𝄐
        </text>
      )}
      {modifiers.has("cadenza") && (
        <g>
          <path
            d={`M ${x - 18} ${staffBottom + 72} C ${x + 22} ${staffBottom + 56}, ${tupletRight - 20} ${staffBottom + 88}, ${tupletRight + 16} ${staffBottom + 68}`}
            fill="none"
            stroke="#b45309"
            strokeWidth="1.8"
            strokeDasharray="5 4"
          />
          <text x={x - 16} y={staffBottom + 88} fontSize="11" fontWeight="700" fill="#b45309">
            华彩 / ad lib.
          </text>
        </g>
      )}
    </g>
  );
}

function notePoint(group: NoteGroup, measures: number[]) {
  const measureIndex = Math.max(0, measures.indexOf(group.measure));
  const systemIndex = Math.floor(measureIndex / MEASURES_PER_SYSTEM);
  const columnIndex = measureIndex % MEASURES_PER_SYSTEM;
  const measureStart = LEFT_PAD + columnIndex * MEASURE_WIDTH;
  const beatRatio = Math.max(0, Math.min(1, ((group.beat || 1) - 1) / BEATS_PER_MEASURE));
  const x = measureStart + MEASURE_INSET + beatRatio * (MEASURE_WIDTH - 82);
  const staffTop = systemTop(systemIndex);
  const staffBottom = systemBottom(systemIndex);
  const pitch = group.target_pitches[0] ?? 71;
  return {
    x,
    y: noteYForPitch(pitch, staffTop, staffBottom),
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
  if (noteBaseType(group.type) === "rest" || !group.target_pitches.length) return [];
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
  const rawDuration = Math.max(0.0625, Number(group.end) - Number(group.start) || BEAT_SECONDS);
  const end = noteEndFor(measure, start, rawDuration);
  const pitches = (group.target_pitches || []).map((p) => Math.max(21, Math.min(108, Number(p) || 69)));
  const sourceNames = Array.isArray(group.target_names) ? group.target_names : [];
  const names = pitches.map((midi, index) => {
    const sourceName = String(sourceNames[index] ?? "").trim();
    const parsed = parsePitchName(sourceName);
    return parsed?.midi === midi ? sourceName : midiToName(midi);
  });
  const baseType = pitches.length === 0 ? "rest" : pitches.length === 1 ? "single_note" : pitches.length === 2 ? "double_stop" : "chord";
  const type = composeNoteType(baseType, noteModifiers(group.type));
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

function noteYForPitch(midi: number, staffTop: number, staffBottom: number): number {
  const y = staffBottom - (midi - 64) * NOTE_STEP;
  return Math.max(staffTop - 56, Math.min(staffBottom + 66, y));
}

function sortGroups(groups: NoteGroup[]) {
  return [...groups].sort((a, b) => a.measure - b.measure || a.beat - b.beat || a.start - b.start);
}

function clampBeat(beat: number): number {
  return Math.max(1, Math.min(4.958, Math.round((Number(beat) || 1) * 24) / 24));
}

function startForPosition(measure: number, beat: number): number {
  return Number((((Math.max(1, measure) - 1) * BEATS_PER_MEASURE + (clampBeat(beat) - 1)) * BEAT_SECONDS).toFixed(4));
}

function noteEndFor(measure: number, start: number, duration: number): number {
  const measureEnd = ((Math.max(1, measure) - 1) * BEATS_PER_MEASURE + BEATS_PER_MEASURE) * BEAT_SECONDS;
  const safeDuration = Math.max(0.0625, Number(duration) || BEAT_SECONDS);
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
  return Math.max(0.0625, Number((group.end - group.start).toFixed(4)));
}

function midiToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[pitchClass]}${octave}`;
}

function parsePitchName(name: string): { step: string; alter: number; octave: number; midi: number } | null {
  const match = String(name).trim().replace(/\s+/g, "").match(/^([A-Ga-g])([#♯b♭-]*)(-?\d+)$/);
  if (!match) return null;

  const step = match[1].toUpperCase();
  const octave = Number(match[3]);
  if (!Number.isFinite(octave)) return null;

  let alter = 0;
  for (const char of match[2]) {
    if (char === "#" || char === "♯") alter += 1;
    if (char === "b" || char === "♭" || char === "-") alter -= 1;
  }

  const baseSemitones: Record<string, number> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11,
  };
  return {
    step,
    alter,
    octave,
    midi: (octave + 1) * 12 + baseSemitones[step] + alter,
  };
}

function formatPitchName(name: string): string {
  const parsed = parsePitchName(name);
  if (!parsed) return name;
  const accidental = parsed.alter > 0 ? "♯".repeat(parsed.alter) : "♭".repeat(Math.abs(parsed.alter));
  return `${parsed.step}${accidental}${parsed.octave}`;
}

function formatTargetNames(group: NoteGroup): string {
  if (noteBaseType(group.type) === "rest" || !group.target_names.length) return "休止";
  return group.target_names.map(formatPitchName).join("/");
}

function keyAlterationMap(fifths: number): Record<string, number> {
  const map: Record<string, number> = {};
  const count = Math.min(7, Math.abs(Math.round(fifths)));
  const order = fifths >= 0 ? SHARP_KEY_ORDER : FLAT_KEY_ORDER;
  const alter = fifths >= 0 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    map[order[i]] = alter;
  }
  return map;
}

function accidentalForPitchName(name: string, keyFifths: number): string | null {
  const parsed = parsePitchName(name);
  if (!parsed) return null;
  const keyAlter = keyAlterationMap(keyFifths)[parsed.step] ?? 0;
  if (parsed.alter === keyAlter) return null;
  if (parsed.alter === 0) return "♮";
  return parsed.alter > 0 ? "♯".repeat(parsed.alter) : "♭".repeat(Math.abs(parsed.alter));
}

function keySignatureAccidentals(fifths: number) {
  const rounded = Math.round(fifths);
  const count = Math.min(7, Math.abs(rounded));
  if (count === 0) return [];
  const sharp = rounded > 0;
  const steps = sharp ? SHARP_KEY_ORDER : FLAT_KEY_ORDER;
  const midis = sharp ? SHARP_KEY_MIDIS : FLAT_KEY_MIDIS;
  return steps.slice(0, count).map((step, index) => ({
    step,
    midi: midis[index],
    symbol: sharp ? "♯" : "♭",
  }));
}

function keySignatureLabel(fifths: number, mode: string): string {
  const majorKeys = ["C♭", "G♭", "D♭", "A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯"];
  const minorKeys = ["A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯", "G♯", "D♯", "A♯"];
  const index = Math.max(0, Math.min(14, Math.round(fifths) + 7));
  const isMinor = mode.toLowerCase() === "minor";
  const name = isMinor ? minorKeys[index] : majorKeys[index];
  const count = Math.abs(Math.round(fifths));
  const accidentalText = count ? ` (${count}${fifths > 0 ? "♯" : "♭"})` : "";
  return `${name}${isMinor ? "小调" : "大调"}${accidentalText}`;
}

function splitTimeSignature(value: string): [string, string] {
  const [beats, beatType] = value.split("/");
  return [beats || "4", beatType || "4"];
}

function parseMusicXmlMetadata(text: string): ScoreDisplayMetadata {
  const metadata = { ...DEFAULT_SCORE_METADATA };
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror")) return metadata;

  const keyElement = firstElementByLocalName(document, "key");
  const fifths = keyElement ? childTextByLocalName(keyElement, "fifths") : null;
  const mode = keyElement ? childTextByLocalName(keyElement, "mode") : null;
  if (fifths !== null && Number.isFinite(Number(fifths))) metadata.keyFifths = Number(fifths);
  if (mode) metadata.keyMode = mode;

  const timeElement = firstElementByLocalName(document, "time");
  const beats = timeElement ? childTextByLocalName(timeElement, "beats") : null;
  const beatType = timeElement ? childTextByLocalName(timeElement, "beat-type") : null;
  if (beats && beatType) metadata.timeSignature = `${beats}/${beatType}`;

  const soundElement = firstElementByLocalName(document, "sound");
  const soundTempo = soundElement?.getAttribute("tempo");
  const metronomeTempo = childTextByLocalName(document, "per-minute");
  const tempo = Number(soundTempo ?? metronomeTempo);
  if (Number.isFinite(tempo) && tempo > 0) metadata.tempo = tempo;

  return metadata;
}

function firstElementByLocalName(root: ParentNode, localName: string): Element | null {
  return Array.from(root.querySelectorAll("*")).find((element) => element.localName === localName) ?? null;
}

function childTextByLocalName(root: ParentNode, localName: string): string | null {
  const element = firstElementByLocalName(root, localName);
  return element?.textContent?.trim() || null;
}

function closestDuration(seconds: number): number {
  return closestDurationPreset(seconds).seconds;
}

function closestDurationPreset(seconds: number): { label: string; seconds: number; modifiers?: string[] } {
  return DURATIONS.reduce((best, current) => (
    Math.abs(current.seconds - seconds) < Math.abs(best.seconds - seconds) ? current : best
  ));
}

function noteBaseType(type: string): string {
  const base = String(type || "").split(":")[0];
  return ["single_note", "double_stop", "chord", "rest"].includes(base) ? base : "single_note";
}

function noteModifiers(type: string): Set<string> {
  const parts = String(type || "").split(":").slice(1);
  return new Set(parts.flatMap((part) => part.split(",")).filter(Boolean));
}

function composeNoteType(base: string, modifiers: Set<string>): string {
  const cleanBase = noteBaseType(base);
  const cleanModifiers = [...modifiers].filter(Boolean).sort();
  return cleanModifiers.length ? `${cleanBase}:${cleanModifiers.join(",")}` : cleanBase;
}

function inputModifiers(seconds: number): Set<string> {
  return new Set(closestDurationPreset(seconds).modifiers ?? []);
}

function durationSymbol(seconds: number): string {
  if (seconds <= 0.13) return "𝅘𝅥𝅯";
  if (seconds <= 0.26) return "𝅘𝅥𝅮";
  if (seconds <= 0.51) return "♩";
  if (seconds <= 1.01) return "𝅗𝅥";
  return "𝅝";
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
