"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { type PlaybackTimeline } from "@/lib/api";

interface PlaybackBarProps {
  timeline: PlaybackTimeline | null;
  onTimeUpdate?: (time: number) => void;
}

export function PlaybackBar({ timeline, onTimeUpdate }: PlaybackBarProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const animRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);

  const totalDuration = timeline?.total_duration ?? 0;

  useEffect(() => {
    if (!playing) return;

    const tick = () => {
      const elapsed = (performance.now() - startRef.current) / 1000 + offsetRef.current;
      if (elapsed >= totalDuration) {
        setCurrentTime(totalDuration);
        setPlaying(false);
        onTimeUpdate?.(totalDuration);
        return;
      }
      setCurrentTime(elapsed);
      onTimeUpdate?.(elapsed);
      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      animRef.current = null;
    };
  }, [playing, totalDuration, onTimeUpdate]);

  function handlePlayPause() {
    if (!timeline) return;
    if (playing) {
      setPlaying(false);
      return;
    }

    const nextTime = currentTime >= totalDuration ? 0 : currentTime;
    setCurrentTime(nextTime);
    offsetRef.current = nextTime;
    startRef.current = performance.now();
    setPlaying(true);
  }

  function handleStop() {
    setPlaying(false);
    setCurrentTime(0);
    offsetRef.current = 0;
    onTimeUpdate?.(0);
  }

  function handleSeek(value: number | readonly number[]) {
    const t = Array.isArray(value) ? value[0] : value;
    setCurrentTime(t);
    offsetRef.current = t;
    startRef.current = performance.now();
    onTimeUpdate?.(t);
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (!timeline) {
    return (
      <div className="h-12 border-t border-border flex items-center justify-center px-4">
        <span className="text-xs text-muted-foreground">加载乐谱后可播放</span>
      </div>
    );
  }

  return (
    <div className="h-12 border-t border-border flex items-center gap-3 px-4">
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={handlePlayPause}>
        {playing ? "⏸" : "▶"}
      </Button>
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={handleStop}>
        ⏹
      </Button>
      <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
        {formatTime(currentTime)}
      </span>
      <Slider
        className="flex-1"
        min={0}
        max={totalDuration}
        step={0.1}
        value={[currentTime]}
        onValueChange={handleSeek}
      />
      <span className="text-xs text-muted-foreground w-10 tabular-nums">
        {formatTime(totalDuration)}
      </span>
      <span className="text-xs text-muted-foreground">
        {timeline.bpm} BPM
      </span>
    </div>
  );
}
