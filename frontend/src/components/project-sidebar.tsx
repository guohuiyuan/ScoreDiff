"use client";

import { useEffect, useState } from "react";
import { Download, FileMusic, Music2, Plus, Trash2, Upload } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  fetchProjects,
  createProject,
  deleteProject,
  fetchScore,
  uploadScoreFile,
  parseScore,
  runOcr,
  convertScoreMedia,
  fetchPlaybackTimeline,
  fileUrl,
  type Project,
  type DiffReport,
  type PlaybackTimeline,
  type ScoreData,
} from "@/lib/api";

interface ProjectSidebarProps {
  onProjectSelect?: (score: ScoreData | null, projectId: string | null) => void;
  onDiffReady?: (report: DiffReport | null) => void;
  onTimelineReady?: (timeline: PlaybackTimeline | null) => void;
}

export function ProjectSidebar({ onProjectSelect, onDiffReady, onTimelineReady }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate() {
    const title = prompt("项目名称:");
    if (!title) return;
    const proj = await createProject(title);
    setProjects((prev) => [proj, ...prev]);
    handleSelect(proj.id);
  }

  async function handleSelect(projectId: string) {
    setSelected(projectId);
    onDiffReady?.(null);
    onTimelineReady?.(null);
    try {
      const score = await fetchScore(projectId);
      onProjectSelect?.(score, projectId);
      if (score.note_groups.length > 0) {
        const tl = await fetchPlaybackTimeline(projectId);
        onTimelineReady?.(tl);
      }
    } catch {
      onProjectSelect?.(null, projectId);
    }
  }

  async function handleDelete(projectId: string, title: string) {
    if (!confirm(`删除项目「${title}」？相关谱面、音频和分析结果会一起删除。`)) return;
    setWorking("正在删除项目...");
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((project) => project.id !== projectId));
      if (selected === projectId) {
        setSelected(null);
        onDiffReady?.(null);
        onTimelineReady?.(null);
        onProjectSelect?.(null, null);
      }
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function refreshScore(projectId: string) {
    const score = await fetchScore(projectId);
    onProjectSelect?.(score, projectId);
    if (score.note_groups.length > 0) {
      const tl = await fetchPlaybackTimeline(projectId);
      onTimelineReady?.(tl);
    }
    return score;
  }

  async function handleUploadScore() {
    if (!selected) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".musicxml,.xml,.mid,.midi,.pdf,.png,.jpg,.jpeg,.webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setWorking("上传并解析中...");
      try {
        await uploadScoreFile(selected, file);
        const suffix = file.name.split(".").pop()?.toLowerCase();
        if (suffix && ["pdf", "png", "jpg", "jpeg", "webp"].includes(suffix)) {
          const omr = await runOcr(selected);
          if (omr.status !== "success") {
            throw new Error(omr.message || "OMR 未生成可编辑谱");
          }
        }
        await parseScore(selected);
        await refreshScore(selected);
        setWorking(null);
      } catch (error) {
        setWorking(error instanceof Error ? error.message : "上传失败");
      }
    };
    input.click();
  }

  async function handleConvert() {
    if (!selected) return;
    setWorking("正在生成 MIDI...");
    try {
      const result = await convertScoreMedia(selected, "midi");
      await refreshScore(selected);
      const url = fileUrl(result.midi_url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "转换失败");
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold">项目列表</h2>
        <Button variant="ghost" size="sm" onClick={handleCreate}>
          <Plus />
          新建
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">加载中...</p>
        ) : projects.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">暂无项目</p>
        ) : (
          <ul className="p-1">
            {projects.map((p) => {
              const active = selected === p.id;
              return (
                <li
                  key={p.id}
                  className={`group flex items-center gap-1 rounded-md pr-1 transition-colors ${
                    active ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                  }`}
                >
                  <button
                    className="min-w-0 flex-1 text-left px-3 py-2 text-sm"
                    onClick={() => handleSelect(p.id)}
                  >
                    <div className="font-medium truncate">{p.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.instrument} / {p.status}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`删除 ${p.title}`}
                    className="opacity-60 hover:opacity-100"
                    onClick={() => handleDelete(p.id, p.title)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
      {selected && (
        <div className="p-3 border-t border-border flex-shrink-0">
          <div className="grid grid-cols-1 gap-2">
            <Button variant="outline" size="sm" onClick={handleUploadScore}>
              <Upload />
              上传 PDF/MIDI
            </Button>
            <Button variant="ghost" size="sm" onClick={handleConvert}>
              <FileMusic />
              导出 MIDI
            </Button>
          </div>
          {working && (
            <p className="mt-2 text-xs text-muted-foreground leading-snug">{working}</p>
          )}
          <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Music2 className="size-3" />
            <span>上传后自动生成可编辑电子谱</span>
            <Download className="size-3 ml-auto" />
          </div>
        </div>
      )}
    </div>
  );
}
