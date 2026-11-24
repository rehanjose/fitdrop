/**
 * FitDrop High-Clarity 3D Cloth Warper & Reality Blender (30-60 FPS)
 * - Full-resolution crisp garment mesh (8x8 grid with high-quality texture filtering)
 * - Real-time Person Segmentation Mask clipping (stops garment floating onto background wall)
 * - Low-frequency Room Lighting Transfer (broad ambient light/shadow without bleeding real clothes)
 * - Organic diffused cloth fold shading (zero hard stroke lines; preserves original cotton folds)
 * - Shoulder-pivot sleeve rotation & hem lift when raising arms
 * - Real Neck/Head + Raised Forearms foreground occlusion
 */

let offscreenCanvas = null;
let offscreenCtx = null;
let lightMapCanvas = null;
let lightMapCtx = null;
let foldMapCanvas = null;
let foldMapCtx = null;
let occlusionCanvas = null;
let occlusionCtx = null;
let armCorridorCanvas = null;
let armCorridorCtx = null;
let armCoreCanvas = null;
let armCoreCtx = null;
let armVideoCanvas = null;
let armVideoCtx = null;
let maskCanvas = null;
let maskCtx = null;
let maskImgData = null;
let smoothMaskProb = null;

// Lightweight Spring-Damper Cloth Inertia State (gives hem & sleeves organic sway & ripple)
const clothPhysics = {
  initialized: false,
  prevCenterX: 0,
  prevCenterY: 0,
  swayX: 0,
  swayY: 0,
  velX: 0,
  velY: 0,
  ripplePhase: 0,
  energy: 0,
};

function stepClothPhysics(centerX, centerY, armEnergy) {
  if (!clothPhysics.initialized) {
    clothPhysics.prevCenterX = centerX;
    clothPhysics.prevCenterY = centerY;
    clothPhysics.initialized = true;
    return clothPhysics;
  }

  // Acceleration impulse from wearer movement
  const dx = centerX - clothPhysics.prevCenterX;
  const dy = centerY - clothPhysics.prevCenterY;
  clothPhysics.prevCenterX = centerX;
  clothPhysics.prevCenterY = centerY;

  // Clamp impulse to avoid wild spikes on tracking jumps
  const impX = Math.max(-16, Math.min(16, dx));
  const impY = Math.max(-12, Math.min(12, dy));

  // Damped spring-mass oscillation (cotton fabric stiffness & damping)
  const stiffness = 0.16;
  const damping = 0.78;
  clothPhysics.velX = (clothPhysics.velX - impX * 0.36 - clothPhysics.swayX * stiffness) * damping;
  clothPhysics.velY = (clothPhysics.velY - impY * 0.30 - clothPhysics.swayY * stiffness) * damping;
  clothPhysics.swayX = Math.max(-18, Math.min(18, clothPhysics.swayX + clothPhysics.velX));
  clothPhysics.swayY = Math.max(-14, Math.min(14, clothPhysics.swayY + clothPhysics.velY));

  const motionMag = Math.hypot(impX, impY) + armEnergy * 5;
  clothPhysics.energy = clothPhysics.energy * 0.88 + Math.min(1.2, motionMag * 0.06) * 0.12;
  clothPhysics.ripplePhase += 0.12 + clothPhysics.energy * 0.10;

  return clothPhysics;
}

/**
 * Renders a broad, velvety fabric fold into a tiny low-res fold map so that when
 * upscaled onto the garment it blends as soft volumetric cloth shading (never a hard line).
 */
function paintDiffusedFold(fCtx, x0, y0, cx, cy, x1, y1, width, intensity) {
  if (intensity <= 0.01) return;
  fCtx.save();
  fCtx.lineCap = 'round';
  fCtx.lineJoin = 'round';

  // Wide outer ambient trough
  fCtx.strokeStyle = `rgba(0, 0, 0, ${Math.min(0.14, intensity * 0.45)})`;
  fCtx.lineWidth = width * 2.4;
  fCtx.beginPath();
  fCtx.moveTo(x0, y0);
  fCtx.quadraticCurveTo(cx, cy, x1, y1);
  fCtx.stroke();

  // Soft core shadow valley
  fCtx.strokeStyle = `rgba(0, 0, 0, ${Math.min(0.22, intensity * 0.75)})`;
  fCtx.lineWidth = width * 1.1;
  fCtx.beginPath();
  fCtx.moveTo(x0, y0);
  fCtx.quadraticCurveTo(cx, cy, x1, y1);
  fCtx.stroke();

  // Gentle displaced highlight crest
  fCtx.strokeStyle = `rgba(255, 255, 255, ${Math.min(0.12, intensity * 0.4)})`;
  fCtx.lineWidth = width * 1.3;
  fCtx.beginPath();
  fCtx.moveTo(x0 + width * 0.55, y0 - width * 0.45);
  fCtx.quadraticCurveTo(
    cx + width * 0.55,
    cy - width * 0.45,
    x1 + width * 0.55,
    y1 - width * 0.45
  );
  fCtx.stroke();

  fCtx.restore();
}

function ensureOffscreen(w, h) {
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCtx = offscreenCanvas.getContext('2d');
  }
  if (offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
  }
  offscreenCtx.imageSmoothingEnabled = true;
  offscreenCtx.imageSmoothingQuality = 'high';
  return { canvas: offscreenCanvas, ctx: offscreenCtx };
}

function ensureLightMap(w, h) {
  if (!lightMapCanvas) {
    lightMapCanvas = document.createElement('canvas');
    lightMapCtx = lightMapCanvas.getContext('2d');
  }
  if (lightMapCanvas.width !== w || lightMapCanvas.height !== h) {
    lightMapCanvas.width = w;
    lightMapCanvas.height = h;
  }
  return { canvas: lightMapCanvas, ctx: lightMapCtx };
}

function ensureFoldMap(w, h) {
  if (!foldMapCanvas) {
    foldMapCanvas = document.createElement('canvas');
    foldMapCtx = foldMapCanvas.getContext('2d');
  }
  if (foldMapCanvas.width !== w || foldMapCanvas.height !== h) {
    foldMapCanvas.width = w;
    foldMapCanvas.height = h;
  }
  return { canvas: foldMapCanvas, ctx: foldMapCtx };
}

function ensureOcclusionCanvas(w, h) {
  if (!occlusionCanvas) {
    occlusionCanvas = document.createElement('canvas');
    occlusionCtx = occlusionCanvas.getContext('2d');
  }
  if (occlusionCanvas.width !== w || occlusionCanvas.height !== h) {
    occlusionCanvas.width = w;
    occlusionCanvas.height = h;
  }
  occlusionCtx.imageSmoothingEnabled = true;
  occlusionCtx.imageSmoothingQuality = 'high';
  return { canvas: occlusionCanvas, ctx: occlusionCtx };
}

function ensureHalfResArmCanvases(hw, hh) {
  if (!armCorridorCanvas) {
    armCorridorCanvas = document.createElement('canvas');
    armCorridorCtx = armCorridorCanvas.getContext('2d', { willReadFrequently: true });
    armCoreCanvas = document.createElement('canvas');
    armCoreCtx = armCoreCanvas.getContext('2d', { willReadFrequently: true });
    armVideoCanvas = document.createElement('canvas');
    armVideoCtx = armVideoCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (armCorridorCanvas.width !== hw || armCorridorCanvas.height !== hh) {
    armCorridorCanvas.width = hw;
    armCorridorCanvas.height = hh;
    armCoreCanvas.width = hw;
    armCoreCanvas.height = hh;
    armVideoCanvas.width = hw;
    armVideoCanvas.height = hh;
  }
  return {
    corridorCanvas: armCorridorCanvas,
    corridorCtx: armCorridorCtx,
    coreCanvas: armCoreCanvas,
    coreCtx: armCoreCtx,
    videoCanvas: armVideoCanvas,
    videoCtx: armVideoCtx,
  };
}

/**
 * Updates a temporally-smoothed alpha-mask canvas from MediaPipe's Float32 segmentation mask.
 * Uses adaptive per-pixel EMA: heavy smoothing on small border noise (eliminates shoulder/arm
 * edge shimmer!) while responding instantaneously to fast hand/body movement (zero ghosting).
 */
export function updatePersonMaskCanvas(segMask) {
  if (!segMask) return null;
  const mw = segMask.width;
  const mh = segMask.height;
  if (!mw || !mh) return null;

  if (!maskCanvas) {
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d');
  }
  if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
    maskCanvas.width = mw;
    maskCanvas.height = mh;
    maskImgData = maskCtx.createImageData(mw, mh);
    smoothMaskProb = null;
  }

  const floatData = segMask.getAsFloat32Array();
  const len = floatData.length;
  if (!smoothMaskProb || smoothMaskProb.length !== len) {
    smoothMaskProb = new Float32Array(floatData);
  } else {
    for (let i = 0; i < len; i++) {
      const curr = floatData[i];
      const prev = smoothMaskProb[i];
      const diff = Math.abs(curr - prev);
      // Small edge flicker -> temporal lock (0.24); real shoulder/arm motion -> crisp fast snap (0.78)
      const ema = diff < 0.22 ? 0.24 : diff < 0.42 ? 0.52 : 0.78;
      smoothMaskProb[i] = prev + (curr - prev) * ema;
    }
  }

  const pixels = maskImgData.data;

  // Convert smoothed 0..1 body probability into clean anti-aliased alpha mask
  for (let i = 0; i < len; i++) {
    const p = smoothMaskProb[i];
    const alpha = p < 0.28 ? 0 : p > 0.68 ? 255 : Math.round(((p - 0.28) / 0.40) * 255);
    const idx = i * 4;
    pixels[idx] = 255;
    pixels[idx + 1] = 255;
    pixels[idx + 2] = 255;
    pixels[idx + 3] = alpha;
  }

  maskCtx.putImageData(maskImgData, 0, 0);
  return maskCanvas;
}

function drawTexturedTriangle(ctx, img, sx0, sy0, sx1, sy1, sx2, sy2, dx0, dy0, dx1, dy1, dx2, dy2) {
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const expand = (px, py) => {
    const vx = px - cx;
    const vy = py - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [px + (vx / len) * 0.6, py + (vy / len) * 0.6];
  };
  const [ex0, ey0] = expand(dx0, dy0);
  const [ex1, ey1] = expand(dx1, dy1);
  const [ex2, ey2] = expand(dx2, dy2);

  const denom = sx0 * (sy2 - sy1) - sx1 * sy2 + sx2 * sy1 + (sx1 - sx2) * sy0;
  if (Math.abs(denom) < 1e-5) return;

  const m11 = -(sy0 * (dx2 - dx1) - sy1 * dx2 + sy2 * dx1 + (sy1 - sy2) * dx0) / denom;
  const m12 = (sy1 * dy2 + sy0 * (dy1 - dy2) - sy2 * dy1 + (sy2 - sy1) * dy0) / denom;
  const m21 = (sx0 * (dx2 - dx1) - sx1 * dx2 + sx2 * dx1 + (sx1 - sx2) * dx0) / denom;
  const m22 = -(sx1 * dy2 + sx0 * (dy1 - dy2) - sx2 * dy1 + (sx2 - sx1) * dy0) / denom;
  const dx =
    (sx0 * (sy2 * dx1 - sy1 * dx2) +
      sy0 * (sx1 * dx2 - sx2 * dx1) +
      (sx2 * sy1 - sx1 * sy2) * dx0) /
    denom;
  const dy =
    (sx0 * (sy2 * dy1 - sy1 * dy2) +
      sy0 * (sx1 * dy2 - sx2 * dy1) +
      (sx2 * sy1 - sx1 * sy2) * dy0) /
    denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();

  ctx.transform(m11, m12, m21, m22, dx, dy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * Renders the T-shirt warped to the 4-corner body quad at high FPS,
 * clipped to the live person silhouette mask, and blended with live room shadows.
 */
export function drawWarpedGarment(mainCtx, img, quad, options = {}) {
  const {
    yaw = 0,
    leftArmLift = 0,
    rightArmLift = 0,
    leftSleeveDelta = 0, // Exact signed radians from rest sleeve angle -> live upper-arm angle
    rightSleeveDelta = 0,
    brightness = 100,
    blendAlpha = 96,
    shadingStrength = 0.30,
    ambientTint = null,
    video = null,
    videoTransform = null,
    personMask = null,
    isOversized = false,
    enableWrinklePhysics = true,
    bodyProfile = 'masculine', // 'feminine' | 'masculine'
    backImg = null, // Clean plain-cotton back/side texture for seamless 3D cross-fade
    frontAlpha = 1, // Smooth 0..1 cross-fade of front graphic as torso rotates sideways
    sideBlend = 0, // Smooth 0..1 side-profile factor (sin² of turn angle)
    lowPowerMode = false, // Auto-enabled on slower Windows iGPUs / older Macs to keep 30+ FPS
  } = options;

  const { tl, tr, br, bl } = quad;
  const cw = mainCtx.canvas.width;
  const ch = mainCtx.canvas.height;

  // Render garment mesh at full 1.0x resolution for crisp prints & authentic cotton texture
  const SCALE = 1.0;
  const lw = Math.max(64, Math.round(cw * SCALE));
  const lh = Math.max(64, Math.round(ch * SCALE));
  const { canvas: layer, ctx } = ensureOffscreen(lw, lh);
  ctx.clearRect(0, 0, lw, lh);

  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  if (!imgW || !imgH) return;

  // Scale quad into offscreen layer space
  const sTL = { x: tl.x * SCALE, y: tl.y * SCALE };
  const sTR = { x: tr.x * SCALE, y: tr.y * SCALE };
  const sBR = { x: br.x * SCALE, y: br.y * SCALE };
  const sBL = { x: bl.x * SCALE, y: bl.y * SCALE };

  const topWidth = Math.hypot(sTR.x - sTL.x, sTR.y - sTL.y);
  const torsoHeight = Math.hypot(
    (sBL.x + sBR.x) * 0.5 - (sTL.x + sTR.x) * 0.5,
    (sBL.y + sBR.y) * 0.5 - (sTL.y + sTR.y) * 0.5
  );
  const downX = ((sBL.x + sBR.x) * 0.5 - (sTL.x + sTR.x) * 0.5) / Math.max(torsoHeight, 1);
  const downY = ((sBL.y + sBR.y) * 0.5 - (sTL.y + sTR.y) * 0.5) / Math.max(torsoHeight, 1);

  // Measure side lean compression (when user leans left or right, one side bunches into folds)
  const leftSideLen = Math.hypot(sBL.x - sTL.x, sBL.y - sTL.y);
  const rightSideLen = Math.hypot(sBR.x - sTR.x, sBR.y - sTR.y);
  const sideCompression = Math.max(-1, Math.min(1, (rightSideLen - leftSideLen) / Math.max(torsoHeight * 0.25, 1)));

  // Step lightweight Spring-Damper Cloth Inertia Physics
  const phys = enableWrinklePhysics
    ? stepClothPhysics((sTL.x + sTR.x) * 0.5, (sTL.y + sTR.y) * 0.5, (leftArmLift + rightArmLift) * 0.5)
    : { swayX: 0, swayY: 0, ripplePhase: 0, energy: 0 };

  // Adaptive mesh density: 12x12 on fast laptops (M-series / dGPU), 8x8 on integrated GPUs for smooth 30-60 FPS
  const COLS = lowPowerMode ? 8 : 12;
  const ROWS = lowPowerMode ? 8 : 12;

  const smoothstep = (e0, e1, val) => {
    const t = Math.max(0, Math.min(1, (val - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const isFeminine = bodyProfile === 'feminine';
  const contourFactor = isOversized ? 0.35 : 1.0;

  // Horizontal unit axis across torso for anatomical contouring
  const rightX = (sTR.x - sTL.x) / Math.max(topWidth, 1);
  const rightY = (sTR.y - sTL.y) / Math.max(topWidth, 1);

  const grid = [];
  for (let r = 0; r <= ROWS; r++) {
    const v = r / ROWS;
    const row = [];
    for (let c = 0; c <= COLS; c++) {
      const u = c / COLS;

      const topX = sTL.x + (sTR.x - sTL.x) * u;
      const topY = sTL.y + (sTR.y - sTL.y) * u;
      const botX = sBL.x + (sBR.x - sBL.x) * u;
      const botY = sBL.y + (sBR.y - sBL.y) * u;

      let x = topX + (botX - topX) * v;
      let y = topY + (botY - topY) * v;

      // 0. Anatomical Silhouette Shaping (Feminine waist/hip/chest contour vs. Masculine structured V-taper)
      const centeredU = u - 0.5; // -0.5..+0.5
      if (isFeminine) {
        // Gentle hourglass waist cinch peaking around v=0.56, plus natural hip flare toward bottom hem
        const waistCinch = Math.exp(-Math.pow((v - 0.56) / 0.21, 2)) * -0.105 * contourFactor;
        const hipFlare = Math.max(0, (v - 0.68) / 0.32) * 0.065 * contourFactor;
        const bustFullness = Math.exp(-Math.pow((v - 0.32) / 0.14, 2)) * 0.025 * contourFactor;
        const widthMod = (waistCinch + hipFlare + bustFullness) * centeredU * topWidth;
        x += rightX * widthMod;
        y += rightY * widthMod;

        // Softer feminine shoulder slope on outer upper edges
        const shoulderSlope = Math.max(0, (0.24 - v) / 0.24) * Math.pow(Math.abs(centeredU) * 2, 1.5);
        x += downX * torsoHeight * 0.026 * shoulderSlope;
        y += downY * torsoHeight * 0.026 * shoulderSlope;

        // Subtle forward bust/chest vertical drape curve
        const bustCurve = Math.exp(-Math.pow((v - 0.34) / 0.16, 2)) * Math.sin(u * Math.PI);
        const bustLift = torsoHeight * 0.016 * bustCurve * contourFactor;
        x -= downX * bustLift;
        y -= downY * bustLift;
      } else {
        // Masculine athletic V-taper: structured upper chest, slight clean taper toward waist/hem
        const vTaper = Math.max(0, (v - 0.38) / 0.62) * -0.038 * contourFactor;
        const widthMod = vTaper * centeredU * topWidth;
        x += rightX * widthMod;
        y += rightY * widthMod;
      }

      // 1. Cylindrical chest curve
      const cylCurve = Math.sin(u * Math.PI);
      const hemCurveAmount = torsoHeight * 0.026 * cylCurve * (0.3 + 0.7 * v);
      x += downX * hemCurveAmount;
      y += downY * hemCurveAmount;

      // 2. True 2D Skeletal Sleeve Skinning (sleeves track the EXACT shoulder->elbow angle,
      // from resting at sides -> T-pose -> flexing -> full 180° overhead raise without ballooning!)
      const isLeftSide = u < 0.5;
      const armLift = isLeftSide ? leftArmLift : rightArmLift;
      const sleeveDelta = isLeftSide ? leftSleeveDelta : rightSleeveDelta;

      const sideDist = Math.abs(u - 0.5) * 2; // 0 at chest center, 1 at outer sleeve cuff
      // Smoothstep reaches rigid 1.0 across the entire sleeve cuff (prevents wingsuit distortion!)
      const sleeveHoriz = smoothstep(0.42, 0.58, sideDist);
      const sleeveVert = smoothstep(0.62, 0.34, v);
      const sleeveMask = sleeveHoriz * sleeveVert;

      if (sleeveMask > 0.001) {
        if (Math.abs(sleeveDelta) > 0.015) {
          // Anchor pivot right at the top shoulder joint (pivotV = 0.10) so raising arms lifts
          // the sleeve cleanly WITHOUT pulling the shoulder seam off the top of the shoulder!
          const pivotU = isLeftSide ? 0.27 : 0.73;
          const pivotV = 0.10;
          const pTopX = sTL.x + (sTR.x - sTL.x) * pivotU;
          const pTopY = sTL.y + (sTR.y - sTL.y) * pivotU;
          const pBotX = sBL.x + (sBR.x - sBL.x) * pivotU;
          const pBotY = sBL.y + (sBR.y - sBL.y) * pivotU;
          const pivotX = pTopX + (pBotX - pTopX) * pivotV;
          const pivotY = pTopY + (pBotY - pTopY) * pivotV;

          // Rigidly rotate sleeve vertices around the shoulder joint to align with the real upper arm!
          const rotAngle = sleeveDelta * sleeveMask;
          const cosA = Math.cos(rotAngle);
          const sinA = Math.sin(rotAngle);
          const rx = x - pivotX;
          const ry = y - pivotY;
          // Gentle natural sleeve bunching (~10%) when arm is raised high overhead
          const bunchScale = 1 - Math.min(0.14, armLift * 0.12) * sleeveMask;
          x = pivotX + (rx * cosA - ry * sinA) * bunchScale;
          y = pivotY + (rx * sinA + ry * cosA) * bunchScale;

          // Subtle shoulder-cap lift as the deltoid rises
          const capLift = torsoHeight * 0.045 * armLift * sleeveMask;
          x -= downX * capLift;
          y -= downY * capLift;
        } else {
          // Natural gravity drape when arms hang down: heavy cotton sleeves fall downward & slightly inward
          // along the upper arms instead of sticking straight out at 45° into empty air!
          const drapeDrop = torsoHeight * (isOversized ? 0.065 : 0.042) * sleeveMask;
          const inwardPull = (isLeftSide ? 1 : -1) * topWidth * (isOversized ? 0.042 : 0.022) * sleeveMask;
          x += downX * drapeDrop + rightX * inwardPull;
          y += downY * drapeDrop + rightY * inwardPull;
        }
      }

      // Realistic torso & hem upward pull when raising arms (natural cotton lift at waist)
      const sidePullWeight = isLeftSide
        ? leftArmLift * (0.45 + 0.55 * (1 - u * 2)) + rightArmLift * 0.22
        : rightArmLift * (0.45 + 0.55 * ((u - 0.5) * 2)) + leftArmLift * 0.22;
      if (sidePullWeight > 0.02) {
        const hemPull = torsoHeight * 0.14 * Math.min(1, sidePullWeight) * (0.20 + 0.80 * v);
        x -= downX * hemPull;
        y -= downY * hemPull;
      }

      // 3. Spring-Damper Cloth Inertia & Subtle Wrinkle Wave Displacement (calm at rest, organic sway on motion!)
      if (enableWrinklePhysics) {
        const looseWeight = v * v; // Zero at pinned shoulders, max at loose bottom hem
        const motionFactor = Math.min(1, phys.energy * 2.2);
        const wave = Math.sin(u * Math.PI * 3.5 + phys.ripplePhase) * (phys.energy * 3.0) * motionFactor * looseWeight;
        x += phys.swayX * looseWeight + wave * 0.45;
        y += phys.swayY * looseWeight * 0.55 + Math.cos(u * Math.PI * 2.5 + phys.ripplePhase) * phys.energy * 1.8 * motionFactor * looseWeight;
      }

      // 4. True 3D Cylindrical Foreshortening (chest print & cotton weave curve naturally around torso!)
      // Side turning away from camera compresses nonlinearly; center-chest bulges toward facing direction
      const cylWrapShift = yaw * topWidth * 0.085 * cylCurve;
      const farSideCompress = yaw * (u - 0.5) * (u - 0.5) * topWidth * 0.09;
      x += rightX * (cylWrapShift - farSideCompress);
      y += rightY * (cylWrapShift - farSideCompress);

      // Smoothly tuck outer flat-sleeve UV margins as torso rotates into side profile (zero pop!)
      const sideCrop = Math.min(0.16, sideBlend * 0.16);
      const srcU = sideCrop + u * (1 - sideCrop * 2);

      row.push({ sx: srcU * imgW, sy: v * imgH, dx: x, dy: y, u, v });
    }
    grid.push(row);
  }

  const drawMeshPass = (targetImg, alpha = 1, uOffset = 0) => {
    const tW = targetImg.naturalWidth || targetImg.width;
    const tH = targetImg.naturalHeight || targetImg.height;
    if (!tW || !tH || alpha <= 0.005) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    const sideCrop = Math.min(0.16, sideBlend * 0.16);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p00 = grid[r][c];
        const p10 = grid[r][c + 1];
        const p01 = grid[r + 1][c];
        const p11 = grid[r + 1][c + 1];

        const mapU = (uVal) =>
          Math.max(0, Math.min(1, sideCrop + uVal * (1 - sideCrop * 2) + uOffset)) * tW;

        const sx00 = mapU(p00.u);
        const sx10 = mapU(p10.u);
        const sx01 = mapU(p01.u);
        const sx11 = mapU(p11.u);
        const sy00 = p00.v * tH;
        const sy10 = p10.v * tH;
        const sy01 = p01.v * tH;
        const sy11 = p11.v * tH;

        drawTexturedTriangle(
          ctx, targetImg,
          sx00, sy00, sx10, sy10, sx11, sy11,
          p00.dx, p00.dy, p10.dx, p10.dy, p11.dx, p11.dy
        );
        drawTexturedTriangle(
          ctx, targetImg,
          sx00, sy00, sx11, sy11, sx01, sy01,
          p00.dx, p00.dy, p11.dx, p11.dy, p01.dx, p01.dy
        );
      }
    }
    ctx.restore();
  };

  // Seamless 3D Cylindrical Cross-Fade:
  // Plain cotton base underneath -> smoothly cross-fade & cylindrically wrap front graphic on top!
  if (backImg && frontAlpha < 0.99) {
    drawMeshPass(backImg, 1.0, 0);
    if (frontAlpha > 0.01) {
      // Gently slide the front graphic toward the facing edge as the wearer rotates sideways
      const wrapShift = -yaw * 0.11 * sideBlend;
      drawMeshPass(img, frontAlpha, wrapShift);
    }
  } else {
    drawMeshPass(img, 1.0, 0);
  }

  // --- REALITY BLENDING PASS (source-atop keeps everything strictly inside the T-shirt) ---
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';

  // A. Subtle cylindrical 3D torso contour shading (keeps center print crisp & punchy)
  const leftMidX = (sTL.x + sBL.x) * 0.5;
  const leftMidY = (sTL.y + sBL.y) * 0.5;
  const rightMidX = (sTR.x + sBR.x) * 0.5;
  const rightMidY = (sTR.y + sBR.y) * 0.5;
  const cylGrad = ctx.createLinearGradient(leftMidX, leftMidY, rightMidX, rightMidY);
  const highlightPos = Math.min(0.72, Math.max(0.28, 0.5 - yaw * 0.18));
  cylGrad.addColorStop(0, `rgba(0, 0, 0, ${shadingStrength * 0.95})`);
  cylGrad.addColorStop(0.16, `rgba(0, 0, 0, ${shadingStrength * 0.22})`);
  cylGrad.addColorStop(highlightPos, `rgba(255, 255, 255, ${shadingStrength * 0.12})`);
  cylGrad.addColorStop(0.84, `rgba(0, 0, 0, ${shadingStrength * 0.22})`);
  cylGrad.addColorStop(1, `rgba(0, 0, 0, ${shadingStrength * 0.95})`);
  ctx.fillStyle = cylGrad;
  ctx.fillRect(0, 0, lw, lh);

  // A2. Subtle anatomical vertical chest contour shading for feminine silhouette
  if (isFeminine && !isOversized) {
    const topMidX = (sTL.x + sTR.x) * 0.5;
    const topMidY = (sTL.y + sTR.y) * 0.5;
    const botMidX = (sBL.x + sBR.x) * 0.5;
    const botMidY = (sBL.y + sBR.y) * 0.5;
    const vGrad = ctx.createLinearGradient(topMidX, topMidY, botMidX, botMidY);
    vGrad.addColorStop(0.0, 'rgba(0, 0, 0, 0)');
    vGrad.addColorStop(0.27, 'rgba(255, 255, 255, 0.055)');
    vGrad.addColorStop(0.42, 'rgba(0, 0, 0, 0.065)');
    vGrad.addColorStop(0.58, 'rgba(0, 0, 0, 0.025)');
    vGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0.04)');
    ctx.fillStyle = vGrad;
    ctx.fillRect(0, 0, lw, lh);
  }

  // A3. Physical Chin/Collar & Bottom-Hem Contact Ambient Occlusion
  // Makes the neckline sit physically against the wearer's neck instead of looking pasted on!
  const collarCx = (sTL.x + sTR.x) * 0.5 + downX * torsoHeight * 0.07;
  const collarCy = (sTL.y + sTR.y) * 0.5 + downY * torsoHeight * 0.07;
  const collarAoR = Math.max(12, topWidth * 0.24);
  const collarAo = ctx.createRadialGradient(collarCx, collarCy, collarAoR * 0.15, collarCx, collarCy, collarAoR);
  collarAo.addColorStop(0, 'rgba(0, 0, 0, 0.16)');
  collarAo.addColorStop(0.6, 'rgba(0, 0, 0, 0.05)');
  collarAo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = collarAo;
  ctx.fillRect(0, 0, lw, lh);

  // B. Low-Frequency Room Lighting Transfer
  // Downsample webcam to 24x14 so ONLY broad room light/shadow gradients transfer
  // (never bleeds patterns, logos, or texture from the user's real clothes onto the tee!)
  if (video && videoTransform) {
    const LM_W = 24;
    const LM_H = 14;
    const { canvas: lightMap, ctx: lCtx } = ensureLightMap(LM_W, LM_H);
    lCtx.clearRect(0, 0, LM_W, LM_H);
    lCtx.save();
    lCtx.translate(LM_W, 0);
    lCtx.scale(-1, 1);
    lCtx.drawImage(
      video,
      (videoTransform.offsetX / cw) * LM_W,
      (videoTransform.offsetY / ch) * LM_H,
      (videoTransform.drawW / cw) * LM_W,
      (videoTransform.drawH / ch) * LM_H
    );
    lCtx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.16;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(lightMap, 0, 0, lw, lh);
    ctx.restore();
  }

  // C. Organic Diffused Cloth Fold Shading (rendered to a tiny 48x48 map & upscaled smoothly
  // so folds appear as soft volumetric cotton shadows instead of hard drawn lines).
  // Only activates during real arm lift, torso twist, or side lean so static shots stay 100% pure!
  if (enableWrinklePhysics) {
    const leanAmount = Math.max(0, Math.abs(sideCompression) - 0.12);
    const twistAmount = Math.max(0, Math.abs(yaw) - 0.12);
    const hasDynamicFolds =
      leftArmLift > 0.12 || rightArmLift > 0.12 || leanAmount > 0.02 || twistAmount > 0.02;

    if (hasDynamicFolds) {
      const FM_W = 48;
      const FM_H = 48;
      const { canvas: foldMap, ctx: fCtx } = ensureFoldMap(FM_W, FM_H);
      fCtx.clearRect(0, 0, FM_W, FM_H);

      const ptF = (u, v) => {
        const tx = sTL.x + (sTR.x - sTL.x) * u;
        const ty = sTL.y + (sTR.y - sTL.y) * u;
        const bx = sBL.x + (sBR.x - sBL.x) * u;
        const by = sBL.y + (sBR.y - sBL.y) * u;
        return {
          x: ((tx + (bx - tx) * v) / lw) * FM_W,
          y: ((ty + (by - ty) * v) / lh) * FM_H,
        };
      };
      const foldW = Math.max(1.4, (topWidth / lw) * FM_W * 0.065);

      // 1. Subtle diagonal armpit tension folds when raising LEFT arm
      if (leftArmLift > 0.18) {
        const strength = (leftArmLift - 0.18) * 0.10;
        const pA = ptF(0.24, 0.30);
        const pB = ptF(0.46, 0.50);
        const pC = ptF(0.35, 0.42);
        paintDiffusedFold(fCtx, pA.x, pA.y, pC.x, pC.y, pB.x, pB.y, foldW, strength);
      }

      // 2. Subtle diagonal armpit tension folds when raising RIGHT arm
      if (rightArmLift > 0.18) {
        const strength = (rightArmLift - 0.18) * 0.10;
        const pA = ptF(0.76, 0.30);
        const pB = ptF(0.54, 0.50);
        const pC = ptF(0.65, 0.42);
        paintDiffusedFold(fCtx, pA.x, pA.y, pC.x, pC.y, pB.x, pB.y, foldW, strength);
      }

      // 3. Soft waist compression folds ONLY when actively leaning or twisting torso
      const waistStrength = Math.min(0.20, leanAmount * 0.22 + twistAmount * 0.15);
      if (waistStrength > 0.015) {
        const compressedLeft = sideCompression > 0 || yaw > 0.05;
        const uStart = compressedLeft ? 0.24 : 0.76;
        const uEnd = compressedLeft ? 0.54 : 0.46;
        [0.64, 0.78].forEach((vPos, idx) => {
          const w0 = ptF(uStart, vPos);
          const w1 = ptF(uEnd, vPos + (idx === 0 ? 0.03 : -0.02));
          const wc = ptF((uStart + uEnd) * 0.5, vPos + 0.035);
          paintDiffusedFold(fCtx, w0.x, w0.y, wc.x, wc.y, w1.x, w1.y, foldW * 0.95, waistStrength);
        });
      }

      // Composite smoothly upscaled fold map strictly inside the garment alpha
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(foldMap, 0, 0, lw, lh);
      ctx.restore();
    }
  }

  // D. True Room White-Balance Color Grading (matches warm/cool room lighting without washing out blacks)
  if (ambientTint) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = `rgba(${ambientTint.r}, ${ambientTint.g}, ${ambientTint.b}, 0.11)`;
    ctx.fillRect(0, 0, lw, lh);
  }
  ctx.restore();

  // E. SAFE PERSON SILHOUETTE CLIPPING:
  // Clip outer sleeves/edges to personMask (slightly expanded +3% for Oversized so it drapes
  // loosely without sticking out like stiff triangles into the background wall!), while ALWAYS
  // keeping the inner chest/belly core solid so bright windows never punch holes.
  if (personMask && videoTransform) {
    const { canvas: clipC, ctx: clipCtx } = ensureOcclusionCanvas(lw, lh);
    clipCtx.clearRect(0, 0, lw, lh);
    clipCtx.save();
    if (!lowPowerMode) {
      clipCtx.filter = 'blur(1.2px)';
    }
    clipCtx.translate(lw, 0);
    clipCtx.scale(-1, 1);
    if (isOversized && leftArmLift < 0.25 && rightArmLift < 0.25) {
      // Gently expand mask by 3% around body center so oversized drop-shoulders stay relaxed but never float
      const exp = 1.03;
      const cxMask = videoTransform.offsetX * SCALE + videoTransform.drawW * SCALE * 0.5;
      const cyMask = videoTransform.offsetY * SCALE + videoTransform.drawH * SCALE * 0.5;
      clipCtx.translate(cxMask, cyMask);
      clipCtx.scale(exp, exp);
      clipCtx.translate(-cxMask, -cyMask);
    }
    clipCtx.drawImage(
      personMask,
      videoTransform.offsetX * SCALE,
      videoTransform.offsetY * SCALE,
      videoTransform.drawW * SCALE,
      videoTransform.drawH * SCALE
    );
    clipCtx.restore();

    // Paint solid inner chest/stomach core (starting BELOW the sloping shoulders at v=0.26!)
    // so the shoulders follow personMask smoothly (zero rectangular corners!) while the chest/belly NEVER gets holes.
    const ptQ = (u, v) => {
      const tx = sTL.x + (sTR.x - sTL.x) * u;
      const ty = sTL.y + (sTR.y - sTL.y) * u;
      const bx = sBL.x + (sBR.x - sBL.x) * u;
      const by = sBL.y + (sBR.y - sBL.y) * u;
      return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
    };
    const coreTL = ptQ(0.27, 0.26);
    const coreTR = ptQ(0.73, 0.26);
    const coreBR = ptQ(0.76, 0.94);
    const coreBL = ptQ(0.24, 0.94);
    clipCtx.save();
    clipCtx.fillStyle = '#ffffff';
    clipCtx.beginPath();
    clipCtx.moveTo(coreTL.x, coreTL.y);
    clipCtx.lineTo(coreTR.x, coreTR.y);
    clipCtx.lineTo(coreBR.x, coreBR.y);
    clipCtx.lineTo(coreBL.x, coreBL.y);
    clipCtx.closePath();
    clipCtx.fill();
    clipCtx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(clipC, 0, 0, lw, lh);
    ctx.restore();
  }

  // Composite finished garment layer onto live webcam canvas with subtle physical contact drop-shadow
  const autoLumFactor = ambientTint
    ? Math.max(0.88, Math.min(1.06, 0.78 + (ambientTint.lum / 255) * 0.42))
    : 1;
  const effectiveBrightness = Math.round(brightness * autoLumFactor);

  mainCtx.save();
  mainCtx.globalAlpha = blendAlpha / 100;
  mainCtx.imageSmoothingEnabled = true;
  mainCtx.imageSmoothingQuality = 'high';
  if (effectiveBrightness !== 100) {
    mainCtx.filter = `brightness(${effectiveBrightness}%)`;
  }
  mainCtx.drawImage(layer, 0, 0, cw, ch);
  mainCtx.restore();
}

/**
 * Pixel-Accurate Foreground Body & Skin-Refined Hand Occlusion:
 * 1. Smoothly interpolated Head/Neck/Hair collar scoop (zero jump during Front -> Side -> Back turns)
 * 2. Live Face-Calibrated YCbCr Skin Segmentation inside each foreground arm/hand corridor:
 *    - Reveals pixel-exact spread fingers, thumbs, palms, wrists, and forearms in Front View
 *    - In Side View, cleanly reveals the near arm emerging out of the T-shirt sleeve!
 *    - Zero patches of underlying clothes or background wall leak around the hand!
 */
export function drawForegroundBodyOcclusion(
  mainCtx,
  video,
  videoTransform,
  landmarksCanvas,
  personMask = null
) {
  const { cw, ch, offsetX, offsetY, drawW, drawH } = videoTransform;
  const {
    nose,
    leftShoulder,
    rightShoulder,
    leftArm,
    rightArm,
    shoulderWidth,
    sideBlend = 0,
    backBlend = 0,
    skinTone = null,
  } = landmarksCanvas;

  const { canvas: occCanvas, ctx: oCtx } = ensureOcclusionCanvas(cw, ch);
  oCtx.clearRect(0, 0, cw, ch);

  // --- PART 1: Smoothly Interpolated Head, Neck, Chin & Hair Collar Scoop ---
  if (nose && leftShoulder && rightShoulder) {
    const shMidX = (leftShoulder.x + rightShoulder.x) * 0.5;
    const shMidY = (leftShoulder.y + rightShoulder.y) * 0.5;

    // Smoothly blend scoop center, width, and height from Front -> Side -> Back (zero snap!)
    // Kept tight inside the neckline hole so the T-shirt's real ribbed crew-neck collar stays 100% intact!
    const neckCenterX = shMidX + (nose.x - shMidX) * (sideBlend * 0.48);
    const frontHalfW = shoulderWidth * 0.19;
    const sideHalfW = shoulderWidth * 0.13;
    const backHalfW = shoulderWidth * 0.18;
    const baseHalfW = frontHalfW * (1 - backBlend) + backHalfW * backBlend;
    const neckHalfW = baseHalfW * (1 - sideBlend) + sideHalfW * sideBlend;

    const frontScoopY = shMidY - shoulderWidth * 0.10;
    const backScoopY = shMidY - shoulderWidth * 0.19;
    const sideScoopY = shMidY - shoulderWidth * 0.20;
    const baseScoopY = frontScoopY * (1 - backBlend) + backScoopY * backBlend;
    const collarY = baseScoopY * (1 - sideBlend) + sideScoopY * sideBlend;
    const dipDepth = shoulderWidth * (0.065 * (1 - Math.max(sideBlend, backBlend)) + 0.03);

    oCtx.save();
    oCtx.filter = 'blur(1.6px)';
    oCtx.fillStyle = '#ffffff';
    // Keep outer head canopy strictly ABOVE the shoulders (at jaw/chin level) so it NEVER
    // exposes bare upper shoulders, while dipping ONLY down the center neck into the collar hole!
    const jawY = Math.min(collarY - shoulderWidth * 0.14, nose.y + (shMidY - nose.y) * 0.44);
    oCtx.beginPath();
    oCtx.moveTo(0, 0);
    oCtx.lineTo(cw, 0);
    oCtx.lineTo(cw, jawY);
    oCtx.lineTo(neckCenterX + neckHalfW * 1.12, jawY);
    oCtx.lineTo(neckCenterX + neckHalfW * 0.96, collarY - shoulderWidth * 0.02);
    oCtx.quadraticCurveTo(
      neckCenterX,
      collarY + dipDepth,
      neckCenterX - neckHalfW * 0.96,
      collarY - shoulderWidth * 0.02
    );
    oCtx.lineTo(neckCenterX - neckHalfW * 1.12, jawY);
    oCtx.lineTo(0, jawY);
    oCtx.closePath();
    oCtx.fill();
    oCtx.restore();
  }

  // --- PART 2: Skin-Refined Pixel-Accurate Hands, Fingers & Side-View Near Arm ---
  const activeArms = [leftArm, rightArm].filter((a) => a && a.inFront && a.wrist);
  if (activeArms.length > 0) {
    const HSCALE = 0.5;
    const hw = Math.max(64, Math.round(cw * HSCALE));
    const hh = Math.max(64, Math.round(ch * HSCALE));
    const {
      corridorCanvas,
      corridorCtx,
      coreCtx,
      videoCtx,
    } = ensureHalfResArmCanvases(hw, hh);

    corridorCtx.clearRect(0, 0, hw, hh);
    coreCtx.clearRect(0, 0, hw, hh);

    let minX = hw, minY = hh, maxX = 0, maxY = 0;
    const expandBox = (px, py, pad) => {
      minX = Math.max(0, Math.min(minX, Math.floor(px - pad)));
      minY = Math.max(0, Math.min(minY, Math.floor(py - pad)));
      maxX = Math.min(hw - 1, Math.max(maxX, Math.ceil(px + pad)));
      maxY = Math.min(hh - 1, Math.max(maxY, Math.ceil(py + pad)));
    };

    const sPt = (pt) => (pt ? { x: pt.x * HSCALE, y: pt.y * HSCALE, v: pt.v ?? 1 } : null);
    const extendPt = (pFrom, pTo, factor) => ({
      x: pFrom.x + (pTo.x - pFrom.x) * factor,
      y: pFrom.y + (pTo.y - pFrom.y) * factor,
    });

    const paintSeg = (targetCtx, pA, pB, radius) => {
      if (!pA || !pB) return;
      targetCtx.lineWidth = radius * 2;
      targetCtx.beginPath();
      targetCtx.moveTo(pA.x, pA.y);
      targetCtx.lineTo(pB.x, pB.y);
      targetCtx.stroke();
      expandBox(pA.x, pA.y, radius + 4);
      expandBox(pB.x, pB.y, radius + 4);
    };

    corridorCtx.save();
    corridorCtx.fillStyle = '#ffffff';
    corridorCtx.strokeStyle = '#ffffff';
    corridorCtx.lineCap = 'round';
    corridorCtx.lineJoin = 'round';

    coreCtx.save();
    coreCtx.fillStyle = '#ffffff';
    coreCtx.strokeStyle = '#ffffff';
    coreCtx.lineCap = 'round';
    coreCtx.lineJoin = 'round';

    const baseForearmR = Math.max(7, shoulderWidth * 0.125 * HSCALE);
    const baseFingerR = Math.max(6, shoulderWidth * 0.088 * HSCALE);

    for (const arm of activeArms) {
      const sh = sPt(arm.shoulder);
      const el = sPt(arm.elbow);
      const wr = sPt(arm.wrist);
      const pk = sPt(arm.pinky);
      const ix = sPt(arm.index);
      const th = sPt(arm.thumb);
      const isSideNear = Boolean(arm.isSideNearArm);

      // 1. Forearm & Side-View Lower Bicep (starts cleanly BELOW the T-shirt sleeve hem!)
      if (isSideNear && sh && el) {
        // In side view, T-shirt sleeve covers shoulder -> 52% down bicep; arm emerges below sleeve!
        const sleeveExit = {
          x: sh.x * 0.46 + el.x * 0.54,
          y: sh.y * 0.46 + el.y * 0.54,
        };
        paintSeg(corridorCtx, sleeveExit, el, baseForearmR * 1.45);
        paintSeg(coreCtx, sleeveExit, el, baseForearmR * 0.62);
        paintSeg(corridorCtx, el, wr, baseForearmR * 1.40);
        paintSeg(coreCtx, el, wr, baseForearmR * 0.58);
      } else if (el && el.v > 0.25) {
        const startPt = arm.elbowInFront
          ? el
          : { x: el.x * 0.85 + wr.x * 0.15, y: el.y * 0.85 + wr.y * 0.15 };
        paintSeg(corridorCtx, startPt, wr, baseForearmR * 1.45);
        paintSeg(coreCtx, startPt, wr, baseForearmR * 0.52);

        if (arm.elbowInFront && sh) {
          const midUpper = { x: sh.x * 0.38 + el.x * 0.62, y: sh.y * 0.38 + el.y * 0.62 };
          paintSeg(corridorCtx, midUpper, el, baseForearmR * 1.35);
          paintSeg(coreCtx, midUpper, el, baseForearmR * 0.52);
        }
      } else {
        const fbEl = { x: wr.x, y: wr.y + shoulderWidth * 0.55 * HSCALE };
        paintSeg(corridorCtx, fbEl, wr, baseForearmR * 1.35);
        paintSeg(coreCtx, fbEl, wr, baseForearmR * 0.50);
      }

      // 2. Generous Hand & Spread-Fingers Corridor (skin classifier refines exact finger outlines!)
      const hasIx = ix && ix.v > 0.18;
      const hasPk = pk && pk.v > 0.18;
      const hasTh = th && th.v > 0.18;

      if (hasIx || hasPk || hasTh) {
        const tipIx = hasIx ? extendPt(wr, ix, 1.72) : null;
        const tipPk = hasPk ? extendPt(wr, pk, 1.68) : null;
        const tipTh = hasTh ? extendPt(wr, th, 1.55) : null;

        if (tipIx) {
          paintSeg(corridorCtx, wr, tipIx, baseFingerR * 1.55);
          paintSeg(coreCtx, wr, ix, baseFingerR * 0.55);
        }
        if (tipPk) {
          paintSeg(corridorCtx, wr, tipPk, baseFingerR * 1.45);
          paintSeg(coreCtx, wr, pk, baseFingerR * 0.50);
        }
        if (tipTh) {
          paintSeg(corridorCtx, wr, tipTh, baseFingerR * 1.40);
          paintSeg(coreCtx, wr, th, baseFingerR * 0.45);
        }
        if (tipIx && tipPk) {
          paintSeg(corridorCtx, tipIx, tipPk, baseFingerR * 1.35);
          corridorCtx.beginPath();
          corridorCtx.moveTo(wr.x, wr.y);
          if (tipTh) corridorCtx.lineTo(tipTh.x, tipTh.y);
          corridorCtx.lineTo(tipIx.x, tipIx.y);
          corridorCtx.lineTo(tipPk.x, tipPk.y);
          corridorCtx.closePath();
          corridorCtx.fill();

          // Tight palm core (keeps palm solid even in deep shadow)
          const palmCx = (wr.x + ix.x + pk.x) / 3;
          const palmCy = (wr.y + ix.y + pk.y) / 3;
          coreCtx.beginPath();
          coreCtx.arc(palmCx, palmCy, baseFingerR * 0.72, 0, Math.PI * 2);
          coreCtx.fill();
        }
      } else {
        corridorCtx.beginPath();
        corridorCtx.arc(wr.x, wr.y, baseForearmR * 1.55, 0, Math.PI * 2);
        corridorCtx.fill();
        expandBox(wr.x, wr.y, baseForearmR * 1.6 + 4);
      }
    }

    corridorCtx.restore();
    coreCtx.restore();

    // Refine corridor pixels with Live Face-Calibrated YCbCr Skin Segmentation (only inside bounding box!)
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw > 2 && bh > 2 && skinTone) {
      videoCtx.save();
      videoCtx.clearRect(minX, minY, bw, bh);
      videoCtx.translate(hw, 0);
      videoCtx.scale(-1, 1);
      videoCtx.drawImage(
        video,
        offsetX * HSCALE,
        offsetY * HSCALE,
        drawW * HSCALE,
        drawH * HSCALE
      );
      videoCtx.restore();

      const corrData = corridorCtx.getImageData(minX, minY, bw, bh);
      const coreData = coreCtx.getImageData(minX, minY, bw, bh).data;
      const vidData = videoCtx.getImageData(minX, minY, bw, bh).data;
      const cPixels = corrData.data;

      const sY = skinTone.y;
      const sCb = skinTone.cb;
      const sCr = skinTone.cr;

      for (let i = 0; i < cPixels.length; i += 4) {
        const corrA = cPixels[i + 3];
        if (corrA === 0) continue;

        const coreA = coreData[i + 3];
        const r = vidData[i];
        const g = vidData[i + 1];
        const b = vidData[i + 2];

        // BT.601 RGB -> YCbCr
        const py = 0.299 * r + 0.587 * g + 0.114 * b;
        const pCb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const pCr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        const dCb = (pCb - sCb) / 14.5;
        const dCr = (pCr - sCr) / 14.5;
        const dY = (py - sY) / 80.0;
        const dist = Math.sqrt(dCb * dCb + dCr * dCr + dY * dY * 0.35);

        let skinA = 0;
        if (dist <= 1.0) {
          skinA = 255;
        } else if (dist < 1.55) {
          skinA = Math.round(((1.55 - dist) / 0.55) * 255);
        }

        // Preserve pixel-accurate skin fingers/forearm + tight core for watches/sleeves
        const refinedA = Math.max(coreA, Math.round((corrA * skinA) / 255));
        cPixels[i + 3] = refinedA;
      }

      corridorCtx.putImageData(corrData, minX, minY);
    }

    // Merge skin-refined arm/hand mask onto the main occlusion mask with subtle anti-alias blur
    oCtx.save();
    oCtx.filter = 'blur(1.2px)';
    oCtx.drawImage(corridorCanvas, 0, 0, cw, ch);
    oCtx.restore();
  }

  // Step 2: Intersect with MediaPipe's real person silhouette mask so background wall NEVER bleeds over the tee
  if (personMask) {
    oCtx.save();
    oCtx.globalCompositeOperation = 'destination-in';
    oCtx.translate(cw, 0);
    oCtx.scale(-1, 1);
    oCtx.drawImage(personMask, offsetX, offsetY, drawW, drawH);
    oCtx.restore();
  }

  // Step 3: Fill the exact foreground silhouette with the live mirrored webcam video
  oCtx.save();
  oCtx.globalCompositeOperation = 'source-in';
  oCtx.translate(cw, 0);
  oCtx.scale(-1, 1);
  oCtx.drawImage(video, offsetX, offsetY, drawW, drawH);
  oCtx.restore();

  // Step 4: Composite cleanly on top of the T-shirt
  mainCtx.save();
  mainCtx.drawImage(occCanvas, 0, 0);
  mainCtx.restore();
}
