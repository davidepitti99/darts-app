// Camera-based dart autoscoring via frame differencing + perspective correction
'use strict';

const CameraScorer = (() => {
  // Board geometry (standard dartboard)
  const SECTORS = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];
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

  // Calibration: 4-point homography (supports tilted views)
  // User taps 4 known points on the outer double wire: top (20), right (6),
  // bottom (3), left (11).
  let calibration = null; // { H, Hinv, cx, cy, pxPerMm }
  let calibStep = 0; // 0=idle, 1-4=collecting points, 5=done
  let calibPoints = [];
  const CALIB_LABELS = [
    'Tap the TOP of the outer wire (20, 12 o\'clock)',
    'Tap the RIGHT of the outer wire (6, 3 o\'clock)',
    'Tap the BOTTOM of the outer wire (3, 6 o\'clock)',
    'Tap the LEFT of the outer wire (11, 9 o\'clock)',
  ];
  // Board positions in mm (0,0 = bullseye, +y = up, +x = right)
  const CALIB_BOARD_PTS = [
    [0, R_OUTER_DOUBLE],     // top (20)
    [R_OUTER_DOUBLE, 0],     // right (6)
    [0, -R_OUTER_DOUBLE],    // bottom (3)
    [-R_OUTER_DOUBLE, 0],    // left (11)
  ];

  // Detection parameters
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
          <button type="button" id="camCalib" class="cam-btn" disabled>Calibrate</button>
          <button type="button" id="camRef" class="cam-btn" disabled>Set Reference</button>
          <button type="button" id="camDetect" class="cam-btn primary" disabled>Detect</button>
          <button type="button" id="camStop" class="cam-btn miss">Stop</button>
        </div>
        <div class="cam-status" id="camStatus">Tap "Start Camera" to begin</div>
      </div>
    `;

    video = document.getElementById('camVideo');
    overlayCanvas = document.getElementById('camOverlay');
    overlayCtx = overlayCanvas.getContext('2d');
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('camStart').addEventListener('click', startCamera);
    document.getElementById('camCalib').addEventListener('click', startCalibration);
    document.getElementById('camRef').addEventListener('click', captureReference);
    document.getElementById('camDetect').addEventListener('click', toggleDetection);
    document.getElementById('camStop').addEventListener('click', stop);
    overlayCanvas.addEventListener('click', onOverlayClick);

    try {
      const saved = localStorage.getItem('dartsCamCalibV2');
      if (saved) {
        calibration = JSON.parse(saved);
        calibStep = 5;
      }
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
      setStatus('Camera active. ' + (calibration ? 'Calibration loaded. Set reference frame.' : 'Calibrate the board (4 points).'));
      document.getElementById('camCalib').disabled = false;
      document.getElementById('camRef').disabled = !calibration;
      drawOverlay();
    } catch (e) {
      setStatus('Camera error: ' + e.message);
    }
  }

  function startCalibration() {
    calibStep = 1;
    calibPoints = [];
    calibration = null;
    document.getElementById('camRef').disabled = true;
    document.getElementById('camDetect').disabled = true;
    setStatus('1/4: ' + CALIB_LABELS[0]);
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
      setStatus(`${calibPoints.length}/4: ` + CALIB_LABELS[calibPoints.length]);
      drawOverlay();
    } else {
      finishCalibration();
    }
  }

  function finishCalibration() {
    // Homography: image pixels → board mm
    const H = computeHomography(calibPoints, CALIB_BOARD_PTS);
    // Inverse: board mm → image pixels (for overlay drawing)
    const Hinv = computeHomography(CALIB_BOARD_PTS, calibPoints);

    const center = applyH(Hinv, [0, 0]);
    const edgePt = applyH(Hinv, [R_OUTER_DOUBLE, 0]);
    const pxPerMm = Math.hypot(edgePt[0] - center[0], edgePt[1] - center[1]) / R_OUTER_DOUBLE;

    calibration = { H, Hinv, cx: center[0], cy: center[1], pxPerMm };
    calibStep = 5;
    try { localStorage.setItem('dartsCamCalibV2', JSON.stringify(calibration)); } catch (_) {}
    setStatus('Calibrated! Now "Set Reference" with no darts on the board.');
    document.getElementById('camRef').disabled = false;
    drawOverlay();
  }

  // --- Homography math (4-point DLT) ---
  function computeHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = src[i];
      const [dx, dy] = dst[i];
      A.push([-sx, -sy, -1, 0, 0, 0, dx * sx, dx * sy, dx]);
      A.push([0, 0, 0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
    }
    // Fix h9=1, solve 8x8 system
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
      for (let row = col + 1; row < n; row++)
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
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

  // --- Detection ---
  function captureReference() {
    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setStatus('Reference captured. Throw a dart then tap "Detect".');
    document.getElementById('camDetect').disabled = false;
  }

  function toggleDetection() {
    if (detecting) {
      detecting = false;
      if (animFrameId) cancelAnimationFrame(animFrameId);
      animFrameId = null;
      document.getElementById('camDetect').textContent = 'Detect';
      setStatus('Detection paused.');
    } else {
      detecting = true;
      document.getElementById('camDetect').textContent = 'Pause';
      setStatus('Detecting darts...');
      detectLoop();
    }
  }

  function detectLoop() {
    if (!detecting) return;
    const now = Date.now();
    if (now - lastScoreTime > COOLDOWN_MS) {
      const result = detectDart();
      if (result) {
        if (pendingDetection &&
            Math.hypot(result.x - pendingDetection.x, result.y - pendingDetection.y) < 30) {
          pendingDetection.confirmCount++;
          pendingDetection.x = result.x;
          pendingDetection.y = result.y;
          pendingDetection.pixels = result.pixels;
          if (pendingDetection.confirmCount >= CONFIRM_FRAMES) {
            lastScoreTime = now;
            scoreDart(pendingDetection);
            pendingDetection = null;
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
    const w = canvas.width, h = canvas.height;

    // Bounding box around board region
    const { cx, cy, pxPerMm } = calibration;
    const r = R_OUTER_DOUBLE * pxPerMm * 1.2;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h, Math.ceil(cy + r));

    let sumX = 0, sumY = 0, count = 0;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * w + px) * 4;
        const diff = (Math.abs(cur[i] - ref[i]) + Math.abs(cur[i+1] - ref[i+1]) + Math.abs(cur[i+2] - ref[i+2])) / 3;
        if (diff > DIFF_THRESHOLD) {
          sumX += px;
          sumY += py;
          count++;
        }
      }
    }

    if (count < MIN_BLOB_PIXELS || count > MAX_BLOB_PIXELS) return null;
    return { x: sumX / count, y: sumY / count, pixels: count };
  }

  function scoreDart(detection) {
    // Map pixel position to board mm via homography
    const boardPt = applyH(calibration.H, [detection.x, detection.y]);
    const bx = boardPt[0], by = boardPt[1];
    const distMm = Math.hypot(bx, by);

    // Angle: 0 = up (+y direction), clockwise
    let angle = Math.atan2(bx, by);
    if (angle < 0) angle += 2 * Math.PI;

    const label = positionToLabel(distMm, angle);
    setStatus(`Detected: ${label} (${detection.pixels}px)`);
    flashDetection(detection.x, detection.y, label);

    // Update reference to include this dart
    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (commitFn) commitFn(label);
  }

  function positionToLabel(distMm, angle) {
    if (distMm <= R_BULL) return 'Bull';
    if (distMm <= R_OUTER_BULL) return '25';
    if (distMm > R_OUTER_DOUBLE) return 'Miss';
    let sectorIdx = Math.round(angle / SECTOR_ANGLE) % 20;
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
    overlayCtx.fillStyle = 'rgba(255, 210, 63, 0.8)';
    overlayCtx.fill();
    overlayCtx.strokeStyle = '#fff';
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();
    overlayCtx.font = 'bold 20px sans-serif';
    overlayCtx.fillStyle = '#fff';
    overlayCtx.textAlign = 'center';
    overlayCtx.fillText(label, x, y - 20);
    setTimeout(() => {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      drawOverlay();
    }, 1000);
  }

  function drawOverlay() {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (!calibration) {
      if (calibStep >= 1 && calibStep <= 4) {
        overlayCtx.strokeStyle = 'rgba(255,210,63,0.5)';
        overlayCtx.lineWidth = 1;
        const w = overlayCanvas.width, h = overlayCanvas.height;
        overlayCtx.beginPath();
        overlayCtx.moveTo(w / 2, 0); overlayCtx.lineTo(w / 2, h);
        overlayCtx.moveTo(0, h / 2); overlayCtx.lineTo(w, h / 2);
        overlayCtx.stroke();
        for (const p of calibPoints) {
          overlayCtx.beginPath();
          overlayCtx.arc(p[0], p[1], 8, 0, 2 * Math.PI);
          overlayCtx.fillStyle = 'rgba(255,210,63,0.9)';
          overlayCtx.fill();
        }
      }
      return;
    }
    // Draw perspective-corrected board rings
    overlayCtx.strokeStyle = 'rgba(255,210,63,0.4)';
    overlayCtx.lineWidth = 1;
    drawProjectedCircle(R_OUTER_DOUBLE);
    drawProjectedCircle(R_OUTER_TRIPLE);
    drawProjectedCircle(R_INNER_TRIPLE);
    drawProjectedCircle(R_OUTER_BULL);
    drawProjectedCircle(R_BULL);
    // Center dot
    const c = applyH(calibration.Hinv, [0, 0]);
    overlayCtx.beginPath();
    overlayCtx.arc(c[0], c[1], 4, 0, 2 * Math.PI);
    overlayCtx.fillStyle = 'rgba(255,210,63,0.8)';
    overlayCtx.fill();
  }

  function drawProjectedCircle(radiusMm) {
    const steps = 48;
    overlayCtx.beginPath();
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
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    video.srcObject = null;
    referenceFrame = null;
    document.getElementById('camDetect').disabled = true;
    document.getElementById('camRef').disabled = true;
    document.getElementById('camCalib').disabled = true;
    document.getElementById('camDetect').textContent = 'Detect';
    setStatus('Camera stopped.');
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function setStatus(msg) {
    const el = document.getElementById('camStatus');
    if (el) el.textContent = msg;
  }

  return { init, stop };
})();
