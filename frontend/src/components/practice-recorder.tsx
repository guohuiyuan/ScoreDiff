"use client";

import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Download, Mic, Square, Upload } from "lucide-react";
import { type CompareSegment, type PerformanceUploadResult } from "@/lib/api";

interface PracticeRecorderProps {
  projectId: string | null;
  compareRange?: [number, number];
  bpm?: number;
  scoreBpm?: number;
  onBpmChange?: (bpm: number) => void;
  onRecordingComplete?: (
    blob: Blob,
    filename: string,
    segment: Pick<CompareSegment, "start" | "end">,
    onUploaded?: (result: PerformanceUploadResult) => void,
  ) => void | Promise<void>;
}

export function PracticeRecorder({ projectId, compareRange, bpm = 120, scoreBpm = 120, onBpmChange, onRecordingComplete }: PracticeRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState<string>("processed_recording.wav");
  const [processedAudioReady, setProcessedAudioReady] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const segmentRef = useRef<Pick<CompareSegment, "start" | "end">>({ start: 0, end: 0 });
  const selectedSegment = normalizeSegment(compareRange);
  const selectedBpm = normalizeBpm(bpm);
  const originalBpm = normalizeBpm(scoreBpm);

  const handleUploadedAudio = useCallback((result: PerformanceUploadResult) => {
    if (result.audio_url) {
      setAudioUrl(result.audio_url);
      setProcessedAudioReady(true);
    }
    if (result.audio_filename) {
      setDownloadName(result.audio_filename);
    }
    setUploadingAudio(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (!projectId || selectedSegment.end <= selectedSegment.start) return;

    try {
      segmentRef.current = selectedSegment;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);

        const ext = mimeType.includes("webm") ? "webm" : "ogg";
        const filename = `recording_${Date.now()}.${ext}`;
        setDownloadName(filename.replace(/\.[^.]+$/, "_trimmed.wav"));
        setProcessedAudioReady(false);
        setUploadingAudio(true);
        const uploadTask = onRecordingComplete?.(blob, filename, segmentRef.current, handleUploadedAudio);
        if (uploadTask) {
          uploadTask.catch(() => setUploadingAudio(false));
        }
      };

      recorder.start(250);
      startTimeRef.current = Date.now();
      setDuration(0);
      setAudioUrl(null);
      setProcessedAudioReady(false);
      setUploadingAudio(false);
      setRecording(true);

      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);
    } catch {
      alert("无法访问麦克风，请检查浏览器权限设置");
    }
  }, [projectId, selectedSegment, onRecordingComplete, handleUploadedAudio]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
  }, []);

  const uploadRecording = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (!projectId || selectedSegment.end <= selectedSegment.start) return;
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
    setDownloadName(file.name || `upload_${Date.now()}`);
    setProcessedAudioReady(false);
    setUploadingAudio(true);
    setDuration(0);
    const uploadTask = onRecordingComplete?.(file, file.name || `upload_${Date.now()}`, selectedSegment, handleUploadedAudio);
    if (uploadTask) {
      uploadTask.catch(() => setUploadingAudio(false));
    }
    event.target.value = "";
  }, [projectId, selectedSegment, onRecordingComplete, handleUploadedAudio]);

  const downloadProcessedAudio = useCallback(async () => {
    if (!audioUrl) return;
    try {
      const response = await fetch(audioUrl);
      if (!response.ok) throw new Error("download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("下载处理后音频失败");
    }
  }, [audioUrl, downloadName]);

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="border-b border-border p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">检测</h2>
        {projectId && selectedSegment.end > selectedSegment.start && (
          <span className="text-xs text-muted-foreground tabular-nums">
            本次只对比 {formatDuration(selectedSegment.start)} - {formatDuration(selectedSegment.end)} / {selectedBpm} BPM
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
      <div className="rounded-md border border-border bg-muted/20 p-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>对比速度</span>
          <button
            type="button"
            className="text-[11px] font-medium text-teal-700 hover:text-teal-900 disabled:opacity-50"
            onClick={() => onBpmChange?.(originalBpm)}
            disabled={!onBpmChange}
          >
            用谱面 {originalBpm} BPM
          </button>
        </div>
        <input
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
          type="number"
          min={40}
          max={240}
          step={1}
          value={selectedBpm}
          onChange={(event) => onBpmChange?.(normalizeBpm(Number(event.target.value)))}
          disabled={!onBpmChange}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac"
        className="hidden"
        onChange={uploadRecording}
      />
      {!recording ? (
        <>
          <Button
            variant="default"
            size="sm"
            onClick={startRecording}
            disabled={!projectId || selectedSegment.end <= selectedSegment.start}
            className="w-full gap-1.5"
          >
            <Mic className="h-4 w-4" />
            开始录音
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!projectId || selectedSegment.end <= selectedSegment.start}
            className="w-full gap-1.5"
          >
            <Upload className="h-4 w-4" />
            上传录音对比
          </Button>
        </>
      ) : (
        <>
          <Button variant="destructive" size="sm" onClick={stopRecording} className="w-full gap-1.5">
            <Square className="h-3.5 w-3.5" />
            停止
          </Button>
          <span className="text-sm tabular-nums text-destructive animate-pulse">
            ● {formatDuration(duration)}
          </span>
        </>
      )}
      {audioUrl && !recording && (
        <div className="rounded-md border border-border bg-background p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {processedAudioReady ? "处理后音频" : uploadingAudio ? "原始音频（处理中...）" : "原始音频"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              onClick={downloadProcessedAudio}
              disabled={!processedAudioReady}
            >
              <Download className="h-3 w-3" />
              下载
            </Button>
          </div>
          <audio controls src={audioUrl} className="h-9 w-full" />
        </div>
      )}
      {!projectId && (
        <span className="text-xs text-muted-foreground">请先选择项目</span>
      )}
      {projectId && selectedSegment.end <= selectedSegment.start && (
        <span className="text-xs text-muted-foreground">请先解析乐谱生成对比范围</span>
      )}
      {projectId && selectedSegment.end > selectedSegment.start && (
        <span className="min-w-0 text-xs text-muted-foreground">
          本次只对比 {formatDuration(selectedSegment.start)} - {formatDuration(selectedSegment.end)} / {selectedBpm} BPM
        </span>
      )}
      </div>
    </div>
  );
}

function normalizeSegment(range?: [number, number]): Pick<CompareSegment, "start" | "end"> {
  const start = Math.max(0, Number(range?.[0] ?? 0));
  const end = Math.max(start, Number(range?.[1] ?? 0));
  return {
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
  };
}

function normalizeBpm(value: number): number {
  const bpm = Math.round(Number(value) || 120);
  return Math.max(40, Math.min(240, bpm));
}
