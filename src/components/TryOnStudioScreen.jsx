import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Upload,
  RotateCcw,
  ArrowLeft,
  Sliders,
  Layers,
  UserCheck,
  FlipHorizontal2,
  Crosshair,
  CheckCircle2,
  Eye,
} from 'lucide-react';
import { preloadPoseLandmarker } from '../utils/poseEngine';
import {
  drawWarpedGarment,
  drawForegroundBodyOcclusion,
  updatePersonMaskCanvas,
} from '../utils/clothWarper';

const FIT_PRESETS = [
  { id: 'fitted', label: 'Fitted', w: 0.94, h: 0.95, hipRatio: 0.92 },
  { id: 'regular', label: 'Regular', w: 1.08, h: 1.05, hipRatio: 1.04 },
  { id: 'oversized', label: 'Oversized', w: 1.18, h: 1.14, hipRatio: 1.14 },
  { id: 'cropped', label: 'Cropped', w: 1.05, h: 0.80, hipRatio: 1.02 },
];

const lerp = (a, b, t) => a + (b - a) * t;

export default function TryOnStudioScreen({
  stream,
  wardrobe,
  activeTeeId,
  onSelectTee,
  onCaptureSnapshot,
  onUploadNew,
  onBackHome,
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const activeTee = wardrobe.find((t) => t.id === activeTeeId) || wardrobe[0];

  const [fitPresetId, setFitPresetId] = useState(activeTee?.defaultFit || 'regular');
  const [viewMode, setViewMode] = useState('auto'); // 'auto' | 'front' | 'back'
  const [widthScale, setWidthScale] = useState(1.0);
  const [lengthScale, setLengthScale] = useState(1.0);
  const [collarOffset, setCollarOffset] = useState(0); // -0.25 to +0.25 of torso height
  const [brightness, setBrightness] = useState(100); // 70% to 130%
  const [blendAlpha, setBlendAlpha] = useState(100); // 75% to 100%

  const [isTracking, setIsTracking] = useState(false);
  const [detectedSide, setDetectedSide] = useState('front');
  const [showInitialGuide, setShowInitialGuide] = useState(true);
  const [fps, setFps] = useState(0);

  // Solid Body Calibration State ('idle' | 'calibrating' | 'locked')
  const [calState, setCalState] = useState('idle');
  const [calProgress, setCalProgress] = useState(0);
  const [bodyProfileMode, setBodyProfileMode] = useState('auto'); // 'auto' | 'feminine' | 'masculine'
  const [detectedBodyProfile, setDetectedBodyProfile] = useState('masculine'); // 'feminine' | 'masculine'
  const [autoLightMatch, setAutoLightMatch] = useState(true);
  const [enableWrinklePhysics, setEnableWrinklePhysics] = useState(true);
  const [isComparing, setIsComparing] = useState(false);

  // Calibration baseline ref (stores averaged body proportions + feminine/masculine silhouette score)
  const calibrationRef = useRef({
    mode: 'auto-pending', // 'auto-pending' | 'calibrating' | 'locked'
    samples: [],
    shoulderToTorsoRatio: 0.72,
    hipToShoulderRatio: 0.86,
    collarToNoseRatio: 0.22,
    lastFrontTorsoHeight: 0,
    lastFrontShoulderWidth: 0,
    feminineScore: 0.5, // smoothed 0 (masculine) -> 1 (feminine)
    detectedProfile: 'masculine',
  });

  // Trigger a fresh 1.5-second Solid Body Calibration (e.g. when switching between boy & girl)
  const triggerBodyCalibration = () => {
    calibrationRef.current.mode = 'calibrating';
    calibrationRef.current.samples = [];
    calibrationRef.current.feminineScore = 0.5;
    setCalState('calibrating');
    setCalProgress(0);
  };

  // Refs synced to latest React state for the 60fps animation loop
  const controlsRef = useRef({
    fitPreset: FIT_PRESETS[1],
    viewMode: 'auto',
    widthScale: 1.0,
    lengthScale: 1.0,
    collarOffset: 0,
    brightness: 100,
    blendAlpha: 100,
    autoLightMatch: true,
    enableWrinklePhysics: true,
    bodyProfileMode: 'auto',
    isComparing: false,
  });

  useEffect(() => {
    controlsRef.current = {
      fitPreset: FIT_PRESETS.find((f) => f.id === fitPresetId) || FIT_PRESETS[1],
      viewMode,
      widthScale,
      lengthScale,
      collarOffset,
      brightness,
      blendAlpha,
      autoLightMatch,
      enableWrinklePhysics,
      bodyProfileMode,
      isComparing,
    };
  }, [
    fitPresetId,
    viewMode,
    widthScale,
    lengthScale,
    collarOffset,
    brightness,
    blendAlpha,
    autoLightMatch,
    enableWrinklePhysics,
    bodyProfileMode,
    isComparing,
  ]);

  // Pre-loaded Image objects for all reconstructed 360° angles of the active tee
  const frontImgRef = useRef(null);
  const backImgRef = useRef(null);
  const leftSideImgRef = useRef(null);
  const rightSideImgRef = useRef(null);

  useEffect(() => {
    if (!activeTee) return;

    const loadInto = (url, ref) => {
      if (!url) {
        ref.current = null;
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        ref.current = img;
      };
      img.src = url;
    };

    loadInto(activeTee.frontUrl, frontImgRef);
    loadInto(activeTee.backUrl, backImgRef);
    loadInto(activeTee.leftSideUrl, leftSideImgRef);
    loadInto(activeTee.rightSideUrl, rightSideImgRef);
  }, [activeTee]);

  // Brief 2-second initial framing guide
  useEffect(() => {
    const timer = setTimeout(() => setShowInitialGuide(false), 2400);
    return () => clearTimeout(timer);
  }, []);

  // Main Live AR Pose Tracking + Rendering Loop
  useEffect(() => {
    let rafId = null;
    let cancelled = false;
    let landmarker = null;
    let lastVideoTime = -1;
    let lastTimestampMs = 0;
    let frameCount = 0;
    let lastFpsUpdate = performance.now();
    let trackingState = false;
    let sideState = 'front';
    let lastAmbientSampleTime = 0;
    let ambientTint = { r: 210, g: 205, b: 200, lum: 165 };
    let skinTone = null; // Live face-calibrated { y, cb, cr } for pixel-accurate hand/finger occlusion

    // Deadzone + quadratic velocity-adaptive smoother (zero micro-jitter when still, instant snap when moving!)
    const adaptiveLerp = (curr, target, scaleRef) => {
      const dist = Math.abs(target - curr);
      if (dist < 1.8) return lerp(curr, target, 0.06);
      const speedRatio = Math.min(1, (dist - 1.8) / Math.max(scaleRef * 0.13, 6));
      const factor = 0.10 + speedRatio * speedRatio * 0.44; // 0.10 rock-solid still -> 0.54 snappy motion
      return lerp(curr, target, factor);
    };

    // Smoothed 4-corner torso quad + yaw + continuous 3D view-blend factors + skeletal sleeve angles
    const smooth = {
      initialized: false,
      tl: { x: 0, y: 0 },
      tr: { x: 0, y: 0 },
      br: { x: 0, y: 0 },
      bl: { x: 0, y: 0 },
      yaw: 0,
      leftArmLift: 0,
      rightArmLift: 0,
      leftSleeveDelta: 0,
      rightSleeveDelta: 0,
      frontAlpha: 1,
      sideBlend: 0,
      backBlend: 0,
    };
    let latestBodyOcclusion = null;
    let latestPersonMask = null;

    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }

    preloadPoseLandmarker()
      .then((instance) => {
        if (!cancelled) landmarker = instance;
      })
      .catch(() => {});

    const renderFrame = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(renderFrame);

      const canvas = canvasRef.current;
      if (!canvas || !video || video.readyState < 2) return;

      const rect = canvas.parentElement.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));

      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }

      const ctx = canvas.getContext('2d');
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;

      // Compute object-fit: cover mapping for crisp 16:9 widescreen mirror
      const videoAspect = vw / vh;
      const canvasAspect = cw / ch;
      let drawW, drawH, offsetX, offsetY;

      if (canvasAspect > videoAspect) {
        drawW = cw;
        drawH = cw / videoAspect;
        offsetX = 0;
        offsetY = (ch - drawH) / 2;
      } else {
        drawH = ch;
        drawW = ch * videoAspect;
        offsetX = (cw - drawW) / 2;
        offsetY = 0;
      }

      // 1. Draw Mirrored Webcam Feed
      ctx.save();
      ctx.clearRect(0, 0, cw, ch);
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, offsetX, offsetY, drawW, drawH);
      ctx.restore();

      // 2. Run MediaPipe Pose Detection (+ Real-Time Person Segmentation Mask) on new video frames
      let poseLandmarks = null;
      if (landmarker && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const nowMs = Math.max(Math.round(performance.now()), lastTimestampMs + 1);
        lastTimestampMs = nowMs;
        try {
          const result = landmarker.detectForVideo(video, nowMs);
          if (result?.landmarks?.length > 0) {
            poseLandmarks = result.landmarks[0];
          }
          if (result?.segmentationMasks?.length > 0) {
            latestPersonMask = updatePersonMaskCanvas(result.segmentationMasks[0]);
            result.segmentationMasks.forEach((m) => m.close?.());
          }
        } catch (detectErr) {
          console.warn('Pose frame warning:', detectErr);
        }
      }

      // Helper to convert normalized MediaPipe landmark -> mirrored canvas coordinates
      const toCanvas = (lm) => ({
        x: cw - (offsetX + lm.x * drawW),
        y: offsetY + lm.y * drawH,
        v: lm.visibility ?? 1,
      });

      if (poseLandmarks) {
        const lmNose = poseLandmarks[0]; // Nose
        const lmLEar = poseLandmarks[7]; // Left Ear (for reliable head-to-shoulder proportion!)
        const lmREar = poseLandmarks[8]; // Right Ear
        const lmLS = poseLandmarks[11]; // Left Shoulder
        const lmRS = poseLandmarks[12]; // Right Shoulder
        const lmLE = poseLandmarks[13]; // Left Elbow
        const lmRE = poseLandmarks[14]; // Right Elbow
        const lmLW = poseLandmarks[15]; // Left Wrist
        const lmRW = poseLandmarks[16]; // Right Wrist
        const lmLPinky = poseLandmarks[17]; // Left Pinky
        const lmRPinky = poseLandmarks[18]; // Right Pinky
        const lmLIndex = poseLandmarks[19]; // Left Index
        const lmRIndex = poseLandmarks[20]; // Right Index
        const lmLThumb = poseLandmarks[21]; // Left Thumb
        const lmRThumb = poseLandmarks[22]; // Right Thumb
        const lmLH = poseLandmarks[23]; // Left Hip
        const lmRH = poseLandmarks[24]; // Right Hip

        const shouldersVisible =
          (lmLS.visibility ?? 1) > 0.28 && (lmRS.visibility ?? 1) > 0.28;

        if (shouldersVisible) {
          if (!trackingState) {
            trackingState = true;
            setIsTracking(true);
            // Auto-start silent calibration on first detection if not yet locked
            if (calibrationRef.current.mode === 'auto-pending') {
              calibrationRef.current.mode = 'calibrating';
              calibrationRef.current.samples = [];
              setCalState('calibrating');
            }
          }

          const pNose = toCanvas(lmNose);
          const pLEar = lmLEar ? toCanvas(lmLEar) : null;
          const pREar = lmREar ? toCanvas(lmREar) : null;
          const pLS = toCanvas(lmLS);
          const pRS = toCanvas(lmRS);
          const pLE = toCanvas(lmLE);
          const pRE = toCanvas(lmRE);
          const pLW = toCanvas(lmLW);
          const pRW = toCanvas(lmRW);
          const pLPinky = lmLPinky ? toCanvas(lmLPinky) : null;
          const pRPinky = lmRPinky ? toCanvas(lmRPinky) : null;
          const pLIndex = lmLIndex ? toCanvas(lmLIndex) : null;
          const pRIndex = lmRIndex ? toCanvas(lmRIndex) : null;
          const pLThumb = lmLThumb ? toCanvas(lmLThumb) : null;
          const pRThumb = lmRThumb ? toCanvas(lmRThumb) : null;
          const hipsVisible =
            (lmLH.visibility ?? 1) > 0.35 && (lmRH.visibility ?? 1) > 0.35;

          const pLH = toCanvas(lmLH);
          const pRH = toCanvas(lmRH);

          // Sample true room ambient white-balance from upper room corners + shoulder ambient every 400ms
          const nowTs = performance.now();
          if (nowTs - lastAmbientSampleTime > 400) {
            lastAmbientSampleTime = nowTs;
            try {
              const patches = [
                ctx.getImageData(Math.max(4, Math.round(cw * 0.12)), Math.max(4, Math.round(ch * 0.12)), 16, 16).data,
                ctx.getImageData(Math.max(4, Math.round(cw * 0.82)), Math.max(4, Math.round(ch * 0.12)), 16, 16).data,
              ];
              let r = 0, g = 0, b = 0, cnt = 0;
              for (const patch of patches) {
                for (let i = 0; i < patch.length; i += 16) {
                  r += patch[i];
                  g += patch[i + 1];
                  b += patch[i + 2];
                  cnt++;
                }
              }
              if (cnt > 0) {
                const ar = Math.round(r / cnt);
                const ag = Math.round(g / cnt);
                const ab = Math.round(b / cnt);
                const lum = Math.round(0.299 * ar + 0.587 * ag + 0.114 * ab);
                ambientTint = {
                  r: Math.round(lerp(ambientTint.r, ar, 0.35)),
                  g: Math.round(lerp(ambientTint.g, ag, 0.35)),
                  b: Math.round(lerp(ambientTint.b, ab, 0.35)),
                  lum: Math.round(lerp(ambientTint.lum, lum, 0.35)),
                };
              }

              // Calibrate wearer's exact YCbCr skin tone from face/cheek patch when facing front
              if ((lmNose.visibility ?? 0) > 0.65 && (lmRS.x - lmLS.x) < -0.04) {
                const fx = Math.max(4, Math.min(cw - 24, Math.round(pNose.x - 10)));
                const fy = Math.max(4, Math.min(ch - 24, Math.round(pNose.y - 16)));
                const fPatch = ctx.getImageData(fx, fy, 20, 14).data;
                let ySum = 0, cbSum = 0, crSum = 0, fCnt = 0;
                for (let i = 0; i < fPatch.length; i += 12) {
                  const pr = fPatch[i];
                  const pg = fPatch[i + 1];
                  const pb = fPatch[i + 2];
                  const py = 0.299 * pr + 0.587 * pg + 0.114 * pb;
                  const pcb = 128 - 0.168736 * pr - 0.331264 * pg + 0.5 * pb;
                  const pcr = 128 + 0.5 * pr - 0.418688 * pg - 0.081312 * pb;
                  // Filter out glasses frames/eyebrows (require plausible skin chroma range)
                  if (pcb >= 75 && pcb <= 135 && pcr >= 128 && pcr <= 180 && py > 45) {
                    ySum += py;
                    cbSum += pcb;
                    crSum += pcr;
                    fCnt++;
                  }
                }
                if (fCnt >= 6) {
                  const sy = ySum / fCnt;
                  const scb = cbSum / fCnt;
                  const scr = crSum / fCnt;
                  skinTone = skinTone
                    ? {
                        y: lerp(skinTone.y, sy, 0.3),
                        cb: lerp(skinTone.cb, scb, 0.3),
                        cr: lerp(skinTone.cr, scr, 0.3),
                      }
                    : { y: sy, cb: scb, cr: scr };
                }
              }
            } catch {
              // Ignore canvas readback errors
            }
          }

          // Ensure left/right screen-ordered points so quad never twists when turning around
          const screenLeftShoulder = pLS.x < pRS.x ? pLS : pRS;
          const screenRightShoulder = pLS.x < pRS.x ? pRS : pLS;
          const screenLeftHip = pLH.x < pRH.x ? pLH : pRH;
          const screenRightHip = pLH.x < pRH.x ? pRH : pLH;

          // Shoulder midpoint, unit axis, and width
          const shoulderMidX = (screenLeftShoulder.x + screenRightShoulder.x) * 0.5;
          const shoulderMidY = (screenLeftShoulder.y + screenRightShoulder.y) * 0.5;
          const shoulderWidth = Math.max(
            24,
            Math.hypot(
              screenRightShoulder.x - screenLeftShoulder.x,
              screenRightShoulder.y - screenLeftShoulder.y
            )
          );
          const shAxisX = (screenRightShoulder.x - screenLeftShoulder.x) / shoulderWidth;
          const shAxisY = (screenRightShoulder.y - screenLeftShoulder.y) / shoulderWidth;

          // Estimate body yaw (-1 to +1) from MediaPipe 3D shoulder depth (z)
          const rawYaw = ((lmRS.z ?? 0) - (lmLS.z ?? 0)) * 2.2;
          const clampedYaw = Math.max(-0.85, Math.min(0.85, rawYaw));

          // Hip midpoint, hip axis, and torso length (NEVER collapses when turning sideways with hips off-screen!)
          const cal = calibrationRef.current;
          const isFacingFrontBroad = Math.abs(lmRS.x - lmLS.x) > 0.08 && Math.abs(clampedYaw) < 0.45;
          let torsoHeight, hipMidX, hipMidY, hipWidth, hipAxisX, hipAxisY;
          if (hipsVisible) {
            hipMidX = (screenLeftHip.x + screenRightHip.x) * 0.5;
            hipMidY = (screenLeftHip.y + screenRightHip.y) * 0.5;
            torsoHeight = Math.max(40, Math.hypot(hipMidX - shoulderMidX, hipMidY - shoulderMidY));
            hipWidth = Math.max(
              20,
              Math.hypot(screenRightHip.x - screenLeftHip.x, screenRightHip.y - screenLeftHip.y)
            );
            hipAxisX = (screenRightHip.x - screenLeftHip.x) / hipWidth;
            hipAxisY = (screenRightHip.y - screenLeftHip.y) / hipWidth;
            if (isFacingFrontBroad) {
              cal.lastFrontTorsoHeight = cal.lastFrontTorsoHeight
                ? lerp(cal.lastFrontTorsoHeight, torsoHeight, 0.15)
                : torsoHeight;
              cal.lastFrontShoulderWidth = cal.lastFrontShoulderWidth
                ? lerp(cal.lastFrontShoulderWidth, shoulderWidth, 0.15)
                : shoulderWidth;
            }
          } else {
            // When hips are off-screen (seated at laptop), anchor torsoHeight to the last front-facing
            // measurement so turning sideways NEVER shrinks the T-shirt into a tiny floating patch!
            const noseDist = Math.max(24, shoulderMidY - pNose.y);
            const estFromNose = noseDist * 2.55;
            const estFromSh = shoulderWidth * 1.42;
            if (isFacingFrontBroad) {
              torsoHeight = Math.max(estFromSh, estFromNose * 0.85);
              cal.lastFrontTorsoHeight = cal.lastFrontTorsoHeight
                ? lerp(cal.lastFrontTorsoHeight, torsoHeight, 0.15)
                : torsoHeight;
              cal.lastFrontShoulderWidth = cal.lastFrontShoulderWidth
                ? lerp(cal.lastFrontShoulderWidth, shoulderWidth, 0.15)
                : shoulderWidth;
            } else {
              torsoHeight = Math.max(
                estFromSh,
                cal.lastFrontTorsoHeight * 0.95,
                estFromNose * 0.9
              );
            }
            // Keep torso vertical (straight down) when turning sideways without hips visible
            const perpX = isFacingFrontBroad ? -shAxisY : 0;
            const perpY = isFacingFrontBroad ? shAxisX : 1;
            hipMidX = shoulderMidX + perpX * torsoHeight;
            hipMidY = shoulderMidY + perpY * torsoHeight;
            hipWidth = Math.max(shoulderWidth, cal.lastFrontShoulderWidth * 0.78) * 0.78;
            hipAxisX = shAxisX;
            hipAxisY = shAxisY;
          }

          // Torso downward unit vector
          const downX = (hipMidX - shoulderMidX) / torsoHeight;
          const downY = (hipMidY - shoulderMidY) / torsoHeight;

          // Keep horizontal axis perpendicular to torso when shoulders overlap at 90° side profile
          // so the garment NEVER twists or collapses into a thin strip!
          const torsoPerpX = downY;
          const torsoPerpY = -downX;
          const refAxisX = torsoPerpX >= 0 ? torsoPerpX : -torsoPerpX;
          const refAxisY = torsoPerpX >= 0 ? torsoPerpY : -torsoPerpY;

          // Solid Body Calibration + Fast Automatic Women's / Men's Silhouette Detection
          const isFacingFrontClean = (lmRS.x - lmLS.x) < -0.04 && Math.abs(clampedYaw) < 0.35;

          // Continuous proportion cues when facing front (adapts quickly when a new person steps in!)
          if (isFacingFrontClean) {
            let cueSum = 0;
            let cueWeight = 0;

            // Cue 1: Shoulder-to-Head width ratio (ear-to-ear) — reliable even when seated close to laptop!
            const earsVisible =
              pLEar && pREar && (lmLEar.visibility ?? 0) > 0.35 && (lmREar.visibility ?? 0) > 0.35;
            if (earsVisible) {
              const headW = Math.hypot(pREar.x - pLEar.x, pREar.y - pLEar.y);
              if (headW > 14) {
                const shToHead = shoulderWidth / headW;
                // Typically ~2.0–2.55 for women, ~2.75–3.4 for men
                const femFromHead = Math.max(0, Math.min(1, (2.78 - shToHead) / 0.55));
                cueSum += femFromHead * 1.3;
                cueWeight += 1.3;
              }
            }

            // Cue 2: Shoulder-width to Nose-to-Shoulder height ratio (works even if ears are covered by hair!)
            const noseToShDist = shoulderMidY - pNose.y;
            if (noseToShDist > 20) {
              const shToNeckH = shoulderWidth / noseToShDist;
              // Typically ~1.7–2.15 for women, ~2.3–2.9 for men
              const femFromNeck = Math.max(0, Math.min(1, (2.32 - shToNeckH) / 0.50));
              cueSum += femFromNeck * 1.1;
              cueWeight += 1.1;
            }

            // Cue 3: Hip-to-Shoulder & Shoulder-to-Torso ratios (when waist/hips are in frame)
            if (hipsVisible) {
              const hipToSh = hipWidth / shoulderWidth;
              const femFromHip = Math.max(0, Math.min(1, (hipToSh - 0.68) / 0.20));
              cueSum += femFromHip * 1.5;
              cueWeight += 1.5;

              const shToTorso = shoulderWidth / torsoHeight;
              const femFromTorso = Math.max(0, Math.min(1, (0.76 - shToTorso) / 0.18));
              cueSum += femFromTorso * 0.6;
              cueWeight += 0.6;
            }

            if (cueWeight > 0) {
              const frameFemScore = cueSum / cueWeight;
              cal.feminineScore = lerp(cal.feminineScore, frameFemScore, 0.18);

              if (cal.detectedProfile !== 'feminine' && cal.feminineScore > 0.54) {
                cal.detectedProfile = 'feminine';
                setDetectedBodyProfile('feminine');
              } else if (cal.detectedProfile !== 'masculine' && cal.feminineScore < 0.46) {
                cal.detectedProfile = 'masculine';
                setDetectedBodyProfile('masculine');
              }
            }
          }

          if (cal.mode === 'calibrating' && isFacingFrontClean) {
            cal.samples.push({
              shToTorso: hipsVisible ? shoulderWidth / torsoHeight : 0.72,
              hipToSh: hipsVisible ? hipWidth / shoulderWidth : 0.86,
            });
            const pct = Math.min(100, Math.round((cal.samples.length / 20) * 100));
            setCalProgress(pct);

            if (cal.samples.length >= 20) {
              const avgShToTorso =
                cal.samples.reduce((s, v) => s + v.shToTorso, 0) / cal.samples.length;
              const avgHipToSh =
                cal.samples.reduce((s, v) => s + v.hipToSh, 0) / cal.samples.length;
              cal.shoulderToTorsoRatio = Math.max(0.55, Math.min(0.92, avgShToTorso));
              cal.hipToShoulderRatio = Math.max(0.68, Math.min(1.08, avgHipToSh));
              cal.mode = 'locked';
              setCalState('locked');
            }
          }

          // Estimate true anatomical shoulder width using calibrated ratio (rock-solid when turning!)
          const estFullShoulderW = Math.max(
            shoulderWidth,
            torsoHeight * cal.shoulderToTorsoRatio
          );
          const cosTurn = Math.min(1, shoulderWidth / estFullShoulderW);
          const sinTurn = Math.sqrt(Math.max(0, 1 - cosTurn * cosTurn));

          // Blend shoulder axis toward stable torso-perpendicular axis as user turns sideways
          const axisBlend = Math.min(1, cosTurn * 1.4);
          let stableTopAxisX = shAxisX * axisBlend + refAxisX * (1 - axisBlend);
          let stableTopAxisY = shAxisY * axisBlend + refAxisY * (1 - axisBlend);
          const topAxisLen = Math.hypot(stableTopAxisX, stableTopAxisY) || 1;
          stableTopAxisX /= topAxisLen;
          stableTopAxisY /= topAxisLen;

          let stableBotAxisX = hipAxisX * axisBlend + refAxisX * (1 - axisBlend);
          let stableBotAxisY = hipAxisY * axisBlend + refAxisY * (1 - axisBlend);
          const botAxisLen = Math.hypot(stableBotAxisX, stableBotAxisY) || 1;
          stableBotAxisX /= botAxisLen;
          stableBotAxisY /= botAxisLen;

          // 3D Elliptical Cylinder Silhouette Width using calibrated wearer proportions
          const sideDepthRatio = 0.68;
          const ellipticalTopW = Math.sqrt(
            Math.pow(estFullShoulderW * cosTurn, 2) +
            Math.pow(estFullShoulderW * sideDepthRatio * sinTurn, 2)
          );
          const estFullHipW = Math.max(hipWidth, estFullShoulderW * cal.hipToShoulderRatio);
          const ellipticalBotW = Math.sqrt(
            Math.pow(estFullHipW * cosTurn, 2) +
            Math.pow(estFullHipW * sideDepthRatio * sinTurn, 2)
          );

          // Auto-detect Front / Side / Back view cleanly (uses both shoulder flip AND nose-behind-ears 3D depth!)
          const shoulderDeltaRawX = lmRS.x - lmLS.x;
          const earMidZ = ((lmLEar?.z ?? 0) + (lmREar?.z ?? 0)) * 0.5;
          const noseBehindHead =
            (lmNose?.z ?? 0) > earMidZ + 0.025 && (lmNose?.visibility ?? 1) < 0.72;

          if (shoulderDeltaRawX > 0.015 || (noseBehindHead && shoulderDeltaRawX > -0.02)) {
            if (sideState !== 'back') {
              sideState = 'back';
              setDetectedSide('back');
            }
          } else if (cosTurn < 0.54) {
            if (sideState !== 'side') {
              sideState = 'side';
              setDetectedSide('side');
            }
          } else if (shoulderDeltaRawX < -0.025) {
            if (sideState !== 'front') {
              sideState = 'front';
              setDetectedSide('front');
            }
          }

          const {
            fitPreset,
            widthScale: wS,
            lengthScale: lS,
            collarOffset: cOff,
            bodyProfileMode: profMode,
          } = controlsRef.current;

          const activeBodyProfile =
            profMode === 'auto' ? cal.detectedProfile : profMode;
          const isFeminineFit = activeBodyProfile === 'feminine';

          // Adaptive half-widths tailored to Women's vs. Men's silhouette
          const shoulderWidthMult = isFeminineFit ? 1.96 : 2.10;
          const topHalfW = ellipticalTopW * 0.5 * shoulderWidthMult * fitPreset.w * wS;
          const naturalHemWidth = isFeminineFit
            ? Math.max(ellipticalBotW * 2.18, ellipticalTopW * 1.88)
            : Math.max(ellipticalBotW * 2.02, ellipticalTopW * 1.86);
          const botHalfW = naturalHemWidth * 0.5 * (fitPreset.hipRatio || fitPreset.w) * wS;

          // Perspective foreshortening on left/right sides when body turns (yaw)
          const leftSideScale = 1 + clampedYaw * 0.10;
          const rightSideScale = 1 - clampedYaw * 0.10;

          // Smooth continuous 3D Front -> Side -> Back blend targets (ZERO sudden pop when turning!)
          const isFacingBack = shoulderDeltaRawX > 0.015 || (noseBehindHead && shoulderDeltaRawX > -0.02);
          const targetBackBlend = isFacingBack ? 1 : 0;
          const targetSideBlend = Math.max(0, Math.min(1, (0.82 - cosTurn) / 0.42));
          // Front graphic smoothly fades out between cosTurn 0.80 (~37°) and 0.45 (~63°)
          const targetFrontAlpha = isFacingBack
            ? 0
            : Math.max(0, Math.min(1, (cosTurn - 0.44) / 0.36));

          smooth.backBlend = lerp(smooth.backBlend, targetBackBlend, 0.22);
          smooth.sideBlend = lerp(smooth.sideBlend, targetSideBlend, 0.22);
          smooth.frontAlpha = lerp(smooth.frontAlpha, targetFrontAlpha, 0.22);

          // Collar positioning: smoothly interpolate between front, oversized, side & back (zero jump!)
          const noseToShoulderY = shoulderMidY - pNose.y;
          const isOversizedFit = fitPreset.id === 'oversized';
          const turnRaiseBlend = Math.max(smooth.backBlend, smooth.sideBlend);
          const frontCollarRaise = isOversizedFit ? -0.23 : -0.19;
          const collarRaise = lerp(frontCollarRaise, -0.25, turnRaiseBlend);
          const maxUpMult = lerp(isOversizedFit ? 0.66 : 0.56, 0.72, turnRaiseBlend);
          const maxUpwardCollar =
            noseToShoulderY > 15
              ? -noseToShoulderY * maxUpMult
              : -torsoHeight * lerp(0.24, 0.28, turnRaiseBlend);
          const rawTopShift = torsoHeight * (collarRaise + cOff);
          const topShift = Math.max(maxUpwardCollar, rawTopShift);
          const botShift = torsoHeight * (1.28 * fitPreset.h * lS - 0.14 + cOff);

          // Compute live arm lift using BOTH elbow & wrist so raising hands ALWAYS lifts sleeves & hem
          // (works even when sitting close to the laptop with elbows near the bottom edge!)
          const computeArmLift = (sh, el, elVis, wr, wrVis) => {
            let elbowLift = 0;
            let wristLift = 0;

            if (elVis > 0.22) {
              // dy is positive when elbow is below shoulder, 0 at shoulder height, negative when raised above
              const dy = el.y - sh.y;
              elbowLift = Math.max(0, Math.min(1, 1 - dy / Math.max(torsoHeight * 0.52, 24)));
            }
            if (wrVis > 0.22) {
              // When wrist rises above mid-chest toward shoulder/head, lift reacts immediately
              const dyW = wr.y - sh.y;
              wristLift = Math.max(0, Math.min(1, 1 - dyW / Math.max(torsoHeight * 0.65, 30)));
            }
            return Math.max(elbowLift, wristLift * 0.92);
          };

          // Compute exact skeletal sleeve rotation delta (radians from rest sleeve angle -> live upper-arm angle!)
          // Works smoothly from arms at sides -> 45° -> T-pose -> flexing -> full 180° overhead raise!
          const normalizeAngle = (a) => {
            let r = a;
            while (r > Math.PI) r -= Math.PI * 2;
            while (r < -Math.PI) r += Math.PI * 2;
            return r;
          };

          const computeSleeveDelta = (isScreenLeft, sh, el, elVis, wr, wrVis) => {
            // Rest sleeve angle in canvas Y-down coordinates (~127° left, ~53° right)
            const restAngle = isScreenLeft ? 2.22 : 0.92;
            let targetPt = null;
            if (elVis > 0.25 && Math.hypot(el.x - sh.x, el.y - sh.y) > 12) {
              targetPt = el;
            } else if (wrVis > 0.25 && Math.hypot(wr.x - sh.x, wr.y - sh.y) > 18) {
              targetPt = wr;
            }
            if (!targetPt) return 0;

            const armAngle = Math.atan2(targetPt.y - sh.y, targetPt.x - sh.x);
            let delta = normalizeAngle(armAngle - restAngle);

            // Clamp to anatomically realistic cotton sleeve rotation limits (up to ~108° overhead lift)
            if (isScreenLeft) {
              // Raising left arm rotates clockwise (+angle) in Y-down canvas coords
              delta = Math.max(-0.22, Math.min(1.88, delta));
            } else {
              // Raising right arm rotates counter-clockwise (-angle) in Y-down canvas coords
              delta = Math.max(-1.88, Math.min(0.22, delta));
            }
            return delta;
          };

          const isMirroredLeftIsRS = pRS.x < pLS.x;
          const screenLeftLift = isMirroredLeftIsRS
            ? computeArmLift(pRS, pRE, lmRE.visibility ?? 0, pRW, lmRW.visibility ?? 0)
            : computeArmLift(pLS, pLE, lmLE.visibility ?? 0, pLW, lmLW.visibility ?? 0);
          const screenRightLift = isMirroredLeftIsRS
            ? computeArmLift(pLS, pLE, lmLE.visibility ?? 0, pLW, lmLW.visibility ?? 0)
            : computeArmLift(pRS, pRE, lmRE.visibility ?? 0, pRW, lmRW.visibility ?? 0);

          const screenLeftDelta = isMirroredLeftIsRS
            ? computeSleeveDelta(true, pRS, pRE, lmRE.visibility ?? 0, pRW, lmRW.visibility ?? 0)
            : computeSleeveDelta(true, pLS, pLE, lmLE.visibility ?? 0, pLW, lmLW.visibility ?? 0);
          const screenRightDelta = isMirroredLeftIsRS
            ? computeSleeveDelta(false, pLS, pLE, lmLE.visibility ?? 0, pLW, lmLW.visibility ?? 0)
            : computeSleeveDelta(false, pRS, pRE, lmRE.visibility ?? 0, pRW, lmRW.visibility ?? 0);

          // Detect foreground hands/arms cleanly for BOTH Front View AND Side View!
          // - Front View: requires strict 3D depth in front of torso + strong visibility (never punches behind-back holes)
          // - Side View: automatically identifies the NEAR arm facing the camera so it emerges cleanly out of the sleeve!
          const torsoMidZ = ((lmLS.z ?? 0) + (lmRS.z ?? 0)) * 0.5;
          const innerTorsoHalfW = estFullShoulderW * 0.66;
          const torsoLeftX = shoulderMidX - innerTorsoHalfW;
          const torsoRightX = shoulderMidX + innerTorsoHalfW;
          const torsoTopY = shoulderMidY + topShift - estFullShoulderW * 0.12;
          const torsoBotY = Math.min(ch * 0.95, shoulderMidY + botShift);

          const isPointInFrontChest = (pt) =>
            pt &&
            pt.x >= torsoLeftX &&
            pt.x <= torsoRightX &&
            pt.y >= torsoTopY &&
            pt.y <= torsoBotY;

          const isSideProfile = smooth.sideBlend > 0.35;
          const leftIsNearSide = (lmLS.z ?? 0) < (lmRS.z ?? 0);

          const buildForegroundArm = (
            isLeftBodyArm,
            lmSh, lmEl, lmWr, lmPk, lmIx, lmTh,
            pSh, pEl, pWr, pPk, pIx, pTh
          ) => {
            const wristVis = lmWr?.visibility ?? 0;
            const elbowVis = lmEl?.visibility ?? 0;
            const indexVis = lmIx?.visibility ?? 0;
            const pinkyVis = lmPk?.visibility ?? 0;
            const maxHandVis = Math.max(wristVis, indexVis, pinkyVis);

            // Dedicated Side-View Near-Arm Occlusion:
            // When turned sideways, the near arm hangs right across the side of the T-shirt;
            // reveal it cleanly from mid-bicep (below the sleeve hem) down through the hand!
            if (isSideProfile && isLeftBodyArm === leftIsNearSide && elbowVis > 0.45 && wristVis > 0.35) {
              return {
                inFront: true,
                isSideNearArm: true,
                elbowInFront: false,
                shoulder: pSh,
                elbow: pEl,
                wrist: pWr,
                pinky: pPk,
                index: pIx,
                thumb: pTh,
              };
            }

            // In side profile, never occlude the far-side arm behind the torso
            if (isSideProfile && isLeftBodyArm !== leftIsNearSide) {
              return { inFront: false };
            }

            // Front/Back View: hands hidden behind the back have low visibility or positive Z depth
            if (maxHandVis < 0.62) return { inFront: false };
            if (!pWr || pWr.y > ch * 0.95) return { inFront: false };

            const minHandZ = Math.min(
              lmWr?.z ?? 1,
              lmIx?.z ?? 1,
              lmPk?.z ?? 1,
              lmTh?.z ?? 1
            );

            // In back view, hanging arms at sides must NEVER cut holes into the back of the tee
            const depthThreshold = smooth.backBlend > 0.5 ? 0.12 : 0.065;
            if (minHandZ >= torsoMidZ - depthThreshold) return { inFront: false };

            // Must actually overlap the inner front chest/torso (not resting out at sides/keyboard)
            const overChest =
              isPointInFrontChest(pWr) ||
              isPointInFrontChest(pIx) ||
              isPointInFrontChest(pPk) ||
              isPointInFrontChest(pTh);

            if (!overChest) return { inFront: false };

            // Only occlude upper arm/elbow if elbow itself is clearly crossing in front of the chest
            const elbowInFront =
              elbowVis > 0.65 &&
              (lmEl.z ?? 1) < torsoMidZ - 0.095 &&
              isPointInFrontChest(pEl);

            return {
              inFront: true,
              isSideNearArm: false,
              elbowInFront,
              shoulder: pSh,
              elbow: pEl,
              wrist: pWr,
              pinky: pPk,
              index: pIx,
              thumb: pTh,
            };
          };

          const leftArmOcc = buildForegroundArm(
            true,
            lmLS, lmLE, lmLW, lmLPinky, lmLIndex, lmLThumb,
            pLS, pLE, pLW, pLPinky, pLIndex, pLThumb
          );
          const rightArmOcc = buildForegroundArm(
            false,
            lmRS, lmRE, lmRW, lmRPinky, lmRIndex, lmRThumb,
            pRS, pRE, pRW, pRPinky, pRIndex, pRThumb
          );

          latestBodyOcclusion = {
            nose: pNose,
            leftShoulder: screenLeftShoulder,
            rightShoulder: screenRightShoulder,
            leftArm: leftArmOcc,
            rightArm: rightArmOcc,
            shoulderWidth: estFullShoulderW,
            sideBlend: smooth.sideBlend,
            backBlend: smooth.backBlend,
            skinTone,
          };

          // Smooth side-profile chest centering (when turning sideways, chest projects toward nose direction)
          const faceDir = Math.sign(pNose.x - shoulderMidX) || 0;
          const sideChestShiftX = faceDir * estFullShoulderW * 0.13 * smooth.sideBlend;

          const topCenterX = shoulderMidX + downX * topShift + sideChestShiftX;
          const topCenterY = shoulderMidY + downY * topShift;
          const botCenterX = shoulderMidX + downX * botShift + sideChestShiftX;
          const botCenterY = shoulderMidY + downY * botShift;

          const targetTL = {
            x: topCenterX - stableTopAxisX * topHalfW * leftSideScale,
            y: topCenterY - stableTopAxisY * topHalfW * leftSideScale,
          };
          const targetTR = {
            x: topCenterX + stableTopAxisX * topHalfW * rightSideScale,
            y: topCenterY + stableTopAxisY * topHalfW * rightSideScale,
          };
          const targetBL = {
            x: botCenterX - stableBotAxisX * botHalfW * leftSideScale,
            y: botCenterY - stableBotAxisY * botHalfW * leftSideScale,
          };
          const targetBR = {
            x: botCenterX + stableBotAxisX * botHalfW * rightSideScale,
            y: botCenterY + stableBotAxisY * botHalfW * rightSideScale,
          };

          if (!smooth.initialized) {
            smooth.tl = targetTL;
            smooth.tr = targetTR;
            smooth.bl = targetBL;
            smooth.br = targetBR;
            smooth.yaw = clampedYaw;
            smooth.leftArmLift = screenLeftLift;
            smooth.rightArmLift = screenRightLift;
            smooth.leftSleeveDelta = screenLeftDelta;
            smooth.rightSleeveDelta = screenRightDelta;
            smooth.initialized = true;
          } else {
            smooth.tl.x = adaptiveLerp(smooth.tl.x, targetTL.x, estFullShoulderW);
            smooth.tl.y = adaptiveLerp(smooth.tl.y, targetTL.y, torsoHeight);
            smooth.tr.x = adaptiveLerp(smooth.tr.x, targetTR.x, estFullShoulderW);
            smooth.tr.y = adaptiveLerp(smooth.tr.y, targetTR.y, torsoHeight);
            smooth.bl.x = adaptiveLerp(smooth.bl.x, targetBL.x, estFullShoulderW);
            smooth.bl.y = adaptiveLerp(smooth.bl.y, targetBL.y, torsoHeight);
            smooth.br.x = adaptiveLerp(smooth.br.x, targetBR.x, estFullShoulderW);
            smooth.br.y = adaptiveLerp(smooth.br.y, targetBR.y, torsoHeight);
            smooth.yaw = lerp(smooth.yaw, clampedYaw, 0.25);
            smooth.leftArmLift = lerp(smooth.leftArmLift, screenLeftLift, 0.3);
            smooth.rightArmLift = lerp(smooth.rightArmLift, screenRightLift, 0.3);
            smooth.leftSleeveDelta = lerp(smooth.leftSleeveDelta, screenLeftDelta, 0.32);
            smooth.rightSleeveDelta = lerp(smooth.rightSleeveDelta, screenRightDelta, 0.32);
          }
        } else if (trackingState) {
          trackingState = false;
          setIsTracking(false);
        }
      }

      // 3. Draw 3D Cylindrical Mesh-Warped Garment + Real Neck & Raised Hands Foreground Layer
      if (smooth.initialized && trackingState && !controlsRef.current.isComparing) {
        const {
          viewMode: vMode,
          brightness: br,
          blendAlpha: alpha,
          autoLightMatch: useAmbient,
        } = controlsRef.current;
        const frontImg = frontImgRef.current;
        // Dynamically pick the exact reconstructed 360° view matching the wearer's current turn direction!
        let secondaryImg = backImgRef.current;
        if (smooth.sideBlend > 0.35 && smooth.backBlend < 0.5) {
          if (smooth.yaw < -0.1 && leftSideImgRef.current) {
            secondaryImg = leftSideImgRef.current;
          } else if (smooth.yaw > 0.1 && rightSideImgRef.current) {
            secondaryImg = rightSideImgRef.current;
          }
        }
        const backOrSideImg = secondaryImg;

        let effectiveFrontAlpha = smooth.frontAlpha;
        if (vMode === 'front') {
          effectiveFrontAlpha = 1;
        } else if (vMode === 'back') {
          effectiveFrontAlpha = 0;
        }

        if (frontImg) {
          const vTransform = { cw, ch, offsetX, offsetY, drawW, drawH };
          const activeBodyProfile =
            controlsRef.current.bodyProfileMode === 'auto'
              ? calibrationRef.current.detectedProfile
              : controlsRef.current.bodyProfileMode;
          drawWarpedGarment(
            ctx,
            frontImg,
            { tl: smooth.tl, tr: smooth.tr, br: smooth.br, bl: smooth.bl },
            {
              yaw: smooth.yaw,
              leftArmLift: smooth.leftArmLift,
              rightArmLift: smooth.rightArmLift,
              leftSleeveDelta: smooth.leftSleeveDelta,
              rightSleeveDelta: smooth.rightSleeveDelta,
              brightness: br,
              blendAlpha: alpha,
              shadingStrength: 0.24,
              ambientTint: useAmbient ? ambientTint : null,
              video,
              videoTransform: vTransform,
              personMask: latestPersonMask,
              isOversized: controlsRef.current.fitPreset?.id === 'oversized',
              enableWrinklePhysics: controlsRef.current.enableWrinklePhysics,
              bodyProfile: activeBodyProfile,
              backImg: backOrSideImg,
              frontAlpha: effectiveFrontAlpha,
              sideBlend: smooth.sideBlend,
            }
          );

          // Composite real neck/head/hair + hands/fingers/forearms ON TOP so hands NEVER hide behind the tee!
          if (latestBodyOcclusion) {
            drawForegroundBodyOcclusion(
              ctx,
              video,
              vTransform,
              latestBodyOcclusion,
              latestPersonMask
            );
          }
        }
      }

      // Update FPS counter once per second
      frameCount++;
      const now = performance.now();
      if (now - lastFpsUpdate >= 1000) {
        setFps(frameCount);
        frameCount = 0;
        lastFpsUpdate = now;
      }
    };

    rafId = requestAnimationFrame(renderFrame);

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [stream]);

  const handleResetAdjustments = () => {
    setWidthScale(1.0);
    setLengthScale(1.0);
    setCollarOffset(0);
    setBrightness(100);
    setBlendAlpha(100);
    setFitPresetId('regular');
    setViewMode('auto');
    setBodyProfileMode('auto');
  };

  const handleCaptureClick = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const activeFit = FIT_PRESETS.find((f) => f.id === fitPresetId) || FIT_PRESETS[1];
    onCaptureSnapshot({
      imageUrl: dataUrl,
      teeName: activeTee?.name || 'Custom Tee',
      fitLabel: activeFit.label.toUpperCase(),
      viewLabel:
        viewMode === 'auto'
          ? detectedSide.toUpperCase()
          : viewMode.toUpperCase(),
    });
  };

  const showTorsoGuide = showInitialGuide || !isTracking;

  return (
    <div className="flex h-screen w-screen bg-[#0B0B0C] text-[#F5F5F7] overflow-hidden">
      {/* LEFT 75%: Live 16:9 Mirrored Webcam Canvas */}
      <div className="relative flex w-[75%] h-full flex-col bg-[#070708] overflow-hidden">
        <video ref={videoRef} autoPlay playsInline muted className="hidden" />
        <canvas ref={canvasRef} className="h-full w-full block" />

        {/* Top-Left Floating HUD Bar */}
        <div className="absolute left-5 top-5 z-20 flex items-center gap-3">
          <button
            onClick={onBackHome}
            className="glass-hud flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium text-[#F5F5F7] hover:border-[#F5F5F7]/40 transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Home
          </button>

          <div className="glass-hud flex items-center gap-2.5 rounded-xl px-3.5 py-2">
            <span
              className={`h-2 w-2 rounded-full ${
                isTracking
                  ? 'bg-[#CCFF00] shadow-[0_0_8px_#CCFF00]'
                  : 'bg-amber-400 animate-pulse'
              }`}
            />
            <span className="font-mono-hud text-[11px] uppercase tracking-[0.14em]">
              {isTracking ? 'TRACKING: ACTIVE' : 'SCANNING FOR TORSO...'}
            </span>
            {fps > 0 && (
              <span className="ml-1 border-l border-[#26262A] pl-2.5 font-mono-hud text-[10px] text-[#8E8E93]">
                {fps} FPS
              </span>
            )}
          </div>

          {isTracking && (
            <div className="glass-hud flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono-hud text-[11px] uppercase tracking-wider text-[#CCFF00]">
              <FlipHorizontal2 className="h-3.5 w-3.5" />
              {viewMode === 'auto'
                ? `AUTO: ${
                    detectedSide === 'back'
                      ? 'BACK VIEW'
                      : detectedSide === 'side'
                      ? 'SIDE VIEW'
                      : 'FRONT VIEW'
                  }`
                : `LOCKED: ${viewMode.toUpperCase()}`}
            </div>
          )}

          {isTracking && (
            <div className="glass-hud flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono-hud text-[11px] uppercase tracking-wider text-[#F5F5F7]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#CCFF00]" />
              {(bodyProfileMode === 'auto' ? detectedBodyProfile : bodyProfileMode) === 'feminine'
                ? `WOMEN'S FIT${bodyProfileMode === 'auto' ? ' (AUTO)' : ''}`
                : `MEN'S FIT${bodyProfileMode === 'auto' ? ' (AUTO)' : ''}`}
            </div>
          )}
        </div>

        {/* Top-Right Active Tee Pill + Hold-to-Compare Original */}
        <div className="absolute right-5 top-5 z-20 flex items-center gap-2.5">
          <button
            onMouseDown={() => setIsComparing(true)}
            onMouseUp={() => setIsComparing(false)}
            onMouseLeave={() => setIsComparing(false)}
            onTouchStart={() => setIsComparing(true)}
            onTouchEnd={() => setIsComparing(false)}
            className={`glass-hud flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono-hud text-[10px] uppercase tracking-wider transition-colors cursor-pointer select-none ${
              isComparing
                ? 'border-[#CCFF00] text-[#CCFF00]'
                : 'text-[#8E8E93] hover:text-[#F5F5F7]'
            }`}
            title="Press and hold to view original without virtual T-shirt"
          >
            <Eye className="h-3.5 w-3.5" />
            {isComparing ? 'ORIGINAL' : 'HOLD COMPARE'}
          </button>

          <div className="glass-hud flex items-center gap-2.5 rounded-xl px-3.5 py-2">
            <UserCheck className="h-3.5 w-3.5 text-[#CCFF00]" />
            <span className="font-display text-xs font-semibold text-[#F5F5F7]">
              {activeTee?.name}
            </span>
            <span className="rounded bg-[#CCFF00]/15 px-1.5 py-0.5 font-mono-hud text-[10px] uppercase text-[#CCFF00]">
              {fitPresetId}
            </span>
          </div>
        </div>

        {/* Framing Guide Overlay (First 2s or when no person detected) */}
        {showTorsoGuide && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center">
            <svg viewBox="0 0 260 320" className="h-[68%] w-auto opacity-60" fill="none">
              <circle
                cx="130"
                cy="48"
                r="26"
                stroke="#CCFF00"
                strokeWidth="2"
                strokeDasharray="6 6"
              />
              <path
                d="M68 102 Q130 82 192 102 L222 178 L194 188 L182 142 L180 295 L80 295 L78 142 L66 188 L38 178 Z"
                stroke="#CCFF00"
                strokeWidth="2"
                strokeDasharray="8 7"
              />
            </svg>
            <div className="glass-hud mt-3 rounded-full px-5 py-2 font-mono-hud text-xs uppercase tracking-[0.14em] text-[#F5F5F7]">
              Step back so your shoulders and waist are visible.
            </div>
          </div>
        )}
      </div>

      {/* RIGHT 25%: Sleek Studio Control Sidebar */}
      <aside className="flex w-[25%] min-w-[300px] h-full flex-col border-l border-[#26262A] bg-[#161618]">
        {/* Sidebar Header */}
        <div className="flex items-center justify-between border-b border-[#26262A] px-5 py-4">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-[#CCFF00]" />
            <span className="font-mono-hud text-xs font-semibold uppercase tracking-[0.16em]">
              STUDIO CONTROLS
            </span>
          </div>
          <button
            onClick={handleResetAdjustments}
            className="flex items-center gap-1 rounded-lg px-2 py-1 font-mono-hud text-[10px] uppercase tracking-wider text-[#8E8E93] hover:bg-[#26262A] hover:text-[#F5F5F7] transition-colors cursor-pointer"
            title="Reset sliders"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>

        {/* Scrollable Controls Area */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* 0. Solid Body Calibration Button (1-Click Lock for Boy/Girl Demo Switch) */}
          <div className="rounded-xl border border-[#26262A] bg-[#0B0B0C] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono-hud text-[10px] uppercase tracking-[0.14em] text-[#8E8E93]">
                BODY CALIBRATION
              </span>
              <span
                className={`flex items-center gap-1 font-mono-hud text-[10px] uppercase ${
                  calState === 'locked'
                    ? 'text-[#CCFF00]'
                    : calState === 'calibrating'
                    ? 'text-amber-400'
                    : 'text-[#8E8E93]'
                }`}
              >
                {calState === 'locked' && <CheckCircle2 className="h-3 w-3" />}
                {calState === 'locked'
                  ? 'LOCKED'
                  : calState === 'calibrating'
                  ? `SCANNING ${calProgress}%`
                  : 'READY'}
              </span>
            </div>
            <button
              onClick={triggerBodyCalibration}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#CCFF00]/40 bg-[#CCFF00]/10 py-2 font-mono-hud text-[11px] font-semibold uppercase tracking-wider text-[#CCFF00] hover:bg-[#CCFF00]/20 transition-colors cursor-pointer"
            >
              <Crosshair className="h-3.5 w-3.5" />
              {calState === 'calibrating' ? 'Stand Facing Front...' : 'Recalibrate Body (2s)'}
            </button>
            <label className="mt-2.5 flex items-center justify-between text-[11px] text-[#8E8E93] cursor-pointer">
              <span>Auto Room Lighting Match</span>
              <input
                type="checkbox"
                checked={autoLightMatch}
                onChange={(e) => setAutoLightMatch(e.target.checked)}
                className="accent-[#CCFF00] h-3.5 w-3.5 cursor-pointer"
              />
            </label>
            <label className="mt-2 flex items-center justify-between text-[11px] text-[#8E8E93] cursor-pointer">
              <span>Cloth Wrinkle Physics</span>
              <input
                type="checkbox"
                checked={enableWrinklePhysics}
                onChange={(e) => setEnableWrinklePhysics(e.target.checked)}
                className="accent-[#CCFF00] h-3.5 w-3.5 cursor-pointer"
              />
            </label>
          </div>

          {/* 0b. Body Silhouette Profile (Auto-detects Women's vs Men's body proportions) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93]">
                BODY SILHOUETTE
              </p>
              {bodyProfileMode === 'auto' && isTracking && (
                <span className="font-mono-hud text-[10px] uppercase text-[#CCFF00]">
                  {detectedBodyProfile === 'feminine' ? "DETECTED: WOMEN'S" : "DETECTED: MEN'S"}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[#26262A] bg-[#0B0B0C] p-1">
              {[
                { id: 'auto', label: 'Auto' },
                { id: 'feminine', label: "Women's" },
                { id: 'masculine', label: "Men's" },
              ].map((opt) => {
                const active = bodyProfileMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setBodyProfileMode(opt.id)}
                    className={`rounded-lg py-1.5 font-mono-hud text-[10px] uppercase tracking-wider transition-all cursor-pointer ${
                      active
                        ? 'bg-[#CCFF00] text-[#0B0B0C] font-bold'
                        : 'text-[#8E8E93] hover:text-[#F5F5F7]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 1. Silhouette / Fit Presets */}
          <div>
            <p className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93] mb-2">
              SILHOUETTE / FIT PRESET
            </p>
            <div className="grid grid-cols-2 gap-2">
              {FIT_PRESETS.map((preset) => {
                const active = fitPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    onClick={() => setFitPresetId(preset.id)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-all cursor-pointer ${
                      active
                        ? 'border-[#CCFF00] bg-[#CCFF00] text-[#0B0B0C]'
                        : 'border-[#26262A] bg-[#0B0B0C] text-[#F5F5F7] hover:border-[#52525B]'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. View Toggle (Auto / Force Front / Force Back) */}
          <div>
            <p className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93] mb-2">
              ANGLE VIEW MODE
            </p>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[#26262A] bg-[#0B0B0C] p-1">
              {[
                { id: 'auto', label: 'Auto' },
                { id: 'front', label: 'Front' },
                { id: 'back', label: 'Back' },
              ].map((opt) => {
                const disabled = opt.id === 'back' && !activeTee?.backUrl;
                const active = viewMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    disabled={disabled}
                    onClick={() => setViewMode(opt.id)}
                    className={`rounded-lg py-1.5 font-mono-hud text-[10px] uppercase tracking-wider transition-all cursor-pointer ${
                      active
                        ? 'bg-[#CCFF00] text-[#0B0B0C] font-bold'
                        : 'text-[#8E8E93] hover:text-[#F5F5F7] disabled:opacity-30 disabled:cursor-not-allowed'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Live Micro-Adjust Sliders */}
          <div className="space-y-3.5 border-t border-[#26262A] pt-4">
            <p className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93]">
              LIVE MICRO-ADJUST
            </p>

            {/* Width */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#F5F5F7]">Width</span>
                <span className="font-mono-hud text-[11px] text-[#CCFF00]">
                  {Math.round(widthScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.75"
                max="1.35"
                step="0.01"
                value={widthScale}
                onChange={(e) => setWidthScale(parseFloat(e.target.value))}
                className="studio-slider"
              />
            </div>

            {/* Length */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#F5F5F7]">Length</span>
                <span className="font-mono-hud text-[11px] text-[#CCFF00]">
                  {Math.round(lengthScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.70"
                max="1.35"
                step="0.01"
                value={lengthScale}
                onChange={(e) => setLengthScale(parseFloat(e.target.value))}
                className="studio-slider"
              />
            </div>

            {/* Vertical Position (Collar) */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#F5F5F7]">Vertical Position (Collar)</span>
                <span className="font-mono-hud text-[11px] text-[#CCFF00]">
                  {collarOffset > 0 ? `+${Math.round(collarOffset * 100)}` : Math.round(collarOffset * 100)}
                </span>
              </div>
              <input
                type="range"
                min="-0.22"
                max="0.22"
                step="0.01"
                value={collarOffset}
                onChange={(e) => setCollarOffset(parseFloat(e.target.value))}
                className="studio-slider"
              />
            </div>

            {/* Brightness / Blend */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#F5F5F7]">Brightness / Lighting Match</span>
                <span className="font-mono-hud text-[11px] text-[#CCFF00]">{brightness}%</span>
              </div>
              <input
                type="range"
                min="65"
                max="135"
                step="1"
                value={brightness}
                onChange={(e) => setBrightness(parseInt(e.target.value, 10))}
                className="studio-slider"
              />
            </div>

            {/* Opacity Blend */}
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-[#F5F5F7]">Fabric Blend</span>
                <span className="font-mono-hud text-[11px] text-[#CCFF00]">{blendAlpha}%</span>
              </div>
              <input
                type="range"
                min="75"
                max="100"
                step="1"
                value={blendAlpha}
                onChange={(e) => setBlendAlpha(parseInt(e.target.value, 10))}
                className="studio-slider"
              />
            </div>
          </div>

          {/* 4. Wardrobe Switcher */}
          <div className="border-t border-[#26262A] pt-4">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-[#CCFF00]" />
                <span className="font-mono-hud text-[10px] uppercase tracking-[0.16em] text-[#8E8E93]">
                  WARDROBE ({wardrobe.length})
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {wardrobe.map((tee) => {
                const isSelected = tee.id === activeTee?.id;
                return (
                  <button
                    key={tee.id}
                    onClick={() => {
                      onSelectTee(tee.id);
                      if (tee.defaultFit) setFitPresetId(tee.defaultFit);
                    }}
                    className={`group flex flex-col items-center rounded-xl border p-1.5 transition-all cursor-pointer ${
                      isSelected
                        ? 'border-[#CCFF00] bg-[#CCFF00]/10'
                        : 'border-[#26262A] bg-[#0B0B0C] hover:border-[#52525B]'
                    }`}
                    title={tee.name}
                  >
                    <div className="flex h-14 w-full items-center justify-center overflow-hidden rounded-lg bg-[#121214] p-1">
                      <img
                        src={tee.frontUrl}
                        alt={tee.name}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <span
                      className={`mt-1 w-full truncate text-center font-mono-hud text-[9px] uppercase ${
                        isSelected ? 'text-[#CCFF00] font-semibold' : 'text-[#8E8E93]'
                      }`}
                    >
                      {tee.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom Action Buttons */}
        <div className="shrink-0 space-y-2.5 border-t border-[#26262A] bg-[#131315] p-4">
          <button
            onClick={handleCaptureClick}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#CCFF00] py-3 font-display text-sm font-bold text-[#0B0B0C] shadow-[0_0_24px_rgba(204,255,0,0.22)] hover:bg-[#d8ff33] active:scale-[0.99] transition-all cursor-pointer"
          >
            <Camera className="h-4 w-4" />
            Capture Look
          </button>
          <button
            onClick={onUploadNew}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#26262A] bg-[#0B0B0C] py-2.5 text-xs font-medium text-[#F5F5F7] hover:border-[#F5F5F7]/35 transition-colors cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload New Tee
          </button>
        </div>
      </aside>
    </div>
  );
}
