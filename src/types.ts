export type ClipMode =
  | 'smart_highlights'
  | 'auto_split'
  | 'custom_count'
  | 'ai_viral_moments';
export type AspectRatio = '9:16' | '1:1' | '16:9';
export type CameraAngle = 'blur_frame' | 'multi_angle' | 'dynamic_pan' | 'center';
export type ClipAnimation = 'fade' | 'zoom' | 'float' | 'slide' | 'none';
export type VideoQuality = '720p' | '1080p';
export type SpeedPreset = 'ultrafast' | 'veryfast' | 'fast';

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeMb: number;
  fps: number;
}

export interface LoadedVideo {
  filePath: string;
  filename: string;
  info: VideoInfo;
}

export interface ViralMoment {
  id: string;
  hook: string;
  title: string;
  viralScore: number;
  viralReason: string;
  start: number;
  end: number;
  duration: number;
  keyQuote?: string;
  selected?: boolean;
}

export interface ClipMeta {
  index: number;
  filename: string;
  start: number;
  end: number;
  duration: number;
  url: string;
  sizeMb: number;
  title?: string;
  hook?: string;
  viralScore?: number;
  viralReason?: string;
}

export interface JobStatusResponse {
  id?: string;
  sourceName?: string;
  aspect?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  completed: number;
  total: number;
  overallPct?: number;
  currentStep: string;
  clips: ClipMeta[];
  plannedSegments: Array<{
    start: number;
    end: number;
    hook?: string;
    title?: string;
    viralScore?: number;
    viralReason?: string;
  }>;
  error: string | null;
}

export interface JobSummary {
  id: string;
  sourceName: string;
  aspect: string;
  createdAt: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  completed: number;
  total: number;
  clipCount: number;
}

export const CLIP_MODES: Array<{
  id: ClipMode;
  title: string;
  description: string;
}> = [
  {
    id: 'ai_viral_moments',
    title: 'AI Viral Moments (Gemini)',
    description: 'Memotong berdasarkan analisis transkrip & hook viral terbaik kurasi Gemini AI.',
  },
  {
    id: 'smart_highlights',
    title: 'Smart Highlights',
    description: 'Mendeteksi puncak energi audio untuk mengambil momen paling seru secara otomatis.',
  },
  {
    id: 'auto_split',
    title: 'Auto Split Penuh',
    description: 'Memotong seluruh video dari awal hingga akhir menjadi banyak klip berurutan.',
  },
  {
    id: 'custom_count',
    title: 'Jumlah Klip Merata',
    description: 'Menghasilkan jumlah klip pilihan yang tersebar merata di sepanjang durasi video.',
  },
];

export const ASPECT_OPTIONS: Array<{
  id: AspectRatio;
  label: string;
  hint: string;
}> = [
  { id: '9:16', label: '9:16 Vertikal', hint: 'TikTok, Reels, Shorts' },
  { id: '1:1', label: '1:1 Persegi', hint: 'Feed Instagram, LinkedIn' },
  { id: '16:9', label: '16:9 Wide', hint: 'YouTube Landscape' },
];

export const ANGLE_OPTIONS: Array<{
  id: CameraAngle;
  title: string;
  description: string;
}> = [
  {
    id: 'blur_frame',
    title: 'Blur Cinematic',
    description: 'Video utama utuh di tengah dengan latar belakang blur estetik.',
  },
  {
    id: 'multi_angle',
    title: 'Multi-Angle Cut',
    description: 'Otomatis berganti sudut Wide dan Close-Up tiap beberapa detik.',
  },
  {
    id: 'dynamic_pan',
    title: 'Dynamic Auto-Pan',
    description: 'Kamera menyapu sisi kiri ke kanan secara halus mengikuti bingkai.',
  },
  {
    id: 'center',
    title: 'Center Crop Full',
    description: 'Mengisi penuh seluruh layar dengan fokus tepat di tengah frame.',
  },
];

export const ANIMATION_OPTIONS: Array<{
  id: ClipAnimation;
  title: string;
  description: string;
}> = [
  {
    id: 'fade',
    title: 'Smooth Fade',
    description: 'Transisi masuk & keluar halus beserta audio fade.',
  },
  {
    id: 'zoom',
    title: 'Ken Burns Zoom',
    description: 'Gerakan zoom sinematik perlahan sepanjang klip.',
  },
  {
    id: 'float',
    title: 'Floating Cam',
    description: 'Efek gerak kamera handheld yang hidup dan dinamis.',
  },
  {
    id: 'slide',
    title: 'Slide-In Intro',
    description: 'Animasi geser masuk di awal klip dan fade out halus.',
  },
  {
    id: 'none',
    title: 'Tanpa Animasi',
    description: 'Pemotongan langsung untuk kecepatan render maksimal.',
  },
];
