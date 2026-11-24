import React, { useState } from 'react';
import {
  ArrowLeft,
  Plus,
  X,
  Sparkles,
  Zap,
  CheckCircle2,
  Upload,
  Layers,
} from 'lucide-react';

export default function UploadGridScreen({
  photos = [], // Array of { id, url, angle, angleDeg, label, classifying }
  teeName,
  cutoutMode,
  onChangeTeeName,
  onChangeCutoutMode,
  onAddFiles,
  onRemovePhoto,
  onClearAll,
  onBackHome,
  onCreateTryOn,
}) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter(
      (f) => f.type.startsWith('image/') || /\.(avif|webp|png|jpe?g)$/i.test(f.name || '')
    );
    if (files.length > 0 && onAddFiles) {
      onAddFiles(files);
    }
  };

  const canLaunch = photos.length > 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0B0B0C] text-[#F5F5F7] overflow-hidden">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[#26262A] px-8">
        <div className="flex items-center gap-4">
          <button
            onClick={onBackHome}
            className="flex items-center gap-2 rounded-xl border border-[#26262A] bg-[#161618] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] hover:bg-[#1E1E22] transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Studio Home
          </button>
          <div className="h-5 w-px bg-[#26262A]" />
          <div>
            <p className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93]">
              360° MULTI-PHOTO RECONSTRUCTION
            </p>
            <h1 className="font-display text-base font-bold text-[#F5F5F7]">
              Upload T-Shirt Photos
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={teeName}
            onChange={(e) => onChangeTeeName(e.target.value)}
            placeholder="Garment Name (e.g. Oversized Street Tee)"
            className="w-64 rounded-xl border border-[#26262A] bg-[#161618] px-3.5 py-2 text-xs text-[#F5F5F7] placeholder-[#8E8E93] focus:border-[#CCFF00] focus:outline-none"
          />
          {photos.length > 0 && (
            <button
              onClick={onClearAll}
              className="rounded-xl border border-[#26262A] bg-[#161618] px-3 py-2 font-mono-hud text-[10px] uppercase tracking-wider text-[#8E8E93] hover:text-red-400 hover:border-red-400/40 transition-colors cursor-pointer"
            >
              Clear All
            </button>
          )}
        </div>
      </header>

      {/* Main Unified Multi-Photo Reconstruction Workspace */}
      <main className="flex flex-1 flex-col justify-between px-8 py-6 min-h-0">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-tight">
              Drop all angles of your T-shirt
            </h2>
            <p className="text-sm text-[#8E8E93] mt-0.5">
              Upload 1–8 photos (flat-lay or online store model shoots). We extract the T-shirt from
              every angle and reconstruct a seamless 360° try-on.
            </p>
          </div>

          {/* Speed / Quality Cutout Toggle */}
          <div className="flex items-center gap-1.5 rounded-xl border border-[#26262A] bg-[#161618] p-1">
            <button
              onClick={() => onChangeCutoutMode('ai')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all cursor-pointer ${
                cutoutMode === 'ai'
                  ? 'bg-[#CCFF00] text-[#0B0B0C] font-semibold'
                  : 'text-[#8E8E93] hover:text-[#F5F5F7]'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Auto AI Cutout (Best Quality)
            </button>
            <button
              onClick={() => onChangeCutoutMode('instant')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-all cursor-pointer ${
                cutoutMode === 'instant'
                  ? 'bg-[#CCFF00] text-[#0B0B0C] font-semibold'
                  : 'text-[#8E8E93] hover:text-[#F5F5F7]'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              Instant Light-BG Cutout (0.5s)
            </button>
          </div>
        </div>

        {/* Unified Multi-Photo Drop Canvas & Gallery Grid */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`flex-1 rounded-[22px] border-2 border-dashed p-6 transition-all min-h-0 overflow-y-auto ${
            isDragging
              ? 'border-[#CCFF00] bg-[#CCFF00]/8'
              : photos.length > 0
              ? 'border-[#26262A] bg-[#131315]'
              : 'border-[#333338] bg-[#161618]/60 hover:border-[#CCFF00]/50'
          }`}
        >
          {photos.length === 0 ? (
            <label className="flex h-full w-full flex-col items-center justify-center gap-4 text-center cursor-pointer">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#CCFF00]/15 border border-[#CCFF00]/40 text-[#CCFF00]">
                <Upload className="h-8 w-8" />
              </div>
              <div>
                <p className="font-display text-xl font-bold text-[#F5F5F7]">
                  Drop all your T-shirt photos here
                </p>
                <p className="text-sm text-[#8E8E93] mt-1 max-w-md mx-auto">
                  Select multiple photos at once—Front, Back, Left &amp; Right model shots or
                  flat-lay pics. Supports PNG, JPG, WEBP &amp; AVIF.
                </p>
              </div>
              <span className="mt-1 rounded-xl bg-[#CCFF00] px-5 py-2.5 font-display text-xs font-bold text-[#0B0B0C]">
                Browse Photos
              </span>
              <input
                type="file"
                accept="image/*,.avif,.webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  const selected = Array.from(e.target.files || []);
                  if (selected.length > 0 && onAddFiles) onAddFiles(selected);
                  e.target.value = '';
                }}
              />
            </label>
          ) : (
            <div className="grid grid-cols-4 gap-4">
              {photos.map((photo) => (
                <div
                  key={photo.id}
                  className="group relative flex aspect-[3/4] flex-col overflow-hidden rounded-2xl border border-[#26262A] bg-[#0B0B0C]"
                >
                  <img
                    src={photo.url}
                    alt={photo.label || 'Uploaded photo'}
                    className="h-full w-full object-contain p-2"
                  />

                  {/* Auto-detected Angle Badge */}
                  <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-black/80 backdrop-blur-md border border-[#26262A] px-2.5 py-1">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        photo.classifying ? 'bg-amber-400 animate-pulse' : 'bg-[#CCFF00]'
                      }`}
                    />
                    <span className="font-mono-hud text-[9px] font-semibold uppercase tracking-wider text-[#F5F5F7]">
                      {photo.classifying ? 'SCANNING...' : photo.label}
                    </span>
                  </div>

                  {/* Remove Button */}
                  <button
                    onClick={() => onRemovePhoto(photo.id)}
                    className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/80 border border-[#26262A] text-[#F5F5F7] opacity-80 hover:opacity-100 hover:bg-red-500/90 hover:border-red-400 transition-all cursor-pointer"
                    title="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}

              {/* Add More Tile (up to 8 photos) */}
              {photos.length < 8 && (
                <label className="flex aspect-[3/4] flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed border-[#333338] bg-[#161618]/60 hover:border-[#CCFF00]/60 hover:bg-[#161618] transition-all cursor-pointer text-center p-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#333338] bg-[#0B0B0C] text-[#CCFF00]">
                    <Plus className="h-5 w-5" />
                  </div>
                  <span className="font-display text-xs font-semibold text-[#F5F5F7]">
                    Add More Angles
                  </span>
                  <span className="font-mono-hud text-[9px] uppercase tracking-wider text-[#8E8E93]">
                    {8 - photos.length} SLOTS LEFT
                  </span>
                  <input
                    type="file"
                    accept="image/*,.avif,.webp"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const selected = Array.from(e.target.files || []);
                      if (selected.length > 0 && onAddFiles) onAddFiles(selected);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        {/* Bottom Primary CTA Bar */}
        <footer className="mt-5 flex shrink-0 items-center justify-between border-t border-[#26262A] pt-4">
          <div className="flex items-center gap-3 text-xs text-[#8E8E93]">
            {canLaunch ? (
              <Layers className="h-4 w-4 text-[#CCFF00]" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-[#3A3A42]" />
            )}
            <span>
              {canLaunch
                ? `${photos.length} photo${photos.length > 1 ? 's' : ''} ready — we will extract & reconstruct all angles for live 360° try-on.`
                : 'Drop at least 1 photo (or a full store model gallery) to reconstruct your T-shirt.'}
            </span>
          </div>

          <button
            onClick={onCreateTryOn}
            disabled={!canLaunch}
            className="flex items-center gap-2.5 rounded-xl bg-[#CCFF00] px-7 py-3.5 font-display text-sm font-bold text-[#0B0B0C] shadow-[0_0_28px_rgba(204,255,0,0.25)] hover:bg-[#d8ff33] disabled:opacity-35 disabled:shadow-none disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            Reconstruct 360° &amp; Try On
          </button>
        </footer>
      </main>
    </div>
  );
}
