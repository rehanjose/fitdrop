import React from 'react';
import { Camera, ShieldAlert, X, RefreshCw } from 'lucide-react';

export default function CameraPermissionModal({
  isOpen,
  error,
  isRequesting,
  onAllow,
  onCancel,
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-6">
      <div className="relative w-full max-w-md rounded-2xl bg-[#161618] border border-[#26262A] p-7 shadow-2xl">
        <button
          onClick={onCancel}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-[#8E8E93] hover:bg-[#26262A] hover:text-[#F5F5F7] transition-colors cursor-pointer"
          aria-label="Close modal"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-[#CCFF00]/12 border border-[#CCFF00]/30 text-[#CCFF00]">
          {error ? <ShieldAlert className="h-6 w-6 text-amber-400" /> : <Camera className="h-6 w-6" />}
        </div>

        <p className="font-mono-hud text-[11px] uppercase tracking-[0.18em] text-[#8E8E93] mb-1.5">
          HARDWARE ACCESS • LOCAL WEBCAM
        </p>
        <h2 className="font-display text-2xl font-bold text-[#F5F5F7] tracking-tight mb-2">
          {error ? 'Camera Access Blocked' : 'Enable Laptop Webcam'}
        </h2>
        <p className="text-sm text-[#8E8E93] leading-relaxed mb-6">
          {error
            ? error
            : 'Allow FitDrop to use your laptop webcam for live virtual try-on. All video stays 100% private on your device—nothing is uploaded to any server.'}
        </p>

        {error && (
          <div className="mb-5 rounded-xl bg-amber-500/10 border border-amber-500/25 p-3.5 text-xs text-amber-200/90 leading-relaxed">
            Click the camera icon in your browser&apos;s address bar, set permission to{' '}
            <span className="font-semibold text-white">Allow</span>, then click Retry below.
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-[#26262A] bg-[#0B0B0C] px-4 py-3 text-sm font-medium text-[#F5F5F7] hover:bg-[#1E1E22] transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onAllow}
            disabled={isRequesting}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-[#CCFF00] px-4 py-3 text-sm font-semibold text-[#0B0B0C] hover:bg-[#d8ff33] disabled:opacity-60 transition-colors cursor-pointer"
          >
            {isRequesting ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : error ? (
              <>
                <RefreshCw className="h-4 w-4" />
                Retry Camera
              </>
            ) : (
              <>
                <Camera className="h-4 w-4" />
                Allow Camera
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
