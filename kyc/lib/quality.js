// Capture quality checks for ID photos.
// Pure functions on a grayscale buffer, so they run in the browser and under node --test.
// These are heuristics. They catch obvious problems (blur, glare, dark, cut off), not every bad photo.
(function (root) {
  const THRESHOLDS = {
    minSharpness: 120,   // variance of the Laplacian; lower means blurry
    maxGlareShare: 0.03, // share of blown-out pixels (>= 252); higher means glare. White card paper sits near 220-240, so it is not counted
    minBrightness: 70,   // mean luma; lower means too dark
    maxBrightness: 235,  // mean luma; higher means overexposed. A white card on a phone photo averages below this
    maxEdgeTouch: 0.2    // share of border pixels with strong edges; higher suggests the card is cut off
  };

  // Variance of the 4-neighbour Laplacian. Sharp text and edges give large values.
  function laplacianVariance(gray, w, h) {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += l;
        sumSq += l * l;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  function glareShare(gray) {
    let bright = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] >= 252) bright++;
    return gray.length ? bright / gray.length : 0;
  }

  function meanLuma(gray) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    return gray.length ? sum / gray.length : 0;
  }

  // Share of strong edges in a thin band along the frame border.
  // If the card runs off the frame, its content touches the border and this rises.
  function borderEdgeShare(gray, w, h) {
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    let edges = 0;
    let total = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const onBorder = x < band || y < band || x >= w - band || y >= h - band;
        if (!onBorder) continue;
        total++;
        const i = y * w + x;
        // Forward differences. Central differences would miss fine patterns such as a checkerboard.
        const g = Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i + w] - gray[i]);
        if (g > 60) edges++;
      }
    }
    return total ? edges / total : 0;
  }

  function assess(gray, w, h, t = THRESHOLDS) {
    const metrics = {
      sharpness: laplacianVariance(gray, w, h),
      glare: glareShare(gray),
      brightness: meanLuma(gray),
      edgeTouch: borderEdgeShare(gray, w, h)
    };
    const issues = [];
    if (metrics.sharpness < t.minSharpness) {
      issues.push({ code: "blur", message: "Image is blurry. Hold the phone steady and tap to focus." });
    }
    if (metrics.glare > t.maxGlareShare) {
      issues.push({ code: "glare", message: "Glare on the card. Tilt it slightly away from the light." });
    }
    if (metrics.brightness < t.minBrightness) {
      issues.push({ code: "dark", message: "Too dark. Move to better light." });
    }
    if (metrics.brightness > t.maxBrightness) {
      issues.push({ code: "bright", message: "Overexposed. Move out of direct light." });
    }
    if (metrics.edgeTouch > t.maxEdgeTouch) {
      issues.push({ code: "crop", message: "The card may be cut off. Move back so all four edges show." });
    }
    return { metrics, issues, pass: issues.length === 0 };
  }

  // Downscale RGBA pixels to grayscale (luma). Used on video frames before assess().
  function toGray(rgba, w, h) {
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
    }
    return gray;
  }

  const api = { THRESHOLDS, laplacianVariance, glareShare, meanLuma, borderEdgeShare, assess, toGray };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KycQuality = api;
})(typeof self !== "undefined" ? self : this);
