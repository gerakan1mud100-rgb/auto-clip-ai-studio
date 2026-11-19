import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);

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

export function getGeminiEnvConfig(): { hasEnvKey: boolean; maskedKey: string | null } {
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  const hasEnvKey = envKey.length > 5;
  const maskedKey = hasEnvKey
    ? `${envKey.slice(0, 8)}...${envKey.slice(-4)}`
    : null;

  return { hasEnvKey, maskedKey };
}

export function resolveApiKey(clientKey?: string): string {
  const custom = (clientKey || '').trim();
  if (custom.length > 0) {
    return custom;
  }
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  if (envKey.length > 0) {
    return envKey;
  }
  throw new Error(
    'Gemini API Key belum disetel. Masukkan API Key pada input form di bagian atas aplikasi atau pastikan GEMINI_API_KEY terpasang di file .env.'
  );
}

export async function extractAudioForGemini(
  videoPath: string,
  ffmpegBin: string,
  tempDir: string
): Promise<string> {
  if (!fs.existsSync(videoPath)) {
    throw new Error('File video sumber tidak ditemukan untuk ekstraksi audio.');
  }

  const rand = crypto.randomBytes(4).toString('hex');
  const audioPath = path.join(tempDir, `audio_${Date.now()}_${rand}.mp3`);

  // Extraksi audio 16kHz Mono 48kbps MP3 (sangat optimal untuk transkrip & ASR AI serta ukuran file sangat hemat)
  await execFileAsync(ffmpegBin, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '48k',
    audioPath,
  ]);

  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    throw new Error('Gagal mengekstrak audio dari video atau video tidak memiliki suara.');
  }

  return audioPath;
}

export async function analyzeMomentsWithGemini(params: {
  audioPath: string;
  videoDuration: number;
  minDur?: number;
  maxDur?: number;
  targetCount?: number;
  apiKey?: string;
}): Promise<ViralMoment[]> {
  const { audioPath, videoDuration } = params;
  const minDur = Math.max(25, Math.min(55, Number(params.minDur || 35)));
  const maxDur = Math.max(minDur + 5, Math.min(65, Number(params.maxDur || 60)));
  const targetCount = Math.max(1, Math.min(20, Number(params.targetCount || 5)));
  const apiKey = resolveApiKey(params.apiKey);

  const ai = new GoogleGenAI({ apiKey });
  const stat = fs.statSync(audioPath);
  const fileSizeMb = stat.size / (1024 * 1024);

  let uploadedFileName: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let audioPart: any;

  try {
    if (fileSizeMb <= 18) {
      // Inline base64 untuk proses yang sangat cepat tanpa upload latency
      const buf = fs.readFileSync(audioPath);
      audioPart = {
        inlineData: {
          mimeType: 'audio/mp3',
          data: buf.toString('base64'),
        },
      };
    } else {
      // Gunakan Files API jika audio berukuran besar (> 18 MB)
      const uploadRes = await ai.files.upload({
        file: audioPath,
        config: {
          mimeType: 'audio/mp3',
        },
      });
      uploadedFileName = uploadRes.name || null;
      audioPart = {
        fileData: {
          fileUri: uploadRes.uri,
          mimeType: uploadRes.mimeType || 'audio/mp3',
        },
      };
    }

    const prompt = `
Anda adalah seorang Creative Director, Editor Video Pendek Profesional, dan Algoritma Specialist untuk TikTok, Instagram Reels, dan YouTube Shorts.
Tugas Anda: Dengarkan dan analisis rekaman audio ini secara mendalam untuk menemukan ${targetCount} potongan momen terbaik yang paling berpotensi viral.

Spesifikasi Pemotongan:
1. Durasi tiap klip HARUS di antara ${minDur} detik sampai ${maxDur} detik. Total durasi video adalah ${videoDuration.toFixed(1)} detik.
2. Titik mulai (start) dan selesai (end) HARUS jatuh pada jeda alami berbicara (natural conversational pause) agar tidak terpotong canggung di tengah kata.
3. Kriteria Momen Viral:
   - Mengandung Hook 3 Detik Pertama yang sangat kuat (membuat penonton berhenti scrolling / Stop-the-Scroll).
   - Memiliki muatan emosi tinggi, punchline lucu, tips/revelation berharga, kontroversi ringan, fakta mengejutkan, atau cerita yang memikat.
   - Pesan yang lengkap dari awal pembuka hingga klimaks/konklusi dalam rentang durasi tersebut.

Untuk setiap klip momen yang ditemukan, buatkan data:
- "hook": Kalimat headline teks hook pembuka di 3 detik pertama (maks 15 kata, gaya click-worthy dan rasa penasaran tinggi).
- "title": Judul klip yang padat dan menarik.
- "viralScore": Angka estimasi viralitas dari 1 sampai 100 (misal: 95, 92, 88).
- "viralReason": Penjelasan singkat 1-2 kalimat mengapa momen ini berpotensi viral tinggi di media sosial.
- "start": Waktu mulai dalam detik (angka desimal).
- "end": Waktu selesai dalam detik (angka desimal).
- "keyQuote": Kutipan kata-kata paling berkesan dari segmen ini.

HANYA berikan output dalam format JSON murni berikut:
{
  "moments": [
    {
      "hook": "Teks hook pembuka 3 detik...",
      "title": "Judul klip...",
      "viralScore": 94,
      "viralReason": "Alasan viral...",
      "start": 14.5,
      "end": 52.0,
      "keyQuote": "Kutipan terkuat..."
    }
  ]
}
`;

    const modelCandidates = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'];
    let lastError: Error | null = null;
    let responseText = '';

    for (const model of modelCandidates) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [audioPart, prompt],
          config: {
            responseMimeType: 'application/json',
            temperature: 0.3,
          },
        });
        if (response.text) {
          responseText = response.text;
          break;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Coba model berikutnya jika model tertentu sibuk / tidak tersedia
        continue;
      }
    }

    if (!responseText) {
      throw lastError || new Error('Tidak ada respon teks yang diterima dari Gemini API.');
    }

    // Bersihkan kemungkinan markdown wrapper
    let cleanJson = responseText.trim();
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(cleanJson);
    } catch {
      throw new Error('Respon dari Gemini bukan format JSON yang valid.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawList: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.moments)
        ? parsed.moments
        : Array.isArray(parsed.clips)
          ? parsed.clips
          : [];

    if (rawList.length === 0) {
      throw new Error('Gemini tidak menemukan momen viral yang memenuhi kriteria durasi.');
    }

    const validatedMoments: ViralMoment[] = [];

    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      let start = Number(item.start);
      let end = Number(item.end);

      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end <= start) end = Math.min(videoDuration, start + minDur);

      // Clamp ke batas video
      start = Math.max(0, Math.min(videoDuration - 5, start));
      end = Math.min(videoDuration, Math.max(start + 5, end));

      let dur = Number((end - start).toFixed(1));

      // Jika durasi terlalu pendek atau terlalu panjang dari toleransi, sesuaikan secara proporsional
      if (dur < minDur && videoDuration >= start + minDur) {
        end = Math.min(videoDuration, start + minDur);
        dur = Number((end - start).toFixed(1));
      } else if (dur > maxDur) {
        end = start + maxDur;
        dur = Number((end - start).toFixed(1));
      }

      const score = Math.max(
        50,
        Math.min(99, Math.round(Number(item.viralScore) || 85))
      );

      validatedMoments.push({
        id: `moment_${Date.now()}_${i + 1}_${crypto.randomBytes(3).toString('hex')}`,
        hook: String(item.hook || 'Momen Paling Menarik!').trim(),
        title: String(item.title || `Viral Highlight #${i + 1}`).trim(),
        viralScore: score,
        viralReason: String(
          item.viralReason || 'Kombinasi topik kuat dan hook awal yang memikat retensi.'
        ).trim(),
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        duration: dur,
        keyQuote: item.keyQuote ? String(item.keyQuote).trim() : undefined,
        selected: true,
      });
    }

    // Urutkan berdasarkan skor viralitas tertinggi
    validatedMoments.sort((a, b) => b.viralScore - a.viralScore);

    return validatedMoments;
  } finally {
    // Hapus file di Gemini cloud jika tadi diupload
    if (uploadedFileName) {
      try {
        await ai.files.delete({ name: uploadedFileName });
      } catch {
        // Abaikan kegagalan cleanup file cloud
      }
    }
  }
}
