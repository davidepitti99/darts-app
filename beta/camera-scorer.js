// Camera-based dart autoscoring via frame differencing
'use strict';

const CameraScorer = (() => {
  // Board geometry (standard dartboard)
  const SECTORS = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];
  const SECTOR_ANGLE = Math.PI / 10; // 18 degrees per sector
  // Radii in mm from center (standard BDO/WDF)
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

  // Calibration: center of board in pixel coords, and pixels-per-mm scale
  let calibration = null; // { cx, cy, pxPerMm }
  let calibStep = 0; // 0=not started, 1=waiting for center, 2=waiting for edge, 3=done
  let calibPoints = [];

  // Detection parameters
  const DIFF_THRESHOLD = 50;   // pixel intensity difference to count as change
  const MIN_BLOB_PIXELS = 150; // minimum changed pixels to count as a dart
  const MAX_BLOB_PIXELS = 8000; // above this = lighting shift, not a dart
  const COOLDOWN_MS = 2000;    // ignore detections for this long after scoring
  const CONFIRM_FRAMES = 3;    // blob must persist this many consecutive frames
  let lastScoreTime = 0;
  let commitFn = null;
  let pendingDetection = null; // { x, y, pixels, confirmCount }

  function init(container, onCommit) {
    commitFn = onCommit;

    // Create UI elements
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

    // Hidden canvas for frame processing
    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });

    document.getElementById('camStart').addEventListener('click', startCamera);
    document.getElementById('camCalib').addEventListener('click', startCalibration);
    document.getElementById('camRef').addEventListener('click', captureReference);
    document.getElementById('camDetect').addEventListener('click', toggleDetection);
    document.getElementById('camStop').addEventListener('click', stop);

    overlayCanvas.addEventListener('click', onOverlayClick);

    // Load saved calibration
    try {
      const saved = localStorage.getItem('dartsCamCalib');
      if (saved) {
        calibration = JSON.parse(saved);
        calibStep = 3;
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

      // Wait for video dimensions
      await new Promise(resolve => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
      });

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;

      setStatus('Camera active. ' + (calibration ? 'Calibration loaded. Set reference frame.' : 'Calibrate the board.'));
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
    setStatus('Tap the CENTER of the dartboard (bullseye)');
    drawOverlay();
  }

  function onOverlayClick(e) {
    if (calibStep === 0 || calibStep === 3) return;
    const rect = overlayCanvas.getBoundingClientRect();
    const scaleX = overlayCanvas.width / rect.width;
    const scaleY = overlayCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (calibStep === 1) {
      calibPoints.push({ x, y });
      calibStep = 2;
      setStatus('Now tap the OUTER EDGE of the double ring (any point on the wire)');
      drawOverlay();
    } else if (calibStep === 2) {
      calibPoints.push({ x, y });
      const cx = calibPoints[0].x, cy = calibPoints[0].y;
      const ex = calibPoints[1].x, ey = calibPoints[1].y;
      const distPx = Math.hypot(ex - cx, ey - cy);
      const pxPerMm = distPx / R_OUTER_DOUBLE;

      calibration = { cx, cy, pxPerMm };
      calibStep = 3;
      try { localStorage.setItem('dartsCamCalib', JSON.stringify(calibration)); } catch (_) {}
      setStatus('Calibrated! Now "Set Reference" with no darts on board.');
      document.getElementById('camRef').disabled = false;
      drawOverlay();
    }
  }

  function captureReference() {
    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setStatus('Reference captured. Throw a dart and tap "Detect" or auto-detect is running.');
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
        // Require the blob to persist across CONFIRM_FRAMES before scoring
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
        // No blob detected — reset pending (was transient noise)
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

    // Only look within the board area (circle from calibration)
    const { cx, cy, pxPerMm } = calibration;
    const boardRadiusPx = R_OUTER_DOUBLE * pxPerMm * 1.1; // slight margin

    let sumX = 0, sumY = 0, count = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Skip pixels outside board area
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > boardRadiusPx * boardRadiusPx) continue;

        const i = (y * w + x) * 4;
        const dr = Math.abs(cur[i] - ref[i]);
        const dg = Math.abs(cur[i + 1] - ref[i + 1]);
        const db = Math.abs(cur[i + 2] - ref[i + 2]);
        const diff = (dr + dg + db) / 3;

        if (diff > DIFF_THRESHOLD) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count < MIN_BLOB_PIXELS) return null;
    if (count > MAX_BLOB_PIXELS) return null; // lighting shift, not a dart

    // Centroid of changed pixels = dart tip estimate
    const dartX = sumX / count;
    const dartY = sumY / count;

    return { x: dartX, y: dartY, pixels: count };
  }

  function scoreDart(detection) {
    const { cx, cy, pxPerMm } = calibration;
    const dx = detection.x - cx;
    const dy = detection.y - cy;
    const distMm = Math.hypot(dx, dy) / pxPerMm;

    // Angle: 0 = up (towards 20), clockwise
    let angle = Math.atan2(dx, -dy); // note: y is inverted in screen coords
    if (angle < 0) angle += 2 * Math.PI;

    const label = positionToLabel(distMm, angle);
    setStatus(`Detected: ${label} (${detection.pixels}px changed)`);

    // Flash overlay
    flashDetection(detection.x, detection.y, label);

    // Update reference to include this dart
    ctx.drawImage(video, 0, 0);
    referenceFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (commitFn) commitFn(label);
  }

  function positionToLabel(distMm, angle) {
    // Bull regions
    if (distMm <= R_BULL) return 'Bull';
    if (distMm <= R_OUTER_BULL) return '25';

    // Outside board
    if (distMm > R_OUTER_DOUBLE) return 'Miss';

    // Determine sector: sector 0 (20) is centered at 0 radians (top)
    let sectorIdx = Math.round(angle / SECTOR_ANGLE) % 20;
    const number = SECTORS[sectorIdx];

    // Determine ring
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
      if (calibStep === 1 || calibStep === 2) {
        // Draw crosshair guide
        overlayCtx.strokeStyle = 'rgba(255,210,63,0.5)';
        overlayCtx.lineWidth = 1;
        const w = overlayCanvas.width, h = overlayCanvas.height;
        overlayCtx.beginPath();
        overlayCtx.moveTo(w / 2, 0); overlayCtx.lineTo(w / 2, h);
        overlayCtx.moveTo(0, h / 2); overlayCtx.lineTo(w, h / 2);
        overlayCtx.stroke();
        // Draw calibration points already placed
        for (const p of calibPoints) {
          overlayCtx.beginPath();
          overlayCtx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
          overlayCtx.fillStyle = 'rgba(255,210,63,0.9)';
          overlayCtx.fill();
        }
      }
      return;
    }
    // Draw board outline using calibration
    const { cx, cy, pxPerMm } = calibration;
    overlayCtx.strokeStyle = 'rgba(255,210,63,0.4)';
    overlayCtx.lineWidth = 1;

    // Double ring
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, R_OUTER_DOUBLE * pxPerMm, 0, 2 * Math.PI);
    overlayCtx.stroke();

    // Triple ring
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, R_OUTER_TRIPLE * pxPerMm, 0, 2 * Math.PI);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, R_INNER_TRIPLE * pxPerMm, 0, 2 * Math.PI);
    overlayCtx.stroke();

    // Bull
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, R_OUTER_BULL * pxPerMm, 0, 2 * Math.PI);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, R_BULL * pxPerMm, 0, 2 * Math.PI);
    overlayCtx.stroke();

    // Center dot
    overlayCtx.beginPath();
    overlayCtx.arc(cx, cy, 4, 0, 2 * Math.PI);
    overlayCtx.fillStyle = 'rgba(255,210,63,0.8)';
    overlayCtx.fill();
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
