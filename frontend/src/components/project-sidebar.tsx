"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileMusic, ImagePlus, Music2, Plus, Trash2, Upload, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  fetchProjects,
  createProject,
  updateProject,
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

interface PastedImage {
  file: File;
  preview: string;
}

interface ProjectSidebarProps {
  onProjectSelect?: (score: ScoreData | null, projectId: string | null, project?: Project | null) => void;
  onDiffReady?: (report: DiffReport | null) => void;
  onTimelineReady?: (timeline: PlaybackTimeline | null) => void;
}

const INSTRUMENT_OPTIONS = [
  { value: "violin", label: "小提琴" },
  { value: "piano", label: "钢琴" },
  { value: "flute", label: "长笛" },
  { value: "guitar", label: "吉他" },
  { value: "cello", label: "大提琴" },
  { value: "clarinet", label: "单簧管" },
];

export function ProjectSidebar({ onProjectSelect, onDiffReady, onTimelineReady }: ProjectSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const pasteBoxRef = useRef<HTMLDivElement>(null);
  const selectedProject = projects.find((project) => project.id === selected) ?? null;

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      pastedImages.forEach((img) => URL.revokeObjectURL(img.preview));
    };
  }, [pastedImages]);

  async function handleCreate() {
    const title = prompt("项目名称:");
    if (!title) return;
    const proj = await createProject(title);
    setProjects((prev) => [proj, ...prev]);
    handleSelect(proj.id);
  }

  async function handleSelect(projectId: string) {
    const project = projects.find((p) => p.id === projectId) ?? null;
    setSelected(projectId);
    onDiffReady?.(null);
    onTimelineReady?.(null);
    try {
      const score = await fetchScore(projectId);
      onProjectSelect?.(score, projectId, project);
      if (score.note_groups.length > 0) {
        const tl = await fetchPlaybackTimeline(projectId);
        onTimelineReady?.(tl);
      }
    } catch {
      onProjectSelect?.(null, projectId, project);
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
        onProjectSelect?.(null, null, null);
      }
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function refreshScore(projectId: string, projectOverride?: Project | null) {
    const score = await fetchScore(projectId);
    onProjectSelect?.(score, projectId, projectOverride ?? projects.find((p) => p.id === projectId) ?? null);
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
    input.multiple = true;
    input.accept = ".musicxml,.xml,.mid,.midi,.pdf,.png,.jpg,.jpeg,.webp";
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      setWorking(`上传 ${files.length} 个文件并解析中...`);
      try {
        for (let i = 0; i < files.length; i++) {
          setWorking(`上传第 ${i + 1}/${files.length} 个文件...`);
          await uploadScoreFile(selected, files[i]);
        }
        const shouldRunOcr = files.some((file) => {
          const suffix = file.name.split(".").pop()?.toLowerCase();
          return !!suffix && ["pdf", "png", "jpg", "jpeg", "webp"].includes(suffix);
        });
        if (shouldRunOcr) {
          setWorking("正在识别并拼接乐谱...");
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

  async function handleExport(target: "midi" | "musicxml") {
    if (!selected) return;
    setWorking(target === "midi" ? "正在生成 MIDI..." : "正在生成 MusicXML...");
    try {
      const result = await convertScoreMedia(selected, target);
      await refreshScore(selected);
      const url = fileUrl(target === "midi" ? result.midi_url : result.musicxml_url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "转换失败");
    }
  }

  async function handleInstrumentChange(instrument: string) {
    if (!selected) return;
    setWorking("正在更新乐器音色...");
    try {
      const project = await updateProject(selected, { instrument });
      setProjects((prev) => prev.map((p) => (p.id === selected ? project : p)));
      await refreshScore(selected, project);
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "更新乐器音色失败");
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (!selected) return;
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const ext = blob.type.split("/")[1] || "png";
          const file = new File([blob], `paste-${Date.now()}-${pastedImages.length}.${ext}`, { type: blob.type });
          const preview = URL.createObjectURL(blob);
          setPastedImages((prev) => [...prev, { file, preview }]);
        }
      }
    }
  }

  function removePastedImage(index: number) {
    setPastedImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  async function handleUploadPasted() {
    if (!selected || pastedImages.length === 0) return;
    setWorking(`上传 ${pastedImages.length} 张图片中...`);
    try {
      for (let i = 0; i < pastedImages.length; i++) {
        setWorking(`上传第 ${i + 1}/${pastedImages.length} 张...`);
        await uploadScoreFile(selected, pastedImages[i].file);
      }
      setWorking("正在识别乐谱...");
      const omr = await runOcr(selected);
      if (omr.status !== "success") {
        throw new Error(omr.message || "OMR 未生成可编辑谱");
      }
      await parseScore(selected);
      await refreshScore(selected);
      pastedImages.forEach((img) => URL.revokeObjectURL(img.preview));
      setPastedImages([]);
      setWorking(null);
    } catch (error) {
      setWorking(error instanceof Error ? error.message : "上传失败");
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
                      {instrumentLabel(p.instrument)} / {statusLabel(p.status)}
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
              上传 PDF/图片/MIDI
            </Button>
          </div>

          <div
            ref={pasteBoxRef}
            tabIndex={0}
            onPaste={handlePaste}
            className="mt-2 rounded-md border-2 border-dashed border-border p-2 text-center text-xs text-muted-foreground focus:border-primary focus:outline-none transition-colors cursor-text"
          >
            {pastedImages.length === 0 ? (
              <div className="flex items-center justify-center gap-1 py-1">
                <ImagePlus className="size-3.5" />
                <span>点击此处后 Ctrl+V 粘贴乐谱图片</span>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  {pastedImages.map((img, index) => (
                    <div key={img.preview} className="relative group/thumb">
                      <img
                        src={img.preview}
                        alt={`粘贴图片 ${index + 1}`}
                        className="h-12 w-auto rounded border border-border object-cover"
                      />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 size-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                        onClick={() => removePastedImage(index)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="default"
                  size="sm"
                  className="w-full"
                  onClick={handleUploadPasted}
                  disabled={!!working}
                >
                  <Upload className="mr-1" />
                  上传 {pastedImages.length} 张图片
                </Button>
              </div>
            )}
          </div>

          <div className="mt-2 grid grid-cols-1 gap-2">
            <Button variant="ghost" size="sm" onClick={() => handleExport("midi")}>
              <FileMusic />
              导出 MIDI
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleExport("musicxml")}>
              <Download />
              导出 MusicXML
            </Button>
          </div>

          <div className="mt-3 rounded-md border border-border p-2">
            <div className="mb-2 text-xs font-medium">系统设置</div>
            <label className="text-xs text-muted-foreground">
              乐器音色
              <select
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={selectedProject?.instrument ?? "violin"}
                onChange={(event) => handleInstrumentChange(event.target.value)}
                disabled={!!working}
              >
                {INSTRUMENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {working && (
            <p className="mt-2 text-xs text-muted-foreground leading-snug">{working}</p>
          )}
          <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Music2 className="size-3" />
            <span>多张图片和 PDF 全页会自动识别并拼接</span>
            <Download className="size-3 ml-auto" />
          </div>
        </div>
      )}
    </div>
  );
}

function instrumentLabel(instrument: string): string {
  return INSTRUMENT_OPTIONS.find((option) => option.value === instrument)?.label ?? instrument;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    created: "已创建",
    file_uploaded: "已上传",
    omr_complete: "识别完成",
    score_parsed: "已解析",
    score_edited: "已编辑",
  };
  return map[status] ?? status;
}
