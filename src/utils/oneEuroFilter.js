/**
 * Stage 2: One Euro Filter (Casiez et al., CHI 2012)
 * Adaptive low-pass filter that eliminates micro-jitter at rest while keeping
 * ultra-low latency during fast arm raises and body turns.
 */

class LowPassFilter {
  constructor(alpha, initVal = 0) {
    this.y = initVal;
    this.s = initVal;
    this.initialized = false;
    this.setAlpha(alpha);
  }

  setAlpha(alpha) {
    this.alpha = Math.max(0.0001, Math.min(1.0, alpha));
  }

  filter(value, alpha) {
    if (alpha !== undefined) this.setAlpha(alpha);
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
    } else {
      this.s = this.alpha * value + (1.0 - this.alpha) * this.s;
    }
    this.y = value;
    return this.s;
  }

  lastValue() {
    return this.y;
  }
}

export class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.04, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter(1.0);
    this.dxFilter = new LowPassFilter(1.0);
    this.lastTimeSec = null;
  }

  static computeAlpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / Math.max(dt, 1e-4));
  }

  filter(value, timestampSec) {
    if (this.lastTimeSec === null) {
      this.lastTimeSec = timestampSec;
      this.dxFilter.filter(0, 1.0);
      return this.xFilter.filter(value, 1.0);
    }

    const dt = Math.max(1 / 240, Math.min(0.2, timestampSec - this.lastTimeSec));
    this.lastTimeSec = timestampSec;

    const dValue = (value - this.xFilter.lastValue()) / dt;
    const edValue = this.dxFilter.filter(dValue, OneEuroFilter.computeAlpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);

    return this.xFilter.filter(value, OneEuroFilter.computeAlpha(cutoff, dt));
  }

  reset() {
    this.lastTimeSec = null;
    this.xFilter = new LowPassFilter(1.0);
    this.dxFilter = new LowPassFilter(1.0);
  }
}

/**
 * Applies independent One Euro Filters to all 33 MediaPipe Pose landmarks (x, y, z).
 */
export class PoseLandmarkOneEuroFilter {
  constructor(numLandmarks = 33, minCutoff = 1.4, beta = 0.08, dCutoff = 1.0) {
    this.filters = Array.from({ length: numLandmarks }, () => ({
      x: new OneEuroFilter(minCutoff, beta, dCutoff),
      y: new OneEuroFilter(minCutoff, beta, dCutoff),
      z: new OneEuroFilter(minCutoff * 0.8, beta * 0.5, dCutoff),
    }));
  }

  filterAll(landmarks, timestampMs) {
    if (!landmarks || landmarks.length === 0) return null;
    const tSec = timestampMs / 1000;
    return landmarks.map((lm, idx) => {
      const f = this.filters[idx];
      if (!f) return lm;
      return {
        x: f.x.filter(lm.x, tSec),
        y: f.y.filter(lm.y, tSec),
        z: f.z.filter(lm.z ?? 0, tSec),
        visibility: lm.visibility ?? 1,
      };
    });
  }

  reset() {
    this.filters.forEach((f) => {
      f.x.reset();
      f.y.reset();
      f.z.reset();
    });
  }
}
