/**
 * Stage 1: Universal Garment Extractor + Automatic Anchor Metadata Computation
 * - Runs SegFormer-B2 Clothes in a dedicated Web Worker (WebGPU -> WASM SIMD)
 * - Downscales uploaded images to max 512px for fast mask inference
 * - Upscales & applies smooth alpha mask back onto a crisp 1024px texture
 * - Automatically computes garment anchor metadata (collarTop, shoulders, armpits, sleeveHems, hem)
 *   from the extracted alpha mask so any top (crew neck, polo, oversized tee) adapts with zero hacks.
 */

let workerInstance = null;
let reqCounter = 0;
const pendingRequests = new Map();
let workerProvider = 'initializing';
const statusListeners = new Set();

function notifyStatus(status) {
  workerProvider = status;
  statusListeners.forEach((fn) => fn(status));
}

export function subscribeClothParserStatus(fn) {
  statusListeners.add(fn);
  fn(workerProvider);
  return () => statusListeners.delete(fn);
}

function getClothWorker() {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('../workers/clothParser.worker.js', import.meta.url), {
      type: 'module',
    });

    workerInstance.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ready') {
        notifyStatus(`ready (${msg.provider})`);
        return;
      }
      if (msg.id != null && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.type === 'error') {
          reject(new Error(msg.error || 'Cloth parser worker error'));
        } else {
          notifyStatus(`ready (${msg.provider})`);
          resolve(msg);
        }
      }
    };

    workerInstance.onerror = (err) => {
      console.error('Cloth parser worker error:', err);
      notifyStatus('error');
    };
  }
  return workerInstance;
}

export function warmupClothParser() {
  try {
    const w = getClothWorker();
    w.postMessage({ type: 'warmup' });
  } catch (err) {
    console.warn('Cloth parser warmup skipped:', err);
  }
}

/**
 * Normalizes any uploaded image file (including .avif / .webp with missing MIME types)
 * into a crisp 1024px max-dimension HTMLImageElement + PNG data URL.
 */
export function normalizeFileToDataUrl(file) {
  return new Promise((resolve) => {
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
        const maxDim = 1024;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
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
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    };
    img.src = objUrl;
  });
}

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
 * Fallback border flood-fill ONLY if SegFormer finds < 1.5% upper-clothes pixels
 * (e.g., an abstract flat-lay illustration without human context).
 */
function fallbackBorderAlphaMask(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 36));
  for (let x = 0; x < w; x += step) {
    for (const y of [2, h - 3]) {
      const idx = (y * w + x) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      cnt++;
    }
  }
  const bgR = rSum / cnt;
  const bgG = gSum / cnt;
  const bgB = bSum / cnt;

  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;

  const isBg = (idx) =>
    Math.hypot(data[idx] - bgR, data[idx + 1] - bgG, data[idx + 2] - bgB) <= 44;

  const enq = (x, y) => {
    const pos = y * w + x;
    if (!visited[pos] && isBg(pos * 4)) {
      visited[pos] = 1;
      queue[tail++] = pos;
    }
  };

  for (let x = 0; x < w; x++) {
    enq(x, 0);
    enq(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    enq(0, y);
    enq(w - 1, y);
  }
  while (head < tail) {
    const pos = queue[head++];
    data[pos * 4 + 3] = 0;
    const x = pos % w;
    const y = (pos - x) / w;
    if (x > 0) enq(x - 1, y);
    if (x < w - 1) enq(x + 1, y);
    if (y > 0) enq(x, y - 1);
    if (y < h - 1) enq(x, y + 1);
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Keeps only the largest connected foreground component (removes tiny stray specks).
 */
function keepLargestComponent(imgData) {
  const { data, width: w, height: h } = imgData;
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let currentLabel = 0;
  let bestLabel = 0;
  let bestSize = 0;

  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== 0 || data[i * 4 + 3] < 48) continue;
    currentLabel++;
    let head = 0, tail = 0;
    labels[i] = currentLabel;
    queue[tail++] = i;

    while (head < tail) {
      const pos = queue[head++];
      const x = pos % w;
      const y = (pos - x) / w;
      if (x > 0 && labels[pos - 1] === 0 && data[(pos - 1) * 4 + 3] >= 48) {
        labels[pos - 1] = currentLabel;
        queue[tail++] = pos - 1;
      }
      if (x < w - 1 && labels[pos + 1] === 0 && data[(pos + 1) * 4 + 3] >= 48) {
        labels[pos + 1] = currentLabel;
        queue[tail++] = pos + 1;
      }
      if (y > 0 && labels[pos - w] === 0 && data[(pos - w) * 4 + 3] >= 48) {
        labels[pos - w] = currentLabel;
        queue[tail++] = pos - w;
      }
      if (y < h - 1 && labels[pos + w] === 0 && data[(pos + w) * 4 + 3] >= 48) {
        labels[pos + w] = currentLabel;
        queue[tail++] = pos + w;
      }
    }

    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = currentLabel;
    }
  }

  if (bestLabel > 0 && bestSize > w * h * 0.01) {
    for (let i = 0; i < w * h; i++) {
      if (labels[i] !== bestLabel) {
        data[i * 4 + 3] = 0;
      }
    }
  }
}

/**
 * Automatically computes universal normalized (0..1) garment anchor metadata
 * directly from the trimmed transparent alpha mask!
 * Adapts to crew necks, V-necks, polos, oversized tees, cropped tees, etc.
 */
export function computeGarmentAnchors(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, w, h).data;

  const isOpaque = (x, y) => {
    const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(h - 1, Math.round(y)));
    return data[(iy * w + ix) * 4 + 3] > 120;
  };

  // Row left/right span profile
  const rowLeft = new Float32Array(h);
  const rowRight = new Float32Array(h);
  const rowWidth = new Float32Array(h);

  for (let y = 0; y < h; y++) {
    let lx = -1;
    let rx = -1;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 120) {
        lx = x;
        break;
      }
    }
    for (let x = w - 1; x >= 0; x--) {
      if (data[(y * w + x) * 4 + 3] > 120) {
        rx = x;
        break;
      }
    }
    rowLeft[y] = lx >= 0 ? lx / w : 0.5;
    rowRight[y] = rx >= 0 ? rx / w : 0.5;
    rowWidth[y] = lx >= 0 && rx >= lx ? (rx - lx) / w : 0;
  }

  // 1. Collar Top Center (deepest neckline point near u = 0.50)
  let collarY = Math.round(h * 0.1);
  for (let y = 0; y < Math.floor(h * 0.45); y++) {
    if (isOpaque(w * 0.5, y)) {
      collarY = y;
      break;
    }
  }

  // 2. Shoulder points (highest opaque y in left [0.22..0.38] and right [0.62..0.78] zones)
  const findShoulder = (uStart, uEnd, defaultU) => {
    let bestY = Math.round(h * 0.14);
    let bestU = defaultU;
    let minY = h;
    for (let u = uStart; u <= uEnd; u += 0.02) {
      for (let y = 0; y < Math.floor(h * 0.35); y++) {
        if (isOpaque(w * u, y)) {
          if (y < minY) {
            minY = y;
            bestY = y;
            bestU = u;
          }
          break;
        }
      }
    }
    return { u: bestU, v: bestY / h };
  };
  const leftShoulder = findShoulder(0.22, 0.38, 0.28);
  const rightShoulder = findShoulder(0.62, 0.78, 0.72);

  // 3. Armpit seams: scan between v = 0.28..0.60 where silhouette width contracts sharply
  // from sleeves into the torso waist!
  let maxUpperWidth = 0;
  let sleeveHemV = 0.34;
  for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.50); y++) {
    if (rowWidth[y] > maxUpperWidth) {
      maxUpperWidth = rowWidth[y];
      sleeveHemV = y / h;
    }
  }

  // Find sharpest inward jump (armpit notch) below sleeve widest row
  let leftArmpit = { u: 0.24, v: 0.42 };
  let rightArmpit = { u: 0.76, v: 0.42 };
  let bestLeftJump = 0;
  let bestRightJump = 0;
  const armpitStart = Math.floor(h * Math.max(0.25, sleeveHemV));
  const armpitEnd = Math.floor(h * 0.62);
  const deltaRows = Math.max(3, Math.round(h * 0.03));

  for (let y = armpitStart; y < armpitEnd - deltaRows; y++) {
    const lJump = rowLeft[y + deltaRows] - rowLeft[y];
    if (lJump > bestLeftJump && rowLeft[y + deltaRows] > 0.12 && rowLeft[y + deltaRows] < 0.42) {
      bestLeftJump = lJump;
      leftArmpit = { u: rowLeft[y + deltaRows], v: (y + deltaRows) / h };
    }
    const rJump = rowRight[y] - rowRight[y + deltaRows];
    if (rJump > bestRightJump && rowRight[y + deltaRows] > 0.58 && rowRight[y + deltaRows] < 0.88) {
      bestRightJump = rJump;
      rightArmpit = { u: rowRight[y + deltaRows], v: (y + deltaRows) / h };
    }
  }

  // 4. Bottom hem span (averaged over bottom 90%..95% of height for curved/oversized hems)
  let hemLSum = 0, hemRSum = 0, hemCnt = 0;
  const hemStart = Math.max(0, Math.floor(h * 0.90));
  const hemEnd = Math.min(h - 1, Math.floor(h * 0.95));
  for (let y = hemStart; y <= hemEnd; y++) {
    if (rowWidth[y] > 0.1) {
      hemLSum += rowLeft[y];
      hemRSum += rowRight[y];
      hemCnt++;
    }
  }
  const hemY = Math.min(h - 2, Math.floor(h * 0.92));
  const avgHemL = hemCnt > 0 ? hemLSum / hemCnt : rowLeft[hemY];
  const avgHemR = hemCnt > 0 ? hemRSum / hemCnt : rowRight[hemY];
  const hemLeft = { u: avgHemL, v: 0.95 };
  const hemRight = { u: avgHemR, v: 0.95 };
  const hemCenter = { u: (avgHemL + avgHemR) * 0.5, v: 0.96 };

  return {
    collarTop: { u: 0.5, v: collarY / h },
    leftShoulder,
    rightShoulder,
    leftArmpit,
    rightArmpit,
    leftSleeveHem: { u: rowLeft[Math.round(sleeveHemV * h)] || 0.04, v: sleeveHemV },
    rightSleeveHem: { u: rowRight[Math.round(sleeveHemV * h)] || 0.96, v: sleeveHemV },
    hemLeft,
    hemCenter,
    hemRight,
    torsoWidthRatio: Math.max(0.45, Math.min(0.85, rightArmpit.u - leftArmpit.u)),
    aspectRatio: w / h,
  };
}

/**
 * Extracts ONLY the `upper-clothes` garment from ANY uploaded image (model shoot or flat-lay)
 * via the SegFormer-B2 Web Worker, applies the smooth mask onto a crisp 1024px texture,
 * and computes universal garment anchor metadata.
 */
export async function extractGarmentWithSegFormer(imageSrc, onProgress) {
  onProgress?.(10, 'Preparing 1024px texture & 512px inference buffer...');
  const img = await loadImage(imageSrc);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  // 1. Build crisp 1024px max-dim texture canvas
  const texScale = Math.min(1, 1024 / Math.max(srcW, srcH));
  const texW = Math.max(1, Math.round(srcW * texScale));
  const texH = Math.max(1, Math.round(srcH * texScale));

  const texCanvas = document.createElement('canvas');
  texCanvas.width = texW;
  texCanvas.height = texH;
  const texCtx = texCanvas.getContext('2d', { willReadFrequently: true });
  texCtx.imageSmoothingEnabled = true;
  texCtx.imageSmoothingQuality = 'high';
  texCtx.drawImage(img, 0, 0, texW, texH);

  // 2. Build 512x512 aspect-preserving letterboxed inference buffer for SegFormer-B2
  const INF_SIZE = 512;
  const fitScale = Math.min(INF_SIZE / srcW, INF_SIZE / srcH);
  const drawW = Math.round(srcW * fitScale);
  const drawH = Math.round(srcH * fitScale);
  const padX = Math.floor((INF_SIZE - drawW) / 2);
  const padY = Math.floor((INF_SIZE - drawH) / 2);

  const infCanvas = document.createElement('canvas');
  infCanvas.width = INF_SIZE;
  infCanvas.height = INF_SIZE;
  const infCtx = infCanvas.getContext('2d', { willReadFrequently: true });
  infCtx.fillStyle = '#ffffff';
  infCtx.fillRect(0, 0, INF_SIZE, INF_SIZE);
  infCtx.drawImage(img, padX, padY, drawW, drawH);

  const rgba512 = infCtx.getImageData(0, 0, INF_SIZE, INF_SIZE).data;
  const transferBuf = rgba512.buffer.slice(0);

  onProgress?.(35, 'Running SegFormer-B2 cloth parsing (Web Worker)...');

  // 3. Dispatch to Web Worker (WebGPU -> WASM SIMD)
  const worker = getClothWorker();
  const id = ++reqCounter;
  const result = await new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage(
      { type: 'segment', id, rgbaBuffer: transferBuf, size: INF_SIZE },
      [transferBuf]
    );
  });

  onProgress?.(82, 'Upscaling alpha mask onto 1024px texture...');

  if (result.coverage >= 0.015) {
    // Paint 128x128 alpha mask into a mask canvas
    const { maskW, maskH } = result;
    const maskBytes = new Uint8ClampedArray(result.maskBuffer);
    const smallMaskCanvas = document.createElement('canvas');
    smallMaskCanvas.width = maskW;
    smallMaskCanvas.height = maskH;
    const smCtx = smallMaskCanvas.getContext('2d');
    const smData = smCtx.createImageData(maskW, maskH);
    for (let i = 0; i < maskW * maskH; i++) {
      smData.data[i * 4] = 255;
      smData.data[i * 4 + 1] = 255;
      smData.data[i * 4 + 2] = 255;
      smData.data[i * 4 + 3] = maskBytes[i];
    }
    smCtx.putImageData(smData, 0, 0);

    // Un-letterbox crop region inside the 128x128 mask corresponding to the original aspect ratio
    const mPadX = (padX / INF_SIZE) * maskW;
    const mPadY = (padY / INF_SIZE) * maskH;
    const mDrawW = (drawW / INF_SIZE) * maskW;
    const mDrawH = (drawH / INF_SIZE) * maskH;

    // Upscale mask onto 1024px texture canvas and sharpen alpha ramp so collar & sleeve
    // edges are CRISP real fabric (never a soft airbrushed "body-paint" fade!)
    const fullMaskCanvas = document.createElement('canvas');
    fullMaskCanvas.width = texW;
    fullMaskCanvas.height = texH;
    const fmCtx = fullMaskCanvas.getContext('2d', { willReadFrequently: true });
    fmCtx.imageSmoothingEnabled = true;
    fmCtx.imageSmoothingQuality = 'high';
    fmCtx.drawImage(smallMaskCanvas, mPadX, mPadY, mDrawW, mDrawH, 0, 0, texW, texH);

    // Crisp fabric edge threshold (turns blurry 128->1024 interpolation into a sharp 1.5px anti-aliased edge)
    const fmImg = fmCtx.getImageData(0, 0, texW, texH);
    const fmD = fmImg.data;
    for (let i = 3; i < fmD.length; i += 4) {
      const a = fmD[i];
      if (a <= 112) {
        fmD[i] = 0;
      } else if (a >= 164) {
        fmD[i] = 255;
      } else {
        fmD[i] = Math.round(((a - 112) / 52) * 255);
      }
    }
    fmCtx.putImageData(fmImg, 0, 0);

    texCtx.save();
    texCtx.globalCompositeOperation = 'destination-in';
    texCtx.drawImage(fullMaskCanvas, 0, 0);
    texCtx.restore();
  } else {
    // Safe fallback for abstract flat-lay graphics without human context
    fallbackBorderAlphaMask(texCtx, texW, texH);
  }

  // Keep only the main garment component and trim tight bounding box
  const fullImgData = texCtx.getImageData(0, 0, texW, texH);
  keepLargestComponent(fullImgData);
  texCtx.putImageData(fullImgData, 0, 0);

  let minX = texW, minY = texH, maxX = 0, maxY = 0, found = false;
  const d = fullImgData.data;
  for (let y = 0; y < texH; y++) {
    for (let x = 0; x < texW; x++) {
      if (d[(y * texW + x) * 4 + 3] > 28) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  const pad = 6;
  const cX = found ? Math.max(0, minX - pad) : 0;
  const cY = found ? Math.max(0, minY - pad) : 0;
  const cW = found ? Math.min(texW, maxX + pad + 1) - cX : texW;
  const cH = found ? Math.min(texH, maxY + pad + 1) - cY : texH;

  const trimmedCanvas = document.createElement('canvas');
  trimmedCanvas.width = Math.max(1, cW);
  trimmedCanvas.height = Math.max(1, cH);
  const trCtx = trimmedCanvas.getContext('2d', { willReadFrequently: true });
  trCtx.drawImage(texCanvas, cX, cY, cW, cH, 0, 0, cW, cH);

  // Symmetric Torso Bite Repair: if a model's arm/hand crossed one side of the waist/belly
  // (leaving a concave bite out of one side of the T-shirt), mirror-fill the missing fabric
  // cleanly from the intact opposite side so the T-shirt silhouette stays 100% complete!
  if (cW > 40 && cH > 40) {
    const tImg = trCtx.getImageData(0, 0, cW, cH);
    const td = tImg.data;
    const midX = cW * 0.5;
    const repairTop = Math.floor(cH * 0.42);
    const repairBot = Math.floor(cH * 0.95);

    for (let y = repairTop; y < repairBot; y++) {
      let lx = -1;
      let rx = -1;
      for (let x = 0; x < cW; x++) {
        if (td[(y * cW + x) * 4 + 3] > 140) {
          lx = x;
          break;
        }
      }
      for (let x = cW - 1; x >= 0; x--) {
        if (td[(y * cW + x) * 4 + 3] > 140) {
          rx = x;
          break;
        }
      }
      if (lx < 0 || rx < 0) continue;

      const leftDist = midX - lx;
      const rightDist = rx - midX;

      // If right side has a deep bite (> 14% narrower than left side), mirror-fill from left side
      if (leftDist > cW * 0.16 && leftDist - rightDist > cW * 0.08) {
        const targetRx = Math.min(cW - 1, Math.round(midX + leftDist));
        for (let x = Math.max(0, rx - 2); x <= targetRx; x++) {
          const mirrorX = Math.max(0, Math.min(cW - 1, Math.round(cW - 1 - x)));
          const dstIdx = (y * cW + x) * 4;
          const srcIdx = (y * cW + mirrorX) * 4;
          if (td[dstIdx + 3] < td[srcIdx + 3]) {
            td[dstIdx] = td[srcIdx];
            td[dstIdx + 1] = td[srcIdx + 1];
            td[dstIdx + 2] = td[srcIdx + 2];
            td[dstIdx + 3] = td[srcIdx + 3];
          }
        }
      } else if (rightDist > cW * 0.16 && rightDist - leftDist > cW * 0.08) {
        // If left side has a deep bite, mirror-fill from right side
        const targetLx = Math.max(0, Math.round(midX - rightDist));
        for (let x = targetLx; x <= Math.min(cW - 1, lx + 2); x++) {
          const mirrorX = Math.max(0, Math.min(cW - 1, Math.round(cW - 1 - x)));
          const dstIdx = (y * cW + x) * 4;
          const srcIdx = (y * cW + mirrorX) * 4;
          if (td[dstIdx + 3] < td[srcIdx + 3]) {
            td[dstIdx] = td[srcIdx];
            td[dstIdx + 1] = td[srcIdx + 1];
            td[dstIdx + 2] = td[srcIdx + 2];
            td[dstIdx + 3] = td[srcIdx + 3];
          }
        }
      }
    }
    trCtx.putImageData(tImg, 0, 0);
  }

  onProgress?.(95, 'Computing universal garment anchors...');
  const anchors = computeGarmentAnchors(trimmedCanvas);

  onProgress?.(100, `Done (${result.elapsedMs}ms on ${result.provider.toUpperCase()})`);
  return {
    textureUrl: trimmedCanvas.toDataURL('image/png'),
    anchors,
    provider: result.provider,
    elapsedMs: result.elapsedMs,
  };
}

/**
 * Generates a clean plain-cotton back view from the front texture if no back photo was uploaded.
 */
export async function synthesizePlainBackTexture(frontTextureUrl) {
  const img = await loadImage(frontTextureUrl);
  const w = img.width;
  const h = img.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const data = ctx.getImageData(0, 0, w, h).data;
  const rV = [], gV = [], bV = [];
  const step = Math.max(2, Math.floor(Math.min(w, h) / 60));
  for (let y = Math.floor(h * 0.14); y < Math.floor(h * 0.90); y += step) {
    for (let x = Math.floor(w * 0.08); x < Math.floor(w * 0.92); x += step) {
      if (x > w * 0.24 && x < w * 0.76 && y > h * 0.18 && y < h * 0.74) continue;
      const idx = (y * w + x) * 4;
      if (data[idx + 3] > 220) {
        rV.push(data[idx]);
        gV.push(data[idx + 1]);
        bV.push(data[idx + 2]);
      }
    }
  }
  const med = (arr, fb) => (arr.length ? arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.5)] : fb);
  const baseR = med(rV, 220);
  const baseG = med(gV, 220);
  const baseB = med(bV, 220);

  // Smoothly cover front print area inside garment alpha
  const patch = document.createElement('canvas');
  patch.width = w;
  patch.height = h;
  const pCtx = patch.getContext('2d');
  pCtx.filter = `blur(${Math.max(12, Math.round(w * 0.03))}px)`;
  pCtx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
  pCtx.beginPath();
  pCtx.roundRect(w * 0.21, h * 0.12, w * 0.58, h * 0.68, w * 0.08);
  pCtx.fill();

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.drawImage(patch, 0, 0);
  ctx.restore();

  return c.toDataURL('image/png');
}
