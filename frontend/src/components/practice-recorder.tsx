"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface PracticeRecorderProps {
  projectId: string | null;
  onRecordingComplete?: (blob: Blob, filename: string) => void;
}

export function PracticeRecorder({ projectId, onRecordingComplete }: PracticeRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const startRecording = useCallback(async () => {
    if (!projectId) return;

    try {
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
        onRecordingComplete?.(blob, filename);
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
  }, [projectId, onRecordingComplete]);

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
    <div className="flex items-center gap-2 px-4 py-2 border-t border-border">
      {!recording ? (
        <Button
          variant="default"
          size="sm"
          onClick={startRecording}
          disabled={!projectId}
        >
          🎙 开始录音
        </Button>
      ) : (
        <>
          <Button variant="destructive" size="sm" onClick={stopRecording}>
            ⏹ 停止
          </Button>
          <span className="text-sm tabular-nums text-destructive animate-pulse">
            ● {formatDuration(duration)}
          </span>
        </>
      )}
      {audioUrl && !recording && (
        <audio controls src={audioUrl} className="h-8 ml-2" />
      )}
      {!projectId && (
        <span className="text-xs text-muted-foreground">请先选择项目</span>
      )}
    </div>
  );
}
