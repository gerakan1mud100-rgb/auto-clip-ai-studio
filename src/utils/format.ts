import type { ClipMode } from '../types';

export function formatDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

export function formatReadableDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} jam ${m} mnt ${s} dtk`;
  if (m > 0) return `${m} mnt ${s} dtk`;
  return `${s} dtk`;
}

export function estimateClipCount(
  durationSec: number,
  mode: ClipMode,
  minDur: number,
  maxDur: number,
  targetCount: number
): number {
  if (durationSec <= 0) return 0;
  if (durationSec <= maxDur) return 1;
  const avg = (minDur + maxDur) / 2;
  const maxPossible = Math.max(1, Math.floor(durationSec / avg));
  if (mode === 'auto_split') {
    return maxPossible;
  }
  return Math.min(targetCount, Math.max(1, Math.floor(durationSec / minDur)));
}
