"use strict";

/* ── State ───────────────────────────────────────────────── */
const state = {
  imageUrl: null,  // blob URL of correctly-oriented display JPEG
  exif: null,
  targetF: 2.8,
};

/* ── DOM refs ────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const uploadSection    = $("upload-section");
const loadingSection   = $("loading-section");
const resultSection    = $("result-section");
const errorBanner      = $("error-banner");
const dropZone         = $("drop-zone");
const fileInput        = $("file-input");
const loadingMsg       = $("loading-msg");

const imgOriginal      = $("img-original");
const canvasSimulated  = $("canvas-simulated");
const sliderF          = $("target-f");
const numberF          = $("target-f-number");
const displayF         = $("target-f-display");
const evLabel          = $("ev-label");
const simLabel         = $("sim-label");
const originalMeta     = $("original-meta");
const simulatedMeta    = $("simulated-meta");
const downloadBtn      = $("download-btn");
const resetBtn         = $("reset-btn");
const exportCanvas     = $("export-canvas");

/* ── Upload / drag-drop ──────────────────────────────────── */
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) processFile(fileInput.files[0]);
});

/* ── Format detection ────────────────────────────────────── */
const RAW_EXTS = new Set(["arw","raw","cr2","cr3","nef","dng","raf","orf","rw2","pef","srw"]);

function isRawFile(file) {
  return RAW_EXTS.has(file.name.split(".").pop().toLowerCase());
}

/* ── File processing ─────────────────────────────────────── */
async function processFile(file) {
  showError(null);
  show("loading");

  try {
    let imageBlob, exif;

    if (isRawFile(file)) {
      loadingMsg.textContent = "Reading RAW file…";
      const buffer = await file.arrayBuffer();

      loadingMsg.textContent = "Extracting EXIF metadata…";
      exif = await extractEXIF(buffer);

      loadingMsg.textContent = "Extracting preview image…";
      const jpegBytes = extractEmbeddedJPEG(buffer);
      if (!jpegBytes || jpegBytes.length < 10_000) {
        throw new Error(
          "No usable embedded preview found. " +
          "Sony ARW, Canon CR2/CR3, Nikon NEF, and DNG are supported."
        );
      }
      imageBlob = new Blob([jpegBytes], { type: "image/jpeg" });

    } else {
      loadingMsg.textContent = "Reading image…";
      exif = await extractEXIF(await file.arrayBuffer());
      imageBlob = file;
    }

    // Resize + bake EXIF orientation into pixels (fixes rotation on iPhone JPEGs)
    loadingMsg.textContent = "Preparing image…";
    const displayUrl = await orientAndResize(imageBlob, 1600);

    if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
    state.imageUrl = displayUrl;
    state.exif     = exif;

    populateExif(exif);

    await new Promise((resolve, reject) => {
      imgOriginal.onload  = resolve;
      imgOriginal.onerror = reject;
      imgOriginal.src     = state.imageUrl;
    });

    await prepareSource(imgOriginal);

    const origF = exif.f_number;
    if (origF) {
      const next    = nextFullStop(origF);
      state.targetF = next;
      sliderF.value = Math.log2(next);
      numberF.value = fmtF(next);
    }

    applySimulation();
    show("result");

  } catch (err) {
    showError(err.message);
    show("upload");
  }
}

/* ── Orient + resize using createImageBitmap ─────────────── */
/**
 * createImageBitmap with imageOrientation:'from-image' reads the EXIF
 * orientation tag and applies the rotation before returning the bitmap.
 * This fixes the sideways/upside-down rendering of iPhone photos.
 * The output JPEG has pixels already in the correct orientation with
 * no EXIF rotation tag needed.
 */
async function orientAndResize(blob, maxWidth) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = srcW > maxWidth ? maxWidth / srcW : 1;
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const oc  = new OffscreenCanvas(w, h);
  const ctx = oc.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const out = await oc.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return URL.createObjectURL(out);
}

/* ── EXIF extraction ─────────────────────────────────────── */
async function extractEXIF(buffer) {
  try {
    const data = await exifr.parse(buffer, { tiff: true, exif: true, iptc: false, xmp: false });
    if (!data) return emptyEXIF();
    return {
      f_number:          data.FNumber       ?? null,
      iso:               data.ISO            ?? null,
      shutter_speed_raw: fmtShutter(data.ExposureTime),
      shutter_speed:     data.ExposureTime   ?? null,
      focal_length:      data.FocalLength    ?? null,
      camera: [data.Make, data.Model].filter(Boolean).join(" ").trim() || null,
      lens:              data.LensModel      ?? null,
    };
  } catch {
    return emptyEXIF();
  }
}

function emptyEXIF() {
  return { f_number: null, iso: null, shutter_speed_raw: null,
           shutter_speed: null, focal_length: null, camera: null, lens: null };
}

function fmtShutter(s) {
  if (s == null) return null;
  if (s >= 1)    return s.toFixed(1) + "s";
  return `1/${Math.round(1 / s)}`;
}

/* ── Embedded JPEG extraction (RAW binary) ───────────────── */
function extractEmbeddedJPEG(buffer) {
  try {
    const j = parseTIFFForJPEG(buffer);
    if (j && j.length > 50_000) return j;
  } catch { /* fall through */ }
  return findLargestJPEG(buffer);
}

function parseTIFFForJPEG(buffer) {
  const view = new DataView(buffer);
  const bo   = view.getUint16(0);
  if (bo !== 0x4949 && bo !== 0x4D4D) return null;
  const le = bo === 0x4949;
  if (view.getUint16(2, le) !== 42) return null;

  let ifdOffset = view.getUint32(4, le);
  let best = null;

  for (let d = 0; d < 8 && ifdOffset > 0 && ifdOffset + 2 < buffer.byteLength; d++) {
    const { jpeg, nextOffset } = readIFDForJPEG(view, ifdOffset, le, buffer);
    if (jpeg && (!best || jpeg.length > best.length)) best = jpeg;
    if (!nextOffset || nextOffset === ifdOffset || nextOffset >= buffer.byteLength) break;
    ifdOffset = nextOffset;
  }
  return best;
}

function readIFDForJPEG(view, offset, le, buffer) {
  if (offset + 2 > buffer.byteLength) return { jpeg: null, nextOffset: 0 };
  const count = view.getUint16(offset, le);
  let jpegOff = 0, jpegLen = 0;
  for (let i = 0; i < count; i++) {
    const base = offset + 2 + i * 12;
    if (base + 12 > buffer.byteLength) break;
    const tag = view.getUint16(base, le);
    if (tag === 0x0201) jpegOff = view.getUint32(base + 8, le);
    if (tag === 0x0202) jpegLen = view.getUint32(base + 8, le);
  }
  let jpeg = null;
  if (jpegOff > 0 && jpegLen > 0 && jpegOff + jpegLen <= buffer.byteLength) {
    jpeg = new Uint8Array(buffer, jpegOff, jpegLen);
  }
  const nextPos = offset + 2 + count * 12;
  const nextOffset = nextPos + 4 <= buffer.byteLength ? view.getUint32(nextPos, le) : 0;
  return { jpeg, nextOffset };
}

function findLargestJPEG(buffer) {
  const bytes = new Uint8Array(buffer);
  const limit = Math.min(bytes.length, 60 * 1024 * 1024);
  let best = null;
  for (let i = 0; i < limit - 3; i++) {
    if (bytes[i] !== 0xFF || bytes[i+1] !== 0xD8 || bytes[i+2] !== 0xFF) continue;
    const scanEnd = Math.min(bytes.length, i + 40 * 1024 * 1024);
    for (let j = i + 2; j < scanEnd - 1; j++) {
      if (bytes[j] === 0xFF && bytes[j+1] === 0xD9) {
        const len = j + 2 - i;
        if (!best || len > best.length) best = bytes.subarray(i, j + 2);
        i += len - 1;
        break;
      }
    }
  }
  return best;
}

/* ── EXIF display ────────────────────────────────────────── */
function populateExif(exif) {
  $("exif-camera").textContent  = exif.camera       || "—";
  $("exif-lens").textContent    = exif.lens          || "—";
  $("exif-f").textContent       = exif.f_number != null ? fmtF(exif.f_number) : "—";
  $("exif-shutter").textContent = exif.shutter_speed_raw || "—";
  $("exif-iso").textContent     = exif.iso != null   ? exif.iso : "—";
  $("exif-fl").textContent      = exif.focal_length  ? `${exif.focal_length.toFixed(0)}mm` : "—";

  $("ei-camera").style.display = exif.camera ? "" : "none";
  $("ei-lens").style.display   = exif.lens   ? "" : "none";

  const parts = [];
  if (exif.f_number != null)    parts.push(`f/${fmtF(exif.f_number)}`);
  if (exif.shutter_speed_raw)   parts.push(exif.shutter_speed_raw + "s");
  if (exif.iso != null)         parts.push(`ISO ${exif.iso}`);
  originalMeta.textContent = parts.join("  ·  ");
}

/* ── Source pixel cache ──────────────────────────────────── */
let sourcePixels = null;
let sourceWidth  = 0;
let sourceHeight = 0;

async function prepareSource(imgEl) {
  // Use createImageBitmap to ensure consistent, orientation-correct pixel reading
  const bitmap = await createImageBitmap(imgEl);
  const w = bitmap.width;
  const h = bitmap.height;
  const oc  = new OffscreenCanvas(w, h);
  const ctx = oc.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData  = ctx.getImageData(0, 0, w, h);
  sourcePixels     = new Uint8Array(imageData.data.buffer.slice(0));
  sourceWidth      = w;
  sourceHeight     = h;
  canvasSimulated.width  = w;
  canvasSimulated.height = h;
}

/* ── FPV tone mapping ────────────────────────────────────── */
function tonemapFPV(x) {
  if (x <= 0) return 0.003;
  if (x < 0.01) {
    const t = x / 0.01;
    return 0.003 * (1 - t) + x * t;
  }
  if (x <= 0.90) return x;
  const over = x - 0.90;
  return 0.90 + 0.10 * (1 - Math.exp(-over * 30));
}

function buildLUT(multiplier) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(encodeGamma(tonemapFPV(decodeGamma(i / 255) * multiplier)) * 255);
  }
  return lut;
}

/* ── Canvas renderer ─────────────────────────────────────── */
let rafId             = null;
let pendingMultiplier = 1;

function scheduleRender(multiplier) {
  pendingMultiplier = multiplier;
  if (rafId === null) {
    rafId = requestAnimationFrame(() => {
      renderSimulated(pendingMultiplier);
      rafId = null;
    });
  }
}

function renderSimulated(multiplier) {
  if (!sourcePixels) return;
  const lut = buildLUT(multiplier);
  const n   = sourcePixels.length;
  const dst = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 4) {
    dst[i]   = lut[sourcePixels[i]];
    dst[i+1] = lut[sourcePixels[i+1]];
    dst[i+2] = lut[sourcePixels[i+2]];
    dst[i+3] = sourcePixels[i+3];
  }
  canvasSimulated.getContext("2d")
    .putImageData(new ImageData(dst, sourceWidth, sourceHeight), 0, 0);
}

/* ── Simulation ──────────────────────────────────────────── */
function applySimulation() {
  const origF   = state.exif?.f_number;
  const targetF = state.targetF;

  let multiplier = 1;
  if (origF && origF > 0 && targetF > 0) multiplier = (origF / targetF) ** 2;

  scheduleRender(multiplier);

  const evStops = origF ? Math.log2(multiplier) : 0;
  const sign    = evStops > 0 ? "+" : "";
  const stops   = Math.abs(evStops);
  evLabel.textContent = stops < 0.05
    ? "same exposure"
    : sign + evStops.toFixed(2) + (evStops > 0 ? " stops brighter" : " stops darker");

  displayF.textContent = fmtF(targetF);
  simLabel.textContent = `Simulated f/${fmtF(targetF)}`;
  simulatedMeta.textContent = stops < 0.05
    ? "Same exposure"
    : (evStops > 0 ? `+${stops.toFixed(1)} EV` : `${stops.toFixed(1)} EV darker`);
}

/* ── Slider / number input ───────────────────────────────── */
sliderF.addEventListener("input", () => {
  const f = Math.pow(2, parseFloat(sliderF.value));
  state.targetF = f;
  numberF.value = fmtF(f);
  applySimulation();
});

numberF.addEventListener("change", () => {
  let v = parseFloat(numberF.value);
  if (isNaN(v) || v <= 0) return;
  v = Math.max(0.3, Math.min(v, 64));
  state.targetF = v;
  sliderF.value = Math.log2(v);
  numberF.value = fmtF(v);
  applySimulation();
});

/* ── Download ────────────────────────────────────────────── */
downloadBtn.addEventListener("click", downloadComparison);

async function downloadComparison() {
  downloadBtn.textContent = "Preparing…";
  downloadBtn.disabled    = true;

  const orig    = state.exif;
  const targetF = state.targetF;
  const origF   = orig?.f_number;

  try {
    const srcImg = await loadImage(state.imageUrl);
    const W = srcImg.naturalWidth;
    const H = srcImg.naturalHeight;

    const LABEL_H  = 56;
    const FOOTER_H = 44;
    const GAP      = 16;
    const PAD      = 24;

    exportCanvas.width  = W * 2 + GAP + PAD * 2;
    exportCanvas.height = H + LABEL_H + FOOTER_H + PAD * 2;
    const canvasW = exportCanvas.width;
    const canvasH = exportCanvas.height;

    const ctx = exportCanvas.getContext("2d");
    ctx.fillStyle = "#0d0f12";
    ctx.fillRect(0, 0, canvasW, canvasH);

    const lx   = PAD;
    const rx   = PAD + W + GAP;
    const imgY = PAD + LABEL_H;

    // Left label (original)
    ctx.fillStyle = "#161a1f";
    ctx.fillRect(lx, PAD, W, LABEL_H);
    ctx.fillStyle = "#e4e8ef";
    ctx.font = "bold 22px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("Original", lx + 14, PAD + 34);
    if (origF) {
      ctx.fillStyle = "#7a8494";
      ctx.font = "16px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(`f/${fmtF(origF)}`, lx + W - measureText(ctx, `f/${fmtF(origF)}`, 16) - 14, PAD + 34);
    }

    // Right label (simulated)
    ctx.fillStyle = "#161a1f";
    ctx.fillRect(rx, PAD, W, LABEL_H);
    ctx.fillStyle = "#e8a838";
    ctx.font = "bold 22px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(`Simulated f/${fmtF(targetF)}`, rx + 14, PAD + 34);
    if (origF) {
      const ev   = 2 * Math.log2(origF / targetF);
      const sign = ev > 0 ? "+" : "";
      ctx.fillStyle = "#5b9bd5";
      ctx.font = "15px -apple-system, BlinkMacSystemFont, sans-serif";
      const t = `${sign}${ev.toFixed(2)} EV`;
      ctx.fillText(t, rx + W - measureText(ctx, t, 15) - 14, PAD + 34);
    }

    ctx.fillStyle = "#2a2f38";
    ctx.fillRect(lx, PAD + LABEL_H - 1, W * 2 + GAP, 1);

    // Draw original
    ctx.drawImage(srcImg, lx, imgY, W, H);

    // Draw simulated with LUT
    let multiplier = 1;
    if (origF && origF > 0 && targetF > 0) multiplier = (origF / targetF) ** 2;
    const offCanvas = new OffscreenCanvas(W, H);
    const offCtx    = offCanvas.getContext("2d");
    offCtx.drawImage(srcImg, 0, 0, W, H);
    const lut = buildLUT(multiplier);
    const id  = offCtx.getImageData(0, 0, W, H);
    const d   = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]];
    }
    offCtx.putImageData(id, 0, 0);
    ctx.drawImage(offCanvas, rx, imgY, W, H);

    // Footer
    const footerY = imgY + H;
    ctx.fillStyle = "#161a1f";
    ctx.fillRect(0, footerY, canvasW, FOOTER_H + PAD);
    ctx.fillStyle = "#7a8494";
    ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
    const fp = [];
    if (orig?.camera)            fp.push(orig.camera);
    if (orig?.lens)              fp.push(orig.lens);
    if (orig?.shutter_speed_raw) fp.push(orig.shutter_speed_raw + "s");
    if (orig?.iso != null)       fp.push(`ISO ${orig.iso}`);
    if (orig?.focal_length)      fp.push(`${orig.focal_length.toFixed(0)}mm`);
    ctx.fillText(fp.join("  ·  "), PAD, footerY + 26);
    ctx.fillStyle = "#2a2f38";
    ctx.fillText("F-Stop Comparison", canvasW - PAD - measureText(ctx, "F-Stop Comparison", 13), footerY + 26);

    exportCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement("a");
      a.href    = url;
      const oS  = origF  ? `f${fmtF(origF).replace(".", "_")}` : "orig";
      const tS  = `f${fmtF(targetF).replace(".", "_")}`;
      a.download = `fstop_${oS}_vs_${tS}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/jpeg", 0.93);

  } finally {
    downloadBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download`;
    downloadBtn.disabled = false;
  }
}

/* ── sRGB gamma ──────────────────────────────────────────── */
function decodeGamma(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function encodeGamma(v) {
  if (v <= 0) return 0; if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/* ── Reset ───────────────────────────────────────────────── */
resetBtn.addEventListener("click", () => {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.exif     = null;
  sourcePixels   = null;
  imgOriginal.src = "";
  canvasSimulated.getContext("2d").clearRect(0, 0, canvasSimulated.width, canvasSimulated.height);
  fileInput.value = "";
  show("upload");
  showError(null);
});

/* ── Helpers ─────────────────────────────────────────────── */
function show(screen) {
  uploadSection.classList.toggle("hidden",  screen !== "upload");
  loadingSection.classList.toggle("hidden", screen !== "loading");
  resultSection.classList.toggle("hidden",  screen !== "result");
}

function showError(msg) {
  errorBanner.textContent = msg ? "Error: " + msg : "";
  errorBanner.classList.toggle("hidden", !msg);
}

function fmtF(v) {
  if (v == null) return "?";
  return parseFloat(v.toFixed(v < 2 ? 2 : 1)).toString();
}

function nextFullStop(f) {
  const stops = [0.3, 0.5, 0.7, 1.0, 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11, 16, 22];
  return stops.find((s) => s > f) ?? Math.round(f * 1.4 * 10) / 10;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src     = src;
  });
}

function measureText(ctx, text, size) {
  ctx.font = `${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  return ctx.measureText(text).width;
}
