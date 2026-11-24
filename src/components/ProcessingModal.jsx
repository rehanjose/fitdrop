import React from 'react';
import { Sparkles } from 'lucide-react';

export default function ProcessingModal({ isOpen, progress, statusText, cutoutMode }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-6">
      <div className="w-full max-w-md rounded-2xl border border-[#26262A] bg-[#161618] p-7 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#CCFF00]/12 border border-[#CCFF00]/30 text-[#CCFF00]">
            <Sparkles className="h-5 w-5 animate-pulse" />
          </div>
          <span className="font-mono-hud text-xs uppercase tracking-widest text-[#CCFF00]">
            {Math.round(progress)}%
          </span>
        </div>

        <p className="font-mono-hud text-[10px] uppercase tracking-[0.18em] text-[#8E8E93] mb-1">
          {cutoutMode === 'ai' ? 'LOCAL AI CUTOUT ENGINE' : 'INSTANT LIGHT-BG ENGINE'}
        </p>
        <h3 className="font-display text-xl font-bold text-[#F5F5F7] mb-2">
          Preparing Virtual Garment
        </h3>
        <p className="text-sm text-[#8E8E93] mb-5">{statusText}</p>

        {/* Progress Bar */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-[#0B0B0C] border border-[#26262A]">
          <div
            className="h-full rounded-full bg-[#CCFF00] transition-all duration-200 ease-out"
            style={{ width: `${Math.max(6, Math.min(100, progress))}%` }}
          />
        </div>

        <p className="mt-4 font-mono-hud text-[10px] uppercase tracking-wider text-[#8E8E93]">
          100% IN-BROWSER PROCESSING • ZERO CLOUD UPLOAD
        </p>
      </div>
    </div>
  );
}
