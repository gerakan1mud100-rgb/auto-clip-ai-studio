import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AspectRatio, CameraAngle, ClipAnimation } from '../types';

interface LiveAnglePreviewProps {
  aspect: AspectRatio;
  angle: CameraAngle;
  animation: ClipAnimation;
}

export function LiveAnglePreview({ aspect, angle, animation }: LiveAnglePreviewProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => (t + 1) % 8);
    }, 1200);
    return () => window.clearInterval(id);
  }, []);

  const isCloseUp = angle === 'multi_angle' && tick % 2 === 1;

  const frameBoxClass =
    aspect === '9:16'
      ? 'w-[168px] h-[298px]'
      : aspect === '1:1'
        ? 'w-[240px] h-[240px]'
        : 'w-[300px] h-[169px]';

  const getMotionProps = () => {
    if (animation === 'zoom') {
      return {
        animate: { scale: [1, 1.14, 1] },
        transition: { duration: 6, repeat: Infinity, ease: 'easeInOut' as const },
      };
    }
    if (animation === 'float') {
      return {
        animate: { x: [-5, 5, -4, 4, -5], y: [-3, 4, 2, -4, -3], scale: 1.08 },
        transition: { duration: 4.5, repeat: Infinity, ease: 'easeInOut' as const },
      };
    }
    if (animation === 'slide') {
      return {
        animate: { x: [-40, 0, 0, 0], opacity: [0.2, 1, 1, 0.9] },
        transition: { duration: 3.6, repeat: Infinity, ease: 'easeOut' as const },
      };
    }
    if (animation === 'fade') {
      return {
        animate: { opacity: [0.35, 1, 1, 0.35] },
        transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' as const },
      };
    }
    return { animate: { scale: 1, x: 0, y: 0, opacity: 1 } };
  };

  const panX = angle === 'dynamic_pan' ? (tick % 4 < 2 ? -14 : 14) : 0;
  const angleScale = isCloseUp ? 1.32 : 1;

  return (
    <div className="flex flex-col items-center justify-center py-6 px-4 bg-[#0B0B10] rounded-xl border border-white/[0.06]">
      <div
        className={`relative overflow-hidden rounded-lg border border-white/15 bg-zinc-950 shadow-2xl transition-all duration-300 ${frameBoxClass}`}
      >
        {/* Blurred Backdrop for blur_frame */}
        {angle === 'blur_frame' && (
          <div
            aria-hidden="true"
            className="absolute inset-0 scale-125 blur-xl opacity-65 bg-[radial-gradient(circle_at_30%_30%,#6d28d9_0%,#1e1b4b_45%,#09090d_100%)]"
          />
        )}

        {/* Simulated Video Layer */}
        <motion.div
          className="relative w-full h-full flex items-center justify-center"
          {...getMotionProps()}
        >
          <motion.div
            animate={{
              scale: angleScale,
              x: panX,
            }}
            transition={{ duration: angle === 'multi_angle' ? 0.15 : 1.1, ease: 'easeInOut' }}
            className={
              angle === 'blur_frame'
                ? 'w-[92%] aspect-video rounded-md overflow-hidden border border-white/15 shadow-lg relative'
                : 'w-full h-full relative overflow-hidden'
            }
          >
            {/* Studio Scene Mockup inside Frame */}
            <div className="w-full h-full bg-gradient-to-br from-violet-950 via-zinc-900 to-zinc-950 relative flex items-center justify-center">
              <div
                aria-hidden="true"
                className="absolute inset-0 opacity-45 bg-[radial-gradient(circle_at_65%_30%,rgba(139,92,246,0.55),transparent_55%),radial-gradient(circle_at_25%_75%,rgba(56,189,248,0.28),transparent_50%)]"
              />
              {/* Subject silhouette */}
              <div className="relative z-10 flex flex-col items-center gap-2">
                <div className="w-11 h-11 rounded-full bg-gradient-to-b from-zinc-200 to-zinc-400/80 shadow-md" />
                <div className="w-20 h-9 rounded-t-2xl bg-gradient-to-b from-zinc-300/90 to-zinc-500/70" />
              </div>

              {/* Safe rule-of-thirds subtle hairlines */}
              <div className="absolute inset-0 pointer-events-none border border-white/10" />
            </div>
          </motion.div>
        </motion.div>

        {/* Angle State Label */}
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[11px] font-mono text-zinc-200/90 bg-black/65 backdrop-blur-sm px-2.5 py-1 rounded">
          <span>{aspect}</span>
          <span>
            {angle === 'multi_angle'
              ? isCloseUp
                ? 'Close-Up'
                : 'Wide'
              : angle === 'blur_frame'
                ? 'Blur BG'
                : angle === 'dynamic_pan'
                  ? 'Auto-Pan'
                  : 'Center'}
          </span>
        </div>
      </div>

      <p className="mt-3 text-xs text-zinc-400 text-center">
        Simulasi framing & gerakan kamera secara langsung
      </p>
    </div>
  );
}
