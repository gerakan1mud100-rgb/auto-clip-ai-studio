import { AlertCircle, Archive, Download, Film, Share2, Sparkles, StopCircle, Trash2 } from 'lucide-react';
import { AspectRatio, JobStatusResponse, JobSummary } from '../types';
import { formatDuration } from '../utils/format';

interface ClipsGalleryProps {
  jobId: string | null;
  jobStatus: JobStatusResponse | null;
  recentJobs: JobSummary[];
  sourceDuration: number;
  aspect: AspectRatio;
  onCancel: () => void;
  onSelectJob: (id: string) => void;
  onDeleteJob: (id: string) => void;
}

export function ClipsGallery({
  jobId,
  jobStatus,
  recentJobs,
  sourceDuration,
  aspect,
  onCancel,
  onSelectJob,
  onDeleteJob,
}: ClipsGalleryProps) {
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  const handleShareClip = async (url: string, filename: string) => {
    const fullUrl = new URL(url, window.location.origin).toString();
    try {
      await navigator.share({
        title: filename,
        text: 'Hasil klip pendek dari Auto Clip.Ai Studio',
        url: fullUrl,
      });
    } catch {
      // Cancelled
    }
  };

  const renderRecentJobs = () => {
    if (recentJobs.length === 0) return null;
    return (
      <div className="pt-5 border-t border-white/[0.07] space-y-3">
        <p className="text-xs font-semibold text-zinc-300">Riwayat Pemotongan Tersimpan</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {recentJobs.map((item) => {
            const isCurrent = item.id === jobId;
            return (
              <div
                key={item.id}
                className={`flex items-center justify-between gap-2 p-3 rounded-xl border transition-colors ${
                  isCurrent
                    ? 'border-violet-500 bg-violet-500/10'
                    : 'border-white/[0.08] bg-[#0B0B10] hover:border-white/20'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectJob(item.id)}
                  className="min-w-0 flex-1 text-left cursor-pointer"
                >
                  <p className="text-xs font-semibold text-white truncate">{item.sourceName}</p>
                  <p className="text-[11px] text-zinc-400 font-mono tabular-nums mt-0.5">
                    {item.clipCount} klip · {item.aspect} ·{' '}
                    {item.status === 'done'
                      ? 'Selesai'
                      : item.status === 'running'
                        ? 'Berjalan'
                        : item.status === 'cancelled'
                          ? 'Dibatalkan'
                          : 'Gagal'}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteJob(item.id)}
                  aria-label={`Hapus riwayat ${item.sourceName}`}
                  className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  if (!jobStatus && !jobId) {
    return (
      <section
        id="hasil-klip"
        className="bg-[#121218] border border-white/[0.08] rounded-2xl p-6 md:p-8 space-y-6"
      >
        <div className="text-center py-2">
          <div className="w-11 h-11 mx-auto rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-3">
            <Film className="w-5 h-5 text-zinc-400" />
          </div>
          <h3 className="text-base font-semibold text-zinc-100">Belum Ada Klip yang Dihasilkan</h3>
          <p className="text-sm text-zinc-400 mt-1 max-w-md mx-auto">
            Pilih sumber video di atas, atur durasi 35–60 detik serta angle kamera, lalu klik tombol
            Generate Auto Clips untuk melihat hasil video pendek di sini.
          </p>
        </div>
        {renderRecentJobs()}
      </section>
    );
  }

  if (!jobStatus) return null;

  const activeAspect = (jobStatus.aspect as AspectRatio) || aspect;
  const total = Math.max(1, jobStatus.total || 1);
  const pct =
    typeof jobStatus.overallPct === 'number'
      ? Math.min(100, Math.max(0, jobStatus.overallPct))
      : jobStatus.total > 0
        ? Math.min(100, Math.round((jobStatus.completed / total) * 100))
        : 0;
  const videoContainerAspect =
    activeAspect === '9:16'
      ? 'aspect-[9/16] max-h-[340px]'
      : activeAspect === '1:1'
        ? 'aspect-square max-h-[300px]'
        : 'aspect-video';

  return (
    <section
      id="hasil-klip"
      className="bg-[#121218] border border-white/[0.08] rounded-2xl p-6 md:p-7 space-y-6"
    >
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">
            Progres & Hasil Klip Video
          </h2>
          <p className="text-sm text-zinc-400 mt-0.5">{jobStatus.currentStep}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {jobStatus.status === 'running' && (
            <button
              type="button"
              onClick={onCancel}
              className="min-h-[40px] px-4 py-2 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-xs font-semibold text-red-300 transition flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <StopCircle className="w-4 h-4" />
              Batalkan Proses
            </button>
          )}

          {jobStatus.clips.length > 0 && jobId && jobStatus.status !== 'running' && (
            <a
              href={`/api/download-zip/${jobId}`}
              className="min-h-[40px] px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition flex items-center gap-2 whitespace-nowrap"
            >
              <Archive className="w-4 h-4" />
              Download Semua (.ZIP)
            </a>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-medium tabular-nums">
          <span className="text-zinc-400">
            Status:{' '}
            {jobStatus.status === 'running'
              ? 'Sedang Memproses'
              : jobStatus.status === 'done'
                ? 'Selesai'
                : jobStatus.status === 'cancelled'
                  ? 'Dibatalkan'
                  : 'Gagal'}
          </span>
          <span className="text-zinc-200 font-mono">
            {jobStatus.completed} / {jobStatus.total} klip ({pct}%)
          </span>
        </div>
        <div className="h-2.5 bg-zinc-900 rounded-full overflow-hidden border border-white/[0.06]">
          <div
            className="h-full bg-violet-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Segment Timeline Map */}
      {sourceDuration > 0 && jobStatus.plannedSegments.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Peta Potongan Sepanjang Video</span>
            <span className="font-mono tabular-nums">{formatDuration(sourceDuration)}</span>
          </div>
          <div className="relative h-3 bg-zinc-900 rounded border border-white/[0.06] overflow-hidden">
            {jobStatus.plannedSegments.map((seg, i) => {
              const leftPct = (seg.start / sourceDuration) * 100;
              const widthPct = Math.max(0.8, ((seg.end - seg.start) / sourceDuration) * 100);
              const isDone = i < jobStatus.completed;
              return (
                <div
                  key={`${seg.start}-${seg.end}`}
                  title={`Klip #${i + 1}: ${formatDuration(seg.start)} – ${formatDuration(seg.end)}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  className={`absolute top-0 bottom-0 transition-colors ${
                    isDone ? 'bg-violet-500' : 'bg-zinc-600/70'
                  }`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Error Message */}
      {jobStatus.status === 'error' && jobStatus.error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-200">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Pemrosesan Gagal</p>
            <p className="text-xs text-red-300/90 mt-0.5 font-mono break-all">{jobStatus.error}</p>
          </div>
        </div>
      )}

      {/* Clips Grid */}
      {jobStatus.clips.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 pt-2 border-t border-white/[0.07]">
          {jobStatus.clips.map((clip) => (
            <article
              key={clip.filename}
              className="bg-[#0B0B10] border border-white/[0.08] rounded-xl overflow-hidden flex flex-col"
            >
              <div className={`w-full bg-black flex items-center justify-center ${videoContainerAspect}`}>
                <video
                  src={clip.url}
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="p-4 space-y-3 border-t border-white/[0.06]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">
                      {clip.title || `Klip #${String(clip.index).padStart(2, '0')}`}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-400 font-mono tabular-nums mt-0.5">
                      <span>{clip.duration} dtk</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {formatDuration(clip.start)}–{formatDuration(clip.end)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{clip.sizeMb} MB</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {canShare && (
                      <button
                        type="button"
                        onClick={() => void handleShareClip(clip.url, clip.filename)}
                        aria-label={`Bagikan ${clip.filename}`}
                        className="min-h-[38px] px-2.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-zinc-200 transition cursor-pointer"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <a
                      href={clip.url}
                      download={clip.filename}
                      className="min-h-[38px] px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white shrink-0 transition flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Unduh
                    </a>
                  </div>
                </div>

                {clip.hook && (
                  <div className="p-2.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 font-semibold text-violet-300 text-[11px]">
                        <Sparkles className="w-3 h-3 text-violet-400" />
                        Hook Pembuka 3 Detik:
                      </span>
                      {typeof clip.viralScore === 'number' && (
                        <span className="px-1.5 py-0.5 rounded bg-violet-500/25 text-[10px] font-bold text-violet-200">
                          🔥 {clip.viralScore}/100
                        </span>
                      )}
                    </div>
                    <p className="text-white italic mt-1 font-medium leading-relaxed">
                      "{clip.hook}"
                    </p>
                    {clip.viralReason && (
                      <p className="text-zinc-400 text-[11px] mt-1 line-clamp-2 leading-relaxed">
                        {clip.viralReason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {renderRecentJobs()}
    </section>
  );
}
