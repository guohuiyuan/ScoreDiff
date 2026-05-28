"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play, Repeat2, Square } from "lucide-react";
import { type PlaybackTimeline } from "@/lib/api";

interface PlaybackBarProps {
  timeline: PlaybackTimeline | null;
  instrument?: string;
  seekRequest?: { time: number; version: number };
  onTimeUpdate?: (time: number) => void;
  compareRange?: [number, number];
}

type InstrumentProfile = {
  label: string;
  waveform: OscillatorType;
  gain: number;
  attack: number;
  release: number;
  sustain: number;
};

export function PlaybackBar({
  timeline,
  instrument = "violin",
  seekRequest,
  onTimeUpdate,
  compareRange,
}: PlaybackBarProps) {
  const initialBpm = Math.round(Math.max(1, timeline?.bpm ?? 120));
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bpm, setBpm] = useState(initialBpm);
  const [bpmText, setBpmText] = useState(String(initialBpm));
  const animRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  const rateRef = useRef(1);
  const lastSeekVersionRef = useRef(0);
  const audioRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<OscillatorNode[]>([]);
  const scheduleAudioRef = useRef<(fromTime: number, playbackRate?: number, untilTime?: number) => Promise<void>>(async () => {});

  const totalDuration = timeline?.total_duration ?? 0;
  const baseBpm = Math.max(1, timeline?.bpm ?? 120);
  const selectedRange = normalizeRange(compareRange ?? [0, totalDuration], totalDuration);
  const selectedStart = selectedRange[0];
  const selectedEnd = selectedRange[1];

  const getAudioContext = useCallback(() => {
    if (!audioRef.current) {
      const audioWindow = window as Window & typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("当前浏览器不支持音频播放");
      }
      audioRef.current = new AudioContextClass();
    }
    return audioRef.current;
  }, []);

  const stopScheduledAudio = useCallback(() => {
    for (const oscillator of scheduledRef.current) {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
    }
    scheduledRef.current = [];
  }, []);

  const scheduleAudio = useCallback(async (
    fromTime: number,
    playbackRate: number = rateRef.current,
    untilTime: number = totalDuration,
  ) => {
    if (!timeline) return;
    const context = getAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    stopScheduledAudio();
    const rate = Math.max(0.25, playbackRate);
    const playUntil = Math.max(fromTime, Math.min(totalDuration, untilTime));
    const startAt = context.currentTime + 0.03;

    for (const event of timeline.events) {
      if (event.type === "rest" || event.pitches.length === 0) continue;
      if (event.time >= playUntil) continue;
      const eventEnd = Math.min(event.time + event.duration, playUntil);
      if (eventEnd <= fromTime) continue;

      const noteStart = startAt + Math.max(0, event.time - fromTime) / rate;
      const duration = Math.max(0.04, (eventEnd - Math.max(fromTime, event.time)) / rate);

      for (const pitch of event.pitches) {
        const profile = instrumentProfile(instrument);
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const attack = Math.min(profile.attack / rate, duration * 0.4);
        const release = Math.min(profile.release / rate, duration * 0.45);
        oscillator.type = profile.waveform;
        oscillator.frequency.value = midiToFrequency(pitch);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.linearRampToValueAtTime(profile.gain / Math.max(1, event.pitches.length), noteStart + attack);
        gain.gain.setValueAtTime(profile.sustain / Math.max(1, event.pitches.length), noteStart + Math.max(0.02, duration - release));
        gain.gain.linearRampToValueAtTime(0.0001, noteStart + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + duration + 0.02);
        scheduledRef.current.push(oscillator);
      }
    }
  }, [getAudioContext, instrument, stopScheduledAudio, timeline, totalDuration]);

  useEffect(() => {
    scheduleAudioRef.current = scheduleAudio;
  }, [scheduleAudio]);

  useEffect(() => {
    rateRef.current = bpm / baseBpm;
  }, [bpm, baseBpm]);

  useEffect(() => {
    if (!playing) return;
    const playStart = selectedEnd > selectedStart ? selectedStart : 0;
    const stopAt = selectedEnd > selectedStart ? selectedEnd : totalDuration;

    const tick = () => {
      const elapsed = ((performance.now() - startRef.current) / 1000) * rateRef.current + offsetRef.current;
      if (elapsed >= stopAt) {
        setCurrentTime(playStart);
        offsetRef.current = playStart;
        startRef.current = performance.now();
        onTimeUpdate?.(playStart);
        void scheduleAudioRef.current(playStart, rateRef.current, stopAt);
        animRef.current = requestAnimationFrame(tick);
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
  }, [playing, totalDuration, selectedStart, selectedEnd, onTimeUpdate, stopScheduledAudio]);

  async function handlePlayPause() {
    if (!timeline) return;
    if (playing) {
      setPlaying(false);
      stopScheduledAudio();
      return;
    }

    const playStart = selectedEnd > selectedStart ? selectedStart : 0;
    const playEnd = selectedEnd > selectedStart ? selectedEnd : totalDuration;
    const nextTime = currentTime < playStart || currentTime >= playEnd ? playStart : currentTime;
    setCurrentTime(nextTime);
    offsetRef.current = nextTime;
    startRef.current = performance.now();
    await scheduleAudio(nextTime, rateRef.current, playEnd);
    setPlaying(true);
  }

  function handleStop() {
    const resetTime = selectedEnd > selectedStart ? selectedStart : 0;
    setPlaying(false);
    stopScheduledAudio();
    setCurrentTime(resetTime);
    offsetRef.current = resetTime;
    onTimeUpdate?.(resetTime);
  }

  useEffect(() => {
    if (!seekRequest || seekRequest.version === lastSeekVersionRef.current) return;
    lastSeekVersionRef.current = seekRequest.version;
    const t = Math.max(0, Math.min(totalDuration, Number(seekRequest.time) || 0));
    setCurrentTime(t);
    offsetRef.current = t;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(t, rateRef.current, selectedEnd);
    }
    onTimeUpdate?.(t);
  }, [seekRequest, totalDuration, playing, selectedEnd, onTimeUpdate, scheduleAudio]);

  function applyBpm(value: number) {
    const nextBpm = Math.max(40, Math.min(240, Math.round(value)));
    const nextRate = nextBpm / baseBpm;
    rateRef.current = nextRate;
    setBpm(nextBpm);
    setBpmText(String(nextBpm));
    offsetRef.current = currentTime;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(currentTime, nextRate, selectedEnd);
    }
  }

  function commitBpmText() {
    const nextBpm = Number(bpmText);
    if (!bpmText.trim() || !Number.isFinite(nextBpm)) {
      setBpmText(String(bpm));
      return;
    }
    applyBpm(nextBpm);
  }

  function handleBpmKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setBpmText(String(bpm));
      event.currentTarget.blur();
    }
  }

  if (!timeline) {
    return (
      <div className="h-14 border-t border-border flex items-center justify-center px-4">
        <span className="text-xs text-muted-foreground">加载乐谱后可播放</span>
      </div>
    );
  }

  return (
    <div className="border-t border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={handlePlayPause}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={handleStop}
          aria-label="停止"
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
        <span className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-800">
          <Repeat2 className="h-3.5 w-3.5" />
          循环所选片段
        </span>
        <span className="text-xs text-muted-foreground">
          原始 {baseBpm}
        </span>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          BPM
          <input
            className="h-8 w-16 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            type="number"
            min={40}
            max={240}
            step={1}
            value={bpmText}
            onChange={(event) => setBpmText(event.target.value)}
            onBlur={commitBpmText}
            onKeyDown={handleBpmKeyDown}
          />
        </label>
        <span className="text-xs text-muted-foreground">
          {instrumentProfile(instrument).label}
        </span>
      </div>
    </div>
  );
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function instrumentProfile(instrument: string): InstrumentProfile {
  const profiles: Record<string, InstrumentProfile> = {
    violin: { label: "小提琴", waveform: "sawtooth", gain: 0.09, attack: 0.035, release: 0.08, sustain: 0.07 },
    piano: { label: "钢琴", waveform: "triangle", gain: 0.18, attack: 0.008, release: 0.18, sustain: 0.04 },
    flute: { label: "长笛", waveform: "sine", gain: 0.13, attack: 0.04, release: 0.09, sustain: 0.1 },
    guitar: { label: "吉他", waveform: "triangle", gain: 0.16, attack: 0.006, release: 0.14, sustain: 0.05 },
    cello: { label: "大提琴", waveform: "sawtooth", gain: 0.11, attack: 0.05, release: 0.12, sustain: 0.08 },
    clarinet: { label: "单簧管", waveform: "square", gain: 0.08, attack: 0.03, release: 0.08, sustain: 0.06 },
  };
  return profiles[instrument] ?? profiles.violin;
}

function normalizeRange(range: [number, number], totalDuration: number): [number, number] {
  const duration = Math.max(0, totalDuration);
  if (duration <= 0) return [0, 0];

  const lower = Math.max(0, Math.min(range[0], range[1], duration));
  const upper = Math.max(0, Math.min(Math.max(range[0], range[1]), duration));
  const minSpan = Math.min(0.1, duration);
  if (upper - lower >= minSpan) {
    return [roundTime(lower), roundTime(upper)];
  }

  const start = Math.min(Math.max(0, lower), Math.max(0, duration - minSpan));
  return [roundTime(start), roundTime(start + minSpan)];
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}
