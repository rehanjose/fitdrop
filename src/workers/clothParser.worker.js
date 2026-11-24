/**
 * Stage 1 Web Worker: Semantic Clothing Segmentation (SegFormer-B2 Clothes via ONNX Runtime Web)
 * - Runs completely off the main thread so the UI stays 60 FPS
 * - Prefers WebGPU execution provider with automatic WASM SIMD fallback
 * - Isolates ONLY the `upper-clothes` class (class 4 in ATR/SegFormer-B2 Clothes)
 */

import * as ort from 'onnxruntime-web/webgpu';

// Load local WASM/JSEP binaries from /public/ort/ via absolute origin URL
// so Vite dev server never tries to transform static public .mjs files
ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, self.navigator?.hardwareConcurrency || 2)
  : 1;
ort.env.wasm.simd = true;

const MODEL_URL = '/models/segformer_b2_clothes.onnx';
const INPUT_SIZE = 512;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// SegFormer-B2 Clothes (mattmdjaga / Xenova) 18-class taxonomy:
// 0: Background, 1: Hat, 2: Hair, 3: Sunglasses, 4: Upper-clothes,
// 5: Skirt, 6: Pants, 7: Dress, 8: Belt, 9: Left-shoe, 10: Right-shoe,
// 11: Face, 12: Left-leg, 13: Right-leg, 14: Left-arm, 15: Right-arm, 16: Bag, 17: Scarf
const CLASS_UPPER_CLOTHES = 4;
const CLASS_DRESS = 7;

let session = null;
let sessionPromise = null;
let activeProvider = 'wasm';

async function getSession() {
  if (session) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    // Try WebGPU first if available in worker, then fall back cleanly to WASM SIMD
    const hasWebGpu = typeof self.navigator !== 'undefined' && 'gpu' in self.navigator;
    const providerOrder = hasWebGpu ? [['webgpu', 'wasm'], ['wasm']] : [['wasm']];

    let lastErr = null;
    for (const providers of providerOrder) {
      try {
        const s = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: providers,
          graphOptimizationLevel: 'all',
        });
        session = s;
        activeProvider = providers[0];
        return s;
      } catch (err) {
        lastErr = err;
      }
    }
    sessionPromise = null;
    throw lastErr || new Error('Failed to initialize SegFormer-B2 ONNX session');
  })();

  return sessionPromise;
}

/**
 * Converts RGBA 512x512 buffer to NCHW Float32 tensor with ImageNet normalization.
 */
function preprocessRgbaToTensor(rgba, size = INPUT_SIZE) {
  const numPixels = size * size;
  const floatData = new Float32Array(3 * numPixels);
  for (let i = 0; i < numPixels; i++) {
    const r = rgba[i * 4] / 255.0;
    const g = rgba[i * 4 + 1] / 255.0;
    const b = rgba[i * 4 + 2] / 255.0;
    floatData[i] = (r - MEAN[0]) / STD[0];
    floatData[numPixels + i] = (g - MEAN[1]) / STD[1];
    floatData[2 * numPixels + i] = (b - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', floatData, [1, 3, size, size]);
}

self.onmessage = async (event) => {
  const { type, id, rgbaBuffer, size } = event.data || {};

  if (type === 'warmup') {
    try {
      await getSession();
      self.postMessage({ type: 'ready', provider: activeProvider });
    } catch (err) {
      self.postMessage({ type: 'error', id: null, error: err?.message || String(err) });
    }
    return;
  }

  if (type === 'segment') {
    try {
      const t0 = performance.now();
      const s = await getSession();
      const rgba = new Uint8ClampedArray(rgbaBuffer);
      const inputTensor = preprocessRgbaToTensor(rgba, size || INPUT_SIZE);
      const inputName = s.inputNames[0];

      const outputs = await s.run({ [inputName]: inputTensor });
      const logitsTensor = outputs[s.outputNames[0]];
      // Expected shape: [1, 18, 128, 128]
      const [, numClasses, maskH, maskW] = logitsTensor.dims;
      const logits = new Float32Array(logitsTensor.data);
      inputTensor.dispose?.();
      logitsTensor.dispose?.();
      const spatialSize = maskH * maskW;

      const alphaMask = new Uint8ClampedArray(spatialSize);
      let upperCount = 0;
      let dressCount = 0;

      // Pass 1: Compute per-pixel argmax & soft probability for class 4 (upper-clothes)
      const upperProbs = new Float32Array(spatialSize);
      const dressProbs = new Float32Array(spatialSize);

      for (let i = 0; i < spatialSize; i++) {
        let maxLogit = -Infinity;
        let argmax = 0;
        for (let c = 0; c < numClasses; c++) {
          const val = logits[c * spatialSize + i];
          if (val > maxLogit) {
            maxLogit = val;
            argmax = c;
          }
        }

        // Numerically stable softmax for target classes
        let expSum = 0;
        for (let c = 0; c < numClasses; c++) {
          expSum += Math.exp(logits[c * spatialSize + i] - maxLogit);
        }

        const pUpper = Math.exp(logits[CLASS_UPPER_CLOTHES * spatialSize + i] - maxLogit) / expSum;
        const pDress = Math.exp(logits[CLASS_DRESS * spatialSize + i] - maxLogit) / expSum;

        upperProbs[i] = pUpper;
        dressProbs[i] = pDress;

        if (argmax === CLASS_UPPER_CLOTHES) upperCount++;
        else if (argmax === CLASS_DRESS) dressCount++;
      }

      // Strictly isolate `upper-clothes` (class 4). Only include `dress` (class 7) if an oversized/long
      // flat-lay top was classified almost exclusively as dress (> 3x upper-clothes).
      const useDressAssist = upperCount < spatialSize * 0.025 && dressCount > spatialSize * 0.04;
      let foregroundPixels = 0;

      for (let i = 0; i < spatialSize; i++) {
        const p = useDressAssist ? Math.min(1, upperProbs[i] + dressProbs[i]) : upperProbs[i];
        // Smooth S-curve ramp between 0.22 and 0.68 for crisp yet anti-aliased garment edges
        let a = 0;
        if (p >= 0.68) {
          a = 255;
        } else if (p > 0.22) {
          const t = (p - 0.22) / 0.46;
          a = Math.round(t * t * (3 - 2 * t) * 255);
        }
        alphaMask[i] = a;
        if (a > 128) foregroundPixels++;
      }

      const elapsedMs = Math.round(performance.now() - t0);
      self.postMessage(
        {
          type: 'result',
          id,
          maskBuffer: alphaMask.buffer,
          maskW,
          maskH,
          coverage: foregroundPixels / spatialSize,
          provider: activeProvider,
          elapsedMs,
        },
        [alphaMask.buffer]
      );
    } catch (err) {
      self.postMessage({
        type: 'error',
        id,
        error: err?.message || String(err),
      });
    }
  }
};
