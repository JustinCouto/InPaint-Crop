/* =========================
   ===== Elements =====
   ========================= */
const fileInput     = document.getElementById('fileInput');
const brushSlider   = document.getElementById('brushSize');
const brushReadout  = document.getElementById('brushReadout');
const clearBtn      = document.getElementById('clearMask');
const saveCombined  = document.getElementById('saveCombined');

// Layout
const controlsBar   = document.querySelector('.controls');
const container     = document.getElementById('canvasContainer');
const mainCanvas    = document.getElementById('mainCanvas');
const maskCanvas    = document.getElementById('maskCanvas');
const uiCanvas      = document.getElementById('uiCanvas');

const baseCtx       = mainCanvas.getContext('2d');
const maskCtx       = maskCanvas.getContext('2d', { willReadFrequently: true });
const uiCtx         = uiCanvas.getContext('2d');

// Tools UI
const cursorToolBtn = document.getElementById('cursorTool');
const zoomInBtn     = document.getElementById('zoomIn');
const zoomOutBtn    = document.getElementById('zoomOut');
const zoomResetBtn  = document.getElementById('zoomReset');
const cropToolBtn   = document.getElementById('cropTool');

/* =========================
   ===== App State =====
   ========================= */
let originalImage   = null;       // HTMLImageElement
let displayW = 0, displayH = 0;   // fitted canvas size
let containerW = 0, containerH = 0;

// Brush
let painting = false;
let lastX = 0, lastY = 0;
let brushSize = Number(brushSlider?.value || 40);

// Zoom/pan
let zoom = 1;                     // scale
let offsetX = 0, offsetY = 0;     // CSS px translate
let zoomMode = 'none';            // 'none' | 'in' | 'out'

// Crop
let cropMode = false;             // selecting a crop rect
let cropSelecting = false;
let cropStart = null;             // {x,y} in canvas coords
let cropRect = null;              // {x,y,w,h} in canvas coords if applied

// ----- Tunables -----
const VIEWPORT_SCALE = 0.90;
const SAFE_BOTTOM    = 12;
const MIN_AVAIL_H    = 240;
const EXPORT_FILENAME = 'combined-image.png';
// Allow higher zoom when fitting a very small crop
const MAX_AUTO_ZOOM = 32;

/* =========================
   ===== Utilities =====
   ========================= */
function sizeCanvas(canvas, ctx, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width  = `${Math.round(w)}px`;
  canvas.style.height = `${Math.round(h)}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function setAllSizes(w, h, snapshotMaskImage = null) {
  container.style.width  = `${Math.round(w)}px`;
  container.style.height = `${Math.round(h)}px`;

  sizeCanvas(mainCanvas, baseCtx, w, h);
  sizeCanvas(maskCanvas, maskCtx, w, h);
  sizeCanvas(uiCanvas,   uiCtx,   w, h);

  if (snapshotMaskImage) {
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.drawImage(
      snapshotMaskImage,
      0, 0, snapshotMaskImage.width, snapshotMaskImage.height,
      0, 0, w, h
    );
  }

  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
}

function vh() {
  return window.visualViewport?.height ?? window.innerHeight;
}

function baselineTopPx() {
  const contTop = container.getBoundingClientRect().top;
  const controlsBottom = controlsBar ? controlsBar.getBoundingClientRect().bottom : 0;
  return Math.max(contTop, controlsBottom);
}

function computeFitSize(img) {
  const maxW = Math.round(window.innerWidth * VIEWPORT_SCALE);
  const baseline = baselineTopPx();
  let availH = Math.max(0, vh() - baseline - SAFE_BOTTOM);
  if (availH < MIN_AVAIL_H) availH = Math.min(Math.max(MIN_AVAIL_H, vh() * 0.6), vh());
  const maxH = Math.round(availH * VIEWPORT_SCALE);

  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);

  return {
    w: Math.max(1, Math.round(img.naturalWidth  * scale)),
    h: Math.max(1, Math.round(img.naturalHeight * scale)),
  };
}

function updateContainerWH() {
  const rect = container.getBoundingClientRect();
  containerW = rect.width;
  containerH = rect.height;
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } else {
      const dataURL = canvas.toDataURL(type, quality);
      const bstr = atob(dataURL.split(',')[1] || '');
      const n = bstr.length;
      const u8 = new Uint8Array(n);
      for (let i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
      resolve(new Blob([u8], { type }));
    }
  });
}

function downloadBlob(blob, filename) {
  if (!blob) return;
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/* =========================
   ===== Zoom / Pan =====
   ========================= */
function applyTransform() {
  const t = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
  [mainCanvas, maskCanvas, uiCanvas].forEach((c) => {
    c.style.transform = t;
    c.style.transformOrigin = 'top left';
  });
}

function clampPan() {
  const imgW = zoom * displayW;
  const imgH = zoom * displayH;

  const minOffsetX = containerW - imgW;
  const maxOffsetX = 0;
  const minOffsetY = containerH - imgH;
  const maxOffsetY = 0;

  offsetX = Math.min(maxOffsetX, Math.max(minOffsetX, offsetX));
  offsetY = Math.min(maxOffsetY, Math.max(minOffsetY, offsetY));
}

function setZoomModeUI() {
  [cursorToolBtn, zoomInBtn, zoomOutBtn].forEach(b => b && b.classList.remove('active'));
  if (zoomMode === 'none' && cursorToolBtn) cursorToolBtn.classList.add('active');
  if (zoomMode === 'in'   && zoomInBtn)     zoomInBtn.classList.add('active');
  if (zoomMode === 'out'  && zoomOutBtn)    zoomOutBtn.classList.add('active');

  if (cropMode) {
    maskCanvas.style.cursor = 'crosshair';
  } else if (zoomMode === 'in') {
    maskCanvas.style.cursor = 'zoom-in';
  } else if (zoomMode === 'out') {
    maskCanvas.style.cursor = 'zoom-out';
  } else {
    maskCanvas.style.cursor = 'crosshair';
  }
}

function setZoomMode(mode) {
  zoomMode = mode;
  setZoomModeUI();
}

function screenToCanvas(sx, sy) {
  return { x: (sx - offsetX) / zoom, y: (sy - offsetY) / zoom };
}

function zoomAt(factor, sx, sy) {
  updateContainerWH();
  const cx = (sx - offsetX) / zoom;
  const cy = (sy - offsetY) / zoom;
  const newZoom = Math.min(8, Math.max(1, zoom * factor));

  const targetX = containerW / 2;
  const targetY = containerH / 2;

  offsetX = targetX - newZoom * cx;
  offsetY = targetY - newZoom * cy;
  zoom = newZoom;

  clampPan();
  applyTransform();
}

function resetZoom() {
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  clampPan();
  applyTransform();
  setZoomMode('none');
}

/* =========================
   ===== Image & Redraw =====
   ========================= */
async function redrawAll(preserveMask = true) {
  if (!originalImage) return;

  let snapshot = null;
  if (preserveMask) {
    snapshot = document.createElement('canvas');
    snapshot.width  = maskCanvas.width;
    snapshot.height = maskCanvas.height;
    snapshot.getContext('2d').drawImage(maskCanvas, 0, 0);
  }

  const fit = computeFitSize(originalImage);
  displayW = fit.w; displayH = fit.h;

  container.classList.add('has-image');
  setAllSizes(displayW, displayH, preserveMask ? snapshot : null);

  void container.offsetWidth;
  await new Promise(requestAnimationFrame);

  baseCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  baseCtx.drawImage(originalImage, 0, 0, displayW, displayH);

  updateContainerWH();
  resetZoom();
  clearCropView();
  applyTransform();
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* =========================
   ===== Brush / Mask =====
   ========================= */
function setBrush(size) {
  brushSize = Number(size);
  if (brushReadout) brushReadout.textContent = `${brushSize}px`;
}

function drawTo(x, y, begin = false) {
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  maskCtx.strokeStyle = 'rgba(255,0,0,1)';
  maskCtx.lineWidth = brushSize;
  maskCtx.beginPath();
  if (begin) maskCtx.moveTo(x, y);
  else maskCtx.moveTo(lastX, lastY);
  maskCtx.lineTo(x, y);
  maskCtx.stroke();
  lastX = x; lastY = y;
}

function getPointerCanvasPos(evt) {
  const r = container.getBoundingClientRect();
  const sx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left;
  const sy = (evt.touches ? evt.touches[0].clientY : evt.clientY) - r.top;
  return screenToCanvas(sx, sy);
}

/* =========================
   ===== Crop Helpers =====
   ========================= */
function normalizeRect(a, b) {
  const x1 = Math.max(0, Math.min(displayW, a.x));
  const y1 = Math.max(0, Math.min(displayH, a.y));
  const x2 = Math.max(0, Math.min(displayW, b.x));
  const y2 = Math.max(0, Math.min(displayH, b.y));
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.max(1, Math.abs(x2 - x1));
  const h = Math.max(1, Math.abs(y2 - y1));
  return { x, y, w, h };
}

function drawCropMarquee(rect) {
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
  if (!rect) return;

  uiCtx.save();
  uiCtx.fillStyle = 'rgba(0,0,0,0.35)';
  uiCtx.fillRect(0, 0, displayW, displayH);
  uiCtx.clearRect(rect.x, rect.y, rect.w, rect.h);

  uiCtx.strokeStyle = 'white';
  uiCtx.lineWidth = 1;
  uiCtx.setLineDash([6, 4]);
  uiCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  uiCtx.setLineDash([]);
  uiCtx.fillStyle = '#ffffff';
  const s = 6;
  uiCtx.fillRect(rect.x - s/2, rect.y - s/2, s, s);
  uiCtx.fillRect(rect.x + rect.w - s/2, rect.y - s/2, s, s);
  uiCtx.fillRect(rect.x - s/2, rect.y + rect.h - s/2, s, s);
  uiCtx.fillRect(rect.x + rect.w - s/2, rect.y + rect.h - s/2, s, s);
  uiCtx.restore();
}

/**
 * Update view so the selected crop:
 *  - is clipped to the crop rect
 *  - is zoomed to FILL the entire canvas area (cover), centered
 */
function applyCropView(rect) {
  if (!rect) return;

  // Build clip-path around the crop (so only crop area remains visible)
  const insetTop    = rect.y;
  const insetLeft   = rect.x;
  const insetBottom = displayH - (rect.y + rect.h);
  const insetRight  = displayW - (rect.x + rect.w);
  const clip = `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`;
  [mainCanvas, maskCanvas, uiCanvas].forEach((c) => {
    c.style.clipPath = clip;
    c.style.webkitClipPath = clip;
  });

  // Now zoom & center so the crop FILLS the canvas area (cover fit)
  updateContainerWH(); // containerW/H match displayW/H
  const scaleW = containerW / rect.w;
  const scaleH = containerH / rect.h;
  const newZoom = Math.min(MAX_AUTO_ZOOM, Math.max(1, Math.max(scaleW, scaleH)));

  zoom = newZoom;

  // Center the crop in the container
  offsetX = (containerW - rect.w * zoom) / 2 - rect.x * zoom;
  offsetY = (containerH - rect.h * zoom) / 2 - rect.y * zoom;

  // Keep within pan limits for the (zoomed) full image
  clampPan();
  applyTransform();
}

function clearCropView() {
  cropRect = null;
  uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
  [mainCanvas, maskCanvas, uiCanvas].forEach((c) => {
    c.style.clipPath = '';
    c.style.webkitClipPath = '';
  });
}

/* =========================
   ===== Event Wiring =====
   ========================= */
// File
fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const img = await loadImageFromFile(file);
    if (img.decode) { try { await img.decode(); } catch {} }
    originalImage = img;

    await redrawAll(false);

    try { URL.revokeObjectURL(img.src); } catch {}
  } catch (err) {
    console.error('Failed to load image:', err);
  }
});

// Brush size
brushSlider?.addEventListener('input', (e) => setBrush(e.target.value));

// Clear mask
clearBtn?.addEventListener('click', () => {
  if (!originalImage) return;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
});

// Painting / Zoom / Crop
maskCanvas.addEventListener('pointerdown', (e) => {
  if (!originalImage) return;

  if (cropMode) {
    cropSelecting = true;
    const p = getPointerCanvasPos(e);
    cropStart = p;
    drawCropMarquee(normalizeRect(p, p));
    return;
  }

  if (zoomMode !== 'none') {
    const r = container.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const factor = (zoomMode === 'in') ? 1.25 : 0.8;
    zoomAt(factor, sx, sy);
    return;
  }

  maskCanvas.setPointerCapture(e.pointerId);
  painting = true;

  const p = getPointerCanvasPos(e);
  lastX = p.x; lastY = p.y;
  drawTo(p.x, p.y, true);
});

maskCanvas.addEventListener('pointermove', (e) => {
  if (!originalImage) return;

  if (cropMode && cropSelecting) {
    const p = getPointerCanvasPos(e);
    const rect = normalizeRect(cropStart, p);
    drawCropMarquee(rect);
    return;
  }

  if (!painting) return;
  const p = getPointerCanvasPos(e);
  drawTo(p.x, p.y);
});

const stopPainting = () => { painting = false; };
maskCanvas.addEventListener('pointerup', (e) => {
  if (!originalImage) return;

  if (cropMode && cropSelecting) {
    cropSelecting = false;
    const p = getPointerCanvasPos(e);
    const rect = normalizeRect(cropStart, p);

    if (rect.w <= 1 || rect.h <= 1) {
      uiCtx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
      return; // keep crop mode active for another try
    }

    cropRect = rect;

    // Apply cropped view (now fills canvas)
    applyCropView(cropRect);

    // Exit crop mode and return to pointer/mask mode
    cropMode = false;
    cropToolBtn?.classList.remove('active');
    setZoomMode('none');
    drawCropMarquee(null);
    return;
  }

  stopPainting();
});
maskCanvas.addEventListener('pointerleave', stopPainting);
maskCanvas.addEventListener('pointercancel', stopPainting);

// Prevent native browser zoom on Ctrl + Wheel inside the app
container.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });

// Zoom Buttons & Shortcuts
cursorToolBtn?.addEventListener('click', () => {
  cropMode = false;
  cropToolBtn?.classList.remove('active');
  setZoomMode('none');
});

zoomInBtn?.addEventListener('click', () => {
  cropMode = false;
  cropToolBtn?.classList.remove('active');
  setZoomMode(zoomMode === 'in' ? 'none' : 'in');
});

zoomOutBtn?.addEventListener('click', () => {
  cropMode = false;
  cropToolBtn?.classList.remove('active');
  setZoomMode(zoomMode === 'out' ? 'none' : 'out');
});

zoomResetBtn?.addEventListener('click', () => {
  resetZoom();
  clearCropView(); // Reset undoes crop
});

// Crop tool toggle
cropToolBtn?.addEventListener('click', () => {
  if (!originalImage) { alert('Upload an image first.'); return; }

  if (cropMode) {
    cropMode = false;
    cropToolBtn.classList.remove('active');
    drawCropMarquee(null);
  } else {
    cropMode = true;
    cropToolBtn.classList.add('active');
    setZoomMode('none');
    drawCropMarquee(null);
  }
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;

  updateContainerWH();
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    zoomAt(1.25, containerW/2, containerH/2);
    setZoomMode('none');
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    zoomAt(0.8, containerW/2, containerH/2);
    setZoomMode('none');
  } else if (e.key === '0') {
    e.preventDefault();
    resetZoom();
    clearCropView();
  }
});

// Resize
let resizeTimer;
window.addEventListener('resize', () => {
  if (!originalImage) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => redrawAll(true), 100);
});

// Init brush readout
setBrush(brushSize);

// Debug
window.__inpaintDebug = {
  get zoom() { return zoom; },
  get offset() { return ({ offsetX, offsetY }); },
  resetZoom,
  setZoomMode,
};

/* =========================
   ===== Save & Prompt =====
   ========================= */
const promptDialog   = document.getElementById('promptDialog');
const promptTextarea = document.getElementById('promptTextarea');
const copyPromptBtn  = document.getElementById('copyPrompt');
const copyImageBtn   = document.getElementById('copyImage');
const copyChatGPTBtn  = document.getElementById('copyChatGPT');

function buildInpaintPrompt() {
  const width = cropRect ? Math.round(cropRect.w) : displayW;
  const height = cropRect ? Math.round(cropRect.h) : displayH;
  return `You are an expert image editing assistant.

I will upload ONE file: combined-image.png (resolution: ${width}×${height} px).
This image shows the original photo with SOLID RED (#ff0000) brush strokes drawn on top wherever content should be REMOVED/REPLACED.

Task:
- Remove ONLY the regions covered by the red strokes and synthesize realistic content consistent with nearby context.
- Preserve all unmarked areas exactly as in the original photo.
- Maintain scene lighting, perspective, textures, and edges.
- Output image must be ${width}×${height} px.

IMPORTANT OUTPUT (no base64 wall):
- Return/attach the edited image as a rendered image preview or image file (PNG).
- Do NOT return a long base64 string in the message body.
- If your interface cannot render images, attach a PNG file instead of base64 text.`;
}

function renderCombinedCanvas() {
  const full = document.createElement('canvas');
  full.width = mainCanvas.width;
  full.height = mainCanvas.height;
  const fctx = full.getContext('2d');

  fctx.drawImage(mainCanvas, 0, 0);
  fctx.drawImage(maskCanvas, 0, 0);

  if (cropRect) {
    // Crop using cropRect directly, since full is already at device pixel size
    const sx = Math.round(cropRect.x);
    const sy = Math.round(cropRect.y);
    const sw = Math.round(cropRect.w);
    const sh = Math.round(cropRect.h);

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const octx = out.getContext('2d');
    octx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    return out;
  }

  return full;
}

let isSaving = false;
// Modify the bindSaveHandlerOnce function:
function bindSaveHandlerOnce() {
  if (!saveCombined || saveCombined.dataset.bound === '1') return;
  saveCombined.dataset.bound = '1';

  saveCombined.addEventListener('click', async () => {
    if (isSaving) return;
    if (!originalImage) { alert('Upload an image first.'); return; }
    isSaving = true;

    try {
      const exportCanvas = renderCombinedCanvas();
      // Instead of downloading, store the image data
      const imageBlob = await canvasToBlob(exportCanvas, 'image/png');
      const imageFile = new File([imageBlob], 'combined-image.png', { type: 'image/png' });

      if (promptDialog && typeof promptDialog.showModal === 'function') {
        // Set the prompt text
        if (promptTextarea) promptTextarea.value = buildInpaintPrompt();
        
        // Store the file for copying
        window.__inpaintImageFile = imageFile;
        
        promptDialog.showModal();
      }
    } catch (err) {
      console.error('Failed to prepare image:', err);
      alert('Sorry—there was a problem preparing the image.');
    } finally {
      isSaving = false;
    }
  });
}
bindSaveHandlerOnce();


// ORIGINAL WORKING CHATGPT CODE (copied from your initial prompt)
if (copyPromptBtn && copyImageBtn && copyChatGPTBtn && promptTextarea) {
  // Copy text prompt only (for Gemini)
  copyPromptBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(promptTextarea.value);
      copyPromptBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyPromptBtn.textContent = 'Copy Prompt';
      }, 1200);
    } catch (err) {
      console.error('Failed to copy prompt:', err);
      promptTextarea.select();
      document.execCommand('copy');
    }
  });

  // Copy image only (for Gemini)
  copyImageBtn.addEventListener('click', async () => {
    try {
      if (!window.__inpaintImageFile) {
        throw new Error("Image file is not available.");
      }
      const clipboardItem = new ClipboardItem({
        'image/png': window.__inpaintImageFile
      });
      await navigator.clipboard.write([clipboardItem]);
      copyImageBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyImageBtn.textContent = 'Copy Image';
      }, 1200);
    } catch (err) {
      console.error('Failed to copy image:', err);
      alert('Failed to copy image to clipboard');
    }
  });

  // Original combined copy for ChatGPT (keep existing functionality)
  copyChatGPTBtn.addEventListener('click', async () => {
    let imageUrl = null;
    try {
      if (!window.__inpaintImageFile) {
        throw new Error("Image file is not available.");
      }

      const imageBlob = window.__inpaintImageFile;
      const text = promptTextarea.value;
      
      imageUrl = URL.createObjectURL(imageBlob);
      const htmlContent = `<p>${text.replace(/\n/g, '<br>')}</p><img src="${imageUrl}">`;
      
      const textBlob = new Blob([text], { type: "text/plain" });
      const htmlBlob = new Blob([htmlContent], { type: "text/html" });

      const clipboardItem = new ClipboardItem({
        [imageBlob.type]: imageBlob,
        "text/plain": textBlob,
        "text/html": htmlBlob,
      });

      await navigator.clipboard.write([clipboardItem]);
      copyChatGPTBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyChatGPTBtn.textContent = 'Copy for ChatGPT';
      }, 1200);
    } catch (err) {
      console.error('Failed to copy:', err);
      await navigator.clipboard.writeText(promptTextarea.value);
      copyChatGPTBtn.textContent = 'Copied text only!';
      setTimeout(() => {
        copyChatGPTBtn.textContent = 'Copy for ChatGPT';
      }, 1200);
    } finally {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    }
  });
}