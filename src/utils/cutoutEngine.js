/**
 * FitDrop Cutout Engine (100% Free, Client-Side)
 * 1. Auto AI Cutout: @imgly/background-removal (ONNX/WASM in browser)
 * 2. Instant Light-BG Cutout: Border flood-fill background remover (~0.3s)
 * 3. Smart Model-Shoot Extractor: Detects if an uploaded online-store photo is a model shoot
 *    and automatically strips the model's head, neck, bare arms, hands, and pants/legs!
 */

import { detectPoseInImage } from './poseEngine';
import { extractGarmentWithSegFormer } from './garmentExtractor';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Trims all empty transparent pixels around the garment so width/height/collar
 * mapping in the AR Try-On engine is exact and predictable.
 */
async function trimTransparentBounds(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found || maxX <= minX || maxY <= minY) {
    return dataUrl;
  }

  // Add a tiny 4px breathing padding
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = cropW;
  outCanvas.height = cropH;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

  return outCanvas.toDataURL('image/png');
}

/**
 * Fast 0.5-second border flood-fill cutout for light/plain walls.
 * Starts from the 4 edges/corners so white prints INSIDE the T-shirt stay untouched!
 */
export async function instantLightBgCutout(imageSrc, onProgress, skipTrim = false) {
  onProgress?.(25, 'Sampling wall background...');
  const img = await loadImage(imageSrc);

  // Keep high resolution (up to 1280px) so prints and cotton texture stay razor-sharp
  const maxDim = 1280;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Sample average background color from border pixels
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 40));
  for (let x = 0; x < w; x += sampleStep) {
    for (const y of [2, h - 3]) {
      const idx = (y * w + x) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
  }
  for (let y = 0; y < h; y += sampleStep) {
    for (const x of [2, w - 3]) {
      const idx = (y * w + x) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
  }

  const bgR = rSum / count;
  const bgG = gSum / count;
  const bgB = bSum / count;

  onProgress?.(60, 'Removing wall & background...');

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  // Threshold tuned for phone photos on plain/white walls with soft shadows
  const colorTol = 46;
  const isBgPixel = (idx) => {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const dist = Math.sqrt(
      (r - bgR) * (r - bgR) + (g - bgG) * (g - bgG) + (b - bgB) * (b - bgB)
    );
    return dist <= colorTol;
  };

  // Seed BFS from all 4 image borders
  const enqueue = (x, y) => {
    const pos = y * w + x;
    if (visited[pos]) return;
    if (isBgPixel(pos * 4)) {
      visited[pos] = 1;
      queue[tail++] = pos;
    }
  };

  for (let x = 0; x < w; x++) {
    enqueue(x, 0);
    enqueue(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    enqueue(0, y);
    enqueue(w - 1, y);
  }

  // 4-neighbor BFS flood fill
  while (head < tail) {
    const pos = queue[head++];
    data[pos * 4 + 3] = 0; // Make transparent

    const x = pos % w;
    const y = (pos - x) / w;

    if (x > 0) enqueue(x - 1, y);
    if (x < w - 1) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y < h - 1) enqueue(x, y + 1);
  }

  // De-fringe 1px white studio halo on silhouette edge so dark tees have razor-clean edges
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const pos = y * w + x;
      if (!visited[pos]) {
        const bgNeighbors =
          visited[pos - 1] + visited[pos + 1] + visited[pos - w] + visited[pos + w];
        if (bgNeighbors >= 1) {
          const idx = pos * 4;
          const distToBg = Math.sqrt(
            (data[idx] - bgR) ** 2 + (data[idx + 1] - bgG) ** 2 + (data[idx + 2] - bgB) ** 2
          );
          if (distToBg < colorTol * 1.95 || bgNeighbors >= 3) {
            // Strip anti-aliased white/light background fringe pixels completely
            data[idx + 3] = 0;
          } else if (bgNeighbors === 2) {
            data[idx + 3] = 175;
          }
        }
      }
    }
  }

  // Keep ONLY the largest connected garment component!
  // Automatically strips stray website UI thumbnails, < > carousel arrows, and X buttons from store screenshots!
  const labels = new Int32Array(w * h);
  const compQueue = new Int32Array(w * h);
  let curLabel = 0;
  let bestLabel = 0;
  let bestSize = 0;
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== 0 || data[i * 4 + 3] < 40) continue;
    curLabel++;
    let cHead = 0;
    let cTail = 0;
    labels[i] = curLabel;
    compQueue[cTail++] = i;
    while (cHead < cTail) {
      const pos = compQueue[cHead++];
      const x = pos % w;
      const y = (pos - x) / w;
      if (x > 0 && labels[pos - 1] === 0 && data[(pos - 1) * 4 + 3] >= 40) {
        labels[pos - 1] = curLabel;
        compQueue[cTail++] = pos - 1;
      }
      if (x < w - 1 && labels[pos + 1] === 0 && data[(pos + 1) * 4 + 3] >= 40) {
        labels[pos + 1] = curLabel;
        compQueue[cTail++] = pos + 1;
      }
      if (y > 0 && labels[pos - w] === 0 && data[(pos - w) * 4 + 3] >= 40) {
        labels[pos - w] = curLabel;
        compQueue[cTail++] = pos - w;
      }
      if (y < h - 1 && labels[pos + w] === 0 && data[(pos + w) * 4 + 3] >= 40) {
        labels[pos + w] = curLabel;
        compQueue[cTail++] = pos + w;
      }
    }
    if (cTail > bestSize) {
      bestSize = cTail;
      bestLabel = curLabel;
    }
  }
  if (bestLabel > 0 && bestSize > w * h * 0.04) {
    for (let i = 0; i < w * h; i++) {
      if (labels[i] !== bestLabel) data[i * 4 + 3] = 0;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  onProgress?.(90, 'Trimming garment bounds...');

  const rawUrl = canvas.toDataURL('image/png');
  return skipTrim ? rawUrl : trimTransparentBounds(rawUrl);
}

/**
 * Synthesizes a clean, authentic plain-cotton BACK view from a front T-shirt cutout PNG.
 * - Samples the garment's real cotton base color from the clean margins (avoiding front prints)
 * - Smoothly replaces the center graphic print area with matching cotton fabric + subtle weave
 * - Raises the front neckline scoop into a realistic higher crew-neck back collar
 */
export async function generatePlainBackCutout(frontPngUrl) {
  const img = await loadImage(frontPngUrl);
  const w = img.width;
  const h = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // 1. Sample clean fabric pixels from outer/lower regions (avoiding center graphic print)
  const rVals = [];
  const gVals = [];
  const bVals = [];
  const step = Math.max(2, Math.floor(Math.min(w, h) / 70));

  for (let y = Math.floor(h * 0.12); y < Math.floor(h * 0.92); y += step) {
    for (let x = Math.floor(w * 0.08); x < Math.floor(w * 0.92); x += step) {
      const inPrintBox =
        x > w * 0.24 && x < w * 0.76 && y > h * 0.16 && y < h * 0.74;
      if (inPrintBox) continue;

      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 235) {
        rVals.push(data[idx]);
        gVals.push(data[idx + 1]);
        bVals.push(data[idx + 2]);
      }
    }
  }

  // Median RGB is robust against any sleeve logo or shadow outlier
  const median = (arr, fallback) => {
    if (!arr.length) return fallback;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.5)];
  };

  const baseR = median(rVals, 230);
  const baseG = median(gVals, 226);
  const baseB = median(bVals, 218);

  // 2. Fill ONLY the inner front neckline dip into a smooth, natural higher crew-neck back collar
  // Scan down from the top to find the exact real left & right collar shoulder edges so ZERO corners stick out!
  const findTopY = (normX) => {
    const px = Math.max(0, Math.min(w - 1, Math.round(w * normX)));
    for (let y = 0; y < Math.floor(h * 0.45); y++) {
      if (data[(y * w + px) * 4 + 3] > 200) return y;
    }
    return Math.round(h * 0.08);
  };

  const leftCollarX = w * 0.35;
  const rightCollarX = w * 0.65;
  const leftCollarY = findTopY(0.35);
  const rightCollarY = findTopY(0.65);
  const midCollarY = Math.max(leftCollarY, rightCollarY) + h * 0.025;

  ctx.save();
  ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
  ctx.beginPath();
  ctx.moveTo(leftCollarX, leftCollarY + 2);
  ctx.quadraticCurveTo(w * 0.50, midCollarY, rightCollarX, rightCollarY + 2);
  ctx.lineTo(rightCollarX + w * 0.02, h * 0.22);
  ctx.lineTo(leftCollarX - w * 0.02, h * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 3. Smoothly paint out the front graphic print region inside the garment silhouette
  // using a feathered radial-shaded cotton fill so sleeves, edges & hem folds stay 100% real!
  const maskC = document.createElement('canvas');
  maskC.width = w;
  maskC.height = h;
  const mCtx = maskC.getContext('2d');

  // Softly fill center chest print zone with slight natural back-of-shirt vertical shading
  const backGrad = mCtx.createLinearGradient(0, h * 0.08, 0, h * 0.85);
  const lightR = Math.min(255, Math.round(baseR * 1.03));
  const lightG = Math.min(255, Math.round(baseG * 1.03));
  const lightB = Math.min(255, Math.round(baseB * 1.03));
  const shadeR = Math.max(0, Math.round(baseR * 0.93));
  const shadeG = Math.max(0, Math.round(baseG * 0.93));
  const shadeB = Math.max(0, Math.round(baseB * 0.93));
  backGrad.addColorStop(0, `rgb(${lightR}, ${lightG}, ${lightB})`);
  backGrad.addColorStop(0.55, `rgb(${baseR}, ${baseG}, ${baseB})`);
  backGrad.addColorStop(1, `rgb(${shadeR}, ${shadeG}, ${shadeB})`);

  mCtx.filter = `blur(${Math.max(12, Math.round(w * 0.032))}px)`;
  mCtx.fillStyle = backGrad;
  mCtx.beginPath();
  mCtx.roundRect(w * 0.21, h * 0.12, w * 0.58, h * 0.68, w * 0.08);
  mCtx.fill();
  mCtx.filter = 'none';

  // Composite the clean plain fabric strictly inside the T-shirt alpha
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.drawImage(maskC, 0, 0);
  ctx.restore();

  return canvas.toDataURL('image/png');
}

/**
 * Post-processes user-uploaded T-shirt cutouts to automatically remove:
 * 1. Protruding hanger hooks sticking above the collar
 * 2. Hands/fingers gripping the shoulders or outer edges when holding a T-shirt up for a photo
 * Then re-trims transparent bounds so the garment is perfectly centered.
 */
async function cleanUploadedGarmentCutout(dataUrl) {
  const trimmedUrl = await trimTransparentBounds(dataUrl);
  const img = await loadImage(trimmedUrl);
  const w = img.width;
  const h = img.height;
  if (w < 20 || h < 20) return trimmedUrl;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // 1. Strip thin protruding hanger hooks at the very top (y < 14% where opaque span < 22% width)
  const topLimit = Math.floor(h * 0.14);
  for (let y = 0; y < topLimit; y++) {
    let rowOpaque = 0;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 40) rowOpaque++;
    }
    if (rowOpaque > 0 && rowOpaque < w * 0.22) {
      for (let x = 0; x < w; x++) {
        data[(y * w + x) * 4 + 3] = 0;
      }
    }
  }

  // 2. Check if the T-shirt's own base fabric is skin-colored (avoid erasing peach/tan tees!)
  const isSkinRGB = (r, g, b) => {
    const py = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return py > 42 && py < 240 && cb >= 76 && cb <= 128 && cr >= 132 && cr <= 176;
  };

  let fabricSamples = 0;
  let fabricSkinHits = 0;
  const step = Math.max(2, Math.floor(Math.min(w, h) / 60));
  for (let y = Math.floor(h * 0.42); y < Math.floor(h * 0.78); y += step) {
    for (let x = Math.floor(w * 0.32); x < Math.floor(w * 0.68); x += step) {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 200) {
        fabricSamples++;
        if (isSkinRGB(data[idx], data[idx + 1], data[idx + 2])) fabricSkinHits++;
      }
    }
  }
  const teeItselfIsSkinToned = fabricSamples > 0 && fabricSkinHits / fabricSamples > 0.35;

  // 3. If tee is NOT skin-toned, flood-remove boundary-connected hands/fingers holding the shoulders/edges
  if (!teeItselfIsSkinToned) {
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;

    const inHoldingZone = (x, y) =>
      y < h * 0.44 || x < w * 0.24 || x > w * 0.76;

    const tryEnqueue = (x, y) => {
      if (x < 0 || x >= w || y < 0 || y >= h) return;
      const pos = y * w + x;
      if (visited[pos]) return;
      if (!inHoldingZone(x, y)) return;
      const idx = pos * 4;
      if (data[idx + 3] < 30) return;
      if (isSkinRGB(data[idx], data[idx + 1], data[idx + 2])) {
        visited[pos] = 1;
        queue[tail++] = pos;
      }
    };

    // Seed from opaque skin pixels touching transparency or image border in the holding zones
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inHoldingZone(x, y)) continue;
        const pos = y * w + x;
        if (data[pos * 4 + 3] < 30) continue;
        const touchesEdge =
          x === 0 ||
          x === w - 1 ||
          y === 0 ||
          y === h - 1 ||
          data[(pos - 1) * 4 + 3] < 30 ||
          data[(pos + 1) * 4 + 3] < 30 ||
          data[(pos - w) * 4 + 3] < 30 ||
          data[(pos + w) * 4 + 3] < 30;
        if (touchesEdge) {
          tryEnqueue(x, y);
        }
      }
    }

    while (head < tail) {
      const pos = queue[head++];
      data[pos * 4 + 3] = 0;
      const x = pos % w;
      const y = (pos - x) / w;
      tryEnqueue(x - 1, y);
      tryEnqueue(x + 1, y);
      tryEnqueue(x, y - 1);
      tryEnqueue(x, y + 1);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return trimTransparentBounds(canvas.toDataURL('image/png'));
}

/**
 * Surgically extracts ONLY the T-shirt from an online-store MODEL SHOOT photo!
 * Uses MediaPipe Pose landmarks detected on the uploaded photo to:
 * 1. Calibrate the model's skin tone (from face or forearms) & T-shirt fabric color (from belly/chest)
 * 2. Remove the model's head, hair & neck cleanly while preserving the T-shirt's ribbed collar
 * 3. Remove bare forearms, hands & lower arms right up to the real T-shirt sleeve hem
 * 4. Detect the T-shirt bottom hem transition and remove pants/jeans/legs below it
 * 5. Keep ONLY the main connected garment component containing the chest (zero floating debris!)
 */
async function extractShirtFromModelCutout(rawCutoutUrl, landmarks) {
  const img = await loadImage(rawCutoutUrl);
  const w = img.width;
  const h = img.height;

  const lmNose = landmarks[0];
  const lmLS = landmarks[11];
  const lmRS = landmarks[12];
  const lmLE = landmarks[13];
  const lmRE = landmarks[14];
  const lmLW = landmarks[15];
  const lmRW = landmarks[16];
  const lmLH = landmarks[23];
  const lmRH = landmarks[24];

  const pt = (lm) => ({ x: lm.x * w, y: lm.y * h, v: lm.visibility ?? 0 });
  const pNose = pt(lmNose);
  const pLS = pt(lmLS);
  const pRS = pt(lmRS);
  const pLE = pt(lmLE);
  const pRE = pt(lmRE);
  const pLW = pt(lmLW);
  const pRW = pt(lmRW);
  const pLH = pt(lmLH);
  const pRH = pt(lmRH);

  const shMidX = (pLS.x + pRS.x) * 0.5;
  const shMidY = (pLS.y + pRS.y) * 0.5;
  const shoulderW = Math.hypot(pRS.x - pLS.x, pRS.y - pLS.y);
  if (shoulderW < w * 0.12) return null;

  const hipsVis = pLH.v > 0.35 && pRH.v > 0.35;
  const hipMidX = hipsVis ? (pLH.x + pRH.x) * 0.5 : shMidX;
  const hipMidY = hipsVis ? (pLH.y + pRH.y) * 0.5 : shMidY + shoulderW * 1.45;
  const torsoH = Math.max(shoulderW * 1.1, Math.hypot(hipMidX - shMidX, hipMidY - shMidY));
  const isBackView = lmRS.x > lmLS.x;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  const toYCbCr = (r, g, b) => ({
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  });

  // 1. Calibrate the model's exact skin tone from face (front) or forearms (back)
  let sY = 0, sCb = 0, sCr = 0, sCnt = 0;
  const sampleSkinPatch = (cx, cy, rad) => {
    const x0 = Math.max(0, Math.floor(cx - rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const x1 = Math.min(w - 1, Math.ceil(cx + rad));
    const y1 = Math.min(h - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const idx = (y * w + x) * 4;
        if (data[idx + 3] < 200) continue;
        const c = toYCbCr(data[idx], data[idx + 1], data[idx + 2]);
        if (c.y > 40 && c.cb >= 75 && c.cb <= 130 && c.cr >= 130 && c.cr <= 178) {
          sY += c.y;
          sCb += c.cb;
          sCr += c.cr;
          sCnt++;
        }
      }
    }
  };

  if (!isBackView && pNose.v > 0.45) {
    sampleSkinPatch(pNose.x, pNose.y, shoulderW * 0.12);
  }
  if (sCnt < 12 && pLE.v > 0.4 && pLW.v > 0.4) {
    sampleSkinPatch((pLE.x + pLW.x) * 0.5, (pLE.y + pLW.y) * 0.5, shoulderW * 0.09);
  }
  if (sCnt < 12 && pRE.v > 0.4 && pRW.v > 0.4) {
    sampleSkinPatch((pRE.x + pRW.x) * 0.5, (pRE.y + pRW.y) * 0.5, shoulderW * 0.09);
  }

  const hasCalSkin = sCnt >= 8;
  const skinRef = hasCalSkin ? { y: sY / sCnt, cb: sCb / sCnt, cr: sCr / sCnt } : null;

  const isModelSkin = (r, g, b) => {
    const c = toYCbCr(r, g, b);
    if (skinRef) {
      const dCb = (c.cb - skinRef.cb) / 14;
      const dCr = (c.cr - skinRef.cr) / 14;
      const dY = (c.y - skinRef.y) / 72;
      return Math.sqrt(dCb * dCb + dCr * dCr + dY * dY * 0.35) < 1.35;
    }
    return c.y > 45 && c.cb >= 77 && c.cb <= 127 && c.cr >= 133 && c.cr <= 174;
  };

  // 2. Sample the T-shirt's base fabric color from the lower-chest / belly (avoids chest print!)
  const fR = [], fG = [], fB = [];
  let fabricSkinHits = 0;
  const fX0 = Math.max(0, Math.floor(shMidX - shoulderW * 0.28));
  const fX1 = Math.min(w - 1, Math.ceil(shMidX + shoulderW * 0.28));
  const fY0 = Math.max(0, Math.floor(shMidY + torsoH * 0.46));
  const fY1 = Math.min(h - 1, Math.floor(shMidY + torsoH * 0.76));
  for (let y = fY0; y <= fY1; y += 3) {
    for (let x = fX0; x <= fX1; x += 3) {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 220) {
        fR.push(data[idx]);
        fG.push(data[idx + 1]);
        fB.push(data[idx + 2]);
        if (isModelSkin(data[idx], data[idx + 1], data[idx + 2])) fabricSkinHits++;
      }
    }
  }
  const med = (arr, fb) => {
    if (!arr.length) return fb;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.5)];
  };
  const teeR = med(fR, 128);
  const teeG = med(fG, 128);
  const teeB = med(fB, 128);
  const teeIsSkinColored = fR.length > 0 && fabricSkinHits / fR.length > 0.4;

  // 3. Detect the exact T-shirt bottom hem row (where T-shirt color transitions to jeans/pants!)
  let hemY = Math.min(h - 1, Math.round(hipMidY + torsoH * 0.26));
  if (hipsVis && fR.length >= 12) {
    const scanStart = Math.max(0, Math.round(hipMidY - torsoH * 0.08));
    const scanEnd = Math.min(h - 1, Math.round(hipMidY + torsoH * 0.34));
    let nonTeeStreak = 0;
    for (let y = scanStart; y <= scanEnd; y++) {
      let rowOpaque = 0;
      let rowDiff = 0;
      for (let x = fX0; x <= fX1; x += 2) {
        const idx = (y * w + x) * 4;
        if (data[idx + 3] < 160) continue;
        rowOpaque++;
        const dist = Math.sqrt(
          (data[idx] - teeR) ** 2 + (data[idx + 1] - teeG) ** 2 + (data[idx + 2] - teeB) ** 2
        );
        if (dist > 52) rowDiff++;
      }
      if (rowOpaque > 6 && rowDiff / rowOpaque > 0.58) {
        nonTeeStreak++;
        if (nonTeeStreak >= 5) {
          hemY = y - 4;
          break;
        }
      } else {
        nonTeeStreak = 0;
      }
    }
  }

  // 4. Erase Head, Hair & Neck above the collar line + everything below the detected T-shirt hem
  const headCutY = Math.round(shMidY - shoulderW * 0.20);
  const neckDipY = Math.round(shMidY + shoulderW * (isBackView ? -0.02 : 0.16));
  const neckHalfW = shoulderW * 0.30;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] === 0) continue;

      // Hard cut: head/hair above shoulder top & pants/legs below T-shirt hem
      if (y < headCutY || y > hemY) {
        data[idx + 3] = 0;
        continue;
      }

      // Neck scoop zone: erase skin/hair pixels inside the collar opening (keeps ribbed collar intact!)
      if (!teeIsSkinColored && y < neckDipY && Math.abs(x - shMidX) < neckHalfW) {
        if (isModelSkin(data[idx], data[idx + 1], data[idx + 2])) {
          data[idx + 3] = 0;
        }
      }
    }
  }

  // 5. Erase Bare Forearms, Hands & Lower Biceps right up to the real T-shirt sleeve hem!
  const eraseDistToSeg = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax;
    const vy = by - ay;
    const lenSq = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
    return { dist: Math.hypot(px - (ax + t * vx), py - (ay + t * vy)), t };
  };

  const armList = [
    { sh: pLS, el: pLE, wr: pLW },
    { sh: pRS, el: pRE, wr: pRW },
  ];

  const forearmCutR = shoulderW * 0.28;
  const upperArmSkinR = shoulderW * 0.24;

  for (const { sh, el, wr } of armList) {
    if (el.v < 0.3) continue;
    // Extend past wrist to cover hands & fingers completely
    const handEnd =
      wr.v > 0.25
        ? { x: wr.x + (wr.x - el.x) * 0.45, y: wr.y + (wr.y - el.y) * 0.45 }
        : el;

    const minAx = Math.max(0, Math.floor(Math.min(sh.x, el.x, handEnd.x) - forearmCutR));
    const maxAx = Math.min(w - 1, Math.ceil(Math.max(sh.x, el.x, handEnd.x) + forearmCutR));
    const minAy = Math.max(0, Math.floor(Math.min(sh.y, el.y, handEnd.y) - forearmCutR));
    const maxAy = Math.min(h - 1, Math.ceil(Math.max(sh.y, el.y, handEnd.y) + forearmCutR));

    for (let y = minAy; y <= maxAy; y++) {
      for (let x = minAx; x <= maxAx; x++) {
        const idx = (y * w + x) * 4;
        if (data[idx + 3] === 0) continue;

        // Hard-erase forearm & hand (elbow -> fingertips), unless it crosses right over the chest
        if (wr.v > 0.25) {
          const dFore = eraseDistToSeg(x, y, el.x, el.y, handEnd.x, handEnd.y);
          const inChestCore = Math.abs(x - shMidX) < shoulderW * 0.36 && y < hipMidY;
          if (dFore.dist < forearmCutR && (!inChestCore || isModelSkin(data[idx], data[idx + 1], data[idx + 2]))) {
            data[idx + 3] = 0;
            continue;
          }
        }

        // Upper arm (shoulder -> elbow): erase bare skin pixels cleanly up to the sleeve cuff!
        if (!teeIsSkinColored) {
          const dUpper = eraseDistToSeg(x, y, sh.x, sh.y, el.x, el.y);
          if (dUpper.t > 0.28 && dUpper.dist < upperArmSkinR) {
            if (isModelSkin(data[idx], data[idx + 1], data[idx + 2])) {
              data[idx + 3] = 0;
            }
          }
        }
      }
    }
  }

  // 6. Connected-Component Chest Keep: keep ONLY the main T-shirt body connected to chest center!
  // Automatically discards any disconnected hair tips, floating hands, or pant scraps!
  const seedX = Math.max(0, Math.min(w - 1, Math.round(shMidX)));
  const seedY = Math.max(0, Math.min(h - 1, Math.round(shMidY + torsoH * 0.38)));
  let startPos = -1;
  // Find nearest opaque pixel to chest center
  outer: for (let rad = 0; rad < Math.round(shoulderW * 0.35); rad += 2) {
    for (let dy = -rad; dy <= rad; dy += 2) {
      for (let dx = -rad; dx <= rad; dx += 2) {
        const sx = seedX + dx;
        const sy = seedY + dy;
        if (sx >= 0 && sx < w && sy >= 0 && sy < h && data[(sy * w + sx) * 4 + 3] > 60) {
          startPos = sy * w + sx;
          break outer;
        }
      }
    }
  }

  if (startPos >= 0) {
    const keep = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    keep[startPos] = 1;
    queue[tail++] = startPos;

    while (head < tail) {
      const pos = queue[head++];
      const x = pos % w;
      const y = (pos - x) / w;
      if (x > 0 && !keep[pos - 1] && data[(pos - 1) * 4 + 3] > 35) {
        keep[pos - 1] = 1;
        queue[tail++] = pos - 1;
      }
      if (x < w - 1 && !keep[pos + 1] && data[(pos + 1) * 4 + 3] > 35) {
        keep[pos + 1] = 1;
        queue[tail++] = pos + 1;
      }
      if (y > 0 && !keep[pos - w] && data[(pos - w) * 4 + 3] > 35) {
        keep[pos - w] = 1;
        queue[tail++] = pos - w;
      }
      if (y < h - 1 && !keep[pos + w] && data[(pos + w) * 4 + 3] > 35) {
        keep[pos + w] = 1;
        queue[tail++] = pos + w;
      }
    }

    // Only apply connected-component filter if the kept chest component is substantial
    if (tail > w * h * 0.04) {
      for (let i = 0; i < w * h; i++) {
        if (!keep[i]) data[i * 4 + 3] = 0;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);

  // 7. Auto-level tilted model poses so the extracted T-shirt's shoulder seam is perfectly horizontal (0°)!
  const leftSh = pLS.x < pRS.x ? pLS : pRS;
  const rightSh = pLS.x < pRS.x ? pRS : pLS;
  const shTilt = Math.atan2(rightSh.y - leftSh.y, rightSh.x - leftSh.x);

  let finalCanvas = canvas;
  if (Math.abs(shTilt) > 0.025 && Math.abs(shTilt) < 0.35) {
    const levelCanvas = document.createElement('canvas');
    levelCanvas.width = w;
    levelCanvas.height = h;
    const lCtx = levelCanvas.getContext('2d');
    lCtx.imageSmoothingEnabled = true;
    lCtx.imageSmoothingQuality = 'high';
    lCtx.translate(shMidX, shMidY);
    lCtx.rotate(-shTilt);
    lCtx.translate(-shMidX, -shMidY);
    lCtx.drawImage(canvas, 0, 0);
    finalCanvas = levelCanvas;
  }

  // 8. Soft 1px alpha edge anti-aliasing on cut seams (collar, cuffs & hem look studio-clean)
  const fCtx = finalCanvas.getContext('2d', { willReadFrequently: true });
  const fData = fCtx.getImageData(0, 0, w, h);
  const fp = fData.data;
  const alphaCopy = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alphaCopy[i] = fp[i * 4 + 3];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const pos = y * w + x;
      const a = alphaCopy[pos];
      if (a > 20 && a < 245) continue;
      const nSum =
        alphaCopy[pos - 1] +
        alphaCopy[pos + 1] +
        alphaCopy[pos - w] +
        alphaCopy[pos + w];
      if (a >= 245 && nSum < 700) {
        // Gentle edge feather on hard-cut boundary pixels
        fp[pos * 4 + 3] = Math.round((a * 2 + nSum * 0.25) / 3);
      } else if (a <= 20 && nSum > 850) {
        // Fill 1px pinholes inside fabric
        fp[pos * 4 + 3] = 200;
      }
    }
  }
  fCtx.putImageData(fData, 0, 0);

  return trimTransparentBounds(finalCanvas.toDataURL('image/png'));
}

/**
 * Auto-levels a SegFormer-extracted T-shirt cutout if the e-commerce model had tilted shoulders,
 * so the collar and chest graphic sit perfectly straight (0°) during live try-on.
 */
async function autoLevelCutoutWithPose(textureUrl, landmarks) {
  if (!landmarks || !landmarks[11] || !landmarks[12]) return textureUrl;
  const leftSh = landmarks[11].x < landmarks[12].x ? landmarks[11] : landmarks[12];
  const rightSh = landmarks[11].x < landmarks[12].x ? landmarks[12] : landmarks[11];
  const tilt = Math.atan2(rightSh.y - leftSh.y, rightSh.x - leftSh.x);
  if (Math.abs(tilt) < 0.025 || Math.abs(tilt) > 0.35) return textureUrl;

  const img = await loadImage(textureUrl);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width * 0.5, c.height * 0.25);
  ctx.rotate(-tilt);
  ctx.translate(-c.width * 0.5, -c.height * 0.25);
  ctx.drawImage(img, 0, 0);
  return trimTransparentBounds(c.toDataURL('image/png'));
}

/**
 * Checks if an uploaded flat-lay photo has a clean uniform/studio background around its border
 * (e.g. e-commerce product photo or screenshot on white/light-grey background).
 */
async function hasCleanUniformBackground(imageSrc) {
  try {
    const img = await loadImage(imageSrc);
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 96, 96);
    const d = ctx.getImageData(0, 0, 96, 96).data;

    // Sample right, top, and bottom borders (skipping left edge in case of e-commerce thumbnail strip!)
    const samples = [];
    for (let x = 16; x < 92; x += 4) {
      for (const y of [2, 93]) {
        const idx = (y * 96 + x) * 4;
        samples.push([d[idx], d[idx + 1], d[idx + 2]]);
      }
    }
    for (let y = 12; y < 86; y += 4) {
      const idx = (y * 96 + 93) * 4;
      samples.push([d[idx], d[idx + 1], d[idx + 2]]);
    }
    const mean = [0, 1, 2].map((k) => samples.reduce((s, p) => s + p[k], 0) / samples.length);
    let closeCount = 0;
    for (const p of samples) {
      const dist = Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]);
      if (dist < 28) closeCount++;
    }
    return closeCount / samples.length > 0.82;
  } catch {
    return false;
  }
}

/**
 * Smart Hybrid AI Garment Extraction:
 * 1. E-Commerce MODEL SHOOT detected -> SegFormer-B2-Clothes 18-class neural fashion parser
 *    (isolates ONLY upper-clothes, stripping head, hair, arms, jeans & busy backgrounds!)
 * 2. FLAT-LAY on uniform studio background -> Full-res 1280px crisp flood-fill + largest-component keep
 *    (razor-sharp ribbed collar & logos, auto-strips website thumbnails/< > arrows/X buttons in 0.1s!)
 * 3. FLAT-LAY on busy background -> @imgly/background-removal AI cutout.
 */
export async function processGarmentImage(imageSrc, mode = 'ai', onProgress) {
  // Detect pose landmarks on the uploaded photo (identifies model shoots vs. flat-lay photos!)
  let modelLandmarks = null;
  try {
    const origImg = await loadImage(imageSrc);
    const lm = await detectPoseInImage(origImg);
    if (lm) {
      const shVis = (lm[11]?.visibility ?? 0) > 0.50 && (lm[12]?.visibility ?? 0) > 0.50;
      const headOrHipVis =
        (lm[0]?.visibility ?? 0) > 0.42 ||
        ((lm[23]?.visibility ?? 0) > 0.42 && (lm[24]?.visibility ?? 0) > 0.42);
      if (shVis && headOrHipVis) {
        modelLandmarks = lm;
      }
    }
  } catch {
    // Proceed as standard flat-lay garment
  }

  // CASE 1: MODEL SHOOT -> Use SegFormer-B2-Clothes Neural Fashion Parser!
  if (mode === 'ai' && modelLandmarks) {
    try {
      onProgress?.(12, 'Model shoot detected — running SegFormer-B2 AI...');
      const segResult = await extractGarmentWithSegFormer(imageSrc, (pct, msg) => {
        onProgress?.(Math.min(92, Math.round(pct * 0.92)), msg);
      });

      if (segResult?.textureUrl) {
        onProgress?.(95, 'Auto-leveling shoulders & finalizing cutout...');
        const leveled = await autoLevelCutoutWithPose(segResult.textureUrl, modelLandmarks);
        onProgress?.(100, `Extracted via SegFormer-B2 (${segResult.provider?.toUpperCase() || 'AI'})`);
        return leveled;
      }
    } catch (segErr) {
      console.warn('SegFormer-B2 parser fallback to background-removal:', segErr);
    }
  }

  // CASE 2: FLAT-LAY ON STUDIO/PLAIN BACKGROUND -> Full-res crisp cutout + UI-element removal!
  if (!modelLandmarks && (mode === 'instant' || (await hasCleanUniformBackground(imageSrc)))) {
    onProgress?.(25, 'Flat-lay studio photo detected — crisp full-res cutout...');
    const rawStudio = await instantLightBgCutout(imageSrc, onProgress, false);
    const cleaned = await cleanUploadedGarmentCutout(rawStudio);
    onProgress?.(100, 'Crisp full-res cutout ready');
    return cleaned;
  }

  let rawCutout = null;

  if (mode === 'instant') {
    rawCutout = await instantLightBgCutout(imageSrc, onProgress, Boolean(modelLandmarks));
  } else {
    try {
      onProgress?.(10, 'Initializing local AI cutout...');
      const { removeBackground } = await import('@imgly/background-removal');

      const blob = await removeBackground(imageSrc, {
        model: 'isnet_fp16',
        progress: (key, current, total) => {
          if (total > 0) {
            const pct = Math.min(84, Math.round(15 + (current / total) * 68));
            const label = key.includes('fetch')
              ? 'Loading local AI model (first run only)...'
              : modelLandmarks
              ? 'Model shoot detected — isolating subject...'
              : 'Removing background...';
            onProgress?.(pct, label);
          }
        },
      });

      rawCutout = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      console.warn('AI cutout failed, falling back to Instant Light-BG Cutout:', err);
      onProgress?.(40, 'Switching to instant cutout engine...');
      rawCutout = await instantLightBgCutout(imageSrc, onProgress, Boolean(modelLandmarks));
    }
  }

  // If this was a model shoot from an online store, surgically extract ONLY the T-shirt!
  if (modelLandmarks) {
    onProgress?.(90, 'Extracting T-shirt from model photo...');
    try {
      const extracted = await extractShirtFromModelCutout(rawCutout, modelLandmarks);
      if (extracted) {
        onProgress?.(100, 'T-shirt extracted & ready for try-on');
        return extracted;
      }
    } catch (extErr) {
      console.warn('Model garment extraction fallback:', extErr);
    }
  }

  onProgress?.(92, 'Cleaning edges & mapping garment proportions...');
  const cleaned = await cleanUploadedGarmentCutout(rawCutout);
  onProgress?.(100, 'Ready for live try-on');
  return cleaned;
}

/**
 * Horizontally mirrors a transparent PNG data URL (used to synthesize the opposite
 * side-profile view when a store shoot only includes one side angle).
 */
export async function mirrorImageHorizontally(dataUrl) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * Estimates the continuous 360° viewing angle (-180°..+180°) of an uploaded garment/model photo:
 *   0° = Front, -90° = Left Side, +90° = Right Side, ±180° = Back.
 */
export async function classifyGarmentPhotoAngle(dataUrl) {
  try {
    const img = await loadImage(dataUrl);
    const lm = await detectPoseInImage(img);
    if (!lm) {
      return { angle: 'front', angleDeg: 0, label: 'FLAT-LAY', score: 0.6 };
    }

    const lmNose = lm[0];
    const lmLEar = lm[7];
    const lmREar = lm[8];
    const lmLS = lm[11];
    const lmRS = lm[12];
    const lmLW = lm[15];
    const lmRW = lm[16];
    const lmLH = lm[23];
    const lmRH = lm[24];

    const shVis = (lmLS?.visibility ?? 0) > 0.4 && (lmRS?.visibility ?? 0) > 0.4;
    if (!shVis) {
      return { angle: 'front', angleDeg: 0, label: 'PRODUCT SHOT', score: 0.3 };
    }

    // In image space: front-facing has RS.x < LS.x (deltaX < 0); back-facing has RS.x > LS.x (deltaX > 0)
    const deltaX = lmRS.x - lmLS.x;
    const deltaZ = (lmRS.z ?? 0) - (lmLS.z ?? 0);
    const hipsVis = (lmLH?.visibility ?? 0) > 0.4 && (lmRH?.visibility ?? 0) > 0.4;
    const hipsInFrame = hipsVis && lmLH.y < 0.94 && lmRH.y < 0.94 && lmLH.y > 0.35;
    const shouldersInFrame = lmLS.y > 0.05 && lmRS.y > 0.05;
    const noseVis = lmNose?.visibility ?? 0;
    const earMidZ = ((lmLEar?.z ?? 0) + (lmREar?.z ?? 0)) * 0.5;
    const noseBehind = (lmNose?.z ?? 0) > earMidZ + 0.02 && noseVis < 0.72;

    // Continuous yaw angle in degrees: 0° = front, +90° = turned right, -90° = turned left, 180° = back
    let angleDeg = Math.round((Math.atan2(deltaZ * 1.15, -deltaX) * 180) / Math.PI);
    if (noseBehind && Math.abs(angleDeg) < 120) {
      angleDeg = angleDeg >= 0 ? 175 : -175;
    }

    const absDeg = Math.abs(angleDeg);
    const shWidth = Math.abs(deltaX);

    // Penalize cropped close-ups (hips cut off or shoulders touching top border)
    // and photos where the model's wrist/forearm crosses in front of the torso!
    const shMinX = Math.min(lmLS.x, lmRS.x);
    const shMaxX = Math.max(lmLS.x, lmRS.x);
    const shMidY = (lmLS.y + lmRS.y) * 0.5;
    const hipMidY = hipsVis ? (lmLH.y + lmRH.y) * 0.5 : shMidY + shWidth * 1.4;

    const wristOverTorso = (lmW) =>
      lmW &&
      (lmW.visibility ?? 0) > 0.4 &&
      lmW.x > shMinX + shWidth * 0.10 &&
      lmW.x < shMaxX - shWidth * 0.10 &&
      lmW.y > shMidY &&
      lmW.y < hipMidY;

    const armCrossPenalty = (wristOverTorso(lmLW) ? 1.4 : 0) + (wristOverTorso(lmRW) ? 1.4 : 0);
    const cropPenalty = (!hipsInFrame ? 1.8 : 0) + (!shouldersInFrame ? 1.2 : 0);
    const framingBonus = (hipsInFrame ? 1.2 : 0) + (shouldersInFrame ? 0.6 : 0);
    // Prefer full torso framing (ideal shWidth ~0.25..0.55) over zoomed-in crops (shWidth > 0.68)
    const idealWidthScore = Math.min(shWidth, 0.55) * 2.0 - Math.max(0, shWidth - 0.62) * 3.0;
    const baseScore = idealWidthScore + framingBonus - cropPenalty - armCrossPenalty;

    if (absDeg <= 38) {
      return {
        angle: 'front',
        angleDeg: Math.max(-35, Math.min(35, angleDeg)),
        label: 'FRONT',
        score: baseScore + (noseVis > 0.5 ? 0.5 : 0),
      };
    }
    if (absDeg >= 135) {
      return {
        angle: 'back',
        angleDeg: 180,
        label: 'BACK',
        score: baseScore,
      };
    }
    if (angleDeg < 0) {
      return {
        angle: 'left-side',
        angleDeg: Math.max(-125, Math.min(-45, angleDeg)),
        label: 'LEFT ANGLE',
        score: baseScore,
      };
    }
    return {
      angle: 'right-side',
      angleDeg: Math.max(45, Math.min(125, angleDeg)),
      label: 'RIGHT ANGLE',
      score: baseScore,
    };
  } catch {
    return { angle: 'front', angleDeg: 0, label: 'PRODUCT SHOT', score: 0.4 };
  }
}
