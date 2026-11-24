/**
 * Stage 2: 3D Pose Tracking & Multiclass Occlusion Engine (@mediapipe/tasks-vision)
 * - Runs PoseLandmarker (Full, 33 2D + 3D worldLandmarks)
 * - Runs ImageSegmenter (Selfie Multiclass 256x256: background, hair, body-skin, face-skin, clothes, others)
 * - Builds real-time foreground occlusion layers so hair, beard/face-skin, glasses,
 *   and forearms/hands (when wrist Z is closer than torso Z) ALWAYS composite cleanly ON TOP of the garment!
 */

import { FilesetResolver, PoseLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

// MediaPipe Selfie Multiclass 256x256 class IDs:
export const SEG_CLASS = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  OTHERS: 5,
};

let poseLandmarker = null;
let imageSegmenter = null;
let initPromise = null;
let engineStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
const listeners = new Set();

function setStatus(s) {
  engineStatus = s;
  listeners.forEach((fn) => fn(s));
}

export function subscribeVisionStatus(fn) {
  listeners.add(fn);
  fn(engineStatus);
  return () => listeners.delete(fn);
}

export async function preloadVisionEngine() {
  if (poseLandmarker && imageSegmenter) {
    return { poseLandmarker, imageSegmenter };
  }
  if (initPromise) return initPromise;

  setStatus('loading');
  initPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks('/wasm');

      const createWithFallback = async (creator, modelPath, extraOpts) => {
        for (const delegate of ['GPU', 'CPU']) {
          try {
            return await creator(vision, {
              baseOptions: { modelAssetPath: modelPath, delegate },
              runningMode: 'VIDEO',
              ...extraOpts,
            });
          } catch (err) {
            console.warn(`${modelPath} (${delegate}) fallback:`, err);
          }
        }
        throw new Error(`Failed to initialize ${modelPath}`);
      };

      const [pose, seg] = await Promise.all([
        createWithFallback(PoseLandmarker.createFromOptions, '/models/pose_landmarker_full.task', {
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        }),
        createWithFallback(
          ImageSegmenter.createFromOptions,
          '/models/selfie_multiclass_256x256.tflite',
          {
            outputCategoryMask: true,
            outputConfidenceMasks: false,
          }
        ),
      ]);

      poseLandmarker = pose;
      imageSegmenter = seg;
      setStatus('ready');
      return { poseLandmarker, imageSegmenter };
    } catch (err) {
      console.error('Vision engine init failed:', err);
      setStatus('error');
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

// Reusable canvases for zero-GC multiclass mask extraction
let hairFaceCanvas = null;
let hairFaceCtx = null;
let hairFaceImgData = null;

let bodySkinCanvas = null;
let bodySkinCtx = null;
let bodySkinImgData = null;

let personMaskCanvas = null;
let personMaskCtx = null;
let personMaskImgData = null;

/**
 * Unpacks MediaPipe Selfie Multiclass categoryMask into 3 reusable alpha canvases:
 * - hairFaceCanvas: `hair` (1) + `face-skin` (3) + `others` (5, e.g. glasses/beard) -> ALWAYS ON TOP!
 * - bodySkinCanvas: `body-skin` (2, forearms/hands/neck) -> masked to foreground arms when wrist Z < torso Z!
 * - personMaskCanvas: entire person (`class !== 0`) -> keeps garment clipped cleanly to body!
 */
export function unpackMulticlassMasks(categoryMask) {
  if (!categoryMask) return null;
  const mw = categoryMask.width;
  const mh = categoryMask.height;
  if (!mw || !mh) return null;

  const ensure = (canvasRef, ctxRef, imgDataRef) => {
    let c = canvasRef;
    let ctx = ctxRef;
    let imgD = imgDataRef;
    if (!c) {
      c = document.createElement('canvas');
      ctx = c.getContext('2d');
    }
    if (c.width !== mw || c.height !== mh) {
      c.width = mw;
      c.height = mh;
      imgD = ctx.createImageData(mw, mh);
    }
    return { c, ctx, imgD };
  };

  ({ c: hairFaceCanvas, ctx: hairFaceCtx, imgD: hairFaceImgData } = ensure(
    hairFaceCanvas,
    hairFaceCtx,
    hairFaceImgData
  ));
  ({ c: bodySkinCanvas, ctx: bodySkinCtx, imgD: bodySkinImgData } = ensure(
    bodySkinCanvas,
    bodySkinCtx,
    bodySkinImgData
  ));
  ({ c: personMaskCanvas, ctx: personMaskCtx, imgD: personMaskImgData } = ensure(
    personMaskCanvas,
    personMaskCtx,
    personMaskImgData
  ));

  const catBytes = categoryMask.getAsUint8Array();
  const hf = hairFaceImgData.data;
  const bs = bodySkinImgData.data;
  const pm = personMaskImgData.data;

  for (let i = 0; i < catBytes.length; i++) {
    const cls = catBytes[i];
    const idx = i * 4;

    const isHairOrFace =
      cls === SEG_CLASS.HAIR || cls === SEG_CLASS.FACE_SKIN || cls === SEG_CLASS.OTHERS;
    const isBodySkin = cls === SEG_CLASS.BODY_SKIN;
    const isPerson = cls !== SEG_CLASS.BACKGROUND;

    hf[idx] = 255;
    hf[idx + 1] = 255;
    hf[idx + 2] = 255;
    hf[idx + 3] = isHairOrFace ? 255 : 0;

    bs[idx] = 255;
    bs[idx + 1] = 255;
    bs[idx + 2] = 255;
    bs[idx + 3] = isBodySkin ? 255 : 0;

    pm[idx] = 255;
    pm[idx + 1] = 255;
    pm[idx + 2] = 255;
    pm[idx + 3] = isPerson ? 255 : 0;
  }

  hairFaceCtx.putImageData(hairFaceImgData, 0, 0);
  bodySkinCtx.putImageData(bodySkinImgData, 0, 0);
  personMaskCtx.putImageData(personMaskImgData, 0, 0);

  return {
    hairFaceMask: hairFaceCanvas,
    bodySkinMask: bodySkinCanvas,
    personMask: personMaskCanvas,
  };
}

// Reusable foreground occlusion compositor canvas
let fgCanvas = null;
let fgCtx = null;
let armMaskCanvas = null;
let armMaskCtx = null;

/**
 * Stage 2 Composite Layer #3:
 * Re-composites the user's `hair` and `face-skin` masks (ALWAYS ON TOP so beard/chin/hair
 * are never covered), PLUS `body-skin` forearms & hands when wrist Z is closer to the camera
 * than torso Z (so crossed arms/hands pass cleanly IN FRONT of the virtual garment!).
 */
export function drawMulticlassForegroundOcclusion(
  mainCtx,
  video,
  videoTransform,
  masks,
  armData
) {
  if (!masks) return;
  const { cw, ch, offsetX, offsetY, drawW, drawH } = videoTransform;
  const { hairFaceMask, bodySkinMask } = masks;

  if (!fgCanvas) {
    fgCanvas = document.createElement('canvas');
    fgCtx = fgCanvas.getContext('2d');
    armMaskCanvas = document.createElement('canvas');
    armMaskCtx = armMaskCanvas.getContext('2d');
  }
  if (fgCanvas.width !== cw || fgCanvas.height !== ch) {
    fgCanvas.width = cw;
    fgCanvas.height = ch;
    armMaskCanvas.width = cw;
    armMaskCanvas.height = ch;
  }

  fgCtx.clearRect(0, 0, cw, ch);

  // 1. Hair + Face-Skin + Glasses (ALWAYS in front of garment)
  fgCtx.save();
  fgCtx.filter = 'blur(1.2px)';
  fgCtx.translate(cw, 0);
  fgCtx.scale(-1, 1);
  fgCtx.drawImage(hairFaceMask, offsetX, offsetY, drawW, drawH);
  fgCtx.restore();

  // 2. Forearms & Hands (`body-skin` restricted to active foreground arm corridors where wrist Z < torso Z)
  const activeArms = (armData?.arms || []).filter((a) => a && a.inFront && a.wrist);
  if (activeArms.length > 0 && bodySkinMask) {
    const shW = armData.shoulderWidth || 160;
    const forearmR = Math.max(20, shW * 0.20);
    const handR = Math.max(24, shW * 0.24);

    armMaskCtx.clearRect(0, 0, cw, ch);
    armMaskCtx.save();
    armMaskCtx.fillStyle = '#ffffff';
    armMaskCtx.strokeStyle = '#ffffff';
    armMaskCtx.lineCap = 'round';
    armMaskCtx.lineJoin = 'round';

    const seg = (pA, pB, r) => {
      if (!pA || !pB) return;
      armMaskCtx.lineWidth = r * 2;
      armMaskCtx.beginPath();
      armMaskCtx.moveTo(pA.x, pA.y);
      armMaskCtx.lineTo(pB.x, pB.y);
      armMaskCtx.stroke();
    };

    for (const arm of activeArms) {
      const { elbow, wrist, index, pinky, thumb } = arm;
      if (elbow && elbow.v > 0.2) {
        seg(elbow, wrist, forearmR);
      } else {
        seg({ x: wrist.x, y: wrist.y + shW * 0.6 }, wrist, forearmR);
      }

      // Generous hand/finger corridor — bodySkinMask trims it to pixel-exact skin!
      armMaskCtx.beginPath();
      armMaskCtx.arc(wrist.x, wrist.y, handR, 0, Math.PI * 2);
      armMaskCtx.fill();
      if (index && index.v > 0.15) seg(wrist, index, handR * 0.85);
      if (pinky && pinky.v > 0.15) seg(wrist, pinky, handR * 0.8);
      if (thumb && thumb.v > 0.15) seg(wrist, thumb, handR * 0.75);
    }
    armMaskCtx.restore();

    // Intersect generous arm corridor with MediaPipe's pixel-exact `body-skin` mask!
    armMaskCtx.save();
    armMaskCtx.globalCompositeOperation = 'destination-in';
    armMaskCtx.filter = 'blur(1px)';
    armMaskCtx.translate(cw, 0);
    armMaskCtx.scale(-1, 1);
    armMaskCtx.drawImage(bodySkinMask, offsetX, offsetY, drawW, drawH);
    armMaskCtx.restore();

    // Merge into foreground mask
    fgCtx.drawImage(armMaskCanvas, 0, 0);
  }

  // 3. Fill combined foreground mask with live mirrored webcam pixels
  fgCtx.save();
  fgCtx.globalCompositeOperation = 'source-in';
  fgCtx.translate(cw, 0);
  fgCtx.scale(-1, 1);
  fgCtx.drawImage(video, offsetX, offsetY, drawW, drawH);
  fgCtx.restore();

  // 4. Composite cleanly ON TOP of the virtual garment
  mainCtx.save();
  mainCtx.drawImage(fgCanvas, 0, 0);
  mainCtx.restore();
}
