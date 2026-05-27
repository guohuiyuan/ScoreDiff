"use client";

import { useEffect, useState } from "react";
import { AudioLines, Download, FileMusic, Music2, Plus, Upload } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  fetchProjects,
  createProject,
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
  onProjectSelect?: (score: ScoreData | null, projectId: string) => void;
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
    input.accept = ".musicxml,.xml,.mid,.midi,.mp3,.pdf,.png,.jpg,.jpeg,.webp";
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

  async function handleConvert(target: "midi" | "mp3") {
    if (!selected) return;
    setWorking(target === "midi" ? "正在生成 MIDI..." : "正在生成 MP3...");
    try {
      const result = await convertScoreMedia(selected, target);
      await refreshScore(selected);
      const url = fileUrl(target === "midi" ? result.midi_url : result.mp3_url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "转换失败");
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold">项目列表</h2>
        <Button variant="ghost" size="sm" onClick={handleCreate}>
          <Plus />
          新建
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <p className="p-3 text-sm text-muted-foreground">加载中...</p>
        ) : projects.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">暂无项目</p>
        ) : (
          <ul className="p-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                    selected === p.id
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted"
                  }`}
                  onClick={() => handleSelect(p.id)}
                >
                  <div className="font-medium truncate">{p.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.instrument} · {p.status}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      {selected && (
        <div className="p-3 border-t border-border">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" className="col-span-2" onClick={handleUploadScore}>
              <Upload />
              上传 PDF/MIDI/MP3
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleConvert("midi")}>
              <FileMusic />
              MIDI
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleConvert("mp3")}>
              <AudioLines />
              MP3
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
