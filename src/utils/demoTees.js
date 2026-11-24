/**
 * Photorealistic Studio Demo Wardrobe (5 Real Ghost-Mannequin Cotton T-Shirts)
 * Loads real high-resolution studio product photos from /tees/, cleanly strips
 * the pure white background via border flood-fill + tight bounding-box crop,
 * and derives realistic cotton colorway variants (zero cartoon/emoji vectors!).
 */

import { instantLightBgCutout, generatePlainBackCutout } from './cutoutEngine';

const RAW_DEMO_SPECS = [
  {
    id: 'demo-oversized-graphic',
    name: 'Oversized Graphic',
    tag: '280 GSM',
    defaultFit: 'oversized',
    src: '/tees/tee-oversized-graphic.jpg',
    tint: null,
  },
  {
    id: 'demo-vintage-thrift',
    name: 'Vintage Thrift',
    tag: 'WASHED ECRU',
    defaultFit: 'regular',
    src: '/tees/tee-vintage-thrift.jpg',
    tint: null,
  },
  {
    id: 'demo-typography-print',
    name: 'Typography Print',
    tag: 'SWISS TYPE',
    defaultFit: 'regular',
    src: '/tees/tee-typography.jpg',
    tint: null,
  },
  {
    id: 'demo-heavyweight-solid',
    name: 'Heavyweight Charcoal',
    tag: 'JET BLACK',
    defaultFit: 'oversized',
    src: '/tees/tee-oversized-graphic.jpg',
    tint: { filter: 'grayscale(100%) brightness(62%) contrast(118%)' },
  },
  {
    id: 'demo-washed-sage',
    name: 'Washed Sage Tee',
    tag: 'EARTH TONE',
    defaultFit: 'fitted',
    src: '/tees/tee-vintage-thrift.jpg',
    tint: { filter: 'sepia(35%) hue-rotate(55deg) saturate(85%) brightness(88%)' },
  },
];

function applyFabricFilter(transparentPngUrl, filterStr) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.filter = filterStr;
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(transparentPngUrl);
    img.src = transparentPngUrl;
  });
}

// Synchronous initial wardrobe (thumbnails load immediately, then upgraded to transparent cutouts)
export function getDemoTees() {
  return RAW_DEMO_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    tag: spec.tag,
    defaultFit: spec.defaultFit,
    frontUrl: spec.src,
    backUrl: null,
    isDemo: true,
    needsCutout: true,
  }));
}

let processedPromise = null;

/**
 * Strips the white studio background from all 5 photorealistic demo tees in parallel
 * (~250ms total) and caches the clean transparent PNGs.
 */
export function loadPhotorealisticDemoTees() {
  if (processedPromise) return processedPromise;

  processedPromise = (async () => {
    // Cut out the 3 unique base studio photos once
    const uniqueSources = [...new Set(RAW_DEMO_SPECS.map((s) => s.src))];
    const cutoutMap = {};

    await Promise.all(
      uniqueSources.map(async (src) => {
        try {
          cutoutMap[src] = await instantLightBgCutout(src);
        } catch {
          cutoutMap[src] = src;
        }
      })
    );

    const results = await Promise.all(
      RAW_DEMO_SPECS.map(async (spec) => {
        let frontUrl = cutoutMap[spec.src] || spec.src;
        if (spec.tint?.filter) {
          frontUrl = await applyFabricFilter(frontUrl, spec.tint.filter);
        }
        let backUrl = null;
        try {
          backUrl = await generatePlainBackCutout(frontUrl);
        } catch {
          backUrl = null;
        }
        return {
          id: spec.id,
          name: spec.name,
          tag: spec.tag,
          defaultFit: spec.defaultFit,
          frontUrl,
          backUrl,
          isDemo: true,
          needsCutout: false,
        };
      })
    );

    return results;
  })();

  return processedPromise;
}
