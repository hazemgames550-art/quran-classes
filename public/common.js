// دوال مشتركة بين كل الصفحات
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CAIRO = "Africa/Cairo";
const LOCALE = "ar-EG-u-nu-latn";
const USER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || CAIRO; } catch { return CAIRO; } })();

function fmtDay(ts, tz = CAIRO) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(ts);
}
function fmtTime(ts, tz = CAIRO) {
  return new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(ts);
}
function dayKey(ts, tz = CAIRO) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}
function fmtDateTime(ts, tz = CAIRO) {
  return `${fmtDay(ts, tz)} - ${fmtTime(ts, tz)}`;
}
function money(n, cur = "ج.م") {
  return `${Number(n).toLocaleString(LOCALE)} ${cur}`;
}
// لو الطالب في منطقة زمنية غير مصر نعرض له ميعاده المحلي كمان
function localHint(ts) {
  if (USER_TZ === CAIRO) return "";
  const sameDay = dayKey(ts, CAIRO) === dayKey(ts, USER_TZ);
  return `بتوقيتك: ${sameDay ? "" : fmtDay(ts, USER_TZ) + " "}${fmtTime(ts, USER_TZ)}`;
}
const tzOffsetNow = () => USER_TZ !== CAIRO;

function normalizePhone(p) {
  let s = String(p || "").trim().replace(/[\s\-()]/g, "");
  s = s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const plus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!plus && s.startsWith("00")) s = s.slice(2);
  else if (!plus && s.startsWith("0") && s.length === 11) s = "2" + s;
  return s;
}
function waLink(phone, text = "") {
  return `https://wa.me/${normalizePhone(phone)}${text ? "?text=" + encodeURIComponent(text) : ""}`;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("مفيش اتصال بالإنترنت، جرب تاني");
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error(data.error || "حصل خطأ، جرب تاني");
    e.status = res.status;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("تم النسخ ✓"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("تم النسخ ✓"); } catch { toast("انسخ الرقم يدويًا", true); }
    ta.remove();
  }
}

const JUZ_NAMES = ["الأول","الثاني","الثالث","الرابع","الخامس","السادس","السابع","الثامن","التاسع","العاشر","الحادي عشر","الثاني عشر","الثالث عشر","الرابع عشر","الخامس عشر","السادس عشر","السابع عشر","الثامن عشر","التاسع عشر","العشرون","الحادي والعشرون","الثاني والعشرون","الثالث والعشرون","الرابع والعشرون","الخامس والعشرون","السادس والعشرون","السابع والعشرون","الثامن والعشرون","التاسع والعشرون","الثلاثون"];
const LESSON_TYPES = { new: "حفظ جديد", review: "مراجعة", tajweed: "تجويد وتصحيح تلاوة", mixed: "حفظ ومراجعة" };
const CAN_READ = { yes: "بتقرأ بطلاقة", little: "بتقرأ بصعوبة", no: "لسه ما بتقرأش" };

function quranText(q) {
  if (!q) return "";
  if (q.mode === "all") return "القرآن الكريم كاملًا";
  if (q.mode === "juz") return "الأجزاء: " + q.juz.join("، ");
  if (q.mode === "range") return q.from === q.to ? `الجزء ${q.from}` : `من الجزء ${q.from} إلى الجزء ${q.to}`;
  if (q.mode === "surahs") return "سور: " + q.surahs;
  return "";
}

// ===== خلفية: جزيئات ذهبية هادية =====
function initBackground() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.id = "bgcanvas";
  document.body.prepend(c);
  const ctx = c.getContext("2d");
  let w, h, dots;
  const make = () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.8 + 0.4, s: Math.random() * 0.25 + 0.07, a: Math.random() * 0.6 + 0.2, p: Math.random() * 6.28 });
  function resize() {
    w = c.width = innerWidth; h = c.height = innerHeight;
    dots = Array.from({ length: Math.min(70, Math.floor(w / 18)) }, make);
  }
  resize();
  addEventListener("resize", resize);
  (function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      d.y -= d.s; d.x += Math.sin(t / 2500 + d.p) * 0.15;
      if (d.y < -5) { d.y = h + 5; d.x = Math.random() * w; }
      const tw = 0.5 + 0.5 * Math.sin(t / 900 + d.p);
      ctx.beginPath();
      ctx.fillStyle = `rgba(232,196,90,${d.a * tw})`;
      ctx.shadowColor = "rgba(212,175,55,.9)"; ctx.shadowBlur = 8;
      ctx.arc(d.x, d.y, d.r, 0, 6.283); ctx.fill();
    }
    requestAnimationFrame(frame);
  })(0);
}

function initReveal() {
  const els = $$(".reveal");
  if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((en) => en.forEach((x) => { if (x.isIntersecting) { x.target.classList.add("in"); io.unobserve(x.target); } }), { threshold: 0.12 });
  els.forEach((e) => io.observe(e));
}

// أيقونة النجمة الإسلامية الصغيرة (للشعار)
const STAR_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="none" stroke="#d4af37" stroke-width="1.6"><rect x="9" y="9" width="22" height="22"/><rect x="9" y="9" width="22" height="22" transform="rotate(45 20 20)"/><circle cx="20" cy="20" r="3.5" fill="#d4af37"/></g></svg>`;

// تصغير صورة الإيصال قبل الرفع
function compressImage(file, maxSide = 1280, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("الصورة مش مفهومة، جرب صورة تانية")); };
    img.src = url;
  });
}

const PAY_LABEL = { instapay: "انستا باي", vodafone: "فودافون كاش" };
const PAY_STATUS = {
  unpaid: ["مستني الدفع", "warn"],
  pending: ["الإيصال اتبعت - مستني التأكيد", "warn"],
  confirmed: ["تم تأكيد الدفع", "ok"],
  rejected: ["الدفع مرفوض", "bad"],
};
const SESSION_STATUS = { scheduled: ["محجوزة", "ok"], done: ["تمت", "mute"], absent: ["غياب", "bad"], cancelled: ["ملغاة", "bad"] };
