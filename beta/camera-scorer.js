// Camera-based dart autoscoring with auto board detection + manual fallback
'use strict';

const CameraScorer = (() => {
  const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const SECTOR_ANGLE = Math.PI / 10;
  const R_BULL = 6.35;
  const R_OUTER_BULL = 15.9;
  const R_INNER_TRIPLE = 99;
  const R_OUTER_TRIPLE = 107;
  const R_INNER_DOUBLE = 162;
  const R_OUTER_DOUBLE = 170;

  let video, canvas, ctx, overlayCanvas, overlayCtx;
  let stream = null;
  let referenceFrame = null;
  let detecting = false;
  let animFrameId = null;

  // Calibration: perspective map from image pixels to board mm.
  let calibration = null; // { H, Hinv, cx, cy, pxPerMm }
  let calibStep = 0; // 0=idle, 1-4=manual points
  let calibPoints = [];
  const CALIB_LABELS = [
    'Tap the TOP of outer wire (20, 12 o clock)',
    'Tap the RIGHT of outer wire (6, 3 o clock)',
    'Tap the BOTTOM of outer wire (3, 6 o clock)',
    'Tap the LEFT of outer wire (11, 9 o clock)'
  ];
  const CALIB_BOARD_PTS = [
    [0, R_OUTER_DOUBLE],
    [R_OUTER_DOUBLE, 0],
    [0, -R_OUTER_DOUBLE],
    [-R_OUTER_DOUBLE, 0]
  ];

  const DIFF_THRESHOLD = 50;
  const MIN_BLOB_PIXELS = 150;
  const MAX_BLOB_PIXELS = 8000;
  const COOLDOWN_MS = 2000;
  const CONFIRM_FRAMES = 3;
  let lastScoreTime = 0;
  let commitFn = null;
  let pendingDetection = null;

  function init(container, onCommit) {
    commitFn = onCommit;
    container.innerHTML = `
      <div class="cam-scorer">
        <div class="cam-view">
          <video id="camVideo" playsinline autoplay muted></video>
          <canvas id="camOverlay"></canvas>
        </div>
        <div class="cam-controls">
          <button type="button" id="camStart" class="cam-btn">Start Camera</button>
          <button type="button" id="camAuto" class="cam-btn" disabled>Auto Detect</button>
          <button type="button" id="camCalib" class="cam-btn" disabled>Manual Calib</button>
          <button type="button" id="camRef" class="cam-btn" disabled>Set Reference</button>
          <button type="button" id="camDetect" class="cam-btn primary" disabled>Detect</button>
          <button type="button" id="camStop" class="cam-btn miss">Stop</button>
        </div>
        <div class="cam-status" id="camStatus">Tap Start Camera to begin</div>
      </div>
    `;

    video = document.getElementById('camVideo');
    overlayCanvas = document.getElementById('camOverlay');
    overlayCtx = overlayCanvas.getContext('2d');
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('camStart').addEventListener('click', startCamera);
    document.getElementById('camAuto').addEventListener('click', autoDetectCalibration);
    document.getElementById('camCalib').addEventListener('click', startManualCalibration);
    document.getElementById('camRef').addEventListener('click', captureReference);
    document.getElementById('camDetect').addEventListener('click', toggleDetection);
    document.getElementById('camStop').addEventListener('click', stop);
    overlayCanvas.addEventListener('click', onOverlayClick);

    try {
      const saved = localStorage.getItem('dartsCamCalibV3');
      if (saved) calibration = JSON.parse(saved);
    } catch (_) {}
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      video.srcObject = stream;
      await video.play();
      await new Promise(resolve => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
      });

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;

      document.getElementById('camAuto').disabled = false;
      document.getElementById('camCalib').disabled = false;
      document.getElementById('camRef').disabled = !calibration;
      setStatus(calibration
        ? 'Camera active. Saved calibration loaded. Set Reference.'
        : 'Camera active. Try Auto Detect. If it fails, use Manual Calib.');
      drawOverlay();
    } catch (e) {
      setStatus('Camera error: ' + e.message);
    }
  }

  function startManualCalibration() {
    calibration = null;
    calibPoints = [];
    calibStep = 1;
    document.getElementById('camRef').disabled = true;
    document.getElementById('camDetect').disabled = true;
    setStatus('Manual 1/4: ' + CALIB_LABELS[0]);
    drawOverlay();
  }

  function onOverlayClick(e) {
    if (calibStep < 1 || calibStep > 4) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    calibPoints.push([x, y]);

    if (calibPoints.length < 4) {
      calibStep = calibPoints.length + 1;
      setStatus(`Manual ${calibPoints.length + 1}/4: ` + CALIB_LABELS[calibPoints.length]);
      drawOverlay();
      return;
    }

    calibration = buildCalibrationFromImagePoints(calibPoints);
    calibStep = 0;
    saveCalibration();
    document.getElementById('camRef').disabled = false;
    setStatus('Manual calibration saved. Set Reference with empty board.');
    drawOverlay();
  }

  function autoDetectCalibration() {
    if (!video || video.videoWidth <= 0) {
      setStatus('Start camera first.');
    const detected = detectBoardEllipse(frame, canvas.width, canvas.height);
    }

    ctx.drawImage(video, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const detected = detectBoardCircle(frame, canvas.width, canvas.height);
    const pts = ellipseCardinalPoints(detected);
      [detected.cx, detected.cy - detected.r],
      [detected.cx + detected.r, detected.cy],
      [detected.cx, detected.cy + detected.r],
      [detected.cx - detected.r, detected.cy]
    setStatus('Auto Detect done (tilt-aware). Set Reference with empty board.');

    calibration = buildCalibrationFromImagePoints(pts);
    saveCalibration();
  function detectBoardEllipse(imageData, w, h) {
    // Downsample for speed; this runs on mobile Safari.
    const maxW = 320;
    const scale = Math.min(1, maxW / w);
    const sw = Math.max(80, Math.round(w * scale));
    const sh = Math.max(80, Math.round(h * scale));
    const sGray = new Uint8Array(sw * sh);
    const src = imageData.data;
    for (let sy = 0; sy < sh; sy++) {
      const y0 = Math.min(h - 1, Math.floor(sy / scale));
      for (let sx = 0; sx < sw; sx++) {
        const x0 = Math.min(w - 1, Math.floor(sx / scale));
        const i = (y0 * w + x0) * 4;
        sGray[sy * sw + sx] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) | 0;
      }
    }

    const edges = new Uint8Array(sw * sh);
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const p = y * sw + x;
        const gx =
          -sGray[p - sw - 1] + sGray[p - sw + 1] +
          -2 * sGray[p - 1] + 2 * sGray[p + 1] +
          -sGray[p + sw - 1] + sGray[p + sw + 1];
        const gy =
          -sGray[p - sw - 1] - 2 * sGray[p - sw] - sGray[p - sw + 1] +
          sGray[p + sw - 1] + 2 * sGray[p + sw] + sGray[p + sw + 1];
        edges[p] = (Math.abs(gx) + Math.abs(gy)) > 130 ? 1 : 0;
      }
    }

    const minDim = Math.min(sw, sh);
    const rxMin = Math.floor(minDim * 0.22);
    const rxMax = Math.floor(minDim * 0.48);
    let best = null;

    // Coarse search over center, major/minor radii, and ellipse rotation.
    for (let cy = Math.floor(sh * 0.35); cy <= Math.floor(sh * 0.65); cy += 12) {
      for (let cx = Math.floor(sw * 0.35); cx <= Math.floor(sw * 0.65); cx += 12) {
        for (let rx = rxMin; rx <= rxMax; rx += 8) {
          for (let ratio = 0.55; ratio <= 1.0; ratio += 0.1) {
            const ry = Math.max(10, Math.round(rx * ratio));
            for (let deg = -40; deg <= 40; deg += 10) {
              const theta = deg * Math.PI / 180;
              const c = Math.cos(theta), s = Math.sin(theta);
              let hit = 0;
              let samples = 0;
              for (let a = 0; a < 360; a += 8) {
                const t = a * Math.PI / 180;
                const ex = rx * Math.cos(t);
                const ey = ry * Math.sin(t);
                const x = Math.round(cx + ex * c - ey * s);
                const y = Math.round(cy + ex * s + ey * c);
                if (x < 1 || y < 1 || x >= sw - 1 || y >= sh - 1) continue;
                samples++;
                if (edges[y * sw + x]) hit++;
              }
              if (samples < 30) continue;
              const score = hit / samples;
              if (!best || score > best.score) {
                best = { cx, cy, rx, ry, theta, score };
              }
            }
          }
        }
      }
    }

    if (!best || best.score < 0.26) return null;

    // Refine locally around best for a sharper estimate.
    best = refineEllipse(edges, sw, sh, best);
    return {
      cx: best.cx / scale,
      cy: best.cy / scale,
      rx: best.rx / scale,
      ry: best.ry / scale,
      theta: best.theta,
      score: best.score
    };
  }

  function refineEllipse(edges, w, h, seed) {
    let best = seed;
    for (let cy = Math.max(10, seed.cy - 10); cy <= Math.min(h - 11, seed.cy + 10); cy += 3) {
      for (let cx = Math.max(10, seed.cx - 10); cx <= Math.min(w - 11, seed.cx + 10); cx += 3) {
        for (let rx = Math.max(12, seed.rx - 8); rx <= seed.rx + 8; rx += 3) {
          for (let ry = Math.max(10, seed.ry - 8); ry <= seed.ry + 8; ry += 3) {
            for (let deg = -12; deg <= 12; deg += 3) {
              const theta = seed.theta + (deg * Math.PI / 180);
              const c = Math.cos(theta), s = Math.sin(theta);
              let hit = 0;
              let samples = 0;
              for (let a = 0; a < 360; a += 6) {
                const t = a * Math.PI / 180;
                const ex = rx * Math.cos(t);
                const ey = ry * Math.sin(t);
                const x = Math.round(cx + ex * c - ey * s);
                const y = Math.round(cy + ex * s + ey * c);
                if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
                samples++;
                if (edges[y * w + x]) hit++;
              }
              if (samples < 40) continue;
              const score = hit / samples;
              if (score > best.score) best = { cx, cy, rx, ry, theta, score };
            }
          }
        }
      }
    }
    return best;
  }

  function ellipseCardinalPoints(el) {
    // Intersections with the image up/right/down/left rays from center.
    const dirs = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0]
    ];
    const c = Math.cos(el.theta), s = Math.sin(el.theta);
    const pts = [];
    for (const [dx, dy] of dirs) {
      // Ray length to ellipse boundary in direction (dx,dy).
      const ux = dx * c + dy * s;
      const uy = -dx * s + dy * c;
      const denom = Math.sqrt((ux * ux) / (el.rx * el.rx) + (uy * uy) / (el.ry * el.ry));
      const t = denom > 1e-9 ? (1 / denom) : 0;
      pts.push([el.cx + dx * t, el.cy + dy * t]);
    }
    return pts;
  }
    return best;
  }

  function buildCalibrationFromImagePoints(imagePts) {
    const H = computeHomography(imagePts, CALIB_BOARD_PTS);
    const Hinv = computeHomography(CALIB_BOARD_PTS, imagePts);
    const center = applyH(Hinv, [0, 0]);
    const edgePt = applyH(Hinv, [R_OUTER_DOUBLE, 0]);
    const pxPerMm = Math.hypot(edgePt[0] - center[0], edgePt[1] - center[1]) / R_OUTER_DOUBLE;
    return { H, Hinv, cx: center[0], cy: center[1], pxPerMm };
  }

  function saveCalibration() {
    try { localStorage.setItem('dartsCamCalibV3', JSON.stringify(calibration)); } catch (_) {}
  }

  function computeHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = src[i];
      const [dx, dy] = dst[i];
      A.push([-sx, -sy, -1, 0, 0, 0, dx * sx, dx * sy, dx]);
      A.push([0, 0, 0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
    }
    const M = A.map(row => row.slice(0, 8));
    const b = A.map(row => -row[8]);
    const h = gaussianElimination(M, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function gaussianElimination(M, b) {
    const n = 8;
    const aug = M.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-12) continue;
      for (let j = col; j <= n; j++) aug[col][j] /= pivot;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const f = aug[row][col];
        for (let j = col; j <= n; j++) aug[row][j] -= f * aug[col][j];
      }
    }
    return aug.map(row => row[n]);
  }

  function applyH(H, pt) {
    const [x, y] = pt;
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function captureReference() {
    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    document.getElementById('camDetect').disabled = false;
    setStatus('Reference captured. Throw a dart and press Detect.');
  }

  function toggleDetection() {
    if (detecting) {
      detecting = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      animFrameId = null;
      pendingDetection = null;
      document.getElementById('camDetect').textContent = 'Detect';
      setStatus('Detection paused.');
      return;
    }
    detecting = true;
    document.getElementById('camDetect').textContent = 'Pause';
    setStatus('Detecting darts...');
    detectLoop();
  }

  function detectLoop() {
    if (!detecting) return;
    const now = Date.now();
    if (now - lastScoreTime > COOLDOWN_MS) {
      const result = detectDart();
      if (result) {
        if (pendingDetection && Math.hypot(result.x - pendingDetection.x, result.y - pendingDetection.y) < 30) {
          pendingDetection.confirmCount++;
          pendingDetection.x = result.x;
          pendingDetection.y = result.y;
          pendingDetection.pixels = result.pixels;
          if (pendingDetection.confirmCount >= CONFIRM_FRAMES) {
            scoreDart(pendingDetection);
            pendingDetection = null;
            lastScoreTime = now;
          }
        } else {
          pendingDetection = { x: result.x, y: result.y, pixels: result.pixels, confirmCount: 1 };
        }
      } else {
        pendingDetection = null;
      }
    }
    animFrameId = requestAnimationFrame(detectLoop);
  }

  function detectDart() {
    if (!referenceFrame || !calibration) return null;
    ctx.drawImage(video, 0, 0);
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const ref = referenceFrame.data;
    const cur = current.data;
    const w = canvas.width;
    const h = canvas.height;

    const r = R_OUTER_DOUBLE * calibration.pxPerMm * 1.2;
    const x0 = Math.max(0, Math.floor(calibration.cx - r));
    const x1 = Math.min(w, Math.ceil(calibration.cx + r));
    const y0 = Math.max(0, Math.floor(calibration.cy - r));
    const y1 = Math.min(h, Math.ceil(calibration.cy + r));

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const diff = (Math.abs(cur[i] - ref[i]) + Math.abs(cur[i + 1] - ref[i + 1]) + Math.abs(cur[i + 2] - ref[i + 2])) / 3;
        if (diff > DIFF_THRESHOLD) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count < MIN_BLOB_PIXELS || count > MAX_BLOB_PIXELS) return null;
    return { x: sumX / count, y: sumY / count, pixels: count };
  }

  function scoreDart(detection) {
    const [bx, by] = applyH(calibration.H, [detection.x, detection.y]);
    const distMm = Math.hypot(bx, by);
    let angle = Math.atan2(bx, by);
    if (angle < 0) angle += 2 * Math.PI;

    const label = positionToLabel(distMm, angle);
    setStatus(`Detected ${label} (${detection.pixels}px)`);
    flashDetection(detection.x, detection.y, label);

    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (commitFn) commitFn(label);
  }

  function positionToLabel(distMm, angle) {
    if (distMm <= R_BULL) return 'Bull';
    if (distMm <= R_OUTER_BULL) return '25';
    if (distMm > R_OUTER_DOUBLE) return 'Miss';

    const sectorIdx = Math.round(angle / SECTOR_ANGLE) % 20;
    const number = SECTORS[sectorIdx];
    if (distMm >= R_INNER_DOUBLE && distMm <= R_OUTER_DOUBLE) return 'D' + number;
    if (distMm >= R_INNER_TRIPLE && distMm <= R_OUTER_TRIPLE) return 'T' + number;
    return 'S' + number;
  }

  function flashDetection(x, y, label) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    drawOverlay();

    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 12, 0, 2 * Math.PI);
    overlayCtx.fillStyle = 'rgba(255,210,63,0.85)';
    overlayCtx.fill();
    overlayCtx.strokeStyle = '#ffffff';
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();

    overlayCtx.font = 'bold 20px sans-serif';
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.textAlign = 'center';
    overlayCtx.fillText(label, x, y - 20);

    setTimeout(() => {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      drawOverlay();
    }, 900);
  }

  function drawOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!calibration) {
      if (calibStep >= 1 && calibStep <= 4) {
        for (const p of calibPoints) {
          overlayCtx.beginPath();
          overlayCtx.arc(p[0], p[1], 7, 0, 2 * Math.PI);
          overlayCtx.fillStyle = 'rgba(255,210,63,0.9)';
          overlayCtx.fill();
        }
      }
      return;
    }

    overlayCtx.strokeStyle = 'rgba(255,210,63,0.4)';
    overlayCtx.lineWidth = 1;
    drawProjectedCircle(R_OUTER_DOUBLE);
    drawProjectedCircle(R_OUTER_TRIPLE);
    drawProjectedCircle(R_INNER_TRIPLE);
    drawProjectedCircle(R_OUTER_BULL);
    drawProjectedCircle(R_BULL);

    const c = applyH(calibration.Hinv, [0, 0]);
    overlayCtx.beginPath();
    overlayCtx.arc(c[0], c[1], 4, 0, 2 * Math.PI);
    overlayCtx.fillStyle = 'rgba(255,210,63,0.8)';
    overlayCtx.fill();
  }

  function drawProjectedCircle(radiusMm) {
    overlayCtx.beginPath();
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      const bx = radiusMm * Math.cos(a);
      const by = radiusMm * Math.sin(a);
      const [px, py] = applyH(calibration.Hinv, [bx, by]);
      if (i === 0) overlayCtx.moveTo(px, py);
      else overlayCtx.lineTo(px, py);
    }
    overlayCtx.stroke();
  }

  function stop() {
    detecting = false;
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
    pendingDetection = null;
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    if (video) video.srcObject = null;
    referenceFrame = null;
    if (document.getElementById('camDetect')) {
      document.getElementById('camDetect').disabled = true;
      document.getElementById('camDetect').textContent = 'Detect';
      document.getElementById('camRef').disabled = true;
      document.getElementById('camCalib').disabled = true;
      document.getElementById('camAuto').disabled = true;
    }
    setStatus('Camera stopped.');
    if (overlayCtx && overlayCanvas) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function setStatus(msg) {
    const el = document.getElementById('camStatus');
    if (el) el.textContent = msg;
  }

  return { init, stop };
})();
