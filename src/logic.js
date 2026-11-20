// منطق الموقع الصافي (من غير اعتماد على Cloudflare) عشان يتختبر بسهولة.

export const TZ = "Africa/Cairo";

export const DEFAULT_SETTINGS = {
  siteName: "تحفيظ القرآن الكريم",
  teacherName: "",
  tagline: "دروس تحفيظ القرآن الكريم أونلاين للسيدات والأطفال",
  welcomeNote: "",
  bookingOpen: false,
  currency: "ج.م",
  priceIndividual: 0,
  priceGroup: 0,
  sessionMinutes: 30,
  groupMinutes: 30,
  groupCapacity: 5,
  trialEnabled: false,
  trialPrice: 0,
  trialNote: "",
  instapay: "",
  vodafone: "",
  whatsapp: "",
  discountRules: [], // [{min:4, pct:10}]
  cancelHours: 3, // أقل مدة قبل الحصة يقدر الطالب يلغي فيها (-1 = الإلغاء مقفول)
  holdHours: 3, // الحجز غير المدفوع بيتحجز المكان كام ساعة
  daysAhead: 14,
  minNoticeHours: 2,
  maxSessions: 8,
  joinEarlyMinutes: 15,
  fixedMeetingLink: "", // لو عايز لينك ثابت (Google Meet مثلا) بدل Jitsi
  rules: [], // [{id, days:[6,1], start:"16:00", end:"20:00", kind:"individual"|"group", capacity:5}]
  blockedDates: [], // ["2026-12-01"]
};

// ---------- الوقت والمنطقة الزمنية ----------
const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return dtfCache.get(tz);
}

function parts(ts, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}

export function tzOffsetMs(ts, tz = TZ) {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// "2026-11-21" + "16:30" بتوقيت القاهرة => ms UTC
export function zonedToUtc(dateStr, timeStr, tz = TZ) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = tzOffsetMs(guess, tz);
  let utc = guess - off;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off) utc = guess - off2;
  return utc;
}

export function ymdInTz(ts, tz = TZ) {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = الأحد
}

const pad = (n) => String(n).padStart(2, "0");

// ---------- توليد الخانات من المواعيد الأسبوعية ----------
export function generateSlots(settings, now) {
  const out = [];
  const seen = new Set();
  const today = ymdInTz(now);
  const minStart = now + (settings.minNoticeHours || 0) * 3600000;
  const blocked = new Set(settings.blockedDates || []);
  for (let i = 0; i < settings.daysAhead; i++) {
    const date = addDays(today, i);
    if (blocked.has(date)) continue;
    const dow = dowOf(date);
    for (const r of settings.rules || []) {
      if (!r.days.includes(dow)) continue;
      const minutes = r.kind === "group" ? settings.groupMinutes : settings.sessionMinutes;
      const [sh, sm] = r.start.split(":").map(Number);
      const [eh, em] = r.end.split(":").map(Number);
      let t = sh * 60 + sm;
      const endM = eh * 60 + em;
      while (t + minutes <= endM) {
        const start = zonedToUtc(date, `${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
        const key = r.kind + start;
        if (start >= minStart && !seen.has(key)) {
          seen.add(key);
          out.push({
            start,
            end: start + minutes * 60000,
            minutes,
            kind: r.kind,
            capacity: r.kind === "group" ? r.capacity || settings.groupCapacity || 5 : 1,
          });
        }
        t += minutes;
      }
    }
  }
  out.sort((a, b) => a.start - b.start || (a.kind < b.kind ? -1 : 1));
  return out;
}

// هل الحجز ده لسه بيحتل مكان؟
export function orderHolds(order, now, settings) {
  if (order.status !== "active") return false;
  if (order.payment.status === "rejected") return false;
  if (
    order.pricing.total > 0 &&
    order.payment.status === "unpaid" &&
    now - order.createdAt > (settings.holdHours || 0) * 3600000
  ) {
    return false;
  }
  return true;
}

export function activeSessions(orders, now, settings) {
  const list = [];
  for (const o of orders) {
    if (!orderHolds(o, now, settings)) continue;
    for (const s of o.sessions) {
      if (s.status === "cancelled") continue;
      list.push({ start: s.start, end: s.end, kind: s.kind });
    }
  }
  return list;
}

export function annotateSlots(slots, sessions) {
  return slots.map((sl) => {
    let taken = 0;
    let conflict = false;
    for (const s of sessions) {
      const same = s.kind === sl.kind && s.start === sl.start;
      if (same) taken++;
      else if (s.start < sl.end && s.end > sl.start) conflict = true;
    }
    const free = conflict ? 0 : Math.max(0, sl.capacity - taken);
    return { ...sl, taken, free };
  });
}

// ---------- السعر ----------
export function computePrice(settings, picks, isTrial) {
  if (isTrial) {
    const t = Number(settings.trialPrice) || 0;
    return { count: 1, subtotal: t, discountPct: 0, total: t, per: [t] };
  }
  const per = picks.map((p) =>
    p.kind === "group" ? Number(settings.priceGroup) || 0 : Number(settings.priceIndividual) || 0
  );
  const subtotal = per.reduce((a, b) => a + b, 0);
  let pct = 0;
  for (const r of settings.discountRules || []) {
    if (picks.length >= r.min && r.pct > pct) pct = r.pct;
  }
  const total = Math.round((subtotal * (100 - pct)) / 100);
  return { count: picks.length, subtotal, discountPct: pct, total, per };
}

// ---------- رقم الواتساب ----------
export function normalizePhone(p) {
  let s = String(p || "").trim().replace(/[\s\-()]/g, "");
  // أرقام عربية => إنجليزية
  s = s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const plus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!plus && s.startsWith("00")) s = s.slice(2);
  else if (!plus && s.startsWith("0") && s.length === 11) s = "2" + s; // مصري 01xxxxxxxxx
  return s;
}

// ---------- تنظيف الإعدادات اللي جاية من لوحة التحكم ----------
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const num = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeSettings(input, current) {
  const s = { ...current };
  const d = DEFAULT_SETTINGS;
  if ("siteName" in input) s.siteName = str(input.siteName, 60) || d.siteName;
  if ("teacherName" in input) s.teacherName = str(input.teacherName, 60);
  if ("tagline" in input) s.tagline = str(input.tagline, 140) || d.tagline;
  if ("welcomeNote" in input) s.welcomeNote = str(input.welcomeNote, 400);
  if ("bookingOpen" in input) s.bookingOpen = !!input.bookingOpen;
  if ("currency" in input) s.currency = str(input.currency, 12) || d.currency;
  if ("priceIndividual" in input) s.priceIndividual = num(input.priceIndividual, 0, 100000, 0);
  if ("priceGroup" in input) s.priceGroup = num(input.priceGroup, 0, 100000, 0);
  if ("sessionMinutes" in input) s.sessionMinutes = Math.round(num(input.sessionMinutes, 10, 180, 30));
  if ("groupMinutes" in input) s.groupMinutes = Math.round(num(input.groupMinutes, 10, 180, 30));
  if ("groupCapacity" in input) s.groupCapacity = Math.round(num(input.groupCapacity, 2, 50, 5));
  if ("trialEnabled" in input) s.trialEnabled = !!input.trialEnabled;
  if ("trialPrice" in input) s.trialPrice = num(input.trialPrice, 0, 100000, 0);
  if ("trialNote" in input) s.trialNote = str(input.trialNote, 200);
  if ("instapay" in input) s.instapay = str(input.instapay, 80);
  if ("vodafone" in input) s.vodafone = str(input.vodafone, 40);
  if ("whatsapp" in input) s.whatsapp = str(input.whatsapp, 30);
  if ("cancelHours" in input) s.cancelHours = Math.round(num(input.cancelHours, -1, 720, 3));
  if ("holdHours" in input) s.holdHours = num(input.holdHours, 0, 240, 3);
  if ("daysAhead" in input) s.daysAhead = Math.round(num(input.daysAhead, 1, 60, 14));
  if ("minNoticeHours" in input) s.minNoticeHours = num(input.minNoticeHours, 0, 168, 2);
  if ("maxSessions" in input) s.maxSessions = Math.round(num(input.maxSessions, 1, 30, 8));
  if ("joinEarlyMinutes" in input) s.joinEarlyMinutes = Math.round(num(input.joinEarlyMinutes, 0, 120, 15));
  if ("fixedMeetingLink" in input) {
    const l = str(input.fixedMeetingLink, 300);
    s.fixedMeetingLink = /^https:\/\//i.test(l) ? l : "";
  }
  if ("discountRules" in input && Array.isArray(input.discountRules)) {
    s.discountRules = input.discountRules
      .map((r) => ({ min: Math.round(num(r.min, 2, 100, 0)), pct: num(r.pct, 1, 90, 0) }))
      .filter((r) => r.min >= 2 && r.pct > 0)
      .slice(0, 6);
  }
  if ("rules" in input && Array.isArray(input.rules)) {
    s.rules = input.rules
      .map((r, i) => ({
        id: str(r.id, 20) || "r" + Date.now().toString(36) + i,
        days: [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((x) => x >= 0 && x <= 6))],
        start: str(r.start, 5),
        end: str(r.end, 5),
        kind: r.kind === "group" ? "group" : "individual",
        capacity: Math.round(num(r.capacity, 2, 50, s.groupCapacity || 5)),
      }))
      .filter((r) => r.days.length && hhmm.test(r.start) && hhmm.test(r.end) && r.end > r.start)
      .slice(0, 40);
  }
  if ("blockedDates" in input && Array.isArray(input.blockedDates)) {
    s.blockedDates = [...new Set(input.blockedDates.map((x) => str(x, 10)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))]
      .sort()
      .slice(0, 200);
  }
  return s;
}

export function publicSettings(s) {
  return {
    siteName: s.siteName,
    teacherName: s.teacherName,
    tagline: s.tagline,
    welcomeNote: s.welcomeNote,
    bookingOpen: s.bookingOpen,
    currency: s.currency,
    priceIndividual: s.priceIndividual,
    priceGroup: s.priceGroup,
    sessionMinutes: s.sessionMinutes,
    groupMinutes: s.groupMinutes,
    trialEnabled: s.trialEnabled,
    trialPrice: s.trialPrice,
    trialNote: s.trialNote,
    instapay: s.instapay,
    vodafone: s.vodafone,
    whatsapp: s.whatsapp,
    discountRules: s.discountRules,
    cancelHours: s.cancelHours,
    holdHours: s.holdHours,
    maxSessions: s.maxSessions,
    joinEarlyMinutes: s.joinEarlyMinutes,
    hasIndividual: s.rules.some((r) => r.kind === "individual"),
    hasGroup: s.rules.some((r) => r.kind === "group"),
  };
}
