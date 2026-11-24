import React, { useEffect, useRef } from 'react';
import { Download, ArrowLeft, X } from 'lucide-react';

export default function SnapshotModal({ snapshot, onClose }) {
  const cardCanvasRef = useRef(null);

  useEffect(() => {
    if (!snapshot || !cardCanvasRef.current) return;

    const canvas = cardCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const cardW = 1080;
    const cardH = 740;
    canvas.width = cardW;
    canvas.height = cardH;

    const img = new Image();
    img.onload = () => {
      // Dark Editorial Card Background
      ctx.fillStyle = '#0B0B0C';
      ctx.fillRect(0, 0, cardW, cardH);

      // Subtle border
      ctx.strokeStyle = '#26262A';
      ctx.lineWidth = 2;
      ctx.strokeRect(12, 12, cardW - 24, cardH - 24);

      // Photo viewport (16:9 crop inside frame)
      const pad = 32;
      const photoW = cardW - pad * 2;
      const photoH = 560;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pad, pad, photoW, photoH, 16);
      ctx.clip();

      // Cover-draw captured AR canvas
      const imgAspect = img.width / img.height;
      const boxAspect = photoW / photoH;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (imgAspect > boxAspect) {
        sw = img.height * boxAspect;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / boxAspect;
        sy = (img.height - sh) / 2;
      }
      ctx.drawImage(img, sx, sy, sw, sh, pad, pad, photoW, photoH);
      ctx.restore();

      // Top-left watermark badge inside photo
      ctx.fillStyle = 'rgba(11, 11, 12, 0.72)';
      ctx.beginPath();
      ctx.roundRect(pad + 18, pad + 18, 178, 36, 8);
      ctx.fill();
      ctx.fillStyle = '#CCFF00';
      ctx.font = 'bold 15px monospace';
      ctx.fillText('FITDROP • AR LOOK', pad + 32, pad + 41);

      // Bottom Editorial Metadata Footer
      const footY = pad + photoH + 46;
      ctx.fillStyle = '#F5F5F7';
      ctx.font = '700 28px "Space Grotesk", sans-serif';
      ctx.fillText(snapshot.teeName.toUpperCase(), pad + 4, footY);

      ctx.fillStyle = '#8E8E93';
      ctx.font = '500 14px "JetBrains Mono", monospace';
      const dateStr = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      });
      ctx.fillText(`VIRTUAL TRY-ON CAPTURE • ${dateStr.toUpperCase()}`, pad + 4, footY + 26);

      // Right Fit Tag Pill
      const tagText = `FIT: ${snapshot.fitLabel} • ${snapshot.viewLabel}`;
      ctx.font = '700 14px "JetBrains Mono", monospace';
      const tagW = ctx.measureText(tagText).width + 32;
      ctx.fillStyle = '#CCFF00';
      ctx.beginPath();
      ctx.roundRect(cardW - pad - tagW, footY - 22, tagW, 38, 10);
      ctx.fill();
      ctx.fillStyle = '#0B0B0C';
      ctx.fillText(tagText, cardW - pad - tagW + 16, footY + 2);
    };
    img.src = snapshot.imageUrl;
  }, [snapshot]);

  if (!snapshot) return null;

  const handleDownload = () => {
    const canvas = cardCanvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `FitDrop-${snapshot.teeName.replace(/\s+/g, '-')}-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/82 backdrop-blur-md p-6">
      <div className="relative flex w-full max-w-4xl flex-col rounded-2xl border border-[#26262A] bg-[#161618] p-6 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-[#8E8E93] hover:bg-[#26262A] hover:text-[#F5F5F7] transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-4 flex items-center gap-3">
          <span className="rounded-md bg-[#CCFF00]/15 border border-[#CCFF00]/30 px-2.5 py-1 font-mono-hud text-[11px] uppercase tracking-widest text-[#CCFF00]">
            FIT: {snapshot.fitLabel}
          </span>
          <h2 className="font-display text-xl font-bold text-[#F5F5F7]">
            Look Card Captured
          </h2>
        </div>

        {/* Framed Look Card Preview */}
        <div className="flex items-center justify-center rounded-xl bg-[#0B0B0C] border border-[#26262A] p-3">
          <canvas
            ref={cardCanvasRef}
            className="max-h-[62vh] w-auto rounded-lg shadow-xl"
          />
        </div>

        {/* Actions */}
        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={onClose}
            className="flex items-center gap-2 rounded-xl border border-[#26262A] bg-[#0B0B0C] px-5 py-3 text-sm font-medium text-[#F5F5F7] hover:bg-[#1E1E22] transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Live Try-On
          </button>

          <button
            onClick={handleDownload}
            className="flex items-center gap-2 rounded-xl bg-[#CCFF00] px-6 py-3 font-display text-sm font-bold text-[#0B0B0C] shadow-[0_0_24px_rgba(204,255,0,0.25)] hover:bg-[#d8ff33] transition-colors cursor-pointer"
          >
            <Download className="h-4 w-4" />
            Download PNG
          </button>
        </div>
      </div>
    </div>
  );
}
