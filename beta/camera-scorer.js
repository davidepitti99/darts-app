// Autoscore camera module: auto start/stop, tilt-aware board lock, no manual reference.
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

  const DIFF_THRESHOLD = 28;
  const MIN_BLOB_PIXELS = 35;
  const MAX_BLOB_PIXELS = 14000;
  const CONFIRM_FRAMES = 2;
  const COOLDOWN_MS = 1800;

  const CALIB_BOARD_PTS = [
    [0, R_OUTER_DOUBLE],
    [R_OUTER_DOUBLE, 0],
    [0, -R_OUTER_DOUBLE],
    [-R_OUTER_DOUBLE, 0]
  ];

  let containerEl = null;
  let video = null;
  let overlayCanvas = null;
  let overlayCtx = null;
  let hiddenCanvas = null;
  let hiddenCtx = null;
  let statusEl = null;
  let zoomWrap = null;
  let zoomInput = null;

  let stream = null;
  let videoTrack = null;
  let running = false;
  let rafId = null;
  let commitFn = null;

  let calibration = null; // { H, Hinv, cx, cy, pxPerMm }
  let lastCalibTryAt = 0;
  let backgroundGray = null;
  let pendingDetection = null;
  let lastScoreAt = 0;
  let frameTicker = 0;

  function init(container, onCommit) {
    containerEl = container;
    commitFn = onCommit;
    container.innerHTML = `
      <div class="cam-scorer">
        <div class="cam-view">
          <video id="camVideo" playsinline muted autoplay></video>
          <canvas id="camOverlay"></canvas>
        </div>
        <div class="cam-controls">
          <button type="button" id="camRecalib" class="cam-btn">Re-detect board</button>
          <button type="button" id="camManual" class="cam-btn">Manual 4-point</button>
        </div>
        <div class="cam-controls hidden" id="camZoomWrap">
          <label for="camZoomInput" style="font-size:12px;color:#bdbdbd">Zoom</label>
          <input id="camZoomInput" type="range" min="1" max="1" step="0.1" value="1" style="flex:1">
        </div>
        <div class="cam-status" id="camStatus">Preparing camera…</div>
      </div>
    `;

    video = document.getElementById('camVideo');
    overlayCanvas = document.getElementById('camOverlay');
    overlayCtx = overlayCanvas.getContext('2d');
    hiddenCanvas = document.createElement('canvas');
    hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
    statusEl = document.getElementById('camStatus');
    zoomWrap = document.getElementById('camZoomWrap');
    zoomInput = document.getElementById('camZoomInput');

    document.getElementById('camRecalib').addEventListener('click', () => {
      calibration = null;
      pendingDetection = null;
      setStatus('Searching for dartboard…');
    });
    document.getElementById('camManual').addEventListener('click', startManualCalibration);

    try {
      const saved = localStorage.getItem('dartsCamCalibV5');
      if (saved) calibration = JSON.parse(saved);
    } catch (_) {}

    setupZoomControl();
  }

  async function enter() {
    if (running) return;
    running = true;
    await ensureCamera();
    if (!running) return;
    setStatus(calibration ? 'Board lock restored. Autoscore active.' : 'Cannot find dartboard. Reposition camera until it autodetects.');
    loop();
  }

  function exit() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    pendingDetection = null;
    backgroundGray = null;

    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
      videoTrack = null;
    }
    if (video) video.srcObject = null;
    clearOverlay();
  }

  async function ensureCamera() {
    if (stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      video.srcObject = stream;
      videoTrack = stream.getVideoTracks()[0] || null;
      await video.play();
      await new Promise(resolve => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
      });
      hiddenCanvas.width = video.videoWidth;
      hiddenCanvas.height = video.videoHeight;
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;
      configureZoomRange();
    } catch (e) {
      setStatus('Camera error: ' + String((e && e.message) || e));
      running = false;
    }
  }

  function setupZoomControl() {
    if (!zoomInput) return;
    zoomInput.addEventListener('input', async () => {
      if (!videoTrack) return;
      const z = Number(zoomInput.value);
      if (!Number.isFinite(z)) return;
      try {
        await videoTrack.applyConstraints({ advanced: [{ zoom: z }] });
      } catch (_) {
        // Some devices expose zoom in capabilities but still reject constraints.
      }
    });
  }

  function configureZoomRange() {
    if (!videoTrack || !zoomWrap || !zoomInput) return;
    try {
      const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : null;
      if (!caps || !caps.zoom) {
        zoomWrap.classList.add('hidden');
        return;
      }
      const min = Number(caps.zoom.min || 1);
      const max = Number(caps.zoom.max || 1);
      const step = Number(caps.zoom.step || 0.1);
      if (!(max > min)) {
        zoomWrap.classList.add('hidden');
        return;
      }
      zoomInput.min = String(min);
      zoomInput.max = String(max);
      zoomInput.step = String(step > 0 ? step : 0.1);
      zoomInput.value = String(min);
      zoomWrap.classList.remove('hidden');
    } catch (_) {
      zoomWrap.classList.add('hidden');
    }
  }

  function loop() {
    if (!running || !video || video.videoWidth <= 0) return;
    frameTicker += 1;

    hiddenCtx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
    const frame = hiddenCtx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height);

    if (!calibration) {
      tryAutoDetectBoard(frame);
      if (frameTicker % 45 === 0) setStatus('Cannot find dartboard. Reposition camera until it autodetects.');
      rafId = requestAnimationFrame(loop);
      return;
    }

    if (!backgroundGray) {
      backgroundGray = frameToGray(frame.data, hiddenCanvas.width, hiddenCanvas.height);
      if (frameTicker % 30 === 0) setStatus('Board locked. Learning background…');
      drawOverlay();
      rafId = requestAnimationFrame(loop);
      return;
    }

    const now = Date.now();
    if (now - lastScoreAt < COOLDOWN_MS) {
      if (frameTicker % 30 === 0) {
        const sec = Math.ceil((COOLDOWN_MS - (now - lastScoreAt)) / 1000);
        setStatus('Cooldown… ' + sec + 's');
      }
      updateBackground(frame.data, 0.02);
      rafId = requestAnimationFrame(loop);
      return;
    }

    const det = detectMotionBlob(frame.data);
    if (!det) {
      pendingDetection = null;
      if (frameTicker % 30 === 0) setStatus('Watching for dart…');
      updateBackground(frame.data, 0.04);
      rafId = requestAnimationFrame(loop);
      return;
    }

    if (pendingDetection && Math.hypot(det.x - pendingDetection.x, det.y - pendingDetection.y) < 40) {
      pendingDetection.x = det.x;
      pendingDetection.y = det.y;
      pendingDetection.pixels = det.pixels;
      pendingDetection.confirm = (pendingDetection.confirm || 1) + 1;
      if (frameTicker % 5 === 0) setStatus('Confirming dart… ' + pendingDetection.confirm + '/' + CONFIRM_FRAMES);
      if (pendingDetection.confirm >= CONFIRM_FRAMES) {
        scoreDetection(pendingDetection, frame.data);
        pendingDetection = null;
      }
    } else {
      pendingDetection = { x: det.x, y: det.y, pixels: det.pixels, confirm: 1 };
    }

    rafId = requestAnimationFrame(loop);
  }

  function tryAutoDetectBoard(frame) {
    const now = Date.now();
    if (now - lastCalibTryAt < 800) return;
    lastCalibTryAt = now;

    const ellipse = detectBoardEllipse(frame, hiddenCanvas.width, hiddenCanvas.height);
    if (!ellipse) return;

    const pts = ellipseCardinalPoints(ellipse);
    calibration = buildCalibrationFromImagePoints(pts);
    saveCalibration();
    backgroundGray = null;
    setStatus('Board locked. Autoscore active.');
    drawOverlay();
  }

  function startManualCalibration() {
    if (!running) return;
    const picks = [];
    const hints = [
      'Manual 1/4: tap TOP outer double (20)',
      'Manual 2/4: tap RIGHT outer double (6)',
      'Manual 3/4: tap BOTTOM outer double (3)',
      'Manual 4/4: tap LEFT outer double (11)'
    ];
    setStatus(hints[0]);

    const onClick = (e) => {
      const rect = overlayCanvas.getBoundingClientRect();
      const sx = overlayCanvas.width / rect.width;
      const sy = overlayCanvas.height / rect.height;
      picks.push([(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy]);
      if (picks.length < 4) {
        setStatus(hints[picks.length]);
        return;
      }
      overlayCanvas.removeEventListener('click', onClick);
      calibration = buildCalibrationFromImagePoints(picks);
      saveCalibration();
      backgroundGray = null;
      setStatus('Manual calibration done. Autoscore active.');
      drawOverlay();
    };

    overlayCanvas.addEventListener('click', onClick);
  }

  function scoreDetection(det, frameData) {
    const [bx, by] = applyH(calibration.H, [det.x, det.y]);
    const dist = Math.hypot(bx, by);
    let angle = Math.atan2(bx, by);
    if (angle < 0) angle += 2 * Math.PI;

    const label = scoreLabel(dist, angle);
    setStatus('Detected ' + label + ' (' + det.pixels + 'px)');
    flash(det.x, det.y, label);

    const payload = { x: bx, y: by, label: label, ts: new Date().toISOString() };
    try {
      window.dispatchEvent(new CustomEvent('darts-autoscore-detected', { detail: payload }));
    } catch (_) {}

    if (typeof commitFn === 'function') commitFn(label, { x: bx, y: by });

    // Rebase background immediately so already-thrown darts do not retrigger.
    backgroundGray = frameToGray(frameData, hiddenCanvas.width, hiddenCanvas.height);
    lastScoreAt = Date.now();
  }

  function detectMotionBlob(frameData) {
    const w = hiddenCanvas.width;
    const h = hiddenCanvas.height;
    const cx = calibration.cx;
    const cy = calibration.cy;
    const r = R_OUTER_DOUBLE * calibration.pxPerMm * 1.2;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h, Math.ceil(cy + r));

    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      let row = y * w;
      for (let x = x0; x < x1; x++) {
        const p = row + x;
        const i = p * 4;
        const g = (frameData[i] * 0.299 + frameData[i + 1] * 0.587 + frameData[i + 2] * 0.114);
        const diff = Math.abs(g - backgroundGray[p]);
        if (diff > DIFF_THRESHOLD) {
          sumX += x;
          sumY += y;
          count += 1;
        }
      }
    }

    if (count < MIN_BLOB_PIXELS || count > MAX_BLOB_PIXELS) return null;
    return { x: sumX / count, y: sumY / count, pixels: count };
  }

  function updateBackground(frameData, alpha) {
    if (!backgroundGray) return;
    const w = hiddenCanvas.width;
    const h = hiddenCanvas.height;
    const cx = calibration.cx;
    const cy = calibration.cy;
    const r = R_OUTER_DOUBLE * calibration.pxPerMm * 1.2;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h, Math.ceil(cy + r));

    const inv = 1 - alpha;
    for (let y = y0; y < y1; y++) {
      let row = y * w;
      for (let x = x0; x < x1; x++) {
        const p = row + x;
        const i = p * 4;
        const g = (frameData[i] * 0.299 + frameData[i + 1] * 0.587 + frameData[i + 2] * 0.114);
        backgroundGray[p] = backgroundGray[p] * inv + g * alpha;
      }
    }
  }

  function frameToGray(frameData, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; p < out.length; p++, i += 4) {
      out[p] = frameData[i] * 0.299 + frameData[i + 1] * 0.587 + frameData[i + 2] * 0.114;
    }
    return out;
  }

  function detectBoardEllipse(frame, w, h) {
    const maxW = 320;
    const scale = Math.min(1, maxW / w);
    const sw = Math.max(80, Math.round(w * scale));
    const sh = Math.max(80, Math.round(h * scale));

    const gray = new Uint8Array(sw * sh);
    const src = frame.data;
    for (let y = 0; y < sh; y++) {
      const oy = Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < sw; x++) {
        const ox = Math.min(w - 1, Math.floor(x / scale));
        const i = (oy * w + ox) * 4;
        gray[y * sw + x] = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) | 0;
      }
    }

    const edges = new Uint8Array(sw * sh);
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const p = y * sw + x;
        const gx = -gray[p - sw - 1] + gray[p - sw + 1] - 2 * gray[p - 1] + 2 * gray[p + 1] - gray[p + sw - 1] + gray[p + sw + 1];
        const gy = -gray[p - sw - 1] - 2 * gray[p - sw] - gray[p - sw + 1] + gray[p + sw - 1] + 2 * gray[p + sw] + gray[p + sw + 1];
        edges[p] = (Math.abs(gx) + Math.abs(gy)) > 130 ? 1 : 0;
      }
    }

    const minDim = Math.min(sw, sh);
    const rxMin = Math.floor(minDim * 0.22);
    const rxMax = Math.floor(minDim * 0.48);
    let best = null;

    for (let cy = Math.floor(sh * 0.35); cy <= Math.floor(sh * 0.65); cy += 12) {
      for (let cx = Math.floor(sw * 0.35); cx <= Math.floor(sw * 0.65); cx += 12) {
        for (let rx = rxMin; rx <= rxMax; rx += 8) {
          for (let ratio = 0.5; ratio <= 1.0; ratio += 0.1) {
            const ry = Math.max(10, Math.round(rx * ratio));
            for (let deg = -45; deg <= 45; deg += 10) {
              const theta = deg * Math.PI / 180;
              const score = ellipseScore(edges, sw, sh, cx, cy, rx, ry, theta, 8);
              if (!best || score > best.score) best = { cx, cy, rx, ry, theta, score };
            }
          }
        }
      }
    }

    if (!best || best.score < 0.26) return null;
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

  function ellipseScore(edges, w, h, cx, cy, rx, ry, theta, stepDeg) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    let hit = 0;
    let samples = 0;
    for (let a = 0; a < 360; a += stepDeg) {
      const t = a * Math.PI / 180;
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      const x = Math.round(cx + ex * c - ey * s);
      const y = Math.round(cy + ex * s + ey * c);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      samples += 1;
      if (edges[y * w + x]) hit += 1;
    }
    if (samples < 30) return 0;
    return hit / samples;
  }

  function refineEllipse(edges, w, h, seed) {
    let best = seed;
    for (let cy = Math.max(10, seed.cy - 10); cy <= Math.min(h - 11, seed.cy + 10); cy += 3) {
      for (let cx = Math.max(10, seed.cx - 10); cx <= Math.min(w - 11, seed.cx + 10); cx += 3) {
        for (let rx = Math.max(12, seed.rx - 8); rx <= seed.rx + 8; rx += 3) {
          for (let ry = Math.max(10, seed.ry - 8); ry <= seed.ry + 8; ry += 3) {
            for (let d = -12; d <= 12; d += 3) {
              const theta = seed.theta + d * Math.PI / 180;
              const score = ellipseScore(edges, w, h, cx, cy, rx, ry, theta, 6);
              if (score > best.score) best = { cx, cy, rx, ry, theta, score };
            }
          }
        }
      }
    }
    return best;
  }

  function ellipseCardinalPoints(el) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const c = Math.cos(el.theta);
    const s = Math.sin(el.theta);
    const out = [];
    for (const d of dirs) {
      const dx = d[0], dy = d[1];
      const ux = dx * c + dy * s;
      const uy = -dx * s + dy * c;
      const denom = Math.sqrt((ux * ux) / (el.rx * el.rx) + (uy * uy) / (el.ry * el.ry));
      const t = denom > 1e-9 ? (1 / denom) : 0;
      out.push([el.cx + dx * t, el.cy + dy * t]);
    }
    return out;
  }

  function buildCalibrationFromImagePoints(imagePts) {
    const H = computeHomography(imagePts, CALIB_BOARD_PTS);
    const Hinv = computeHomography(CALIB_BOARD_PTS, imagePts);
    const center = applyH(Hinv, [0, 0]);
    const edge = applyH(Hinv, [R_OUTER_DOUBLE, 0]);
    const pxPerMm = Math.hypot(edge[0] - center[0], edge[1] - center[1]) / R_OUTER_DOUBLE;
    return { H, Hinv, cx: center[0], cy: center[1], pxPerMm };
  }

  function saveCalibration() {
    try { localStorage.setItem('dartsCamCalibV5', JSON.stringify(calibration)); } catch (_) {}
  }

  function computeHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const sx = src[i][0], sy = src[i][1];
      const dx = dst[i][0], dy = dst[i][1];
      A.push([-sx, -sy, -1, 0, 0, 0, dx * sx, dx * sy, dx]);
      A.push([0, 0, 0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
    }
    const M = A.map(r => r.slice(0, 8));
    const b = A.map(r => -r[8]);
    const h = gaussian8x8(M, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function gaussian8x8(M, b) {
    const n = 8;
    const aug = M.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      const t = aug[col];
      aug[col] = aug[maxRow];
      aug[maxRow] = t;

      const piv = aug[col][col];
      if (Math.abs(piv) < 1e-12) continue;
      for (let j = col; j <= n; j++) aug[col][j] /= piv;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const f = aug[row][col];
        for (let j = col; j <= n; j++) aug[row][j] -= f * aug[col][j];
      }
    }
    return aug.map(r => r[n]);
  }

  function applyH(H, pt) {
    const x = pt[0], y = pt[1];
    const w = H[6] * x + H[7] * y + H[8];
    return [
      (H[0] * x + H[1] * y + H[2]) / w,
      (H[3] * x + H[4] * y + H[5]) / w
    ];
  }

  function scoreLabel(distMm, angle) {
    if (distMm <= R_BULL) return 'Bull';
    if (distMm <= R_OUTER_BULL) return '25';
    if (distMm > R_OUTER_DOUBLE) return 'Miss';
    const sectorIdx = Math.round(angle / SECTOR_ANGLE) % 20;
    const n = SECTORS[sectorIdx];
    if (distMm >= R_INNER_DOUBLE && distMm <= R_OUTER_DOUBLE) return 'D' + n;
    if (distMm >= R_INNER_TRIPLE && distMm <= R_OUTER_TRIPLE) return 'T' + n;
    return 'S' + n;
  }

  function drawOverlay() {
    clearOverlay();
    if (!calibration) return;
    overlayCtx.strokeStyle = 'rgba(255,210,63,0.45)';
    overlayCtx.lineWidth = 1;
    drawProjectedCircle(R_OUTER_DOUBLE);
    drawProjectedCircle(R_OUTER_TRIPLE);
    drawProjectedCircle(R_INNER_TRIPLE);
    drawProjectedCircle(R_OUTER_BULL);
    drawProjectedCircle(R_BULL);
    drawProjectedSectorWires();
  }

  function drawProjectedSectorWires() {
    // Draw inferred spoke wires at sector boundaries.
    overlayCtx.strokeStyle = 'rgba(255,210,63,0.35)';
    overlayCtx.lineWidth = 1;
    for (let k = 0; k < 20; k++) {
      const a = (k + 0.5) * SECTOR_ANGLE;
      const x = R_OUTER_DOUBLE * Math.sin(a);
      const y = R_OUTER_DOUBLE * Math.cos(a);
      drawProjectedLine([0, 0], [x, y]);
    }
  }

  function drawProjectedLine(p0, p1) {
    const a = applyH(calibration.Hinv, p0);
    const b = applyH(calibration.Hinv, p1);
    overlayCtx.beginPath();
    overlayCtx.moveTo(a[0], a[1]);
    overlayCtx.lineTo(b[0], b[1]);
    overlayCtx.stroke();
  }

  function drawProjectedCircle(rMm) {
    overlayCtx.beginPath();
    const steps = 52;
    for (let i = 0; i <= steps; i++) {
      const a = 2 * Math.PI * i / steps;
      const p = applyH(calibration.Hinv, [rMm * Math.cos(a), rMm * Math.sin(a)]);
      if (i === 0) overlayCtx.moveTo(p[0], p[1]);
      else overlayCtx.lineTo(p[0], p[1]);
    }
    overlayCtx.stroke();
  }

  function flash(x, y, label) {
    drawOverlay();
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 12, 0, 2 * Math.PI);
    overlayCtx.fillStyle = 'rgba(255,210,63,0.85)';
    overlayCtx.fill();
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();
    overlayCtx.font = 'bold 20px sans-serif';
    overlayCtx.fillStyle = '#fff';
    overlayCtx.textAlign = 'center';
    overlayCtx.fillText(label, x, y - 18);
    setTimeout(drawOverlay, 900);
  }

  function clearOverlay() {
    if (overlayCtx && overlayCanvas)
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  return { init, enter, exit };
})();
