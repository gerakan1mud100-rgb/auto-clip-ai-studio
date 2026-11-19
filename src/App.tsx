import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Film,
  Flame,
  FolderOpen,
  Key,
  Link2,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  UploadCloud,
  Wand2,
  X,
} from 'lucide-react';
import {
  ANGLE_OPTIONS,
  ANIMATION_OPTIONS,
  ASPECT_OPTIONS,
  AspectRatio,
  CLIP_MODES,
  CameraAngle,
  ClipAnimation,
  ClipMode,
  JobStatusResponse,
  JobSummary,
  LoadedVideo,
  SpeedPreset,
  VideoQuality,
  ViralMoment,
} from './types';
import { estimateClipCount, formatDuration, formatReadableDuration } from './utils/format';
import { LiveAnglePreview } from './components/LiveAnglePreview';
import { ClipsGallery } from './components/ClipsGallery';
import { OfflineBanner, PWAInstallControls } from './components/MobileAccessControls';

const DIRECT_UPLOAD_THRESHOLD = 20 * 1024 * 1024; // <= 20 MB single fast POST
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks
const UPLOAD_CONCURRENCY = 4; // 4 parallel chunk workers for rapid mobile/desktop upload
const ACTIVE_JOB_KEY = 'autoclip_active_job_id';

export default function App() {
  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null);
  const [serverAppUrl, setServerAppUrl] = useState<string | null>(null);
  const [youtubeCookiesSaved, setYoutubeCookiesSaved] = useState(false);

  // Gemini API & AI Viral Hook Detector State
  const [geminiConfig, setGeminiConfig] = useState<{ hasEnvKey: boolean; maskedKey: string | null } | null>(null);
  const [customApiKey, setCustomApiKey] = useState(() => localStorage.getItem('autoclip_custom_gemini_key') || '');
  const [apiKeyInput, setApiKeyInput] = useState(() => localStorage.getItem('autoclip_custom_gemini_key') || '');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeySavedSuccess, setApiKeySavedSuccess] = useState(false);
  const [viralMoments, setViralMoments] = useState<ViralMoment[]>([]);
  const [isAnalyzingHooks, setIsAnalyzingHooks] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [sourceTab, setSourceTab] = useState<'upload' | 'youtube' | 'local'>('upload');
  const [localPath, setLocalPath] = useState('');
  const [videoUrlInput, setVideoUrlInput] = useState('');
  const [cookiesInput, setCookiesInput] = useState('');
  const [showCookiesField, setShowCookiesField] = useState(false);
  const [isSavingCookies, setIsSavingCookies] = useState(false);
  const [loadedVideo, setLoadedVideo] = useState<LoadedVideo | null>(null);

  const handleSetLoadedVideo = useCallback((video: LoadedVideo | null) => {
    setLoadedVideo(video);
    setViralMoments([]);
    setAnalyzeError(null);
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<{
    pct: number;
    loadedMb: number;
    totalMb: number;
    speedMbps: number;
    phase: 'uploading' | 'probing';
  } | null>(null);
  const [urlImportState, setUrlImportState] = useState<{
    importId: string;
    pct: number;
    statusText: string;
  } | null>(null);
  const [isCreatingSample, setIsCreatingSample] = useState(false);
  const [isProbingLocal, setIsProbingLocal] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Clip & Styling State (default to ultrafast for rapid rendering)
  const [mode, setMode] = useState<ClipMode>('smart_highlights');
  const [targetCount, setTargetCount] = useState(15);
  const [minDur, setMinDur] = useState(35);
  const [maxDur, setMaxDur] = useState(60);
  const [quality, setQuality] = useState<VideoQuality>('720p');
  const [speedPreset, setSpeedPreset] = useState<SpeedPreset>('ultrafast');
  const [aspect, setAspect] = useState<AspectRatio>('9:16');
  const [angle, setAngle] = useState<CameraAngle>('blur_frame');
  const [animation, setAnimation] = useState<ClipAnimation>('fade');

  // Job & History State
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusResponse | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);

  const pollTimerRef = useRef<number | null>(null);
  const urlPollTimerRef = useRef<number | null>(null);

  const fetchRecentJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const data = await res.json();
      setRecentJobs(data.jobs || []);
    } catch {
      // Ignore
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
      }
      const fetchStatus = async () => {
        try {
          const res = await fetch(`/api/status/${id}`);
          if (!res.ok) {
            if (res.status === 404) {
              localStorage.removeItem(ACTIVE_JOB_KEY);
              if (pollTimerRef.current) {
                window.clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
              }
            }
            return;
          }
          const data: JobStatusResponse = await res.json();
          setJobStatus(data);
          if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
            if (pollTimerRef.current) {
              window.clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            void fetchRecentJobs();
          }
        } catch {
          // Ignore transient poll hiccup
        }
      };
      void fetchStatus();
      pollTimerRef.current = window.setInterval(fetchStatus, 900);
    },
    [fetchRecentJobs]
  );

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async (attempt = 1) => {
      try {
        const res = await fetch('/api/health');
        const text = await res.text();
        const data = JSON.parse(text);
        if (!cancelled) {
          setFfmpegReady(Boolean(data.ffmpegReady));
          if (data.appUrl) setServerAppUrl(data.appUrl);
          setYoutubeCookiesSaved(Boolean(data.youtubeCookiesSaved));
        }
      } catch {
        if (!cancelled && attempt < 3) {
          window.setTimeout(() => void checkHealth(attempt + 1), 1500);
        }
      }
    };
    void checkHealth();
    void fetchRecentJobs();

    const fetchGeminiConfig = async () => {
      try {
        const res = await fetch('/api/gemini/config');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setGeminiConfig(data);
        }
      } catch {
        // Ignore
      }
    };
    void fetchGeminiConfig();

    const savedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
    if (savedJobId) {
      setJobId(savedJobId);
      startPolling(savedJobId);
    }

    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
      }
      if (urlPollTimerRef.current) {
        window.clearInterval(urlPollTimerRef.current);
      }
    };
  }, [fetchRecentJobs, startPolling]);

  const handleMinDurChange = (val: number) => {
    setMinDur(val);
    if (val > maxDur) {
      setMaxDur(val);
    }
  };

  const handleMaxDurChange = (val: number) => {
    setMaxDur(val);
    if (val < minDur) {
      setMinDur(val);
    }
  };

  const uploadSingleFileFast = (file: File): Promise<LoadedVideo> =>
    new Promise((resolve, reject) => {
      const totalMb = Number((file.size / (1024 * 1024)).toFixed(1));
      const startedAt = Date.now();
      const form = new FormData();
      form.append('video', file, file.name || 'video.mp4');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
          const speedMbps = Number((ev.loaded / (1024 * 1024) / elapsedSec).toFixed(1));
          const pct = Math.min(99, Math.round((ev.loaded / ev.total) * 100));
          setUploadState({
            pct,
            loadedMb: Number((ev.loaded / (1024 * 1024)).toFixed(1)),
            totalMb,
            speedMbps,
            phase: pct >= 99 ? 'probing' : 'uploading',
          });
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            reject(new Error(data.error || 'Gagal mengunggah video.'));
          }
        } catch {
          reject(new Error('Respons server tidak valid saat mengunggah video.'));
        }
      };

      xhr.onerror = () => reject(new Error('Koneksi terputus saat mengunggah video.'));
      xhr.send(form);
    });

  const uploadChunkWithRetry = (
    uploadId: string,
    chunkIndex: number,
    blob: Blob,
    onBytesProgress: (bytesInChunk: number) => void
  ): Promise<void> => {
    const attemptUpload = (attempt: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('uploadId', uploadId);
        form.append('chunkIndex', String(chunkIndex));
        form.append('chunk', blob, `chunk_${chunkIndex}`);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload/chunk');

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            onBytesProgress(Math.min(blob.size, ev.loaded));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            onBytesProgress(blob.size);
            resolve();
          } else if (attempt < 3) {
            onBytesProgress(0);
            window.setTimeout(() => {
              attemptUpload(attempt + 1).then(resolve).catch(reject);
            }, 600 * attempt);
          } else {
            reject(new Error('Gagal mengirim potongan video ke server.'));
          }
        };

        xhr.onerror = () => {
          if (attempt < 3) {
            onBytesProgress(0);
            window.setTimeout(() => {
              attemptUpload(attempt + 1).then(resolve).catch(reject);
            }, 600 * attempt);
          } else {
            reject(new Error('Koneksi terputus saat mengunggah video.'));
          }
        };

        xhr.send(form);
      });

    return attemptUpload(1);
  };

  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return;
    setErrorMsg(null);
    const totalMb = Number((file.size / (1024 * 1024)).toFixed(1));
    setUploadState({ pct: 0, loadedMb: 0, totalMb, speedMbps: 0, phase: 'uploading' });

    try {
      // Fast single-request upload for files <= 20 MB
      if (file.size <= DIRECT_UPLOAD_THRESHOLD) {
        const result = await uploadSingleFileFast(file);
        handleSetLoadedVideo(result);
        return;
      }

      // Parallel 4-worker chunked upload for large/1-hour videos
      const startedAt = Date.now();
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name || 'video.mp4',
          totalSize: file.size,
          chunkSize: CHUNK_SIZE,
        }),
      });
      const initData = await initRes.json();
      if (!initRes.ok) {
        throw new Error(initData.error || 'Gagal memulai sesi upload.');
      }

      const uploadId: string = initData.uploadId;
      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      const chunkLoaded = new Float64Array(totalChunks);
      let nextChunk = 0;

      const updateAggregatedProgress = () => {
        let sum = 0;
        for (let i = 0; i < totalChunks; i++) sum += chunkLoaded[i];
        const totalUploaded = Math.min(file.size, sum);
        const elapsedSec = Math.max(0.2, (Date.now() - startedAt) / 1000);
        const speedMbps = Number((totalUploaded / (1024 * 1024) / elapsedSec).toFixed(1));
        const pct = Math.min(99, Math.round((totalUploaded / Math.max(1, file.size)) * 100));
        setUploadState({
          pct,
          loadedMb: Number((totalUploaded / (1024 * 1024)).toFixed(1)),
          totalMb,
          speedMbps,
          phase: 'uploading',
        });
      };

      const worker = async () => {
        while (true) {
          const idx = nextChunk++;
          if (idx >= totalChunks) break;
          const start = idx * CHUNK_SIZE;
          const end = Math.min(file.size, start + CHUNK_SIZE);
          const slice = file.slice(start, end);

          await uploadChunkWithRetry(uploadId, idx, slice, (bytesInChunk) => {
            chunkLoaded[idx] = bytesInChunk;
            updateAggregatedProgress();
          });
        }
      };

      const workerCount = Math.min(UPLOAD_CONCURRENCY, totalChunks);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      setUploadState({
        pct: 100,
        loadedMb: totalMb,
        totalMb,
        speedMbps: 0,
        phase: 'probing',
      });

      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completeData.error || 'Gagal membaca metadata video.');
      }

      handleSetLoadedVideo(completeData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Gagal mengunggah video.';
      setErrorMsg(msg);
    } finally {
      setUploadState(null);
    }
  };

  const handleSaveCookiesAndRetry = async (retryImport = false) => {
    if (!cookiesInput.trim()) {
      setErrorMsg('Tempel isi file cookies.txt YouTube terlebih dahulu.');
      return;
    }
    setErrorMsg(null);
    setIsSavingCookies(true);
    try {
      const res = await fetch('/api/youtube/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesTxt: cookiesInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Gagal menyimpan cookies.');
        return;
      }
      setYoutubeCookiesSaved(true);
      setCookiesInput('');
      setShowCookiesField(false);
      if (retryImport && videoUrlInput.trim()) {
        await handleImportUrl();
      }
    } catch {
      setErrorMsg('Gagal menyimpan cookies ke server.');
    } finally {
      setIsSavingCookies(false);
    }
  };

  const handleDeleteSavedCookies = async () => {
    try {
      const res = await fetch('/api/youtube/cookies', { method: 'DELETE' });
      const data = await res.json();
      setYoutubeCookiesSaved(Boolean(data.saved));
    } catch {
      // ignore
    }
  };

  const handleCookiesFileSelect = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setCookiesInput(text);
  };

  const handleImportUrl = async () => {
    if (!videoUrlInput.trim()) {
      setErrorMsg('Tempel link YouTube atau URL video terlebih dahulu.');
      return;
    }
    setErrorMsg(null);
    try {
      const res = await fetch('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: videoUrlInput.trim(),
          cookiesTxt: cookiesInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Gagal memulai impor dari link.');
        return;
      }

      const importId: string = data.importId;
      setUrlImportState({
        importId,
        pct: 0,
        statusText: 'Memulai pengunduhan video...',
      });

      if (urlPollTimerRef.current) {
        window.clearInterval(urlPollTimerRef.current);
      }

      const pollUrlImport = async () => {
        try {
          const stRes = await fetch(`/api/import-url/status/${importId}`);
          if (!stRes.ok) return;
          const stData = await stRes.json();

          setUrlImportState({
            importId,
            pct: Number(stData.progressPct || 0),
            statusText: stData.statusText || 'Mengunduh...',
          });

          if (stData.status === 'done' && stData.filePath && stData.info) {
            if (urlPollTimerRef.current) {
              window.clearInterval(urlPollTimerRef.current);
              urlPollTimerRef.current = null;
            }
            setUrlImportState(null);
            handleSetLoadedVideo({
              filePath: stData.filePath,
              filename: stData.filename || 'YouTube_Video.mp4',
              info: stData.info,
            });
          } else if (stData.status === 'error' || stData.status === 'cancelled') {
            if (urlPollTimerRef.current) {
              window.clearInterval(urlPollTimerRef.current);
              urlPollTimerRef.current = null;
            }
            setUrlImportState(null);
            if (stData.needsCookies) {
              setShowCookiesField(true);
            }
            if (stData.status === 'error') {
              setErrorMsg(stData.error || 'Gagal mengunduh video dari link.');
            }
          }
        } catch {
          // Ignore transient error
        }
      };

      void pollUrlImport();
      urlPollTimerRef.current = window.setInterval(pollUrlImport, 900);
    } catch {
      setUrlImportState(null);
      setErrorMsg('Gagal menghubungi server untuk mengunduh link.');
    }
  };

  const handleCancelUrlImport = async () => {
    if (!urlImportState) return;
    try {
      await fetch(`/api/import-url/cancel/${urlImportState.importId}`, { method: 'POST' });
    } catch {
      // ignore
    }
    if (urlPollTimerRef.current) {
      window.clearInterval(urlPollTimerRef.current);
      urlPollTimerRef.current = null;
    }
    setUrlImportState(null);
  };

  const handleProbeLocal = async () => {
    if (!localPath.trim()) {
      setErrorMsg('Masukkan path lengkap file video terlebih dahulu.');
      return;
    }
    setErrorMsg(null);
    setIsProbingLocal(true);
    try {
      const res = await fetch('/api/probe-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: localPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'File lokal tidak ditemukan.');
        return;
      }
      handleSetLoadedVideo(data);
    } catch {
      setErrorMsg('Gagal memeriksa file lokal.');
    } finally {
      setIsProbingLocal(false);
    }
  };

  const handleCreateSample = async () => {
    setErrorMsg(null);
    setIsCreatingSample(true);
    try {
      const res = await fetch('/api/create-sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Gagal membuat video sampel.');
        return;
      }
      handleSetLoadedVideo(data);
    } catch {
      setErrorMsg('Gagal menghubungi server untuk membuat video sampel.');
    } finally {
      setIsCreatingSample(false);
    }
  };

  const handleSaveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    setCustomApiKey(trimmed);
    if (trimmed) {
      localStorage.setItem('autoclip_custom_gemini_key', trimmed);
    } else {
      localStorage.removeItem('autoclip_custom_gemini_key');
    }
    setApiKeySavedSuccess(true);
    setTimeout(() => {
      setApiKeySavedSuccess(false);
      setShowApiKeyModal(false);
    }, 600);
  };

  const handleAnalyzeViralHooks = async () => {
    if (!loadedVideo) {
      setErrorMsg('Pilih atau muat video sumber terlebih dahulu sebelum mendeteksi viral hooks.');
      document.getElementById('sumber-video')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!loadedVideo.info.hasAudio) {
      setErrorMsg('Video sumber tidak memiliki audio. Gemini memerlukan suara audio untuk menganalisis transkrip dan hook pembuka.');
      return;
    }

    setIsAnalyzingHooks(true);
    setAnalyzeError(null);
    try {
      const res = await fetch('/api/gemini/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: loadedVideo.filePath,
          minDur,
          maxDur,
          targetCount: Math.min(20, Math.max(1, targetCount || 5)),
          apiKey: customApiKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data.error || 'Gagal menganalisis viral hook dengan Gemini AI.');
        return;
      }

      const list: ViralMoment[] = (data.moments || []).map((m: ViralMoment) => ({
        ...m,
        selected: true,
      }));
      setViralMoments(list);
      setMode('ai_viral_moments');
      setTimeout(() => {
        document.getElementById('viral-detector-panel')?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    } catch {
      setAnalyzeError('Terjadi kendala jaringan saat menghubungi server Gemini.');
    } finally {
      setIsAnalyzingHooks(false);
    }
  };

  const toggleMomentSelection = (id: string) => {
    setViralMoments((prev) =>
      prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m))
    );
  };

  const selectAllMoments = (select: boolean) => {
    setViralMoments((prev) => prev.map((m) => ({ ...m, selected: select })));
  };

  const handleStartGenerate = async () => {
    if (!loadedVideo) {
      setErrorMsg('Pilih atau muat video sumber terlebih dahulu sebelum memulai.');
      document.getElementById('sumber-video')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    if (mode === 'ai_viral_moments' && viralMoments.length === 0) {
      setErrorMsg('Klik tombol "Deteksi Viral Hooks" terlebih dahulu untuk mendeteksi momen terbaik sebelum memotong.');
      document.getElementById('viral-detector-panel')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const selectedViralSegments = mode === 'ai_viral_moments'
      ? viralMoments.filter((m) => m.selected)
      : [];

    if (mode === 'ai_viral_moments' && selectedViralSegments.length === 0) {
      setErrorMsg('Pilih setidaknya 1 momen viral untuk dipotong.');
      return;
    }

    setErrorMsg(null);
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: loadedVideo.filePath,
          sourceName: loadedVideo.filename,
          mode,
          minDur,
          maxDur,
          targetCount: mode === 'ai_viral_moments' ? selectedViralSegments.length : targetCount,
          aspect,
          angle,
          animation,
          quality,
          speedPreset,
          customSegments: mode === 'ai_viral_moments' ? selectedViralSegments : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Gagal memulai proses Auto Clip.');
        return;
      }

      setJobId(data.jobId);
      localStorage.setItem(ACTIVE_JOB_KEY, data.jobId);
      setJobStatus({
        id: data.jobId,
        sourceName: loadedVideo.filename,
        aspect,
        status: 'running',
        completed: 0,
        total: 0,
        overallPct: 0,
        currentStep: 'Memulai mesin pemotongan video...',
        clips: [],
        plannedSegments: [],
        error: null,
      });

      startPolling(data.jobId);
      void fetchRecentJobs();
      window.setTimeout(() => {
        document.getElementById('hasil-klip')?.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    } catch {
      setErrorMsg('Gagal menghubungi server untuk memulai proses.');
    }
  };

  const handleCancelJob = async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/cancel/${jobId}`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  const handleSelectJob = (id: string) => {
    setJobId(id);
    localStorage.setItem(ACTIVE_JOB_KEY, id);
    startPolling(id);
    document.getElementById('hasil-klip')?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
      if (jobId === id) {
        setJobId(null);
        setJobStatus(null);
        localStorage.removeItem(ACTIVE_JOB_KEY);
      }
      void fetchRecentJobs();
    } catch {
      // ignore
    }
  };

  const estimatedClips = loadedVideo
    ? mode === 'ai_viral_moments' && viralMoments.length > 0
      ? viralMoments.filter((m) => m.selected).length
      : estimateClipCount(loadedVideo.info.duration, mode, minDur, maxDur, targetCount)
    : mode === 'auto_split'
      ? Math.floor(3600 / ((minDur + maxDur) / 2))
      : targetCount;

  const isRunning = jobStatus?.status === 'running';
  const isBusyLoadingSource = Boolean(uploadState) || Boolean(urlImportState) || isCreatingSample;

  return (
    <div className="min-h-screen bg-[#09090D] text-zinc-100 pb-20">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-40 bg-[#09090D]/90 backdrop-blur-md border-b border-white/[0.08]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4 md:gap-8">
          <a
            href="#top"
            className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 flex items-center gap-2"
          >
            <span>Auto Clip.Ai Studio</span>
            <span className="hidden sm:inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-500/20 text-violet-300 border border-violet-500/30">
              AI VIRAL
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
            <a
              href="#sumber-video"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Sumber Video
            </a>
            <a
              href="#konfigurasi"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Durasi & Mode
            </a>
            <a
              href="#angle-animasi"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Angle & Animasi
            </a>
            <a
              href="#hasil-klip"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Hasil Klip
            </a>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowApiKeyModal(true)}
              className="min-h-[40px] px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-300 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0"
              title="Konfigurasi Google Gemini API Key"
            >
              <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
              <span className="hidden sm:inline">Gemini AI</span>
              {geminiConfig?.hasEnvKey || customApiKey ? (
                <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse" />
                  {customApiKey ? 'Kustom' : 'Aktif'}
                </span>
              ) : (
                <span className="text-[11px] text-amber-400">Setel Key</span>
              )}
            </button>

            <button
              type="button"
              onClick={handleStartGenerate}
              disabled={isRunning || isBusyLoadingSource}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isRunning ? 'Memproses...' : 'Generate Klip'}
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-8 md:pt-10 space-y-6 md:space-y-8">
        {/* Hero Intro */}
        <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-white/[0.08]">
          <div className="space-y-2 max-w-2xl">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-white [text-wrap:balance]">
              Ubah Video 1 Jam Menjadi Banyak Klip Pendek Siap Tayang
            </h1>
            <p className="text-sm sm:text-[15px] text-zinc-400 leading-relaxed">
              Potong video dari galeri HP, komputer, maupun link YouTube menjadi klip 35–60 detik
              dengan auto-highlight audio, angle kamera dinamis, dan animasi halus.
            </p>
          </div>

          <div className="flex flex-col items-start md:items-end gap-3 shrink-0">
            <PWAInstallControls serverAppUrl={serverAppUrl} />
            {ffmpegReady === false && (
              <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 px-3.5 py-2 rounded-lg shrink-0">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Mesin FFmpeg belum terdeteksi pada sistem</span>
              </div>
            )}
          </div>
        </section>

        {/* Mobile Section Quick-Jump Bar */}
        <nav aria-label="Navigasi cepat" className="grid grid-cols-4 gap-2 md:hidden">
          <a
            href="#sumber-video"
            className="min-h-[40px] flex items-center justify-center rounded-lg bg-[#121218] border border-white/[0.08] text-xs font-medium text-zinc-200 whitespace-nowrap"
          >
            Sumber
          </a>
          <a
            href="#konfigurasi"
            className="min-h-[40px] flex items-center justify-center rounded-lg bg-[#121218] border border-white/[0.08] text-xs font-medium text-zinc-200 whitespace-nowrap"
          >
            Durasi
          </a>
          <a
            href="#angle-animasi"
            className="min-h-[40px] flex items-center justify-center rounded-lg bg-[#121218] border border-white/[0.08] text-xs font-medium text-zinc-200 whitespace-nowrap"
          >
            Angle
          </a>
          <a
            href="#hasil-klip"
            className="min-h-[40px] flex items-center justify-center rounded-lg bg-[#121218] border border-white/[0.08] text-xs font-medium text-zinc-200 whitespace-nowrap"
          >
            Hasil
          </a>
        </nav>

        {/* Global Error Feedback */}
        {errorMsg && (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-200"
          >
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold text-red-300 hover:text-white px-2 py-1 cursor-pointer shrink-0"
            >
              Tutup
            </button>
          </div>
        )}

        {/* 12-Column Studio Workspace */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Left 7 Columns: Single-Elevation Configuration Surface */}
          <div className="lg:col-span-7 bg-[#121218] border border-white/[0.08] rounded-2xl divide-y divide-white/[0.07]">
            {/* 01. Sumber Video */}
            <section id="sumber-video" className="p-5 sm:p-6 md:p-7 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-white">01. Sumber Video</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Unggah file dari HP/PC, tempel link YouTube/MP4, atau gunakan path file lokal.
                  </p>
                </div>

                <div className="inline-flex p-1 bg-[#09090D] border border-white/[0.08] rounded-lg self-start shrink-0">
                  <button
                    type="button"
                    onClick={() => setSourceTab('upload')}
                    className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      sourceTab === 'upload'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    Upload File
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceTab('youtube')}
                    className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      sourceTab === 'youtube'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    Link YouTube
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceTab('local')}
                    className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      sourceTab === 'local'
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    Path Lokal
                  </button>
                </div>
              </div>

              {sourceTab === 'upload' && (
                <label
                  htmlFor="video-upload-input"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    if (!uploadState) {
                      void handleFileUpload(e.dataTransfer.files?.[0]);
                    }
                  }}
                  className={`block border border-dashed rounded-xl p-6 sm:p-7 text-center transition-colors ${
                    uploadState ? 'cursor-wait' : 'cursor-pointer'
                  } ${
                    isDragging
                      ? 'border-violet-500 bg-violet-500/10'
                      : 'border-white/15 hover:border-violet-400/60 bg-[#0B0B10]'
                  }`}
                >
                  <input
                    id="video-upload-input"
                    type="file"
                    accept="video/*,.mp4,.mov,.mkv,.webm,.m4v,.3gp"
                    disabled={Boolean(uploadState)}
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = '';
                      void handleFileUpload(file);
                    }}
                  />
                  <UploadCloud className="w-7 h-7 text-violet-400 mx-auto mb-2.5" />
                  <p className="text-sm font-medium text-zinc-100">
                    Ketuk untuk Pilih Video dari Galeri HP atau File
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    Upload paralel 4 jalur super cepat (mendukung MP4, MOV, MKV hingga 10 GB)
                  </p>

                  {!uploadState && (
                    <span className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors">
                      Pilih Video Sekarang
                    </span>
                  )}

                  {uploadState && (
                    <div className="max-w-sm mx-auto mt-4 space-y-1.5">
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-violet-500 transition-all"
                          style={{ width: `${uploadState.pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-zinc-300 font-mono tabular-nums">
                        {uploadState.phase === 'uploading'
                          ? `${uploadState.loadedMb} / ${uploadState.totalMb} MB (${uploadState.pct}%) · ${uploadState.speedMbps} MB/s`
                          : 'Memeriksa metadata video...'}
                      </p>
                    </div>
                  )}
                </label>
              )}

              {sourceTab === 'youtube' && (
                <div className="space-y-3.5 bg-[#0B0B10] border border-white/[0.08] rounded-xl p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      type="url"
                      value={videoUrlInput}
                      onChange={(e) => setVideoUrlInput(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=... atau link langsung .mp4"
                      className="flex-1 bg-[#09090D] border border-white/[0.1] rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                    />
                    {urlImportState ? (
                      <button
                        type="button"
                        onClick={handleCancelUrlImport}
                        className="min-h-[42px] px-4 py-2.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-xs font-semibold text-red-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Batalkan
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleImportUrl()}
                        className="min-h-[42px] px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Link2 className="w-4 h-4" />
                        Ambil Video
                      </button>
                    )}
                  </div>

                  {urlImportState && (
                    <div className="space-y-1.5 pt-1">
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-violet-500 transition-all"
                          style={{ width: `${urlImportState.pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-zinc-300 font-mono tabular-nums">
                        {urlImportState.statusText}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 text-zinc-400">
                      {youtubeCookiesSaved ? (
                        <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                          <Check className="w-3.5 h-3.5" />
                          Cookies YouTube tersimpan di server
                        </span>
                      ) : (
                        <span>Mendukung YouTube & tautan langsung MP4.</span>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      {youtubeCookiesSaved && (
                        <button
                          type="button"
                          onClick={handleDeleteSavedCookies}
                          className="text-zinc-400 hover:text-red-400 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Hapus Cookies
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowCookiesField((v) => !v)}
                        className="text-violet-300 hover:text-violet-200 font-medium whitespace-nowrap cursor-pointer"
                      >
                        {showCookiesField
                          ? 'Tutup Pengaturan Cookies'
                          : youtubeCookiesSaved
                            ? 'Perbarui Cookies'
                            : 'Setup Cookies YouTube (1x)'}
                      </button>
                    </div>
                  </div>

                  {showCookiesField && (
                    <div className="space-y-3 pt-3 border-t border-white/[0.06]">
                      <div className="space-y-1">
                        <p className="text-xs font-semibold text-white">
                          Simpan Cookies YouTube di Server (Cukup Sekali untuk Semua Perangkat)
                        </p>
                        <p className="text-xs text-zinc-400 leading-relaxed">
                          Karena YouTube membatasi IP server Cloud, simpan file{' '}
                          <code className="text-zinc-200">cookies.txt</code> (ekspor lewat ekstensi
                          Chrome/Edge <strong className="text-zinc-200">Get cookies.txt LOCALLY</strong> saat membuka YouTube). Setelah disimpan, HP Anda dapat langsung mengambil link YouTube tanpa setup ulang.
                        </p>
                      </div>

                      <textarea
                        rows={3}
                        value={cookiesInput}
                        onChange={(e) => setCookiesInput(e.target.value)}
                        placeholder="# Netscape HTTP Cookie File..."
                        className="w-full bg-[#09090D] border border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                      />

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          htmlFor="cookies-file-input"
                          className="min-h-[38px] px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 cursor-pointer inline-flex items-center"
                        >
                          <input
                            id="cookies-file-input"
                            type="file"
                            accept=".txt,text/plain"
                            className="sr-only"
                            onChange={(e) => {
                              void handleCookiesFileSelect(e.target.files?.[0]);
                              e.currentTarget.value = '';
                            }}
                          />
                          Pilih File cookies.txt
                        </label>

                        <button
                          type="button"
                          onClick={() => void handleSaveCookiesAndRetry(Boolean(videoUrlInput.trim()))}
                          disabled={isSavingCookies}
                          className="min-h-[38px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white cursor-pointer"
                        >
                          {isSavingCookies
                            ? 'Menyimpan...'
                            : videoUrlInput.trim()
                              ? 'Simpan Cookies & Ambil Video'
                              : 'Simpan Cookies di Server'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {sourceTab === 'local' && (
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      type="text"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder="/path/ke/video_1jam.mp4 atau D:\Videos\podcast.mp4"
                      className="flex-1 bg-[#0B0B10] border border-white/[0.1] rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                    />
                    <button
                      type="button"
                      onClick={handleProbeLocal}
                      disabled={isProbingLocal}
                      className="min-h-[42px] px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <FolderOpen className="w-4 h-4" />
                      {isProbingLocal ? 'Memeriksa...' : 'Muat Video'}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-400">
                    Khusus jika dijalankan langsung di PC lokal agar video 1 jam+ terbaca tanpa
                    menunggu upload.
                  </p>
                </div>
              )}

              {/* Quick Sample Action + Loaded Video Summary */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                {loadedVideo ? (
                  <div className="flex items-center gap-3 min-w-0">
                    <Film className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {loadedVideo.filename}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400 font-mono tabular-nums">
                        <span>{formatReadableDuration(loadedVideo.info.duration)}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {loadedVideo.info.width}×{loadedVideo.info.height}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{loadedVideo.info.sizeMb} MB</span>
                        <span aria-hidden="true">·</span>
                        <span>{loadedVideo.info.hasAudio ? 'Audio Aktif' : 'Tanpa Audio'}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">Belum ada video dipilih.</p>
                )}

                <button
                  type="button"
                  onClick={handleCreateSample}
                  disabled={isBusyLoadingSource}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-medium text-zinc-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 text-violet-400" />
                  {isCreatingSample ? 'Membuat Sampel...' : 'Gunakan Video Sampel (105 dtk)'}
                </button>
              </div>
            </section>

            {/* 02. Mode & Durasi Klip (35 - 60 Detik) */}
            <section id="konfigurasi" className="p-5 sm:p-6 md:p-7 space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-white">02. Mode & Durasi Klip</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Setiap klip video pendek otomatis dijaga pada rentang minimal 35 detik dan maksimal
                  60 detik.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {CLIP_MODES.map((item) => {
                  const active = mode === item.id;
                  const isAiMode = item.id === 'ai_viral_moments';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setMode(item.id)}
                      className={`min-h-[44px] p-3.5 rounded-xl text-left border transition-all cursor-pointer relative ${
                        active
                          ? 'border-violet-500 bg-violet-500/15 shadow-sm shadow-violet-500/10'
                          : 'border-white/[0.08] bg-[#0B0B10] hover:border-white/20'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-white flex items-center gap-1.5">
                          {isAiMode && <Sparkles className="w-4 h-4 text-violet-400 shrink-0" />}
                          {item.title}
                        </p>
                        {isAiMode && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-500/25 text-violet-300 border border-violet-500/30">
                            GEMINI AI
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                        {item.description}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* AI Viral Hook Detector Panel */}
              {(mode === 'ai_viral_moments' || viralMoments.length > 0) && (
                <div
                  id="viral-detector-panel"
                  className="p-4 sm:p-5 rounded-2xl bg-gradient-to-b from-violet-950/40 via-[#0E0E17] to-[#09090D] border border-violet-500/30 space-y-4 shadow-xl shadow-violet-950/20"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-3 border-b border-white/[0.08]">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md bg-violet-500/20 text-violet-300 text-[10px] font-bold tracking-wider uppercase flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-violet-400" />
                          Gemini AI Engine
                        </span>
                        <span className="text-xs text-zinc-400">Deteksi Transkrip & Hook 3 Detik</span>
                      </div>
                      <h3 className="text-sm sm:text-base font-bold text-white tracking-tight">
                        AI Viral Hook Detector & Moment Analyzer
                      </h3>
                      <p className="text-xs text-zinc-300 max-w-xl leading-relaxed">
                        Mengekstrak audio video, menganalisis transkrip percakapan, mencari 3 detik pembuka paling memikat (Stop-the-Scroll), dan memberi skor viral 1–100.
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={handleAnalyzeViralHooks}
                        disabled={isAnalyzingHooks || !loadedVideo}
                        className="min-h-[42px] px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-50 text-xs font-semibold text-white shadow-md shadow-violet-600/30 transition flex items-center gap-2 cursor-pointer whitespace-nowrap"
                      >
                        {isAnalyzingHooks ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin text-violet-200" />
                            <span>Menganalisis Audio...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4 text-violet-200" />
                            <span>
                              {viralMoments.length > 0
                                ? 'Analisis Ulang Hooks'
                                : 'Deteksi Viral Hooks'}
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Loading State Animation */}
                  {isAnalyzingHooks && (
                    <div className="p-5 sm:p-6 rounded-xl bg-violet-500/10 border border-violet-500/20 text-center space-y-3">
                      <div className="w-10 h-10 mx-auto rounded-full bg-violet-600/20 border border-violet-500/40 flex items-center justify-center animate-pulse">
                        <Sparkles className="w-5 h-5 text-violet-300" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white">
                          Sedang mengekstrak audio & menganalisis momen viral dengan Gemini AI...
                        </p>
                        <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed mt-1">
                          Audio 16kHz hemat kompresi diekstrak via FFmpeg dan diproses oleh Gemini untuk menemukan jeda bicara alami dan hook pembuka 3 detik.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error State */}
                  {analyzeError && (
                    <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/25 flex items-start justify-between gap-3 text-xs text-red-200">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold text-red-100">Gagal Menganalisis Hook</p>
                          <p className="text-red-300/90 mt-0.5 leading-relaxed">{analyzeError}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAnalyzeError(null)}
                        className="text-red-300 hover:text-white px-2 py-0.5 shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* Detected Moments List */}
                  {viralMoments.length > 0 && !isAnalyzingHooks && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">
                            Ditemukan {viralMoments.length} Momen Viral
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-mono text-[11px]">
                            {viralMoments.filter((m) => m.selected).length} dipilih
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => selectAllMoments(true)}
                            className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 text-[11px] text-zinc-300 transition cursor-pointer"
                          >
                            Pilih Semua
                          </button>
                          <button
                            type="button"
                            onClick={() => selectAllMoments(false)}
                            className="px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 text-[11px] text-zinc-400 transition cursor-pointer"
                          >
                            Batal Pilih
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2.5 max-h-[460px] overflow-y-auto pr-1">
                        {viralMoments.map((moment, idx) => {
                          const isSelected = Boolean(moment.selected);
                          const score = moment.viralScore;
                          const scoreBadgeColor =
                            score >= 90
                              ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
                              : score >= 80
                                ? 'bg-violet-500/20 border-violet-500/30 text-violet-300'
                                : 'bg-amber-500/20 border-amber-500/30 text-amber-300';

                          return (
                            <div
                              key={moment.id}
                              onClick={() => toggleMomentSelection(moment.id)}
                              className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none ${
                                isSelected
                                  ? 'border-violet-500/60 bg-violet-500/10 shadow-sm'
                                  : 'border-white/[0.06] bg-[#09090D] opacity-70 hover:opacity-100 hover:border-white/20'
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => {}} // handled by parent div click
                                  className="mt-1 w-4 h-4 rounded text-violet-600 bg-zinc-800 border-zinc-700 cursor-pointer shrink-0"
                                />

                                <div className="flex-1 min-w-0 space-y-1.5">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-xs font-bold text-white truncate">
                                      #{idx + 1} {moment.title}
                                    </span>

                                    <div className="flex items-center gap-2 shrink-0">
                                      <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                                        {formatDuration(moment.start)} – {formatDuration(moment.end)} ({moment.duration}s)
                                      </span>
                                      <span
                                        className={`px-2 py-0.5 rounded-md border text-[11px] font-bold flex items-center gap-1 ${scoreBadgeColor}`}
                                      >
                                        <Flame className="w-3 h-3" />
                                        {score}/100
                                      </span>
                                    </div>
                                  </div>

                                  {/* Headline Hook 3 Detik */}
                                  <div className="p-2.5 rounded-lg bg-black/40 border border-white/[0.06]">
                                    <p className="text-[11px] font-semibold text-violet-300 flex items-center gap-1">
                                      <Sparkles className="w-3 h-3 text-violet-400 shrink-0" />
                                      Hook Pembuka 3 Detik:
                                    </p>
                                    <p className="text-xs font-semibold text-white italic mt-1 leading-snug">
                                      "{moment.hook}"
                                    </p>
                                  </div>

                                  {/* Alasan Viral */}
                                  <p className="text-[11px] text-zinc-300 leading-relaxed">
                                    <span className="text-zinc-400 font-medium">Alasan Viral:</span>{' '}
                                    {moment.viralReason}
                                  </p>

                                  {moment.keyQuote && (
                                    <p className="text-[10px] text-zinc-500 font-mono italic">
                                      Quote: "{moment.keyQuote}"
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Empty State before Analysis */}
                  {viralMoments.length === 0 && !isAnalyzingHooks && !analyzeError && (
                    <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2.5 text-zinc-300">
                        <Bot className="w-4 h-4 text-violet-400 shrink-0" />
                        <span>
                          {loadedVideo
                            ? 'Video siap dianalisis. Tekan "Deteksi Viral Hooks" untuk membiarkan Gemini memindai audio.'
                            : 'Muat video sumber terlebih dahulu di bagian atas untuk memulai analisis AI.'}
                        </span>
                      </div>
                      {loadedVideo && (
                        <button
                          type="button"
                          onClick={handleAnalyzeViralHooks}
                          className="px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white shrink-0 transition cursor-pointer self-start sm:self-auto"
                        >
                          Mulai Deteksi
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {mode !== 'auto_split' && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs font-medium">
                    <span className="text-zinc-300">Target Jumlah Klip Pendek</span>
                    <span className="font-mono tabular-nums text-violet-300">
                      {targetCount} klip
                    </span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={80}
                    value={targetCount}
                    onChange={(e) => setTargetCount(Number(e.target.value))}
                    className="w-full h-6 cursor-pointer"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-medium">
                    <span className="text-zinc-300">Durasi Minimal</span>
                    <span className="font-mono tabular-nums text-white">{minDur} detik</span>
                  </div>
                  <input
                    type="range"
                    min={35}
                    max={55}
                    value={minDur}
                    onChange={(e) => handleMinDurChange(Number(e.target.value))}
                    className="w-full h-6 cursor-pointer"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-medium">
                    <span className="text-zinc-300">Durasi Maksimal</span>
                    <span className="font-mono tabular-nums text-white">{maxDur} detik</span>
                  </div>
                  <input
                    type="range"
                    min={35}
                    max={60}
                    value={maxDur}
                    onChange={(e) => handleMaxDurChange(Number(e.target.value))}
                    className="w-full h-6 cursor-pointer"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                <div className="space-y-1.5">
                  <label htmlFor="quality-select" className="text-xs font-medium text-zinc-300 block">
                    Resolusi Output
                  </label>
                  <select
                    id="quality-select"
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as VideoQuality)}
                    className="w-full min-h-[42px] bg-[#0B0B10] border border-white/[0.1] rounded-lg px-3 py-2.5 text-xs font-medium text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="720p">720p HD (Proses Super Cepat)</option>
                    <option value="1080p">1080p Full HD (Ketajaman Maksimal)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="speed-select" className="text-xs font-medium text-zinc-300 block">
                    Kecepatan Render
                  </label>
                  <select
                    id="speed-select"
                    value={speedPreset}
                    onChange={(e) => setSpeedPreset(e.target.value as SpeedPreset)}
                    className="w-full min-h-[42px] bg-[#0B0B10] border border-white/[0.1] rounded-lg px-3 py-2.5 text-xs font-medium text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="ultrafast">Ultra Fast (Tercepat untuk 1 Jam)</option>
                    <option value="veryfast">Very Fast (Seimbang Cepat & Halus)</option>
                    <option value="fast">Fast (Kompresi Lebih Rapi)</option>
                  </select>
                </div>
              </div>
            </section>

            {/* 03. Angle Kamera & Animasi */}
            <section id="angle-animasi" className="p-5 sm:p-6 md:p-7 space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-white">03. Angle Kamera & Animasi</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Pilih rasio platform, sudut kamera dinamis, dan gaya animasi transisi.
                </p>
              </div>

              <div className="space-y-2.5">
                <span className="text-xs font-medium text-zinc-300 block">Rasio Video</span>
                <div className="grid grid-cols-3 gap-2.5">
                  {ASPECT_OPTIONS.map((opt) => {
                    const active = aspect === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAspect(opt.id)}
                        className={`min-h-[44px] px-3 py-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-violet-500 bg-violet-500/12'
                            : 'border-white/[0.08] bg-[#0B0B10] hover:border-white/20'
                        }`}
                      >
                        <p className="text-xs font-semibold text-white">{opt.label}</p>
                        <p className="text-[11px] text-zinc-400 mt-0.5 truncate">{opt.hint}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2.5">
                <span className="text-xs font-medium text-zinc-300 block">Angle Kamera</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {ANGLE_OPTIONS.map((opt) => {
                    const active = angle === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAngle(opt.id)}
                        className={`min-h-[44px] p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-violet-500 bg-violet-500/12'
                            : 'border-white/[0.08] bg-[#0B0B10] hover:border-white/20'
                        }`}
                      >
                        <p className="text-xs font-semibold text-white">{opt.title}</p>
                        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                          {opt.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2.5">
                <span className="text-xs font-medium text-zinc-300 block">Efek Animasi</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                  {ANIMATION_OPTIONS.map((opt) => {
                    const active = animation === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAnimation(opt.id)}
                        className={`min-h-[44px] p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-violet-500 bg-violet-500/12'
                            : 'border-white/[0.08] bg-[#0B0B10] hover:border-white/20'
                        }`}
                      >
                        <p className="text-xs font-semibold text-white">{opt.title}</p>
                        <p className="text-[11px] text-zinc-400 mt-1 leading-snug">
                          {opt.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>

          {/* Right 5 Columns: Sticky Live Framing Preview & Execution Summary */}
          <aside className="lg:col-span-5 lg:sticky lg:top-24 bg-[#121218] border border-white/[0.08] rounded-2xl p-5 sm:p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Pratinjau Angle & Animasi</h2>
              <span className="text-xs font-mono text-zinc-400">{aspect}</span>
            </div>

            <LiveAnglePreview aspect={aspect} angle={angle} animation={animation} />

            <dl className="divide-y divide-white/[0.07] text-xs">
              <div className="py-2.5 flex items-center justify-between gap-4">
                <dt className="text-zinc-400">Durasi Sumber</dt>
                <dd className="font-mono tabular-nums text-zinc-100">
                  {loadedVideo ? formatDuration(loadedVideo.info.duration) : '—'}
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-4">
                <dt className="text-zinc-400">Rentang Klip Output</dt>
                <dd className="font-mono tabular-nums text-zinc-100">
                  {minDur}–{maxDur} detik
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-4">
                <dt className="text-zinc-400">Estimasi Jumlah Klip</dt>
                <dd className="font-mono tabular-nums text-zinc-100">
                  {loadedVideo ? `± ${estimatedClips} klip` : 'Menunggu video'}
                </dd>
              </div>
              {mode === 'ai_viral_moments' && (
                <div className="py-2.5 flex items-center justify-between gap-4 text-violet-300">
                  <dt className="flex items-center gap-1.5 font-medium">
                    <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                    Momen Viral Gemini
                  </dt>
                  <dd className="font-mono tabular-nums font-semibold">
                    {viralMoments.length > 0
                      ? `${viralMoments.filter((m) => m.selected).length} dari ${viralMoments.length} dipilih`
                      : 'Belum dianalisis'}
                  </dd>
                </div>
              )}
              <div className="py-2.5 flex items-center justify-between gap-4">
                <dt className="text-zinc-400">Angle & Animasi</dt>
                <dd className="text-zinc-100 text-right">
                  {ANGLE_OPTIONS.find((a) => a.id === angle)?.title} ·{' '}
                  {ANIMATION_OPTIONS.find((a) => a.id === animation)?.title}
                </dd>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-4">
                <dt className="text-zinc-400">Resolusi & Preset</dt>
                <dd className="font-mono text-zinc-100">
                  {quality} · {speedPreset}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={handleStartGenerate}
              disabled={isRunning || isBusyLoadingSource}
              className="w-full min-h-[46px] py-3.5 px-5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-violet-600/20"
            >
              {isRunning ? (
                <>
                  <Scissors className="w-4 h-4 animate-spin" />
                  Sedang Memotong Video...
                </>
              ) : mode === 'ai_viral_moments' ? (
                <>
                  <Sparkles className="w-4 h-4 text-violet-200" />
                  {viralMoments.length > 0
                    ? `Potong ${viralMoments.filter((m) => m.selected).length} Klip Viral`
                    : 'Deteksi & Potong Klip Viral'}
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4" />
                  Generate Auto Clips Sekarang
                </>
              )}
            </button>

            <div className="flex items-start gap-2.5 text-xs text-zinc-400 leading-relaxed pt-1">
              <Sparkles className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
              <p>
                Mode default <strong className="text-zinc-200">720p · Ultra Fast</strong> dengan
                blur terakselerasi membuat pemotongan klip berjalan jauh lebih cepat di server maupun
                HP.
              </p>
            </div>
          </aside>
        </div>

        {/* Full-Width Progress & Output Gallery */}
        <ClipsGallery
          jobId={jobId}
          jobStatus={jobStatus}
          recentJobs={recentJobs}
          sourceDuration={loadedVideo?.info.duration || 0}
          aspect={aspect}
          onCancel={handleCancelJob}
          onSelectJob={handleSelectJob}
          onDeleteJob={handleDeleteJob}
        />

        {/* Gemini API Key Configuration Modal */}
        {showApiKeyModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
            <div className="bg-[#121218] border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">Gemini API Key</h3>
                    <p className="text-xs text-zinc-400">Pengaturan untuk AI Viral Hook Detector</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowApiKeyModal(false)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {geminiConfig?.hasEnvKey && (
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-start gap-2.5 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-emerald-200">Kunci bawaan .env terdeteksi</p>
                    <p className="font-mono text-emerald-400 mt-0.5">{geminiConfig.maskedKey}</p>
                    <p className="text-[11px] text-emerald-300/80 mt-1 leading-relaxed">
                      Server sudah memiliki API key aktif. Anda dapat langsung menjalankan deteksi atau masukkan key kustom di bawah jika ingin menimpanya.
                    </p>
                  </div>
                </div>
              )}

              {!geminiConfig?.hasEnvKey && (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-2.5 text-xs text-amber-300">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-amber-200">GEMINI_API_KEY belum disetel di .env</p>
                    <p className="text-[11px] text-amber-300/90 mt-0.5 leading-relaxed">
                      Masukkan Google Gemini API Key Anda untuk mengaktifkan AI Viral Hook Detector & Moment Analyzer.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-300">
                  API Key Kustom (Opsional):
                </label>
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full bg-[#0B0B10] border border-white/[0.1] rounded-xl px-3.5 py-2.5 text-xs font-mono text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500"
                />
                <p className="text-[11px] text-zinc-500">
                  Tersimpan di penyimpanan lokal browser Anda untuk sesi ini.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                {customApiKey && (
                  <button
                    type="button"
                    onClick={() => {
                      setApiKeyInput('');
                      setCustomApiKey('');
                      localStorage.removeItem('autoclip_custom_gemini_key');
                    }}
                    className="px-3 py-2 rounded-xl text-xs font-medium text-red-400 hover:bg-red-500/10 transition cursor-pointer"
                  >
                    Hapus Key Kustom
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowApiKeyModal(false)}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleSaveApiKey}
                  className="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition flex items-center gap-1.5 cursor-pointer shadow-md shadow-violet-600/30"
                >
                  {apiKeySavedSuccess ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Tersimpan!
                    </>
                  ) : (
                    'Simpan Key'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
      <OfflineBanner />
    </div>
  );
}
