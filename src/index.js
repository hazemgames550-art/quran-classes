import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_SETTINGS,
  generateSlots,
  activeSessions,
  annotateSlots,
  computePrice,
  normalizePhone,
  sanitizeSettings,
  publicSettings,
  orderHolds,
} from "./logic.js";
import { RoomDO } from "./room.js";
export { RoomDO };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomString(len, chars) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hashPassword(pw, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const DAY = 86400000;

export class QuranDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.loginFail = { count: 0, until: 0 };
    this.settingUp = false;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, code TEXT UNIQUE, created INTEGER, data TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS receipts(order_id TEXT PRIMARY KEY, mime TEXT, img TEXT, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sess(token TEXT PRIMARY KEY, exp INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(k TEXT PRIMARY KEY, token TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rtokens(token TEXT PRIMARY KEY, data TEXT, exp INTEGER)`);
  }

  // ---------- تخزين ----------
  kvGet(k) {
    const r = this.sql.exec(`SELECT v FROM kv WHERE k=?`, k).toArray();
    return r.length ? JSON.parse(r[0].v) : null;
  }
  kvSet(k, v) {
    this.sql.exec(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, JSON.stringify(v));
  }
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this.kvGet("settings") || {}) };
  }
  allOrders() {
    return this.sql.exec(`SELECT data FROM orders ORDER BY created DESC`).toArray().map((r) => JSON.parse(r.data));
  }
  getOrderByCode(code) {
    const r = this.sql.exec(`SELECT data FROM orders WHERE code=?`, String(code || "").toUpperCase()).toArray();
    return r.length ? JSON.parse(r[0].data) : null;
  }
  getOrderById(id) {
    const r = this.sql.exec(`SELECT data FROM orders WHERE id=?`, String(id || "")).toArray();
    return r.length ? JSON.parse(r[0].data) : null;
  }
  saveOrder(o) {
    this.sql.exec(
      `INSERT INTO orders(id,code,created,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      o.id,
      o.code,
      o.createdAt,
      JSON.stringify(o)
    );
  }

  roomToken(key) {
    const r = this.sql.exec(`SELECT token FROM rooms WHERE k=?`, key).toArray();
    if (r.length) return r[0].token;
    const t = randomString(16, "abcdefghijkmnpqrstuvwxyz23456789");
    this.sql.exec(`INSERT INTO rooms(k,token) VALUES(?,?)`, key, t);
    return t;
  }
  roomKeyFor(order, session) {
    return session.kind === "group" ? "g:" + session.start : "o:" + order.id;
  }
  meetingUrl(order, session, settings, host = false) {
    if (order.meetingLink) return order.meetingLink;
    if (settings.meetingProvider === "builtin") {
      return `/room?c=${order.code}&s=${session.start}${host ? "&host=1" : ""}`;
    }
    if (settings.fixedMeetingLink) return settings.fixedMeetingLink;
    return `https://meet.jit.si/Quran-${this.roomToken(this.roomKeyFor(order, session))}`;
  }

  // ---------- غرفة الاجتماع الخاصة ----------
  async iceServers() {
    const base = [{ urls: "stun:stun.cloudflare.com:3478" }];
    const id = this.env && this.env.TURN_KEY_ID;
    const tok = this.env && this.env.TURN_KEY_API_TOKEN;
    if (!id || !tok) return { iceServers: base, turn: false };
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
      const j = await r.json();
      let list = j.iceServers;
      if (list && !Array.isArray(list)) list = [list];
      if (r.ok && list && list.length) return { iceServers: list, turn: true };
    } catch (e) {
      console.error("turn", e);
    }
    return { iceServers: base, turn: false };
  }
  makeRoomToken(key, data, exp) {
    this.sql.exec(`DELETE FROM rtokens WHERE exp<?`, Date.now());
    const k64 = btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = k64 + "." + randomString(32, "abcdefghijklmnopqrstuvwxyz0123456789");
    this.sql.exec(`INSERT INTO rtokens(token,data,exp) VALUES(?,?,?)`, token, JSON.stringify({ ...data, key }), exp);
    return token;
  }
  async roomJoinResponse(key, data, exp) {
    const settings = this.getSettings();
    const { iceServers, turn } = await this.iceServers();
    return json({
      token: this.makeRoomToken(key, data, exp),
      role: data.role,
      name: data.name,
      end: data.end || null,
      iceServers,
      turn,
      siteName: settings.siteName,
    });
  }
  testRoom(create) {
    let t = this.kvGet("testRoom");
    if (!t && create) {
      t = { id: randomString(10, "abcdefghijkmnpqrstuvwxyz23456789") };
      this.kvSet("testRoom", t);
    }
    return t;
  }
  async roomJoin(b, now) {
    const settings = this.getSettings();
    if (b.test) {
      const t = this.testRoom(false);
      if (!t || t.id !== String(b.test)) throw new HttpError(404, "رابط التجربة غير صالح");
      const name = String(b.name || "").trim().slice(0, 40) || "ضيف التجربة";
      return this.roomJoinResponse("t:" + t.id, { role: "student", name, uid: "t-" + randomString(8, "abcdefghijk"), end: null }, now + 6 * 3600000);
    }
    const order = this.getOrderByCode(b.code);
    if (!order) throw new HttpError(404, "مفيش حجز بالكود ده");
    const s = order.sessions.find((x) => x.start === Number(b.start));
    if (!s) throw new HttpError(404, "الحصة مش موجودة");
    const paidOk = order.payment.status === "confirmed" || order.pricing.total === 0;
    if (order.status !== "active" || s.status !== "scheduled") throw new HttpError(403, "الحصة دي مش شغالة");
    if (!paidOk) throw new HttpError(403, "الدفع لسه ما اتأكدش");
    if (now < s.start - settings.joinEarlyMinutes * 60000) throw new HttpError(403, "لسه بدري على الحصة، ارجعي قبل الميعاد بشوية");
    if (now > s.end + 60 * 60000) throw new HttpError(403, "الحصة دي خلصت");
    return this.roomJoinResponse(
      this.roomKeyFor(order, s),
      { role: "student", name: order.student.name, uid: "s:" + order.code, end: s.end },
      s.end + 2 * 3600000
    );
  }
  async adminRoomJoin(b, now) {
    const settings = this.getSettings();
    const name = settings.teacherName || "المعلم";
    if (b.test) {
      const t = this.testRoom(true);
      return this.roomJoinResponse("t:" + t.id, { role: "host", name, uid: "host", end: null }, now + 12 * 3600000);
    }
    const order = this.getOrderByCode(b.code);
    if (!order) throw new HttpError(404, "الحجز مش موجود");
    const s = order.sessions.find((x) => x.start === Number(b.start));
    if (!s) throw new HttpError(404, "الحصة مش موجودة");
    return this.roomJoinResponse(this.roomKeyFor(order, s), { role: "host", name, uid: "host", end: s.end }, now + 12 * 3600000);
  }

  // ---------- عرض الحجز للطالب (من غير بيانات حساسة) ----------
  publicOrder(order, settings, now) {
    const paidOk = order.payment.status === "confirmed" || order.pricing.total === 0;
    const holds = orderHolds(order, now, settings);
    const expired = order.status === "active" && !holds && order.payment.status === "unpaid";
    return {
      code: order.code,
      createdAt: order.createdAt,
      status: expired ? "expired" : order.status,
      isTrial: order.isTrial,
      student: { name: order.student.name, kind: order.student.kind },
      pricing: order.pricing,
      payment: { method: order.payment.method, status: order.payment.status, hasReceipt: !!order.payment.receiptAt },
      holdUntil: order.pricing.total > 0 && order.payment.status === "unpaid" ? order.createdAt + settings.holdHours * 3600000 : null,
      sessions: order.sessions.map((s) => {
        const canJoin =
          order.status === "active" &&
          paidOk &&
          s.status === "scheduled" &&
          now >= s.start - settings.joinEarlyMinutes * 60000 &&
          now <= s.end + 60 * 60000;
        return {
          start: s.start,
          end: s.end,
          kind: s.kind,
          status: s.status,
          progress: s.progress || "",
          canJoin,
          joinUrl: canJoin ? this.meetingUrl(order, s, settings) : null,
          canCancel:
            order.status === "active" &&
            s.status === "scheduled" &&
            settings.cancelHours >= 0 &&
            s.start - now > settings.cancelHours * 3600000,
        };
      }),
    };
  }

  // ---------- المسؤول عن الدخول ----------
  requireAdmin(request) {
    const h = request.headers.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) throw new HttpError(401, "لازم تسجل دخول");
    const r = this.sql.exec(`SELECT exp FROM sess WHERE token=?`, token).toArray();
    if (!r.length || r[0].exp < Date.now()) throw new HttpError(401, "انتهت الجلسة، سجل دخول تاني");
    return token;
  }
  newSession() {
    this.sql.exec(`DELETE FROM sess WHERE exp<?`, Date.now());
    const token = randomString(40, "abcdefghijklmnopqrstuvwxyz0123456789");
    this.sql.exec(`INSERT INTO sess(token,exp) VALUES(?,?)`, token, Date.now() + 30 * DAY);
    return token;
  }

  async fetch(request) {
    try {
      return await this.route(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "حصل خطأ في السيرفر" }, 500);
    }
  }

  async body(request, maxChars = 20000) {
    const text = await request.text();
    if (text.length > maxChars) throw new HttpError(413, "الطلب كبير أوي");
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, "بيانات غير صالحة");
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const now = Date.now();
    let m;

    // ===== عام =====
    if (method === "GET" && path === "/api/public") {
      return json({ settings: publicSettings(this.getSettings()), now });
    }

    if (method === "GET" && path === "/api/slots") {
      const settings = this.getSettings();
      const slots = generateSlots(settings, now);
      const sessions = activeSessions(this.allOrders(), now, settings);
      return json({ slots: annotateSlots(slots, sessions), now });
    }

    if (method === "POST" && path === "/api/book") return this.book(await this.body(request), now);

    if (method === "POST" && path === "/api/room/join") return this.roomJoin(await this.body(request), now);

    // داخلي: بيناديه RoomDO بس (الـ Worker بيمنع الوصول ليه من بره)
    if (method === "POST" && path === "/api/internal/redeem") {
      const b = await this.body(request);
      const r = this.sql.exec(`SELECT data,exp FROM rtokens WHERE token=?`, String(b.token || "")).toArray();
      if (!r.length || r[0].exp < now) throw new HttpError(403, "تذكرة غير صالحة");
      const d = JSON.parse(r[0].data);
      if (d.key !== b.key) throw new HttpError(403, "غرفة غير صحيحة");
      return json(d);
    }

    if ((m = path.match(/^\/api\/booking\/([A-Za-z0-9]{4,10})$/)) && method === "GET") {
      const order = this.getOrderByCode(m[1]);
      if (!order) throw new HttpError(404, "مفيش حجز بالكود ده");
      return json({ order: this.publicOrder(order, this.getSettings(), now) });
    }

    if ((m = path.match(/^\/api\/booking\/([A-Za-z0-9]{4,10})\/receipt$/)) && method === "POST") {
      const order = this.getOrderByCode(m[1]);
      if (!order) throw new HttpError(404, "مفيش حجز بالكود ده");
      const b = await this.body(request, 2_000_000);
      if (order.status !== "active") throw new HttpError(400, "الحجز ده مش شغال");
      if (order.payment.status === "confirmed") throw new HttpError(400, "الدفع متأكد بالفعل");
      if (order.pricing.total === 0) throw new HttpError(400, "الحجز ده مجاني");
      const img = String(b.image || "");
      const mm = img.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!mm || img.length > 1_800_000) throw new HttpError(400, "ارفع صورة (JPG أو PNG) أصغر من 1.5 ميجا");
      if (b.method === "instapay" || b.method === "vodafone") order.payment.method = b.method;
      // لو الحجز كان منتهي (من غير دفع) لازم نتأكد المكان لسه فاضي قبل ما نرجّعه
      const settings = this.getSettings();
      if (!orderHolds(order, now, settings)) {
        const others = this.allOrders().filter((o) => o.id !== order.id);
        const sessions = activeSessions(others, now, settings);
        const taken = annotateSlots(
          order.sessions.filter((s) => s.status === "scheduled").map((s) => ({ ...s, capacity: s.kind === "group" ? 50 : 1 })),
          sessions
        );
        // لو أي حصة مكانها اتحجز لحد تاني => الحجز انتهى
        const clash = taken.some((s) => s.free < 1);
        if (clash) throw new HttpError(409, "الحجز انتهى ومكانه اتحجز لحد تاني، احجز ميعاد جديد");
      }
      this.sql.exec(
        `INSERT INTO receipts(order_id,mime,img,at) VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET mime=excluded.mime,img=excluded.img,at=excluded.at`,
        order.id,
        mm[1],
        mm[2],
        now
      );
      order.payment.status = "pending";
      order.payment.receiptAt = now;
      this.saveOrder(order);
      return json({ ok: true, order: this.publicOrder(order, settings, now) });
    }

    if ((m = path.match(/^\/api\/booking\/([A-Za-z0-9]{4,10})\/cancel$/)) && method === "POST") {
      const order = this.getOrderByCode(m[1]);
      if (!order) throw new HttpError(404, "مفيش حجز بالكود ده");
      const b = await this.body(request);
      const settings = this.getSettings();
      const s = order.sessions.find((x) => x.start === Number(b.start));
      if (!s || s.status !== "scheduled" || order.status !== "active") throw new HttpError(400, "مينفعش تلغي الحصة دي");
      if (settings.cancelHours < 0) throw new HttpError(400, "الإلغاء مقفول، كلم المعلم على الواتساب");
      if (s.start - now <= settings.cancelHours * 3600000) {
        throw new HttpError(400, `الإلغاء لازم يبقى قبل الحصة بـ ${settings.cancelHours} ساعة على الأقل`);
      }
      s.status = "cancelled";
      s.cancelledAt = now;
      if (order.sessions.every((x) => x.status === "cancelled")) order.status = "cancelled";
      this.saveOrder(order);
      return json({ ok: true, order: this.publicOrder(order, settings, now) });
    }

    // ===== الأدمن =====
    if (method === "GET" && path === "/api/admin/status") {
      return json({ setup: !!this.kvGet("admin") });
    }

    if (method === "POST" && path === "/api/admin/setup") {
      if (this.kvGet("admin") || this.settingUp) throw new HttpError(400, "كلمة السر متحطة بالفعل");
      this.settingUp = true;
      try {
        const b = await this.body(request);
        const pw = String(b.password || "");
        if (pw.length < 8) throw new HttpError(400, "كلمة السر لازم تبقى 8 حروف على الأقل");
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        this.kvSet("admin", { salt, hash: await hashPassword(pw, salt) });
        return json({ token: this.newSession() });
      } finally {
        this.settingUp = false;
      }
    }

    if (method === "POST" && path === "/api/admin/login") {
      if (now < this.loginFail.until) throw new HttpError(429, "محاولات كتير غلط، استنى شوية وجرب تاني");
      const admin = this.kvGet("admin");
      if (!admin) throw new HttpError(400, "لسه مفيش كلمة سر، افتح الصفحة وسجل كلمة سر الأول");
      const b = await this.body(request);
      const h = await hashPassword(String(b.password || ""), admin.salt);
      if (!safeEqual(h, admin.hash)) {
        this.loginFail.count++;
        if (this.loginFail.count >= 8) {
          this.loginFail = { count: 0, until: now + 10 * 60000 };
        }
        throw new HttpError(401, "كلمة السر غلط");
      }
      this.loginFail = { count: 0, until: 0 };
      return json({ token: this.newSession() });
    }

    if (path.startsWith("/api/admin/")) {
      const token = this.requireAdmin(request);

      if (method === "POST" && path === "/api/admin/logout") {
        this.sql.exec(`DELETE FROM sess WHERE token=?`, token);
        return json({ ok: true });
      }

      if (method === "POST" && path === "/api/admin/password") {
        const b = await this.body(request);
        const admin = this.kvGet("admin");
        if (!safeEqual(await hashPassword(String(b.old || ""), admin.salt), admin.hash)) {
          throw new HttpError(401, "كلمة السر القديمة غلط");
        }
        const pw = String(b.password || "");
        if (pw.length < 8) throw new HttpError(400, "كلمة السر الجديدة لازم تبقى 8 حروف على الأقل");
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        this.kvSet("admin", { salt, hash: await hashPassword(pw, salt) });
        this.sql.exec(`DELETE FROM sess WHERE token<>?`, token);
        return json({ ok: true });
      }

      if (method === "POST" && path === "/api/admin/room-join") return this.adminRoomJoin(await this.body(request), now);

      if (method === "POST" && path === "/api/admin/test-room") {
        const b = await this.body(request);
        if (b.renew) this.kvSet("testRoom", null);
        const t = this.testRoom(true) || (this.kvSet("testRoom", null), this.testRoom(true));
        return json({ id: t.id });
      }

      if (method === "GET" && path === "/api/admin/data") {
        const settings = this.getSettings();
        const orders = this.allOrders().slice(0, 600).map((o) => ({
          ...o,
          holds: orderHolds(o, now, settings),
          sessions: o.sessions.map((s) => ({
            ...s,
            joinUrl: this.meetingUrl(o, s, settings, true),
            studentUrl: this.meetingUrl(o, s, settings, false),
          })),
        }));
        return json({ settings, orders, now });
      }

      if (method === "POST" && path === "/api/admin/settings") {
        const b = await this.body(request, 60000);
        const next = sanitizeSettings(b, this.getSettings());
        this.kvSet("settings", next);
        return json({ settings: next });
      }

      if ((m = path.match(/^\/api\/admin\/receipt\/([\w-]+)$/)) && method === "GET") {
        const r = this.sql.exec(`SELECT mime,img FROM receipts WHERE order_id=?`, m[1]).toArray();
        if (!r.length) throw new HttpError(404, "مفيش إيصال");
        return json({ image: `data:${r[0].mime};base64,${r[0].img}` });
      }

      if ((m = path.match(/^\/api\/admin\/orders\/([\w-]+)$/)) && method === "POST") {
        const order = this.getOrderById(m[1]);
        if (!order) throw new HttpError(404, "الحجز مش موجود");
        const b = await this.body(request, 20000);
        if (b.paymentStatus) {
          if (!["unpaid", "pending", "confirmed", "rejected"].includes(b.paymentStatus)) throw new HttpError(400, "حالة غير صالحة");
          order.payment.status = b.paymentStatus;
          if (b.paymentStatus === "confirmed") order.payment.confirmedAt = now;
        }
        if (typeof b.adminNote === "string") order.adminNote = b.adminNote.slice(0, 1000);
        if (typeof b.meetingLink === "string") {
          const l = b.meetingLink.trim();
          order.meetingLink = /^https:\/\//i.test(l) ? l.slice(0, 300) : "";
        }
        if (b.sessionStart !== undefined) {
          const s = order.sessions.find((x) => x.start === Number(b.sessionStart));
          if (!s) throw new HttpError(404, "الحصة مش موجودة");
          if (b.sessionStatus) {
            if (!["scheduled", "done", "absent", "cancelled"].includes(b.sessionStatus)) throw new HttpError(400, "حالة غير صالحة");
            s.status = b.sessionStatus;
          }
          if (typeof b.progress === "string") s.progress = b.progress.slice(0, 600);
        }
        if (b.cancelOrder) order.status = "cancelled";
        if (b.reopenOrder) order.status = "active";
        this.saveOrder(order);
        return json({ ok: true });
      }
    }

    throw new HttpError(404, "غير موجود");
  }

  // ---------- إنشاء حجز ----------
  book(b, now) {
    const settings = this.getSettings();
    if (!settings.bookingOpen) throw new HttpError(403, "الحجز مقفول حاليًا");

    const kind = b.studentKind === "child" ? "child" : "woman";
    const name = String(b.name || "").trim().slice(0, 80);
    if (name.length < 2) throw new HttpError(400, "اكتب الاسم");
    const phone = normalizePhone(b.phone);
    if (phone.length < 8 || phone.length > 15) throw new HttpError(400, "رقم الواتساب غير صحيح");
    const age = b.age === "" || b.age == null ? null : Math.round(Number(b.age));
    if (age !== null && (!Number.isFinite(age) || age < 3 || age > 90)) throw new HttpError(400, "السن غير صحيح");
    let guardianName = "";
    if (kind === "child") {
      guardianName = String(b.guardianName || "").trim().slice(0, 80);
      if (guardianName.length < 2) throw new HttpError(400, "اكتب اسم ولي الأمر");
      if (age === null) throw new HttpError(400, "اكتب سن الطفل");
    }

    // الأجزاء
    const q = b.quran || {};
    const modes = ["all", "juz", "range", "surahs"];
    const mode = modes.includes(q.mode) ? q.mode : "all";
    const quran = { mode };
    if (mode === "juz") {
      quran.juz = [...new Set((Array.isArray(q.juz) ? q.juz : []).map(Number).filter((x) => x >= 1 && x <= 30))].sort((a, c) => a - c);
      if (!quran.juz.length) throw new HttpError(400, "اختار جزء واحد على الأقل");
    } else if (mode === "range") {
      quran.from = Number(q.from);
      quran.to = Number(q.to);
      if (!(quran.from >= 1 && quran.to <= 30 && quran.from <= quran.to)) throw new HttpError(400, "حدد الجزء من وإلى صح");
    } else if (mode === "surahs") {
      quran.surahs = String(q.surahs || "").trim().slice(0, 200);
      if (!quran.surahs) throw new HttpError(400, "اكتب السور اللي عايزاها");
    }
    const lessonTypes = ["new", "review", "tajweed", "mixed"];
    const lessonType = lessonTypes.includes(b.lessonType) ? b.lessonType : "new";
    const level = {
      canRead: ["yes", "little", "no"].includes(b.canRead) ? b.canRead : "yes",
      memorized: String(b.memorized || "").trim().slice(0, 120),
    };
    const notes = String(b.notes || "").trim().slice(0, 500);

    // الخانات
    const isTrial = !!b.trial;
    if (isTrial && !settings.trialEnabled) throw new HttpError(400, "الحصة التجريبية مش متاحة حاليًا");
    const picks = Array.isArray(b.sessions) ? b.sessions : [];
    if (!picks.length) throw new HttpError(400, "اختار ميعاد");
    if (picks.length > settings.maxSessions) throw new HttpError(400, `أقصى عدد حصص في الحجز الواحد ${settings.maxSessions}`);
    if (isTrial && picks.length !== 1) throw new HttpError(400, "الحصة التجريبية حصة واحدة بس");

    const orders = this.allOrders();
    const open = orders.filter((o) => o.student.phone === phone && o.status === "active" && o.payment.status === "unpaid" && orderHolds(o, now, settings) && o.pricing.total > 0);
    if (open.length >= 3) throw new HttpError(429, "عندك حجوزات كتير مستنية دفع، ادفع الأول أو استنى تنتهي");
    if (isTrial && orders.some((o) => o.student.phone === phone && o.isTrial && o.status === "active" && o.payment.status !== "rejected")) {
      throw new HttpError(400, "الحصة التجريبية خدتيها قبل كده");
    }

    const slots = annotateSlots(generateSlots(settings, now), activeSessions(orders, now, settings));
    const chosen = [];
    const seen = new Set();
    for (const p of picks) {
      const start = Number(p.start);
      const k = p.kind === "group" ? "group" : "individual";
      if (isTrial && k !== "individual") throw new HttpError(400, "الحصة التجريبية فردية");
      const key = k + start;
      if (seen.has(key)) throw new HttpError(400, "ميعاد متكرر");
      seen.add(key);
      const slot = slots.find((s) => s.kind === k && s.start === start);
      if (!slot || slot.free < 1) throw new HttpError(409, "واحد من المواعيد اللي اخترتيها اتحجز، اختاري مواعيد تانية");
      chosen.push(slot);
    }
    // مفيش حصتين متداخلتين في نفس الحجز
    for (let i = 0; i < chosen.length; i++)
      for (let j = i + 1; j < chosen.length; j++)
        if (chosen[i].start < chosen[j].end && chosen[j].start < chosen[i].end) throw new HttpError(400, "مواعيد متداخلة");

    const pricing = computePrice(settings, chosen, isTrial);
    const method = b.method === "vodafone" ? "vodafone" : "instapay";
    const paid = pricing.total === 0;

    let code;
    do code = randomString(6, CODE_CHARS);
    while (this.getOrderByCode(code));

    const order = {
      id: crypto.randomUUID(),
      code,
      createdAt: now,
      status: "active",
      isTrial,
      student: {
        kind,
        name,
        age,
        guardianName,
        phone,
        country: String(b.country || "").slice(0, 40),
        tz: String(b.tz || "").slice(0, 60),
      },
      quran,
      lessonType,
      level,
      notes,
      sessions: chosen
        .sort((a, c) => a.start - c.start)
        .map((s) => ({ start: s.start, end: s.end, minutes: s.minutes, kind: s.kind, status: "scheduled", progress: "" })),
      pricing,
      payment: { method, status: paid ? "confirmed" : "unpaid", receiptAt: null },
      meetingLink: "",
      adminNote: "",
    };
    this.saveOrder(order);
    return json({ ok: true, code, order: this.publicOrder(order, settings, now) });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/room/ws") {
      const tok = url.searchParams.get("token") || "";
      let key = "";
      try {
        const k64 = tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
        key = atob(k64 + "=".repeat((4 - (k64.length % 4)) % 4));
      } catch {
        return new Response("bad token", { status: 400 });
      }
      if (!key) return new Response("bad token", { status: 400 });
      const origin = request.headers.get("Origin");
      if (origin && new URL(origin).host !== url.host) return new Response("forbidden", { status: 403 });
      const headers = new Headers(request.headers);
      headers.set("x-room-key", key);
      return env.ROOM.get(env.ROOM.idFromName(key)).fetch(new Request(request, { headers }));
    }
    if (url.pathname.startsWith("/api/internal")) return new Response("not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) {
      const stub = env.QURAN.get(env.QURAN.idFromName("main"));
      return stub.fetch(request);
    }
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(res.body, { status: res.status, headers });
  },
};
