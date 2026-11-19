import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download, Share2, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

const FALLBACK_PUBLIC_URL =
  'https://ais-pre-utfg4kpz5mladdhh4fcgri-770362630053.asia-southeast1.run.app';

interface PWAInstallControlsProps {
  serverAppUrl: string | null;
}

export function PWAInstallControls({ serverAppUrl }: PWAInstallControlsProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showMobileModal, setShowMobileModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const shareUrl =
    serverAppUrl ||
    (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? window.location.origin
      : FALLBACK_PUBLIC_URL);

  useEffect(() => {
    if (!showMobileModal) return;
    let active = true;
    QRCode.toDataURL(shareUrl, {
      width: 220,
      margin: 2,
      color: { dark: '#111118', light: '#FFFFFF' },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [showMobileModal, shareUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Auto Clip.Ai Studio',
          text: 'Buka Auto Clip.Ai Studio di HP untuk memotong video otomatis 35–60 detik.',
          url: shareUrl,
        });
        return;
      } catch {
        // Cancelled
      }
    }
    setShowMobileModal(true);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 shrink-0">
        {!isInstalled && isInstallable && (
          <button
            type="button"
            onClick={() => void install()}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Install Web App
          </button>
        )}

        {!isInstalled && isIOS && (
          <button
            type="button"
            onClick={() => setShowMobileModal(true)}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.1] text-xs font-semibold text-white transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
          >
            <Smartphone className="w-4 h-4 text-violet-400" />
            Install di iPhone
          </button>
        )}

        <button
          type="button"
          onClick={() => setShowMobileModal(true)}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] text-xs font-medium text-zinc-200 transition-colors flex items-center gap-2 whitespace-nowrap cursor-pointer"
        >
          <Smartphone className="w-4 h-4 text-violet-400" />
          Akses & Link HP
        </button>
      </div>

      {showMobileModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-access-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto"
        >
          <div className="w-full max-w-md bg-[#121218] border border-white/[0.12] rounded-2xl p-6 space-y-5 shadow-2xl my-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="mobile-access-title" className="text-base font-bold text-white">
                  Buka Auto Clip.Ai Studio di HP
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Scan QR code dengan kamera HP atau salin link di bawah untuk memasang aplikasi ke
                  Layar Utama (Web APK).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowMobileModal(false)}
                aria-label="Tutup"
                className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {qrDataUrl && (
              <div className="flex flex-col items-center justify-center py-3 bg-white rounded-xl">
                <img
                  src={qrDataUrl}
                  alt="QR Code Akses Auto Clip.Ai Studio di HP"
                  className="w-44 h-44"
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-300 block">
                Link Web App (Android & iPhone)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 min-w-0 bg-[#09090D] border border-white/[0.1] rounded-lg px-3 py-2.5 text-xs font-mono text-zinc-200 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Tersalin' : 'Salin'}
                </button>
              </div>
            </div>

            <div className="divide-y divide-white/[0.07] text-xs border-t border-b border-white/[0.07]">
              <div className="py-3 space-y-1">
                <p className="font-semibold text-white">Agar Link Publik Langsung Masuk ke Aplikasi</p>
                <p className="text-zinc-400 leading-relaxed">
                  Link <code className="text-zinc-200">ais-dev-...</code> bersifat privat untuk akun
                  Google AI Studio Anda. Untuk akses publik langsung tanpa login AI Studio, klik{' '}
                  <strong className="text-zinc-200">Deploy to Cloud Run</strong> atau atur{' '}
                  <strong className="text-zinc-200">Share &rarr; Public</strong> di kanan atas AI Studio.
                </p>
              </div>
              <div className="py-3 space-y-1">
                <p className="font-semibold text-white">Android (Chrome / Edge)</p>
                <p className="text-zinc-400 leading-relaxed">
                  Buka link publik di Chrome, tekan tombol <strong className="text-zinc-200">Install Web App</strong> atau menu{' '}
                  <strong className="text-zinc-200">⋮ &rarr; Tambahkan ke Layar Utama / Install Aplikasi</strong>.
                </p>
              </div>
              <div className="py-3 space-y-1">
                <p className="font-semibold text-white">iPhone / iPad (Safari)</p>
                <p className="text-zinc-400 leading-relaxed">
                  Buka link publik di Safari, ketuk ikon <strong className="text-zinc-200">Share</strong> di
                  bilah bawah, lalu pilih <strong className="text-zinc-200">Add to Home Screen</strong>.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              {typeof navigator !== 'undefined' && 'share' in navigator && (
                <button
                  type="button"
                  onClick={() => void handleNativeShare()}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Kirim Link
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowMobileModal(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
              >
                Selesai
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 right-4 sm:right-auto z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2.5 text-xs font-medium text-white shadow-lg"
    >
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>Mode Offline — Koneksi internet diperlukan untuk memproses klip video di server.</span>
    </div>
  );
}
