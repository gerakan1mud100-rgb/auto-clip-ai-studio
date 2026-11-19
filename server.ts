import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import multer from 'multer';
import { ZipArchive, type ArchiverError } from 'archiver';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  getGeminiEnvConfig,
  extractAudioForGemini,
  analyzeMomentsWithGemini,
  ViralMoment,
} from './geminiAnalyzer';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const OUTPUT_DIR = path.join(ROOT_DIR, 'outputs');
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const SAVED_COOKIES_PATH = path.join(BIN_DIR, 'youtube_cookies.txt');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

let resolvedFfmpegPath: string | null = null;
let resolvedFfprobePath: string | null = null;
let resolvedYtDlpPath: string | null = null;

async function canExecuteBinary(binPath: string, args = ['-version']): Promise<boolean> {
  try {
    if (binPath.includes(path.sep) && fs.existsSync(binPath)) {
      try {
        fs.chmodSync(binPath, 0o755);
      } catch {
        // Ignore if read-only fs
      }
    }
    await execFileAsync(binPath, args, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveMediaBinaries(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  if (!resolvedFfmpegPath) {
    const candidates = [ffmpegStatic, 'ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].filter(
      (x): x is string => Boolean(x)
    );
    for (const candidate of candidates) {
      if (await canExecuteBinary(candidate, ['-version'])) {
        resolvedFfmpegPath = candidate;
        break;
      }
    }
  }

  if (!resolvedFfprobePath) {
    const candidates = [
      ffprobeStatic?.path,
      'ffprobe',
      '/usr/bin/ffprobe',
      '/usr/local/bin/ffprobe',
    ].filter((x): x is string => Boolean(x));
    for (const candidate of candidates) {
      if (await canExecuteBinary(candidate, ['-version'])) {
        resolvedFfprobePath = candidate;
        break;
      }
    }
  }

  return { ffmpeg: resolvedFfmpegPath, ffprobe: resolvedFfprobePath };
}

function getYtDlpBinaryInfo() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return {
      filename: 'yt-dlp.exe',
      url: 'https://github.com',
    };
  }
  if (platform === 'darwin') {
    return {
      filename: 'yt-dlp_macos',
      url: 'https://github.com',
    };
  }
  if (arch === 'arm64') {
    return {
      filename: 'yt-dlp_linux_aarch64',
      url: 'https://github.com',
    };
  }
  return {
    filename: 'yt-dlp_linux',
    url: 'https://github.com',
  };
}

async function ensureYtDlp(): Promise<string> {
  if (resolvedYtDlpPath && (await canExecuteBinary(resolvedYtDlpPath, ['--version']))) {
    return resolvedYtDlpPath;
  }

  const { filename, url } = getYtDlpBinaryInfo();
  const localBin = path.join(BIN_DIR, filename);
  const candidates = [localBin, 'yt-dlp', 'yt-dlp.exe', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];

  for (const candidate of candidates) {
    if (await canExecuteBinary(candidate, ['--version'])) {
      resolvedYtDlpPath = candidate;
      return candidate;
    }
  }

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Gagal mengunduh engine ${filename} dari GitHub.`);
  }
  const fileStream = fs.createWriteStream(localBin);
  await pipeline(Readable.fromWeb(res.body as never), fileStream);

  if (process.platform !== 'win32') {
    fs.chmodSync(localBin, 0o755);
  }

  if (!(await canExecuteBinary(localBin, ['--version']))) {
    throw new Error(`Binary ${filename} tidak dapat dijalankan di sistem ini.`);
  }
  resolvedYtDlpPath = localBin;
  return localBin;
}


export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeMb: number;
  fps: number;
}

export interface ClipMeta {
  index: number;
  filename: string;
  start: number;
  end: number;
  duration: number;
  url: string;
  sizeMb: number;
  hook?: string;
  title?: string;
  viralScore?: number;
  viralReason?: string;
}

export interface SegmentItem {
  start: number;
  end: number;
  hook?: string;
  title?: string;
  viralScore?: number;
  viralReason?: string;
  keyQuote?: string;
}

interface PersistedJob {
  id: string;
  sourceName: string;
  aspect: string;
  createdAt: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  completed: number;
  total: number;
  overallPct: number;
  currentStep: string;
  clips: ClipMeta[];
  plannedSegments: SegmentItem[];
  error: string | null;
}

interface JobState extends PersistedJob {
  cancelled: boolean;
  activeProc: ChildProcess | null;
}

interface UploadSession {
  id: string;
  filename: string;
  filePath: string;
  totalSize: number;
  chunkSize: number;
  createdAt: number;
}

interface UrlImportJob {
  id: string;
  url: string;
  status: 'downloading' | 'probing' | 'done' | 'error' | 'cancelled';
  progressPct: number;
  statusText: string;
  filePath: string | null;
  filename: string | null;
  info: VideoInfo | null;
  error: string | null;
  needsCookies?: boolean;
  activeProc: ChildProcess | null;
}

const jobs = new Map<string, JobState>();
const uploadSessions = new Map<string, UploadSession>();
const urlImports = new Map<string, UrlImportJob>();

function getUploadSession(uploadId: string): UploadSession | null {
  const cached = uploadSessions.get(uploadId);
  if (cached) return cached;
  const metaPath = path.join(UPLOAD_DIR, `${uploadId}.session.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as UploadSession;
    uploadSessions.set(uploadId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function saveUploadSession(session: UploadSession) {
  uploadSessions.set(session.id, session);
  fs.writeFileSync(path.join(UPLOAD_DIR, `${session.id}.session.json`), JSON.stringify(session));
}

function persistJob(job: JobState) {
  try {
    const jobDir = path.join(OUTPUT_DIR, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const data: PersistedJob = {
      id: job.id,
      sourceName: job.sourceName,
      aspect: job.aspect,
      createdAt: job.createdAt,
      status: job.status,
      completed: job.completed,
      total: job.total,
      overallPct: job.overallPct,
      currentStep: job.currentStep,
      clips: job.clips,
      plannedSegments: job.plannedSegments,
      error: job.error,
    };
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(data, null, 2));
  } catch {
    // Best-effort persistence
  }
}

function loadExistingJobs() {
  try {
    const entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(OUTPUT_DIR, entry.name, 'job.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PersistedJob;
        if (parsed.status === 'running') {
          parsed.status = 'error';
          parsed.error = 'Server dimulai ulang saat pemrosesan berlangsung.';
          parsed.currentStep = 'Pemrosesan terhenti.';
        }
        parsed.clips = (parsed.clips || []).filter((c) =>
          fs.existsSync(path.join(OUTPUT_DIR, parsed.id, c.filename))
        );
        if (typeof parsed.overallPct !== 'number') {
          parsed.overallPct =
            parsed.total > 0 ? Math.round((parsed.completed / parsed.total) * 100) : 0;
        }
        jobs.set(parsed.id, {
          ...parsed,
          cancelled: false,
          activeProc: null,
        });
      } catch {
        // Ignore corrupt job file
      }
    }
  } catch {
    // Ignore
  }
}

function cleanupOldUploads() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const full = path.join(UPLOAD_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }
}

async function probeVideo(filePath: string): Promise<VideoInfo> {
  const { ffprobe } = await resolveMediaBinaries();
  if (!ffprobe) {
    throw new Error('FFprobe tidak tersedia di sistem.');
  }

  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const duration = Number(data?.format?.duration || 0);
  let width = 1920;
  let height = 1080;
  let hasAudio = false;
  let fps = 30;
  let hasVideo = false;

  for (const stream of data?.streams || []) {
    if (stream.codec_type === 'video' && !hasVideo) {
      hasVideo = true;
      width = Number(stream.width || 1920);
      height = Number(stream.height || 1080);
      const rateParts = String(stream.r_frame_rate || '30/1').split('/');
      if (rateParts.length === 2 && Number(rateParts[1]) > 0) {
        fps = Math.round(Number(rateParts[0]) / Number(rateParts[1])) || 30;
      }
    } else if (stream.codec_type === 'audio') {
      hasAudio = true;
    }
  }

  if (!hasVideo || duration <= 0) {
    throw new Error('File bukan video yang valid atau durasi tidak terbaca.');
  }

  const stat = fs.statSync(filePath);
  return {
    duration,
    width,
    height,
    hasAudio,
    fps,
    sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
  };
}

async function analyzeAudioEnergy(filePath: string, duration: number): Promise<number[]> {
  const { ffmpeg } = await resolveMediaBinaries();
  if (!ffmpeg) {
    return Array(Math.max(1, Math.floor(duration))).fill(1);
  }

  return new Promise((resolve) => {
    const sampleRate = 2000;
    const bytesPerSec = sampleRate * 2;
    const proc = spawn(ffmpeg, [
      '-v', 'quiet',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1',
    ]);

    const energies: number[] = [];
    let leftover = Buffer.alloc(0);

    proc.stdout.on('data', (chunk: Buffer) => {
      const combined = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (offset + bytesPerSec <= combined.length) {
        let sumSq = 0;
        const sampleCount = bytesPerSec / 2;
        for (let i = 0; i < bytesPerSec; i += 2) {
          const val = combined.readInt16LE(offset + i);
          sumSq += val * val;
        }
        energies.push(Math.sqrt(sumSq / sampleCount));
        offset += bytesPerSec;
      }
      leftover = Buffer.from(combined.subarray(offset));
    });

    proc.on('close', () => {
      if (leftover.length >= 2) {
        const usable = leftover.length - (leftover.length % 2);
        let sumSq = 0;
        const sampleCount = usable / 2;
        for (let i = 0; i < usable; i += 2) {
          const val = leftover.readInt16LE(i);
          sumSq += val * val;
        }
        energies.push(Math.sqrt(sumSq / sampleCount));
      }
      if (energies.length === 0) {
        resolve(Array(Math.max(1, Math.floor(duration))).fill(1));
      } else {
        resolve(energies);
      }
    });

    proc.on('error', () => {
      resolve(Array(Math.max(1, Math.floor(duration))).fill(1));
    });
  });
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function generateSegments(
  filePath: string,
  info: VideoInfo,
  mode: string,
  minDurInput: number,
  maxDurInput: number,
  targetCount: number
): Promise<Array<{ start: number; end: number }>> {
  const duration = info.duration;
  const minDur = Math.max(5, Math.min(minDurInput, Math.floor(duration)));
  const maxDur = Math.max(minDur, Math.min(maxDurInput, Math.floor(duration)));

  if (duration <= maxDur) {
    return [{ start: 0, end: Number(duration.toFixed(2)) }];
  }

  if (mode === 'auto_split') {
    const segments: Array<{ start: number; end: number }> = [];
    let pos = 0;
    while (pos < duration) {
      const rem = duration - pos;
      if (rem <= maxDur) {
        if (rem >= minDur || pos === 0) {
          segments.push({ start: Number(pos.toFixed(2)), end: Number(duration.toFixed(2)) });
        }
        break;
      } else if (rem < minDur + maxDur) {
        const segDur = Math.max(minDur, Math.min(maxDur, rem / 2));
        segments.push({ start: Number(pos.toFixed(2)), end: Number((pos + segDur).toFixed(2)) });
        pos += segDur;
      } else {
        const segDur = randomInt(minDur, maxDur);
        segments.push({ start: Number(pos.toFixed(2)), end: Number((pos + segDur).toFixed(2)) });
        pos += segDur;
      }
    }
    return segments;
  }

  if (mode === 'smart_highlights' && info.hasAudio) {
    const energies = await analyzeAudioEnergy(filePath, duration);
    const totalSecs = energies.length;
    const avgWin = Math.floor((minDur + maxDur) / 2);

    if (totalSecs <= avgWin) {
      return [{ start: 0, end: Number(Math.min(duration, maxDur).toFixed(2)) }];
    }

    const prefix = new Float64Array(totalSecs + 1);
    for (let i = 0; i < totalSecs; i++) {
      prefix[i + 1] = prefix[i] + energies[i];
    }

    const windowScores: Array<{ score: number; startSec: number }> = [];
    for (let s = 0; s <= totalSecs - avgWin; s++) {
      const score = (prefix[s + avgWin] - prefix[s]) / avgWin;
      windowScores.push({ score, startSec: s });
    }

    windowScores.sort((a, b) => b.score - a.score);

    const chosen: Array<{ start: number; end: number }> = [];
    for (const item of windowScores) {
      if (chosen.length >= targetCount) break;
      let startSec = item.startSec;
      const segDur = randomInt(minDur, maxDur);
      const endSec = Math.min(duration, startSec + segDur);
      if (endSec - startSec < minDur) {
        startSec = Math.max(0, endSec - minDur);
      }

      const overlaps = chosen.some(
        (c) => !(endSec <= c.start - 2 || startSec >= c.end + 2)
      );
      if (!overlaps) {
        chosen.push({
          start: Number(startSec.toFixed(2)),
          end: Number(endSec.toFixed(2)),
        });
      }
    }

    return chosen.sort((a, b) => a.start - b.start);
  }

  const maxPossible = Math.max(1, Math.floor(duration / minDur));
  const count = Math.min(Math.max(1, targetCount), maxPossible);
  const step = count > 1 ? (duration - minDur) / (count - 1) : 0;

  const segments: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const startSec = i === 0 ? pos : Math.max(pos, i * step);
    if (startSec + minDur > duration) break;
    const segDur = randomInt(minDur, maxDur);
    const endSec = Math.min(duration, startSec + segDur);
    segments.push({ start: Number(startSec.toFixed(2)), end: Number(endSec.toFixed(2)) });
    pos = endSec + 1;
  }

  return segments;
}

function getTargetDimensions(aspect: string, quality: string): [number, number] {
  const hd = quality === '1080p';
  if (aspect === '9:16') return hd ? [1080, 1920] : [720, 1280];
  if (aspect === '1:1') return hd ? [1080, 1080] : [720, 720];
  return hd ? [1920, 1080] : [1280, 720];
}

function buildFfmpegFilters(
  angle: string,
  animation: string,
  aspect: string,
  quality: string,
  clipDur: number,
  hasAudio: boolean
): { filterComplex: string; audioFilter: string | null } {
  const [W, H] = getTargetDimensions(aspect, quality);
  const chains: string[] = [];

  if (angle === 'blur_frame') {
    // Fast downscaled blur (~2.3x faster than full-res boxblur with identical smooth bokeh backdrop)
    const bw = Math.max(32, Math.round(W / 8 / 2) * 2);
    const bh = Math.max(32, Math.round(H / 8 / 2) * 2);
    chains.push(
      `[0:v]split[bg][fg];` +
        `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4:2,scale=${W}:${H}:flags=bilinear,setsar=1[bg_b];` +
        `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[fg_s];` +
        `[bg_b][fg_s]overlay=(W-w)/2:(H-h)/2,setsar=1[v_angle]`
    );
  } else if (angle === 'dynamic_pan') {
    const sw = Math.round(W * 1.12);
    const sh = Math.round(H * 1.12);
    chains.push(
      `[0:v]scale=${sw}:${sh}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:'(iw-ow)/2+(iw-ow)/2*sin(t*0.5)':'(ih-oh)/2',setsar=1[v_angle]`
    );
  } else if (angle === 'multi_angle') {
    const zw = Math.round(W * 1.32);
    const zh = Math.round(H * 1.32);
    chains.push(
      `[0:v]split[wide_in][close_in];` +
        `[wide_in]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[v_wide];` +
        `[close_in]scale=${zw}:${zh}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:'(iw-ow)/2':'(ih-oh)*0.35'[v_close];` +
        `[v_wide][v_close]overlay=0:0:enable='gt(sin(t*0.8),0)',setsar=1[v_angle]`
    );
  } else {
    chains.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[v_angle]`
    );
  }

  const fadeOutSt = Math.max(0.1, clipDur - 0.5).toFixed(2);
  if (animation === 'fade') {
    chains.push(
      `[v_angle]fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOutSt}:d=0.5[v_out]`
    );
  } else if (animation === 'zoom') {
    chains.push(
      `[v_angle]fps=24,zoompan=z='min(zoom+0.0008,1.15)':d=1:` +
        `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=24,` +
        `fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutSt}:d=0.5[v_out]`
    );
  } else if (animation === 'float') {
    const fw = Math.round(W * 1.08);
    const fh = Math.round(H * 1.08);
    chains.push(
      `[v_angle]scale=${fw}:${fh},` +
        `crop=${W}:${H}:'(iw-ow)/2+(iw-ow)/2*sin(t*1.3)':'(ih-oh)/2+(ih-oh)/2*cos(t*0.9)',` +
        `fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutSt}:d=0.5[v_out]`
    );
  } else if (animation === 'slide') {
    chains.push(
      `color=c=black:s=${W}x${H}:r=30:d=${clipDur.toFixed(2)}[slide_bg];` +
        `[v_angle]fps=30[v_angle_fps];` +
        `[slide_bg][v_angle_fps]overlay=x='min(0,-${W}+t*2*${W})':y=0:shortest=1,` +
        `fade=t=out:st=${fadeOutSt}:d=0.5[v_out]`
    );
  } else {
    chains.push(`[v_angle]null[v_out]`);
  }

  const audioFilter =
    hasAudio && animation !== 'none'
      ? `afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOutSt}:d=0.4`
      : null;

  return { filterComplex: chains.join(';'), audioFilter };
}

function runFfmpegClip(
  ffmpegBin: string,
  job: JobState,
  clipIdx: number,
  totalClips: number,
  clipDur: number,
  args: string[]
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, args);
    job.activeProc = proc;
    let stderr = '';
    let outBuf = '';

    proc.stdout.on('data', (d: Buffer) => {
      outBuf += d.toString();
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) {
          const us = Number(line.slice('out_time_us='.length));
          if (!Number.isNaN(us) && clipDur > 0) {
            const clipFrac = Math.min(0.99, Math.max(0, us / (clipDur * 1_000_000)));
            const overall = Math.min(
              99,
              Math.round((((clipIdx - 1) + clipFrac) / Math.max(1, totalClips)) * 100)
            );
            const clipPct = Math.round(clipFrac * 100);
            job.overallPct = overall;
            job.currentStep = `Merender Klip #${clipIdx} dari ${totalClips} (${clipPct}%)...`;
          }
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    proc.on('close', (code) => {
      job.activeProc = null;
      resolve({ code, stderr });
    });

    proc.on('error', (err) => {
      job.activeProc = null;
      resolve({ code: 1, stderr: err.message });
    });
  });
}

async function processJob(
  job: JobState,
  params: {
    filePath: string;
    info: VideoInfo;
    mode: string;
    minDur: number;
    maxDur: number;
    targetCount: number;
    aspect: string;
    angle: string;
    animation: string;
    quality: string;
    speedPreset: string;
    customSegments?: SegmentItem[];
  }
) {
  const jobOutDir = path.join(OUTPUT_DIR, job.id);
  fs.mkdirSync(jobOutDir, { recursive: true });

  try {
    const { ffmpeg } = await resolveMediaBinaries();
    if (!ffmpeg) {
      throw new Error('FFmpeg tidak ditemukan di sistem.');
    }

    job.currentStep = 'Menganalisis energi audio & menyusun daftar segmen klip...';
    persistJob(job);

    const segments: SegmentItem[] =
      params.customSegments && params.customSegments.length > 0
        ? params.customSegments
        : await generateSegments(
            params.filePath,
            params.info,
            params.mode,
            params.minDur,
            params.maxDur,
            params.targetCount
          );

    if (job.cancelled) {
      job.status = 'cancelled';
      job.currentStep = 'Proses dibatalkan oleh pengguna.';
      persistJob(job);
      return;
    }

    job.plannedSegments = segments;
    job.total = segments.length;
    job.currentStep = `Menyiapkan render ${segments.length} klip video...`;
    persistJob(job);

    for (let i = 0; i < segments.length; i++) {
      if (job.cancelled) {
        job.status = 'cancelled';
        job.currentStep = 'Proses dibatalkan oleh pengguna.';
        persistJob(job);
        return;
      }

      const idx = i + 1;
      const seg = segments[i];
      const clipDur = Number((seg.end - seg.start).toFixed(2));
      const outName = `autoclip_${String(idx).padStart(3, '0')}_${Math.floor(seg.start)}s-${Math.floor(seg.end)}s.mp4`;
      const outPath = path.join(jobOutDir, outName);

      job.currentStep = `Merender Klip #${idx} dari ${segments.length} (0%)...`;
      persistJob(job);

      const { filterComplex, audioFilter } = buildFfmpegFilters(
        params.angle,
        params.animation,
        params.aspect,
        params.quality,
        clipDur,
        params.info.hasAudio
      );

      const cmdArgs = [
        '-y',
        '-ss', String(seg.start),
        '-i', params.filePath,
        '-t', String(clipDur),
        '-threads', '0',
        '-filter_complex', filterComplex,
        '-map', '[v_out]',
      ];

      if (params.info.hasAudio) {
        cmdArgs.push('-map', '0:a?');
        if (audioFilter) {
          cmdArgs.push('-af', audioFilter);
        }
        cmdArgs.push('-c:a', 'aac', '-b:a', '128k');
      }

      cmdArgs.push(
        '-vsync', '1',
        '-c:v', 'libx264',
        '-preset', params.speedPreset,
        '-crf', '24',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats',
        outPath
      );

      const { code, stderr } = await runFfmpegClip(
        ffmpeg,
        job,
        idx,
        segments.length,
        clipDur,
        cmdArgs
      );

      if (job.cancelled) {
        job.status = 'cancelled';
        job.currentStep = 'Proses dibatalkan oleh pengguna.';
        persistJob(job);
        return;
      }

      if (code !== 0) {
        throw new Error(`FFmpeg gagal pada Klip #${idx}: ${stderr.slice(-300)}`);
      }

      const stat = fs.statSync(outPath);
      job.clips.push({
        index: idx,
        filename: outName,
        start: seg.start,
        end: seg.end,
        duration: Number(clipDur.toFixed(1)),
        url: `/outputs/${job.id}/${outName}`,
        sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
        hook: seg.hook,
        title: seg.title,
        viralScore: seg.viralScore,
        viralReason: seg.viralReason,
      });
      job.completed = idx;
      job.overallPct = Math.round((idx / segments.length) * 100);
      persistJob(job);
    }

    job.status = 'done';
    job.overallPct = 100;
    job.currentStep = `Selesai! ${segments.length} video pendek siap ditonton & diunduh.`;
    persistJob(job);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Terjadi kesalahan sistem.';
    job.status = 'error';
    job.error = message;
    job.currentStep = 'Gagal memproses video.';
    persistJob(job);
  }
}

function isDirectVideoFileUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return /\.(mp4|mov|mkv|webm|m4v)(\?|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function getEffectiveYouTubeCookies(overrideCookies?: string): string | null {
  if (overrideCookies && overrideCookies.trim().length > 0) {
    return overrideCookies.trim();
  }
  if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim().length > 0) {
    return process.env.YOUTUBE_COOKIES.trim();
  }
  if (fs.existsSync(SAVED_COOKIES_PATH)) {
    const content = fs.readFileSync(SAVED_COOKIES_PATH, 'utf-8').trim();
    if (content.length > 0) return content;
  }
  return null;
}

async function runUrlImport(importJob: UrlImportJob, cookiesTxt?: string) {
  let tempCookieFilePath: string | null = null;
  try {
    const { ffmpeg } = await resolveMediaBinaries();

    if (isDirectVideoFileUrl(importJob.url)) {
      importJob.statusText = 'Mengunduh file video langsung dari URL...';
      const extMatch = new URL(importJob.url).pathname.match(/\.(mp4|mov|mkv|webm|m4v)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
      const targetPath = path.join(UPLOAD_DIR, `url_${importJob.id}.${ext}`);

      const res = await fetch(importJob.url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`Gagal mengunduh URL video (HTTP ${res.status}).`);
      }

      const totalBytes = Number(res.headers.get('content-length') || 0);
      let downloaded = 0;
      const writer = fs.createWriteStream(targetPath);

      for await (const chunk of Readable.fromWeb(res.body as never)) {
        if (importJob.status === 'cancelled') {
          writer.close();
          if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloaded += buf.length;
        writer.write(buf);
        if (totalBytes > 0) {
          importJob.progressPct = Math.min(98, Math.round((downloaded / totalBytes) * 100));
          importJob.statusText = `Mengunduh ${(downloaded / (1024 * 1024)).toFixed(1)} MB...`;
        }
      }
      await new Promise<void>((resolve) => writer.end(() => resolve()));

      importJob.status = 'probing';
      importJob.progressPct = 99;
      importJob.statusText = 'Memeriksa metadata video...';
      const info = await probeVideo(targetPath);
      importJob.filePath = targetPath;
      importJob.filename =
        path.basename(new URL(importJob.url).pathname) || `video_${importJob.id}.mp4`;
      importJob.info = info;
      importJob.progressPct = 100;
      importJob.status = 'done';
      importJob.statusText = 'Video berhasil dimuat dari URL.';
      return;
    }

    importJob.statusText = 'Menyiapkan engine pengunduh YouTube...';
    const ytdlpBin = await ensureYtDlp();

    const outTemplate = path.join(UPLOAD_DIR, `yt_${importJob.id}_%(title).60B.%(ext)s`);
    const args = [
      '--no-playlist',
      '--newline',
      '--no-warnings',
      '--js-runtimes',
      'node',
      '-f',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best',
      '--merge-output-format',
      'mp4',
      '-o',
      outTemplate,
    ];

    if (ffmpeg) {
      args.push('--ffmpeg-location', ffmpeg);
    }

    if (process.env.YOUTUBE_PROXY && process.env.YOUTUBE_PROXY.trim()) {
      args.push('--proxy', process.env.YOUTUBE_PROXY.trim());
    }

    const effectiveCookies = getEffectiveYouTubeCookies(cookiesTxt);
    if (effectiveCookies) {
      tempCookieFilePath = path.join(UPLOAD_DIR, `cookies_${importJob.id}.txt`);
      fs.writeFileSync(tempCookieFilePath, effectiveCookies, 'utf-8');
      args.push('--cookies', tempCookieFilePath);
    }

    args.push(importJob.url);

    importJob.statusText = 'Mengambil informasi & mengunduh video YouTube...';

    const { code, stderr, stdout } = await new Promise<{
      code: number | null;
      stderr: string;
      stdout: string;
    }>((resolve) => {
      const proc = spawn(ytdlpBin, args);
      importJob.activeProc = proc;
      let outBuf = '';
      let errBuf = '';

      const handleLine = (line: string) => {
        const pctMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (pctMatch) {
          const pct = Math.min(98, Math.round(Number(pctMatch[1])));
          importJob.progressPct = pct;
          importJob.statusText = `Mengunduh video YouTube (${pct}%)...`;
        } else if (line.includes('[Merger]') || line.includes('Merging formats')) {
          importJob.statusText = 'Menggabungkan video & audio MP4...';
        }
      };

      proc.stdout.on('data', (d: Buffer) => {
        const text = d.toString();
        outBuf += text;
        text.split(/\r?\n/).forEach(handleLine);
      });

      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        errBuf += text;
        text.split(/\r?\n/).forEach(handleLine);
      });

      proc.on('close', (exitCode) => {
        importJob.activeProc = null;
        resolve({ code: exitCode, stderr: errBuf, stdout: outBuf });
      });

      proc.on('error', (err) => {
        importJob.activeProc = null;
        resolve({ code: 1, stderr: err.message, stdout: outBuf });
      });
    });

    if (importJob.status === 'cancelled') {
      return;
    }

    if (code !== 0) {
      const combinedErr = `${stderr}\n${stdout}`;
      if (
        combinedErr.includes('Sign in to confirm') ||
        combinedErr.includes('not a bot') ||
        combinedErr.includes('--cookies')
      ) {
        importJob.needsCookies = true;
        throw new Error(
          'Server Cloud dibatasi verifikasi anti-bot YouTube. Simpan file cookies.txt YouTube sekali saja di panel Cookies YouTube di bawah agar semua link YouTube berjalan otomatis.'
        );
      }
      throw new Error(stderr.trim().slice(-260) || 'Gagal mengunduh video dari link YouTube.');
    }

    const prefix = `yt_${importJob.id}_`;
    const matchedFile = fs
      .readdirSync(UPLOAD_DIR)
      .find((f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

    if (!matchedFile) {
      throw new Error('File hasil unduhan YouTube tidak ditemukan.');
    }

    const fullPath = path.join(UPLOAD_DIR, matchedFile);
    importJob.status = 'probing';
    importJob.progressPct = 99;
    importJob.statusText = 'Membaca metadata video...';

    const info = await probeVideo(fullPath);
    importJob.filePath = fullPath;
    importJob.filename = matchedFile.replace(prefix, '');
    importJob.info = info;
    importJob.progressPct = 100;
    importJob.status = 'done';
    importJob.statusText = 'Video YouTube berhasil dimuat!';
  } catch (err: unknown) {
    if (importJob.status === 'cancelled') return;
    importJob.status = 'error';
    importJob.error = err instanceof Error ? err.message : 'Gagal mengunduh dari URL.';
    importJob.statusText = 'Gagal memuat video dari link.';
  } finally {
    if (tempCookieFilePath && fs.existsSync(tempCookieFilePath)) {
      try {
        fs.unlinkSync(tempCookieFilePath);
      } catch {
        // Ignore
      }
    }
  }
}

async function startServer() {
  await resolveMediaBinaries();
  loadExistingJobs();
  cleanupOldUploads();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  const diskStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${crypto.randomBytes(4).toString('hex')}_${safe}`);
    },
  });

  const directUpload = multer({
    storage: diskStorage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 },
  });

  const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 24 * 1024 * 1024 },
  });

  app.get('/api/health', async (req, res) => {
    const { ffmpeg, ffprobe } = await resolveMediaBinaries();
    const envAppUrl = process.env.APP_URL;
    const validEnvUrl =
      envAppUrl && envAppUrl !== 'MY_APP_URL' && envAppUrl.startsWith('http')
        ? envAppUrl.replace(/\/$/, '')
        : null;
    const derivedUrl = `${req.protocol}://${req.get('host')}`;
    const hasEnvCookies = Boolean(process.env.YOUTUBE_COOKIES?.trim());
    const hasFileCookies = fs.existsSync(SAVED_COOKIES_PATH);
    res.json({
      ffmpegReady: Boolean(ffmpeg && ffprobe),
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      appUrl: validEnvUrl || derivedUrl,
      youtubeCookiesSaved: hasEnvCookies || hasFileCookies,
    });
  });

  // Save/Check/Delete server-side YouTube cookies (1-time setup for all devices)
  app.get('/api/youtube/cookies/status', (_req, res) => {
    const hasEnv = Boolean(process.env.YOUTUBE_COOKIES?.trim());
    const hasFile = fs.existsSync(SAVED_COOKIES_PATH);
    res.json({
      saved: hasEnv || hasFile,
      source: hasEnv ? 'env' : hasFile ? 'file' : null,
    });
  });

  app.post('/api/youtube/cookies', (req, res) => {
    const raw = String(req.body?.cookiesTxt || '').trim();
    if (!raw || raw.length < 20) {
      res.status(400).json({ error: 'Isi cookies.txt YouTube tidak valid atau terlalu pendek.' });
      return;
    }
    fs.writeFileSync(SAVED_COOKIES_PATH, raw, 'utf-8');
    res.json({ ok: true, saved: true });
  });

  app.delete('/api/youtube/cookies', (_req, res) => {
    if (fs.existsSync(SAVED_COOKIES_PATH)) {
      fs.unlinkSync(SAVED_COOKIES_PATH);
    }
    res.json({ ok: true, saved: Boolean(process.env.YOUTUBE_COOKIES?.trim()) });
  });

  // YouTube / Direct Video URL Import
  app.post('/api/import-url', (req, res) => {
    const rawUrl = String(req.body?.url || '').trim();
    const cookiesTxt = typeof req.body?.cookiesTxt === 'string' ? req.body.cookiesTxt : undefined;

    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).json({ error: 'Gunakan link http:// atau https:// yang valid.' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Format link YouTube atau URL video tidak valid.' });
      return;
    }

    const importId = crypto.randomBytes(5).toString('hex');
    const importJob: UrlImportJob = {
      id: importId,
      url: rawUrl,
      status: 'downloading',
      progressPct: 0,
      statusText: 'Memulai pengunduhan video...',
      filePath: null,
      filename: null,
      info: null,
      error: null,
      activeProc: null,
    };

    urlImports.set(importId, importJob);
    void runUrlImport(importJob, cookiesTxt);
    res.json({ importId });
  });

  app.get('/api/import-url/status/:importId', (req, res) => {
    const imp = urlImports.get(req.params.importId);
    if (!imp) {
      res.status(404).json({ error: 'Sesi impor link tidak ditemukan.' });
      return;
    }
    res.json({
      id: imp.id,
      status: imp.status,
      progressPct: imp.progressPct,
      statusText: imp.statusText,
      filePath: imp.filePath,
      filename: imp.filename,
      info: imp.info,
      error: imp.error,
      needsCookies: Boolean(imp.needsCookies),
    });
  });

  app.post('/api/import-url/cancel/:importId', (req, res) => {
    const imp = urlImports.get(req.params.importId);
    if (!imp) {
      res.status(404).json({ error: 'Sesi impor tidak ditemukan.' });
      return;
    }
    imp.status = 'cancelled';
    if (imp.activeProc) {
      imp.activeProc.kill('SIGTERM');
    }
    res.json({ ok: true });
  });

  // Parallel-Safe Chunked Upload
  app.post('/api/upload/init', (req, res) => {
    const filename = String(req.body?.filename || 'video.mp4');
    const totalSize = Number(req.body?.totalSize || 0);
    const chunkSize = Number(req.body?.chunkSize || 4 * 1024 * 1024);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadId = crypto.randomBytes(6).toString('hex');
    const filePath = path.join(UPLOAD_DIR, `${uploadId}_${safeName}`);

    fs.writeFileSync(filePath, Buffer.alloc(0));

    saveUploadSession({
      id: uploadId,
      filename,
      filePath,
      totalSize,
      chunkSize,
      createdAt: Date.now(),
    });

    res.json({ uploadId });
  });

  app.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
    const uploadId = String(req.body?.uploadId || '');
    const chunkIndex = Number(req.body?.chunkIndex ?? -1);
    const session = getUploadSession(uploadId);

    if (!session || chunkIndex < 0 || !req.file) {
      res.status(400).json({ error: 'Sesi upload atau potongan data tidak valid.' });
      return;
    }

    try {
      const offset = chunkIndex * session.chunkSize;
      const handle = await fs.promises.open(session.filePath, 'r+');
      try {
        await handle.write(req.file.buffer, 0, req.file.buffer.length, offset);
      } finally {
        await handle.close();
      }
      res.json({ ok: true, chunkIndex });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal menyimpan potongan video.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/upload/complete', async (req, res) => {
    const uploadId = String(req.body?.uploadId || '');
    const session = getUploadSession(uploadId);
    if (!session) {
      res.status(404).json({ error: 'Sesi upload tidak ditemukan.' });
      return;
    }

    const metaPath = path.join(UPLOAD_DIR, `${uploadId}.session.json`);
    try {
      const info = await probeVideo(session.filePath);
      uploadSessions.delete(uploadId);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      res.json({
        filePath: session.filePath,
        filename: session.filename,
        info,
      });
    } catch (err: unknown) {
      try {
        if (fs.existsSync(session.filePath)) fs.unlinkSync(session.filePath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      } catch {
        // Ignore cleanup failure
      }
      uploadSessions.delete(uploadId);
      const message = err instanceof Error ? err.message : 'Gagal membaca metadata video.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/upload', directUpload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Tidak ada file video yang diunggah.' });
        return;
      }
      const info = await probeVideo(req.file.path);
      res.json({
        filePath: req.file.path,
        filename: req.file.originalname,
        info,
      });
    } catch (err: unknown) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      const message = err instanceof Error ? err.message : 'Gagal membaca metadata video.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/probe-local', async (req, res) => {
    try {
      const rawPath = String(req.body?.path || '').trim().replace(/^["']|["']$/g, '');
      if (!rawPath || !fs.existsSync(rawPath) || !fs.statSync(rawPath).isFile()) {
        res.status(404).json({ error: 'File video tidak ditemukan pada path tersebut.' });
        return;
      }
      const info = await probeVideo(rawPath);
      res.json({
        filePath: rawPath,
        filename: path.basename(rawPath),
        info,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal membaca file video lokal.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/create-sample', async (_req, res) => {
    try {
      const { ffmpeg } = await resolveMediaBinaries();
      if (!ffmpeg) {
        res.status(500).json({ error: 'Mesin FFmpeg belum tersedia.' });
        return;
      }
      const samplePath = path.join(UPLOAD_DIR, `sample_autoclip_${Date.now()}.mp4`);
      await execFileAsync(ffmpeg, [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc2=size=1280x720:rate=30:duration=105',
        '-f', 'lavfi',
        '-i', 'aevalsrc=0.35*sin(2*PI*220*t)*(0.3+0.7*abs(sin(t*0.18))):s=44100:d=105',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '96k',
        samplePath,
      ]);
      const info = await probeVideo(samplePath);
      res.json({
        filePath: samplePath,
        filename: 'Video_Sampel_AutoClip_105dtk.mp4',
        info,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal membuat video sampel.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/gemini/config', (_req, res) => {
    const config = getGeminiEnvConfig();
    res.json(config);
  });

  app.post('/api/gemini/analyze', async (req, res) => {
    try {
      const { ffmpeg } = await resolveMediaBinaries();
      if (!ffmpeg) {
        res.status(500).json({ error: 'FFmpeg tidak terdeteksi pada sistem.' });
        return;
      }
      const filePath = String(req.body?.filePath || '');
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(400).json({ error: 'File video tidak ditemukan.' });
        return;
      }

      const info = await probeVideo(filePath);
      if (!info.hasAudio) {
        res.status(400).json({ error: 'Video ini tidak memiliki trek audio untuk dianalisis.' });
        return;
      }

      const minDur = Number(req.body?.minDur) || 35;
      const maxDur = Number(req.body?.maxDur) || 60;
      const targetCount = Number(req.body?.targetCount) || 5;
      const apiKey = req.body?.apiKey ? String(req.body.apiKey) : undefined;

      const audioPath = await extractAudioForGemini(filePath, ffmpeg, UPLOAD_DIR);

      try {
        const moments = await analyzeMomentsWithGemini({
          audioPath,
          videoDuration: info.duration,
          minDur,
          maxDur,
          targetCount,
          apiKey,
        });

        res.json({ moments });
      } finally {
        if (fs.existsSync(audioPath)) {
          try {
            fs.unlinkSync(audioPath);
          } catch {
            // Abaikan gagal unlink temp
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal menganalisis momen viral dengan AI.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/start', async (req, res) => {
    const { ffmpeg, ffprobe } = await resolveMediaBinaries();
    if (!ffmpeg || !ffprobe) {
      res.status(500).json({ error: 'FFmpeg tidak terdeteksi pada sistem.' });
      return;
    }

    const filePath = String(req.body?.filePath || '');
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(400).json({ error: 'Sumber video tidak valid atau belum dipilih.' });
      return;
    }

    try {
      const info = await probeVideo(filePath);
      const jobId = crypto.randomBytes(5).toString('hex');
      const minDur = Math.max(35, Math.min(55, Number(req.body?.minDur || 35)));
      const maxDur = Math.max(minDur, Math.min(60, Number(req.body?.maxDur || 60)));
      const aspect = String(req.body?.aspect || '9:16');
      const sourceName = String(req.body?.sourceName || path.basename(filePath));

      const job: JobState = {
        id: jobId,
        sourceName,
        aspect,
        createdAt: Date.now(),
        status: 'running',
        completed: 0,
        total: 0,
        overallPct: 0,
        currentStep: 'Memulai mesin Auto Clip...',
        clips: [],
        plannedSegments: [],
        error: null,
        cancelled: false,
        activeProc: null,
      };

      jobs.set(jobId, job);
      persistJob(job);

      const customSegments: SegmentItem[] | undefined = Array.isArray(req.body?.customSegments)
        ? req.body.customSegments
        : undefined;

      void processJob(job, {
        filePath,
        info,
        mode: String(req.body?.mode || (customSegments?.length ? 'ai_viral_moments' : 'smart_highlights')),
        minDur,
        maxDur,
        targetCount: Math.max(1, Math.min(120, Number(req.body?.targetCount || (customSegments ? customSegments.length : 12)))),
        aspect,
        angle: String(req.body?.angle || 'blur_frame'),
        animation: String(req.body?.animation || 'fade'),
        quality: String(req.body?.quality || '720p'),
        speedPreset: String(req.body?.speedPreset || 'ultrafast'),
        customSegments,
      });

      res.json({ jobId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal memulai pemotongan video.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/jobs', (_req, res) => {
    const list = Array.from(jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12)
      .map((j) => ({
        id: j.id,
        sourceName: j.sourceName,
        aspect: j.aspect,
        createdAt: j.createdAt,
        status: j.status,
        completed: j.completed,
        total: j.total,
        clipCount: j.clips.length,
      }));
    res.json({ jobs: list });
  });

  app.get('/api/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job tidak ditemukan.' });
      return;
    }
    res.json({
      id: job.id,
      sourceName: job.sourceName,
      aspect: job.aspect,
      status: job.status,
      completed: job.completed,
      total: job.total,
      overallPct: job.overallPct,
      currentStep: job.currentStep,
      clips: job.clips,
      plannedSegments: job.plannedSegments,
      error: job.error,
    });
  });

  app.post('/api/cancel/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job tidak ditemukan.' });
      return;
    }
    job.cancelled = true;
    if (job.activeProc) {
      job.activeProc.kill('SIGTERM');
    }
    persistJob(job);
    res.json({ ok: true });
  });

  app.delete('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job?.activeProc) {
      job.cancelled = true;
      job.activeProc.kill('SIGTERM');
    }
    jobs.delete(req.params.jobId);
    const jobDir = path.join(OUTPUT_DIR, req.params.jobId);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
    res.json({ ok: true });
  });

  app.get('/api/download-zip/:jobId', (req, res) => {
    const jobDir = path.join(OUTPUT_DIR, req.params.jobId);
    if (!fs.existsSync(jobDir)) {
      res.status(404).json({ error: 'Folder hasil tidak ditemukan.' });
      return;
    }

    const files = fs.readdirSync(jobDir).filter((f) => f.endsWith('.mp4')).sort();
    if (files.length === 0) {
      res.status(404).json({ error: 'Belum ada klip video yang tersedia.' });
      return;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="AutoClip_${req.params.jobId}.zip"`);

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('error', (err: ArchiverError) => {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
    archive.pipe(res);

    for (const file of files) {
      archive.file(path.join(jobDir, file), { name: file });
    }
    void archive.finalize();
  });

  app.use('/outputs', express.static(OUTPUT_DIR));

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Auto Clip.Ai Studio server listening on http://0.0.0.0:${PORT}`);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
}

void startServer();
