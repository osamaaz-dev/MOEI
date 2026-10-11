'use strict';

/* =====================================================================
   الإعدادات
   ===================================================================== */
const CONFIG = {
  maxPhotos: 10,
  jpegQuality: 0.92,
};

// القوالب: ملف PNG شفاف يوضع فوق الصورة بنفس القياس
const FORMATS = {
  post:  { w: 1280, h: 853,  overlay: 'templates/post.png',  label: 'أفقي',  size: '1280×853' },
  wide:  { w: 1920, h: 1080, overlay: 'templates/wide.png',  label: '16:9',  size: '1920×1080' },
  story: { w: 1080, h: 1920, overlay: 'templates/story.png', label: 'ستوري', size: '1080×1920' },
  smedc: { w: 1920, h: 1080, overlay: 'templates/smedc.png', label: 'SMEDC', size: '1920×1080',
           hint: 'قالب هيئة تنمية المشروعات الصغيرة والمتوسطة' },
};
const FORMAT_KEYS = Object.keys(FORMATS);
// الاختيار التلقائي حسب نسبة العرض/الارتفاع للصورة
const AUTO_FORMAT = { portrait: 'story', landscape: 'post', wide: 'wide' };
const PORTRAIT_RATIO = 0.9;      // أقل من هيك ← ستوري
const WIDE_RATIO = 1.65;         // أكثر من هيك (مثل 16:9) ← عريض

const PREVIEW_MAX_SIDE = 1800;   // دقة نسخة المعاينة (التصدير دائمًا من الأصل)

/* =====================================================================
   الحالة
   ===================================================================== */
const state = {
  items: [],
  globalFormat: 'auto',
  busy: false,
};
const ASSETS = {};
let assetsReady = null;
let uid = 0;

/* =====================================================================
   أدوات عامة
   ===================================================================== */
const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_error'));
    img.src = src;
  });
}

function canvasToBlob(canvas, quality = CONFIG.jpegQuality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذّر تصدير الصورة'))), 'image/jpeg', quality);
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ` is-${kind}` : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

const ICONS = {
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></svg>',
  chevRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* =====================================================================
   القص والتموضع
   crop = { zoom, cx, cy } ← (cx, cy) نقطة من الصورة (0..1) تقع في منتصف الإطار
   ===================================================================== */
function newCrop() { return { zoom: 1, cx: 0.5, cy: 0.5 }; }
function newCrops() { return Object.fromEntries(FORMAT_KEYS.map((k) => [k, newCrop()])); }

function photoLayout(iw, ih, W, H, crop) {
  const s = Math.max(W / iw, H / ih) * crop.zoom;
  const dw = iw * s;
  const dh = ih * s;
  let x = W / 2 - crop.cx * dw;
  let y = H / 2 - crop.cy * dh;
  x = dw >= W ? clamp(x, W - dw, 0) : (W - dw) / 2;
  y = dh >= H ? clamp(y, H - dh, 0) : (H - dh) / 2;
  return { x, y, dw, dh };
}

function normalizeCrop(item, crop, W, H) {
  const L = photoLayout(item.iw, item.ih, W, H, crop);
  crop.cx = (W / 2 - L.x) / L.dw;
  crop.cy = (H / 2 - L.y) / L.dh;
}

function drawPhoto(ctx, item, W, H, crop, s, src) {
  const L = photoLayout(item.iw, item.ih, W, H, crop);
  if (L.dw < W - 0.5 || L.dh < H - 0.5) {
    // الصورة أصغر من الإطار: خلفية ضبابية من نفس الصورة
    const base = Math.max(W / item.iw, H / item.ih);
    const bw = item.iw * base;
    const bh = item.ih * base;
    const over = 60;
    ctx.save();
    ctx.filter = `blur(${Math.max(1, Math.round(40 * s))}px)`;
    ctx.drawImage(src, (W - bw) / 2 - over, (H - bh) / 2 - over, bw + over * 2, bh + over * 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(0, 39, 35, 0.35)';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(src, L.x, L.y, L.dw, L.dh);
}

function autoFormat(item) {
  const r = item.iw / item.ih;
  if (r < PORTRAIT_RATIO) return AUTO_FORMAT.portrait;
  return r > WIDE_RATIO ? AUTO_FORMAT.wide : AUTO_FORMAT.landscape;
}
function effectiveFormat(item) {
  if (item.format !== 'auto') return item.format;
  if (state.globalFormat !== 'auto') return state.globalFormat;
  return autoFormat(item);
}

/* =====================================================================
   رسم الصورة (صورة + قالب)
   ===================================================================== */
function renderPhoto(ctx, item, fmt, s, src) {
  const F = FORMATS[fmt];
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, F.w, F.h);
  drawPhoto(ctx, item, F.w, F.h, item.crop[fmt], s, src);
  ctx.drawImage(ASSETS[fmt], 0, 0, F.w, F.h);
}

/* =====================================================================
   إضافة الصور
   ===================================================================== */
function makePreviewSource(img) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(iw, ih));
  if (k === 1) return img;
  const c = document.createElement('canvas');
  c.width = Math.round(iw * k);
  c.height = Math.round(ih * k);
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function addFiles(fileList) {
  // نأخذ نسخة فورًا: قائمة الملفات تنمسح بعد ما نفرّغ حقل الاختيار أو ينتهي حدث السحب
  const picked = [...fileList];
  try { await assetsReady; } catch { return; }
  const files = picked
    .filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) { toast('اختر ملفات صور', 'error'); return; }
  const room = CONFIG.maxPhotos - state.items.length;
  if (room <= 0) { toast(`الحد الأقصى ${CONFIG.maxPhotos} صور`, 'error'); return; }
  if (files.length > room) toast(`تمت إضافة ${room} صور فقط — الحد الأقصى ${CONFIG.maxPhotos}`, 'error');

  for (const file of files.slice(0, room)) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const item = {
        id: ++uid,
        name: file.name,
        url,
        img,
        iw: img.naturalWidth,
        ih: img.naturalHeight,
        format: 'auto',
        crop: newCrops(),
      };
      item.preview = makePreviewSource(img);
      state.items.push(item);
      $('#grid').appendChild(buildCard(item));
      drawCard(item);
    } catch {
      URL.revokeObjectURL(url);
      toast(`تعذّر فتح الصورة: ${file.name} (جرّب JPG أو PNG)`, 'error');
    }
  }
  refreshUI();
}

function removeItem(item) {
  state.items = state.items.filter((i) => i !== item);
  item.el.remove();
  URL.revokeObjectURL(item.url);
  refreshUI();
}

/* =====================================================================
   بطاقات الصور
   ===================================================================== */
function buildCard(item) {
  const el = document.createElement('article');
  el.className = 'card';
  const segButtons = FORMAT_KEYS.map((k) => `<button type="button" data-f="${k}" title="${FORMATS[k].hint || FORMATS[k].size}">${FORMATS[k].label}</button>`).join('');
  el.innerHTML = `
    <div class="card-media">
      <canvas aria-label="معاينة الصورة — اسحب لتحريك الكادر"></canvas>
      <span class="badge-num"></span>
    </div>
    <div class="card-body">
      <div class="card-head">
        <button type="button" class="grip" title="اسحب لتغيير الترتيب" aria-label="اسحب لتغيير الترتيب">${ICONS.grip}</button>
        <div class="card-name"></div>
        <span class="auto-tag">تلقائي</span>
        <button type="button" class="icon-btn icon-sm move-prev" title="تقديم" aria-label="تقديم الصورة">${ICONS.chevRight}</button>
        <button type="button" class="icon-btn icon-sm move-next" title="تأخير" aria-label="تأخير الصورة">${ICONS.chevLeft}</button>
      </div>
      <div class="card-row">
        <div class="seg" role="group" aria-label="القالب">${segButtons}</div>
      </div>
      <div class="card-row">
        <div class="zoom">
          <span aria-hidden="true">−</span>
          <input type="range" min="0.5" max="3" step="0.01" value="1" aria-label="تكبير">
          <span aria-hidden="true">+</span>
        </div>
        <button type="button" class="icon-btn reset" title="إعادة الكادر" aria-label="إعادة الكادر">${ICONS.reset}</button>
        <button type="button" class="icon-btn remove" title="حذف الصورة" aria-label="حذف الصورة">${ICONS.trash}</button>
      </div>
    </div>`;
  el.querySelector('.card-name').textContent = item.name;
  item.el = el;
  item.canvas = el.querySelector('canvas');
  item.zoomInput = el.querySelector('.zoom input');

  el.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    item.format = b.dataset.f;
    drawCard(item);
  }));
  item.zoomInput.addEventListener('input', () => {
    const f = effectiveFormat(item);
    const F = FORMATS[f];
    item.crop[f].zoom = parseFloat(item.zoomInput.value);
    normalizeCrop(item, item.crop[f], F.w, F.h);
    drawCard(item);
  });
  el.querySelector('.reset').addEventListener('click', () => {
    item.crop[effectiveFormat(item)] = newCrop();
    drawCard(item);
  });
  el.querySelector('.remove').addEventListener('click', () => removeItem(item));
  el.querySelector('.move-prev').addEventListener('click', () => moveItem(item, -1));
  el.querySelector('.move-next').addEventListener('click', () => moveItem(item, 1));
  attachReorder(el.querySelector('.grip'), item);

  attachPan(item.canvas, () => {
    const f = effectiveFormat(item);
    return { item, crop: item.crop[f], W: FORMATS[f].w, H: FORMATS[f].h, redraw: () => drawCard(item) };
  });
  return el;
}

/* تغيير الترتيب */
function moveItem(item, delta) {
  const i = state.items.indexOf(item);
  const j = i + delta;
  if (j < 0 || j >= state.items.length) return;
  state.items.splice(i, 1);
  state.items.splice(j, 0, item);
  const grid = $('#grid');
  state.items.forEach((it) => grid.appendChild(it.el));
  refreshUI();
  item.el.querySelector(delta < 0 ? '.move-prev' : '.move-next').focus();
}

function renumberCards() {
  [...$('#grid').children].forEach((el, i) => { el.querySelector('.badge-num').textContent = i + 1; });
}

// سحب البطاقة من المقبض ⠿ وإفلاتها مكان بطاقة ثانية
function attachReorder(handle, item) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* تجاهل */ }
    const grid = $('#grid');
    const card = item.el;
    card.classList.add('is-moving');
    document.body.classList.add('is-reordering');
    let pos = { x: e.clientX, y: e.clientY };

    const place = () => {
      const hit = document.elementFromPoint(pos.x, pos.y);
      const target = hit && hit.closest('.card');
      if (!target || target === card || target.parentNode !== grid) return;
      const r = target.getBoundingClientRect();
      const beforeTarget = pos.x > r.left + r.width / 2; // الصفحة من اليمين لليسار
      grid.insertBefore(card, beforeTarget ? target : target.nextSibling);
      renumberCards();
    };
    // تمرير الصفحة تلقائيًا إذا وصل المؤشر لأعلى أو أسفل الشاشة
    let raf = 0;
    const autoScroll = () => {
      const dy = pos.y < 80 ? -14 : pos.y > window.innerHeight - 160 ? 14 : 0;
      if (dy) { window.scrollBy(0, dy); place(); }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const move = (ev) => {
      pos = { x: ev.clientX, y: ev.clientY };
      place();
    };
    const end = () => {
      cancelAnimationFrame(raf);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      card.classList.remove('is-moving');
      document.body.classList.remove('is-reordering');
      const order = [...grid.children];
      state.items.sort((a, b) => order.indexOf(a.el) - order.indexOf(b.el));
      refreshUI();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

function drawCard(item) {
  const f = effectiveFormat(item);
  const F = FORMATS[f];
  const s = 600 / Math.max(F.w, F.h);
  const c = item.canvas;
  const cw = Math.round(F.w * s);
  const ch = Math.round(F.h * s);
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  renderPhoto(c.getContext('2d'), item, f, s, item.preview);

  item.el.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
  item.el.querySelector('.auto-tag').hidden = !(item.format === 'auto' && state.globalFormat === 'auto');
  item.zoomInput.value = item.crop[f].zoom;
}

/* سحب الصورة داخل الإطار */
function attachPan(canvas, getTarget) {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* تجاهل */ }
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = getTarget();
    const rect = canvas.getBoundingClientRect();
    const k = t.W / rect.width;
    const L = photoLayout(t.item.iw, t.item.ih, t.W, t.H, t.crop);
    t.crop.cx -= ((e.clientX - drag.x) * k) / L.dw;
    t.crop.cy -= ((e.clientY - drag.y) * k) / L.dh;
    normalizeCrop(t.item, t.crop, t.W, t.H);
    drag = { x: e.clientX, y: e.clientY };
    t.redraw();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/* =====================================================================
   تحديث الواجهة
   ===================================================================== */
function refreshUI() {
  const n = state.items.length;

  $('#dropzone').classList.toggle('is-compact', n > 0);
  $('#photosToolbar').hidden = n === 0;
  $('#photoCount').textContent = n ? `${n} من ${CONFIG.maxPhotos}` : '';
  $('#dropzone strong').textContent = n ? 'إضافة صور أخرى' : 'اسحب الصور إلى هنا أو اضغط للاختيار';

  state.items.forEach((item, i) => {
    item.el.querySelector('.badge-num').textContent = i + 1;
    item.el.querySelector('.move-prev').disabled = i === 0;
    item.el.querySelector('.move-next').disabled = i === n - 1;
  });

  $('#actionbar').classList.toggle('is-shown', n > 0);
  $('#abSummary').textContent = n ? `${n} ${n === 1 ? 'صورة جاهزة' : 'صور جاهزة'} للتنزيل` : '';
  updateButtons();
}

function updateButtons() {
  $('#btnDownload').disabled = state.busy || state.items.length === 0;
}

function setStatus(text, isError = false) {
  const el = $('#abStatus');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}
function setProgress(fraction) {
  $('#abProgress').style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
}

/* =====================================================================
   التصدير
   ===================================================================== */
function buildOutputs() {
  return state.items.map((item, i) => ({ item, fmt: effectiveFormat(item), file: `${pad2(i + 1)}.jpg`, label: `الصورة ${i + 1}` }));
}

function renderOutput(out) {
  const F = FORMATS[out.fmt];
  const c = document.createElement('canvas');
  c.width = F.w;
  c.height = F.h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  renderPhoto(ctx, out.item, out.fmt, 1, out.item.img);
  return c;
}

function setBusy(busy) {
  state.busy = busy;
  updateButtons();
}

async function downloadAll() {
  if (state.busy) return;
  if (!state.items.length) { toast('ارفع صورة واحدة على الأقل', 'error'); return; }
  const outs = buildOutputs();
  setBusy(true);
  setProgress(0);
  try {
    for (let i = 0; i < outs.length; i++) {
      setStatus(`جاري تجهيز ${outs[i].label} (${i + 1} من ${outs.length})…`);
      await sleep(20);
      const blob = await canvasToBlob(renderOutput(outs[i]));
      saveBlob(blob, outs[i].file);
      setProgress((i + 1) / outs.length);
      await sleep(300);
    }
    setStatus(`تم تنزيل ${outs.length} ${outs.length === 1 ? 'ملف' : 'ملفات'} ✓`);
    toast(outs.length > 1 ? 'تم التنزيل ✓ — إذا طلب المتصفح السماح بتنزيل عدة ملفات، اضغط «سماح»' : 'تم التنزيل ✓', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(exportErrorText(err), true);
  } finally {
    setBusy(false);
  }
}

function exportErrorText(err) {
  if (err && err.name === 'SecurityError') return 'المتصفح منع التصدير: افتح الموقع من الرابط وليس بالنقر المزدوج على الملف';
  return `حدث خطأ: ${err && err.message ? err.message : err}`;
}

/* =====================================================================
   التشغيل
   ===================================================================== */
async function loadAssets() {
  await Promise.all(FORMAT_KEYS.map(async (key) => {
    const src = FORMATS[key].overlay;
    try { ASSETS[key] = await loadImage(src); } catch { throw new Error(src); }
  }));
}

function initFormatSeg() {
  const box = $('#globalFormat');
  for (const key of ['auto', ...FORMAT_KEYS]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = key;
    if (key === 'auto') {
      b.textContent = 'تلقائي';
    } else {
      b.textContent = FORMATS[key].label;
      b.title = FORMATS[key].hint || FORMATS[key].size;
      const small = document.createElement('small');
      small.textContent = FORMATS[key].size;
      b.appendChild(small);
    }
    b.setAttribute('aria-pressed', String(key === state.globalFormat));
    b.addEventListener('click', () => {
      state.globalFormat = key;
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state.items.forEach((item) => { item.format = 'auto'; drawCard(item); });
    });
    box.appendChild(b);
  }
}

function initUpload() {
  const input = $('#fileInput');
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) addFiles(files);
  });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('is-over')));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  });
  // منع فتح الصورة بالمتصفح إذا انرمت خارج المنطقة
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  });

  initFormatSeg();

  $('#btnClearAll').addEventListener('click', () => {
    if (!confirm('حذف كل الصور من الصفحة؟')) return;
    state.items.forEach((item) => { item.el.remove(); URL.revokeObjectURL(item.url); });
    state.items = [];
    refreshUI();
  });
}

async function init() {
  initUpload();
  $('#btnDownload').addEventListener('click', downloadAll);
  refreshUI();

  assetsReady = loadAssets();
  try {
    await assetsReady;
  } catch (err) {
    const box = $('#loadError');
    box.textContent = `تعذّر تحميل ملف القالب: ${err.message} — تأكد أن مجلد templates موجود بجانب index.html وأن الموقع مفتوح من خادم (وليس بالنقر المزدوج)`;
    box.hidden = false;
    $('#fileInput').disabled = true;
  }
}

init();
