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
  const audioRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<OscillatorNode[]>([]);

  const totalDuration = timeline?.total_duration ?? 0;

  function getAudioContext() {
    if (!audioRef.current) {
      const audioWindow = window as Window & typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("AudioContext is not supported in this browser");
      }
      audioRef.current = new AudioContextClass();
    }
    return audioRef.current;
  }

  function stopScheduledAudio() {
    for (const oscillator of scheduledRef.current) {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
    }
    scheduledRef.current = [];
  }

  async function scheduleAudio(fromTime: number) {
    if (!timeline) return;
    const context = getAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    stopScheduledAudio();
    const startAt = context.currentTime + 0.03;

    for (const event of timeline.events) {
      if (event.type === "rest" || event.pitches.length === 0) continue;
      const eventEnd = event.time + event.duration;
      if (eventEnd <= fromTime) continue;

      const noteStart = startAt + Math.max(0, event.time - fromTime);
      const duration = Math.max(0.08, eventEnd - Math.max(fromTime, event.time));

      for (const pitch of event.pitches) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.value = midiToFrequency(pitch);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(0.14 / Math.max(1, event.pitches.length), noteStart + 0.015);
        gain.gain.setValueAtTime(0.12 / Math.max(1, event.pitches.length), noteStart + Math.max(0.02, duration - 0.05));
        gain.gain.linearRampToValueAtTime(0.0001, noteStart + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + duration + 0.02);
        scheduledRef.current.push(oscillator);
      }
    }
  }

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
      stopScheduledAudio();
    };
  }, [playing, totalDuration, onTimeUpdate]);

  async function handlePlayPause() {
    if (!timeline) return;
    if (playing) {
      setPlaying(false);
      stopScheduledAudio();
      return;
    }

    const nextTime = currentTime >= totalDuration ? 0 : currentTime;
    setCurrentTime(nextTime);
    offsetRef.current = nextTime;
    startRef.current = performance.now();
    await scheduleAudio(nextTime);
    setPlaying(true);
  }

  function handleStop() {
    setPlaying(false);
    stopScheduledAudio();
    setCurrentTime(0);
    offsetRef.current = 0;
    onTimeUpdate?.(0);
  }

  function handleSeek(value: number | readonly number[]) {
    const t = Array.isArray(value) ? value[0] : value;
    setCurrentTime(t);
    offsetRef.current = t;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(t);
    }
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

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
