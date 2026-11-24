/**
 * Singleton Google MediaPipe Pose (@mediapipe/tasks-vision) engine.
 * Pre-loads in the background on app mount so the webcam AR studio starts with zero delay.
 */

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

let landmarkerInstance = null;
let imageLandmarkerInstance = null;
let imageLoadPromise = null;
let loadPromise = null;
let currentStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
const listeners = new Set();

function setStatus(status) {
  currentStatus = status;
  listeners.forEach((fn) => fn(status));
}

export function subscribePoseStatus(listener) {
  listeners.add(listener);
  listener(currentStatus);
  return () => listeners.delete(listener);
}

export function getPoseStatus() {
  return currentStatus;
}

export async function preloadPoseLandmarker() {
  if (landmarkerInstance) return landmarkerInstance;
  if (loadPromise) return loadPromise;

  setStatus('loading');

  loadPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks('/wasm');
      // Prefer the high-accuracy Full model on laptops for sharper landmarks, 3D depth & segmentation
      const modelCandidates = [
        '/models/pose_landmarker_full.task',
        '/models/pose_landmarker_lite.task',
      ];

      let lastErr = null;
      for (const modelAssetPath of modelCandidates) {
        for (const delegate of ['GPU', 'CPU']) {
          try {
            landmarkerInstance = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: {
                modelAssetPath,
                delegate,
              },
              runningMode: 'VIDEO',
              numPoses: 1,
              outputSegmentationMasks: true,
              minPoseDetectionConfidence: 0.4,
              minPosePresenceConfidence: 0.4,
              minTrackingConfidence: 0.4,
            });
            break;
          } catch (err) {
            lastErr = err;
            console.warn(`PoseLandmarker init failed (${modelAssetPath}, ${delegate}):`, err);
          }
        }
        if (landmarkerInstance) break;
      }

      if (!landmarkerInstance) {
        throw lastErr || new Error('Failed to initialize PoseLandmarker');
      }

      setStatus('ready');
      return landmarkerInstance;
    } catch (err) {
      console.error('Failed to load MediaPipe PoseLandmarker:', err);
      setStatus('error');
      loadPromise = null;
      throw err;
    }
  })();

  return loadPromise;
}

export function getPoseLandmarker() {
  return landmarkerInstance;
}

/**
 * On-demand IMAGE-mode PoseLandmarker to detect if an uploaded store photo
 * features a human model (so we can automatically extract ONLY the T-shirt!).
 */
export async function detectPoseInImage(imgElement) {
  try {
    if (!imageLandmarkerInstance) {
      if (!imageLoadPromise) {
        imageLoadPromise = (async () => {
          const vision = await FilesetResolver.forVisionTasks('/wasm');
          const modelCandidates = [
            '/models/pose_landmarker_full.task',
            '/models/pose_landmarker_lite.task',
          ];
          for (const modelAssetPath of modelCandidates) {
            for (const delegate of ['GPU', 'CPU']) {
              try {
                const inst = await PoseLandmarker.createFromOptions(vision, {
                  baseOptions: { modelAssetPath, delegate },
                  runningMode: 'IMAGE',
                  numPoses: 1,
                  minPoseDetectionConfidence: 0.45,
                  minPosePresenceConfidence: 0.45,
                });
                imageLandmarkerInstance = inst;
                return inst;
              } catch {
                // try next candidate
              }
            }
          }
          return null;
        })();
      }
      await imageLoadPromise;
    }

    if (!imageLandmarkerInstance) return null;
    const result = imageLandmarkerInstance.detect(imgElement);
    return result?.landmarks?.[0] || null;
  } catch (err) {
    console.warn('Static image pose detection skipped:', err);
    return null;
  }
}
