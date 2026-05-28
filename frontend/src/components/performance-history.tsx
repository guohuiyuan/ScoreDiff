"use client";

import { useCallback, useEffect, useState } from "react";
import { Edit2, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  deletePerformance,
  fetchDiff,
  fetchPerformances,
  updatePerformance,
  type DiffReport,
  type PerformanceItem,
} from "@/lib/api";

interface PerformanceHistoryProps {
  projectId: string | null;
  refreshKey?: number;
  selectedPerformanceId?: string | null;
  onSelect?: (performance: PerformanceItem, diffReport: DiffReport) => void;
  onDeleted?: (performanceId: string) => void;
}

export function PerformanceHistory({
  projectId,
  refreshKey = 0,
  selectedPerformanceId,
  onSelect,
  onDeleted,
}: PerformanceHistoryProps) {
  const [items, setItems] = useState<PerformanceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNotes, setDraftNotes] = useState("");

  const load = useCallback(async (showLoading: boolean = true) => {
    if (!projectId) {
      setItems([]);
      return;
    }
    if (showLoading) setLoading(true);
    try {
      setItems(await fetchPerformances(projectId));
    } catch {
      setItems([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      if (!projectId) {
        setItems([]);
        return;
      }
      setLoading(true);
      try {
        const nextItems = await fetchPerformances(projectId);
        if (!cancelled) setItems(nextItems);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    refresh();
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  const startEdit = useCallback((item: PerformanceItem) => {
    setEditingId(item.performance_id);
    setDraftTitle(item.title ?? "");
    setDraftNotes(item.notes ?? "");
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const updated = await updatePerformance(editingId, {
      title: draftTitle.trim(),
      notes: draftNotes.trim(),
    });
    setItems((current) => current.map((item) => item.performance_id === editingId ? updated : item));
    setEditingId(null);
  }, [draftNotes, draftTitle, editingId]);

  const viewResult = useCallback(async (item: PerformanceItem) => {
    try {
      const diff = await fetchDiff(item.performance_id);
      onSelect?.(item, diff);
    } catch {
      alert("这条记录还没有可查看的分析结果");
    }
  }, [onSelect]);

  const remove = useCallback(async (item: PerformanceItem) => {
    if (!confirm("删除这条录音对比记录？关联的处理后音频也会删除。")) return;
    await deletePerformance(item.performance_id);
    setItems((current) => current.filter((next) => next.performance_id !== item.performance_id));
    onDeleted?.(item.performance_id);
  }, [onDeleted]);

  return (
    <div className="flex h-72 min-h-0 flex-col border-b border-border">
      <div className="flex items-center justify-between border-b border-border p-3">
        <h2 className="text-sm font-semibold">历史对比</h2>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => load()} disabled={!projectId || loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-2">
          {!projectId && <p className="p-2 text-xs text-muted-foreground">请先选择项目</p>}
          {projectId && items.length === 0 && !loading && (
            <p className="p-2 text-xs text-muted-foreground">暂无录音对比记录</p>
          )}
          {items.map((item) => {
            const editing = editingId === item.performance_id;
            const selected = selectedPerformanceId === item.performance_id;
            return (
              <div
                key={item.performance_id}
                className={`rounded-md border p-2 text-xs ${selected ? "border-primary bg-primary/5" : "border-border"}`}
              >
                {editing ? (
                  <div className="space-y-2">
                    <input
                      className="h-7 w-full rounded border border-input bg-background px-2 text-xs"
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="记录标题"
                    />
                    <textarea
                      className="min-h-14 w-full resize-none rounded border border-input bg-background px-2 py-1 text-xs"
                      value={draftNotes}
                      onChange={(event) => setDraftNotes(event.target.value)}
                      placeholder="备注"
                    />
                    <div className="flex gap-1">
                      <Button type="button" size="xs" className="flex-1 gap-1" onClick={saveEdit}>
                        <Save className="h-3 w-3" />
                        保存
                      </Button>
                      <Button type="button" variant="outline" size="xs" onClick={() => setEditingId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{item.title || formatDate(item.created_at)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {formatDate(item.created_at)} · {item.status === "analyzed" ? "已分析" : "待分析"}
                        </p>
                      </div>
                      {typeof item.total_score === "number" && (
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {item.total_score.toFixed(0)}
                        </span>
                      )}
                    </div>
                    {item.segment_start !== null && item.segment_end !== null && item.segment_start !== undefined && item.segment_end !== undefined && (
                      <p className="mb-1 text-[11px] text-muted-foreground">
                        片段 {formatTime(item.segment_start)} - {formatTime(item.segment_end)} · {item.segment_note_count ?? 0} 个音符
                      </p>
                    )}
                    {item.notes && <p className="mb-1 line-clamp-2 text-[11px] text-muted-foreground">{item.notes}</p>}
                    {item.audio_url && <audio controls src={item.audio_url} className="mb-2 h-8 w-full" />}
                    <div className="flex gap-1">
                      <Button type="button" size="xs" className="flex-1" onClick={() => viewResult(item)}>
                        查看
                      </Button>
                      <Button type="button" variant="outline" size="icon-xs" onClick={() => startEdit(item)}>
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button type="button" variant="destructive" size="icon-xs" onClick={() => remove(item)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const m = Math.floor(safeSeconds / 60);
  const s = Math.floor(safeSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
