import React, { useState, useRef } from 'react';
import { Upload, Sparkles, ArrowUpRight, Layers, CheckCircle2 } from 'lucide-react';

export default function HomeScreen({
  poseStatus,
  demoTees,
  onOpenUpload,
  onDropFiles,
  onLaunchDemoTee,
}) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const isImageFile = (f) =>
    f.type.startsWith('image/') || /\.(avif|webp|png|jpe?g)$/i.test(f.name || '');

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter(isImageFile);
    if (files.length > 0) {
      onDropFiles(files);
    } else {
      onOpenUpload();
    }
  };

  const handleQuickFileSelect = (e) => {
    const files = Array.from(e.target.files || []).filter(isImageFile);
    if (files.length > 0) {
      onDropFiles(files);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0B0B0C] text-[#F5F5F7] overflow-hidden">
      {/* Top Studio Bar */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[#26262A] px-8">
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="FitDrop"
            className="h-8 w-auto object-contain select-none"
          />
          <span className="ml-2 rounded-md border border-[#26262A] bg-[#161618] px-2 py-0.5 font-mono-hud text-[10px] uppercase tracking-wider text-[#8E8E93]">
            STUDIO v1.0
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-[#26262A] bg-[#161618] px-3.5 py-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                poseStatus === 'ready'
                  ? 'bg-[#CCFF00] shadow-[0_0_8px_#CCFF00]'
                  : poseStatus === 'loading'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-[#8E8E93]'
              }`}
            />
            <span className="font-mono-hud text-[11px] uppercase tracking-[0.14em] text-[#F5F5F7]">
              {poseStatus === 'ready'
                ? 'LOCAL AR ENGINE • READY'
                : poseStatus === 'loading'
                ? 'PRE-LOADING POSE ENGINE...'
                : 'LOCAL AR ENGINE • STANDBY'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Widescreen Split Content */}
      <main className="flex flex-1 flex-col justify-between px-8 py-6 min-h-0">
        {/* Hero + Two Large Action Cards */}
        <div className="grid grid-cols-12 gap-6 items-center my-auto">
          {/* Left Hero Column */}
          <div className="col-span-5 flex flex-col gap-4 pr-4">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[#26262A] bg-[#161618] px-3 py-1 font-mono-hud text-[11px] uppercase tracking-[0.16em] text-[#CCFF00]">
              <Sparkles className="h-3.5 w-3.5" />
              ZERO-BACKEND • PHOTO-TO-AR
            </div>

            <h1 className="font-display text-5xl font-bold leading-[1.06] tracking-tight text-[#F5F5F7]">
              Upload T-shirt angles.
              <br />
              <span className="text-[#8E8E93]">Try it on live.</span>
            </h1>

            <p className="text-[15px] leading-relaxed text-[#8E8E93] max-w-md">
              Lay your T-shirt flat on a plain background, upload the Front &amp; Back photos, and
              preview the exact fit live on any body frame—with automatic background removal and
              360° front, side &amp; back tracking.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-4 font-mono-hud text-[11px] uppercase tracking-wider text-[#8E8E93]">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#CCFF00]" />
                Boy &amp; Girl Adaptive Fit
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#CCFF00]" />
                Auto AI Cutout
              </span>
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#CCFF00]" />
                100% Local &amp; Free
              </span>
            </div>
          </div>

          {/* Right Action Card: Upload Front & Back Photos */}
          <div className="col-span-7">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={onOpenUpload}
              className={`group relative flex h-[280px] flex-col justify-between rounded-[20px] border p-8 transition-all cursor-pointer ${
                isDragging
                  ? 'border-[#CCFF00] bg-[#CCFF00]/10 scale-[1.01]'
                  : 'border-[#26262A] bg-[#161618] hover:border-[#CCFF00]/60 hover:bg-[#1A1A1E]'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleQuickFileSelect}
              />
              <div className="flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#CCFF00] text-[#0B0B0C] shadow-[0_0_24px_rgba(204,255,0,0.22)]">
                  <Upload className="h-6 w-6" />
                </div>
                <span className="rounded-full border border-[#26262A] bg-[#0B0B0C] px-3 py-1 font-mono-hud text-[10px] uppercase tracking-wider text-[#CCFF00]">
                  FLAT-LAY OR ONLINE STORE MODEL PHOTOS
                </span>
              </div>

              <div>
                <h2 className="font-display text-3xl font-bold text-[#F5F5F7] mb-2 flex items-center gap-2">
                  Upload T-Shirt Photos
                  <ArrowUpRight className="h-6 w-6 text-[#8E8E93] group-hover:text-[#CCFF00] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                </h2>
                <p className="text-sm text-[#8E8E93] leading-relaxed max-w-lg">
                  Drop all your product or model-shoot photos at once—we extract the T-shirt from
                  every angle and reconstruct a seamless 360° live try-on.
                </p>
              </div>

              <div className="flex items-center justify-between border-t border-[#26262A] pt-4 font-mono-hud text-[11px] uppercase tracking-wider text-[#8E8E93]">
                <span>{isDragging ? 'DROP PHOTOS TO START' : 'PNG • JPG • WEBP • AVIF'}</span>
                <span className="text-[#F5F5F7] group-hover:text-[#CCFF00]">
                  360° MULTI-PHOTO UPLOAD →
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Strip: Saved Wardrobe (5 Demo Tees) */}
        <section className="shrink-0 border-t border-[#26262A] pt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[#CCFF00]" />
              <span className="font-mono-hud text-xs font-semibold uppercase tracking-[0.16em] text-[#F5F5F7]">
                SAVED WARDROBE ({demoTees.length} DEMO TEES)
              </span>
              <span className="text-xs text-[#8E8E93]">— Click any tee for instant 1-click try-on</span>
            </div>
            <span className="font-mono-hud text-[11px] uppercase tracking-wider text-[#8E8E93]">
              PRE-CUTOUT TRANSPARENT PNGs
            </span>
          </div>

          <div className="grid grid-cols-5 gap-3.5">
            {demoTees.map((tee) => (
              <button
                key={tee.id}
                onClick={() => onLaunchDemoTee(tee)}
                className="group flex items-center gap-3.5 rounded-2xl border border-[#26262A] bg-[#161618] p-2.5 text-left hover:border-[#CCFF00]/70 hover:bg-[#1C1C20] transition-all cursor-pointer"
              >
                <div className="flex h-16 w-14 shrink-0 items-center justify-center rounded-xl bg-[#0B0B0C] border border-[#26262A] p-1 overflow-hidden">
                  <img
                    src={tee.frontUrl}
                    alt={tee.name}
                    className="h-full w-full object-contain group-hover:scale-105 transition-transform"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-sm font-semibold text-[#F5F5F7] group-hover:text-[#CCFF00] transition-colors">
                    {tee.name}
                  </p>
                  <p className="font-mono-hud text-[10px] uppercase tracking-wider text-[#8E8E93] mt-0.5">
                    {tee.tag} • {tee.defaultFit}
                  </p>
                  <p className="font-mono-hud text-[10px] uppercase tracking-wider text-[#CCFF00]/80 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    TRY ON LIVE →
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
