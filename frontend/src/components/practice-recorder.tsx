"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square } from "lucide-react";
import { type CompareSegment } from "@/lib/api";

interface PracticeRecorderProps {
  projectId: string | null;
  compareRange?: [number, number];
  onRecordingComplete?: (blob: Blob, filename: string, segment: Pick<CompareSegment, "start" | "end">) => void;
}

export function PracticeRecorder({ projectId, compareRange, onRecordingComplete }: PracticeRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const segmentRef = useRef<Pick<CompareSegment, "start" | "end">>({ start: 0, end: 0 });
  const selectedSegment = normalizeSegment(compareRange);

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
        onRecordingComplete?.(blob, filename, segmentRef.current);
      };

      recorder.start(250);
      startTimeRef.current = Date.now();
      setDuration(0);
      setAudioUrl(null);
      setRecording(true);

      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 200);
    } catch {
      alert("无法访问麦克风，请检查浏览器权限设置");
    }
  }, [projectId, selectedSegment, onRecordingComplete]);

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
            {formatDuration(selectedSegment.start)} - {formatDuration(selectedSegment.end)}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">
      {!recording ? (
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
        <audio controls src={audioUrl} className="h-9 w-full" />
      )}
      {!projectId && (
        <span className="text-xs text-muted-foreground">请先选择项目</span>
      )}
      {projectId && selectedSegment.end <= selectedSegment.start && (
        <span className="text-xs text-muted-foreground">请先解析乐谱生成对比范围</span>
      )}
      {projectId && selectedSegment.end > selectedSegment.start && (
        <span className="min-w-0 text-xs text-muted-foreground">
          本次只对比 {formatDuration(selectedSegment.start)} - {formatDuration(selectedSegment.end)}
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
