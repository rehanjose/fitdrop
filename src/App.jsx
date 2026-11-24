import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getDemoTees, loadPhotorealisticDemoTees } from './utils/demoTees';
import {
  processGarmentImage,
  generatePlainBackCutout,
  classifyGarmentPhotoAngle,
  mirrorImageHorizontally,
} from './utils/cutoutEngine';
import { preloadPoseLandmarker, subscribePoseStatus } from './utils/poseEngine';
import { warmupClothParser } from './utils/garmentExtractor';
import { preloadVisionEngine } from './utils/visionEngine';
import HomeScreen from './components/HomeScreen';
import CameraPermissionModal from './components/CameraPermissionModal';
import UploadGridScreen from './components/UploadGridScreen';
import ProcessingModal from './components/ProcessingModal';
import TryOnStudioScreen from './components/TryOnStudioScreen';
import SnapshotModal from './components/SnapshotModal';

export default function App() {
  // Screens: 'home' | 'upload' | 'tryon'
  const [screen, setScreen] = useState('home');
  const [poseStatus, setPoseStatus] = useState('idle');

  // Wardrobe state (5 pre-loaded transparent demo tees + newly uploaded tees)
  const [wardrobe, setWardrobe] = useState(() => getDemoTees());
  const [activeTeeId, setActiveTeeId] = useState(() => getDemoTees()[0].id);

  // Unified Multi-Photo Reconstruction Pool (1–8 photos of any angles -> reconstructed into 360° views)
  const [uploadedPhotos, setUploadedPhotos] = useState([]);
  const [teeName, setTeeName] = useState('');
  const [cutoutMode, setCutoutMode] = useState('ai'); // 'ai' | 'instant'

  // Processing Modal state
  const [isProcessing, setIsProcessing] = useState(false);
  const [processProgress, setProcessProgress] = useState(0);
  const [processStatus, setProcessStatus] = useState('');

  // Camera Permission Modal & MediaStream
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [isRequestingCamera, setIsRequestingCamera] = useState(false);
  const pendingCameraTargetRef = useRef(null); // 'tryon' | 'guided-capture'

  // Snapshot Modal state
  const [snapshot, setSnapshot] = useState(null);

  // Pre-load MediaPipe Pose + Multiclass Segmenter + SegFormer-B2 Clothes Worker + Demo Tees on mount!
  useEffect(() => {
    const unsub = subscribePoseStatus(setPoseStatus);
    preloadPoseLandmarker().catch(() => {});
    preloadVisionEngine().catch(() => {});
    warmupClothParser();
    loadPhotorealisticDemoTees()
      .then((cleanDemoTees) => {
        setWardrobe((prev) => {
          const customTees = prev.filter((t) => !t.isDemo);
          return [...customTees, ...cleanDemoTees];
        });
      })
      .catch(() => {});
    return () => unsub();
  }, []);

  // Clean up webcam stream on unmount
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [cameraStream]);

  // Request webcam access via clean permission modal
  const ensureCameraAndNavigate = useCallback(
    (targetScreen) => {
      if (cameraStream && cameraStream.active) {
        setScreen(targetScreen);
        return;
      }
      pendingCameraTargetRef.current = targetScreen;
      setCameraError('');
      setCameraModalOpen(true);
    },
    [cameraStream]
  );

  const handleAllowCamera = async () => {
    setIsRequestingCamera(true);
    setCameraError('');
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
            facingMode: 'user',
          },
          audio: false,
        });
      } catch (constraintErr) {
        // Fallback for older Windows/Mac webcams that reject 1280x720 constraints
        console.warn('Ideal 720p webcam constraint failed, retrying default camera:', constraintErr);
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
      }
      setCameraStream(stream);
      setCameraModalOpen(false);
      if (pendingCameraTargetRef.current) {
        setScreen(pendingCameraTargetRef.current);
        pendingCameraTargetRef.current = null;
      }
    } catch (err) {
      console.error('Webcam access error:', err);
      setCameraError(
        'Webcam permission was denied or no camera was detected. Please allow camera access to continue.'
      );
    } finally {
      setIsRequestingCamera(false);
    }
  };

  // Normalize any uploaded image file (including .avif / .webp / missing MIME types) into a clean PNG data URL
  const normalizeFileToDataUrl = (file) =>
    new Promise((resolve) => {
      if (!file) return resolve(null);
      const ext = (file.name || '').split('.').pop()?.toLowerCase();
      const mimeMap = {
        avif: 'image/avif',
        webp: 'image/webp',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
      };
      const blob =
        file.type && file.type.startsWith('image/')
          ? file
          : new Blob([file], { type: mimeMap[ext] || 'image/png' });

      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const maxDim = 1400;
          const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(objUrl);
          resolve(c.toDataURL('image/png'));
        } catch {
          URL.revokeObjectURL(objUrl);
          resolve(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        // Fallback to direct FileReader
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      };
      img.src = objUrl;
    });

  // Multi-photo upload: accepts 1–8 photos (flat-lay or online-store model shoots),
  // displays ALL of them immediately, and tags each photo's exact 360° viewing angle sequentially.
  const handleSmartMultiFiles = useCallback(async (files) => {
    const imgFiles = Array.from(files || []).filter(
      (f) => f.type.startsWith('image/') || /\.(avif|webp|png|jpe?g)$/i.test(f.name || '')
    );
    if (imgFiles.length === 0) return;

    const dataUrls = await Promise.all(imgFiles.slice(0, 8).map(normalizeFileToDataUrl));
    const validUrls = dataUrls.filter(Boolean);
    if (validUrls.length === 0) return;

    const newItems = validUrls.map((url, idx) => ({
      id: `photo-${Date.now()}-${idx}`,
      url,
      angle: 'front',
      angleDeg: 0,
      label: 'SCANNING...',
      score: 0.5,
      classifying: true,
    }));

    setScreen('upload');
    setUploadedPhotos((prev) => [...prev, ...newItems].slice(0, 8));

    // Classify sequentially (MediaPipe WASM detect() is single-threaded)
    for (const item of newItems) {
      const res = await classifyGarmentPhotoAngle(item.url);
      setUploadedPhotos((prev) =>
        prev.map((p) =>
          p.id === item.id
            ? {
                ...p,
                angle: res.angle,
                angleDeg: res.angleDeg,
                label: res.label,
                score: res.score,
                classifying: false,
              }
            : p
        )
      );
    }
  }, []);

  // Launch 1-click demo tee straight into Try-On Studio
  const handleLaunchDemoTee = (tee) => {
    setActiveTeeId(tee.id);
    ensureCameraAndNavigate('tryon');
  };

  // Reconstruct ALL uploaded photos into a 360° Multi-Angle Virtual T-Shirt!
  const handleCreateVirtualTryOn = async () => {
    if (uploadedPhotos.length === 0) return;

    setIsProcessing(true);
    setProcessProgress(5);
    setProcessStatus(`Reconstructing ${uploadedPhotos.length} garment angle${uploadedPhotos.length > 1 ? 's' : ''}...`);

    try {
      // Ensure every photo has an angle classification before reconstruction
      const readyPhotos = [];
      for (const p of uploadedPhotos) {
        if (p.classifying) {
          const res = await classifyGarmentPhotoAngle(p.url);
          readyPhotos.push({ ...p, ...res, classifying: false });
        } else {
          readyPhotos.push(p);
        }
      }

      // Deduplicate by angle bucket (keep highest-scoring front, back, left-side, right-side — up to 4 core angles)
      const pickBest = (kind) =>
        readyPhotos
          .filter((p) => p.angle === kind)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] || null;

      const bestFront = pickBest('front') || readyPhotos[0];
      const bestBack = pickBest('back');
      const bestLeft = pickBest('left-side');
      const bestRight = pickBest('right-side');

      const toProcess = [
        { role: 'front', photo: bestFront },
        bestBack ? { role: 'back', photo: bestBack } : null,
        bestLeft ? { role: 'left-side', photo: bestLeft } : null,
        bestRight ? { role: 'right-side', photo: bestRight } : null,
      ].filter(Boolean);

      const totalSteps = toProcess.length;
      const reconstructed = {};

      for (let i = 0; i < totalSteps; i++) {
        const { role, photo } = toProcess[i];
        const basePct = (i / totalSteps) * 90;
        const stepSpan = 90 / totalSteps;
        const roleLabel =
          role === 'front'
            ? 'Front View'
            : role === 'back'
            ? 'Back View'
            : role === 'left-side'
            ? 'Left Side View'
            : 'Right Side View';

        reconstructed[role] = await processGarmentImage(photo.url, cutoutMode, (pct, text) => {
          setProcessProgress(Math.round(basePct + (pct / 100) * stepSpan));
          setProcessStatus(`(${i + 1}/${totalSteps}) ${roleLabel}: ${text}`);
        });
      }

      setProcessProgress(94);
      setProcessStatus('Synthesizing missing 360° angles...');

      const processedFront = reconstructed.front;
      let processedBack = reconstructed.back || null;
      if (!processedBack) {
        try {
          processedBack = await generatePlainBackCutout(processedFront);
        } catch {
          processedBack = null;
        }
      }

      // If user uploaded one side angle, mirror it cleanly to synthesize the opposite side!
      let processedLeft = reconstructed['left-side'] || null;
      let processedRight = reconstructed['right-side'] || null;
      if (processedLeft && !processedRight) {
        try {
          processedRight = await mirrorImageHorizontally(processedLeft);
        } catch {
          processedRight = null;
        }
      } else if (processedRight && !processedLeft) {
        try {
          processedLeft = await mirrorImageHorizontally(processedRight);
        } catch {
          processedLeft = null;
        }
      }

      const angleCount = [processedFront, processedBack, processedLeft, processedRight].filter(Boolean).length;
      const customCount = wardrobe.filter((t) => !t.isDemo).length + 1;
      const newTee = {
        id: `custom-tee-${Date.now()}`,
        name: teeName.trim() || `Uploaded Tee #${customCount}`,
        tag: angleCount >= 3 ? '360° MULTI-VIEW' : 'RECONSTRUCTED',
        defaultFit: 'regular',
        frontUrl: processedFront,
        backUrl: processedBack,
        leftSideUrl: processedLeft,
        rightSideUrl: processedRight,
        isDemo: false,
      };

      setWardrobe((prev) => [newTee, ...prev]);
      setActiveTeeId(newTee.id);
      setProcessProgress(100);
      setIsProcessing(false);
      ensureCameraAndNavigate('tryon');
    } catch (err) {
      console.error('Garment reconstruction error:', err);
      setIsProcessing(false);
    }
  };

  return (
    <>
      {screen === 'home' && (
        <HomeScreen
          poseStatus={poseStatus}
          demoTees={wardrobe.filter((t) => t.isDemo)}
          onOpenUpload={() => setScreen('upload')}
          onDropFiles={handleSmartMultiFiles}
          onLaunchDemoTee={handleLaunchDemoTee}
        />
      )}

      {screen === 'upload' && (
        <UploadGridScreen
          photos={uploadedPhotos}
          teeName={teeName}
          cutoutMode={cutoutMode}
          onChangeTeeName={setTeeName}
          onChangeCutoutMode={setCutoutMode}
          onAddFiles={handleSmartMultiFiles}
          onRemovePhoto={(id) =>
            setUploadedPhotos((prev) => prev.filter((p) => p.id !== id))
          }
          onClearAll={() => setUploadedPhotos([])}
          onBackHome={() => setScreen('home')}
          onCreateTryOn={handleCreateVirtualTryOn}
        />
      )}

      {screen === 'tryon' && (
        <TryOnStudioScreen
          stream={cameraStream}
          wardrobe={wardrobe}
          activeTeeId={activeTeeId}
          onSelectTee={setActiveTeeId}
          onCaptureSnapshot={setSnapshot}
          onUploadNew={() => {
            setUploadedPhotos([]);
            setTeeName('');
            setScreen('upload');
          }}
          onBackHome={() => setScreen('home')}
        />
      )}

      {/* Modals */}
      <CameraPermissionModal
        isOpen={cameraModalOpen}
        error={cameraError}
        isRequesting={isRequestingCamera}
        onAllow={handleAllowCamera}
        onCancel={() => {
          setCameraModalOpen(false);
          pendingCameraTargetRef.current = null;
        }}
      />

      <ProcessingModal
        isOpen={isProcessing}
        progress={processProgress}
        statusText={processStatus}
        cutoutMode={cutoutMode}
      />

      <SnapshotModal snapshot={snapshot} onClose={() => setSnapshot(null)} />
    </>
  );
}
