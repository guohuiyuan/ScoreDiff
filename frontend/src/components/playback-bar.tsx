"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { type PlaybackTimeline } from "@/lib/api";

interface PlaybackBarProps {
  timeline: PlaybackTimeline | null;
  instrument?: string;
  seekRequest?: { time: number; version: number };
  onTimeUpdate?: (time: number) => void;
}

type InstrumentProfile = {
  label: string;
  waveform: OscillatorType;
  gain: number;
  attack: number;
  release: number;
  sustain: number;
};

export function PlaybackBar({ timeline, instrument = "violin", seekRequest, onTimeUpdate }: PlaybackBarProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bpm, setBpm] = useState(120);
  const animRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const offsetRef = useRef<number>(0);
  const rateRef = useRef(1);
  const lastSeekVersionRef = useRef(0);
  const audioRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<OscillatorNode[]>([]);

  const totalDuration = timeline?.total_duration ?? 0;
  const baseBpm = Math.max(1, timeline?.bpm ?? 120);

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

  const scheduleAudio = useCallback(async (fromTime: number, playbackRate: number = rateRef.current) => {
    if (!timeline) return;
    const context = getAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    stopScheduledAudio();
    const rate = Math.max(0.25, playbackRate);
    const startAt = context.currentTime + 0.03;

    for (const event of timeline.events) {
      if (event.type === "rest" || event.pitches.length === 0) continue;
      const eventEnd = event.time + event.duration;
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
  }, [getAudioContext, instrument, stopScheduledAudio, timeline]);

  useEffect(() => {
    rateRef.current = bpm / baseBpm;
  }, [bpm, baseBpm]);

  useEffect(() => {
    if (!playing) return;

    const tick = () => {
      const elapsed = ((performance.now() - startRef.current) / 1000) * rateRef.current + offsetRef.current;
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
  }, [playing, totalDuration, onTimeUpdate, stopScheduledAudio]);

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
    seekTo(t);
  }

  function seekTo(time: number) {
    const t = Math.max(0, Math.min(totalDuration, Number(time) || 0));
    setCurrentTime(t);
    offsetRef.current = t;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(t);
    }
    onTimeUpdate?.(t);
  }

  useEffect(() => {
    if (!seekRequest || seekRequest.version === lastSeekVersionRef.current) return;
    lastSeekVersionRef.current = seekRequest.version;
    const t = Math.max(0, Math.min(totalDuration, Number(seekRequest.time) || 0));
    setCurrentTime(t);
    offsetRef.current = t;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(t);
    }
    onTimeUpdate?.(t);
  }, [seekRequest, totalDuration, playing, onTimeUpdate, scheduleAudio]);

  function handleBpmChange(value: string) {
    const nextBpm = Math.max(40, Math.min(240, Math.round(Number(value) || baseBpm)));
    const nextRate = nextBpm / baseBpm;
    rateRef.current = nextRate;
    setBpm(nextBpm);
    offsetRef.current = currentTime;
    startRef.current = performance.now();
    if (playing) {
      void scheduleAudio(currentTime, nextRate);
    }
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
          value={bpm}
          onChange={(event) => handleBpmChange(event.target.value)}
        />
      </label>
      <span className="text-xs text-muted-foreground">
        {instrumentProfile(instrument).label}
      </span>
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
