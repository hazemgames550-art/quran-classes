import { DurableObject } from "cloudflare:workers";

// غرفة اجتماع واحدة. كل غرفة = Durable Object لوحدها.
// السيرفر هنا بس بيوصّل رسايل الإشارة (WebRTC signaling) والشات وتحكم المعلم،
// والصوت والفيديو نفسهم بيمشوا مباشرة بين الأجهزة.

const MAX_PEERS = 10;
const DEFAULT_STATE = { lobby: true, locked: false, chat: true };

const rid = (n = 8) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += a[x % a.length];
  return s;
};
const pub = (a) => ({ id: a.id, name: a.name, role: a.role, hand: !!a.hand, mic: a.mic !== false, cam: a.cam !== false });

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    try {
      if (typeof WebSocketRequestResponsePair !== "undefined") {
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      }
    } catch {}
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const key = request.headers.get("x-room-key");
    const token = new URL(request.url).searchParams.get("token");
    const info = await this.redeem(token, key);
    if (!info) return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.attach(server, info);
    return new Response(null, { status: 101, webSocket: client });
  }

  async redeem(token, key) {
    if (!token || !key) return null;
    try {
      const stub = this.env.QURAN.get(this.env.QURAN.idFromName("main"));
      const r = await stub.fetch("https://internal/api/internal/redeem", {
        method: "POST",
        body: JSON.stringify({ token, key }),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async getState() {
    return { ...DEFAULT_STATE, ...((await this.ctx.storage.get("st")) || {}) };
  }
  async getChat() {
    return (await this.ctx.storage.get("chat")) || [];
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  socks() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, a: ws.deserializeAttachment() })).filter((x) => x.a);
  }
  admitted() {
    return this.socks().filter((x) => x.a.admitted);
  }
  broadcast(obj, exceptWs) {
    for (const { ws } of this.admitted()) if (ws !== exceptWs) this.send(ws, obj);
  }
  hostPresent() {
    return this.admitted().some((x) => x.a.role === "host");
  }
  notifyLobby() {
    const list = this.socks().filter((x) => !x.a.admitted).map((x) => pub(x.a));
    for (const { ws, a } of this.admitted()) if (a.role === "host") this.send(ws, { t: "lobby", list });
  }

  async attach(ws, info) {
    this.ctx.acceptWebSocket(ws);
    // لو نفس الشخص دخل من جهاز تاني نقفل القديم
    for (const { ws: o, a } of this.socks()) {
      if (o !== ws && a.uid === info.uid) {
        this.send(o, { t: "replaced" });
        try { o.close(4001, "replaced"); } catch {}
      }
    }
    const st = await this.getState();
    const host = info.role === "host";
    if (!host && st.locked) {
      this.send(ws, { t: "denied", reason: "locked" });
      try { ws.close(4003, "locked"); } catch {}
      return;
    }
    const att = { id: rid(8), uid: info.uid, name: info.name, role: host ? "host" : "student", admitted: false, hand: false, mic: true, cam: true };
    if (host) att.admitted = true;
    else if (!st.lobby) att.admitted = true;
    if (att.admitted && this.admitted().length >= MAX_PEERS) {
      this.send(ws, { t: "denied", reason: "full" });
      try { ws.close(4003, "full"); } catch {}
      return;
    }
    ws.serializeAttachment(att);
    const chat = att.admitted ? await this.getChat() : [];
    this.send(ws, {
      t: "welcome",
      id: att.id,
      role: att.role,
      name: att.name,
      state: st,
      end: info.end || null,
      waiting: !att.admitted,
      hostPresent: this.hostPresent(),
      peers: att.admitted ? this.admitted().filter((x) => x.ws !== ws).map((x) => pub(x.a)) : [],
      chat,
      lobby: host ? this.socks().filter((x) => !x.a.admitted).map((x) => pub(x.a)) : [],
    });
    if (att.admitted) {
      this.broadcast({ t: "peer-joined", peer: pub(att) }, ws);
      if (host) for (const { ws: w, a } of this.socks()) if (!a.admitted) this.send(w, { t: "host-present", value: true });
    } else {
      this.notifyLobby();
    }
  }

  async admit(ws, a) {
    if (a.admitted) return;
    if (this.admitted().length >= MAX_PEERS) {
      this.send(ws, { t: "denied", reason: "full" });
      try { ws.close(4003, "full"); } catch {}
      return;
    }
    a.admitted = true;
    ws.serializeAttachment(a);
    this.send(ws, {
      t: "admitted",
      state: await this.getState(),
      peers: this.admitted().filter((x) => x.ws !== ws).map((x) => pub(x.a)),
      chat: await this.getChat(),
      hostPresent: this.hostPresent(),
    });
    this.broadcast({ t: "peer-joined", peer: pub(a) }, ws);
  }

  find(id) {
    return this.socks().find((x) => x.a.id === id);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 24000) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m || typeof m.t !== "string") return;
    const host = a.role === "host" && a.admitted;

    if (m.t === "signal") {
      if (!a.admitted) return;
      const to = this.find(m.to);
      if (to && to.a.admitted) this.send(to.ws, { t: "signal", from: a.id, data: m.data });
      return;
    }

    if (m.t === "chat") {
      if (!a.admitted) return;
      const st = await this.getState();
      if (!st.chat && !host) return this.send(ws, { t: "chat-blocked" });
      const text = String(m.text || "").trim().slice(0, 500);
      if (!text) return;
      const msg = { id: rid(6), from: a.id, name: a.name, role: a.role, text, ts: Date.now() };
      const chat = await this.getChat();
      chat.push(msg);
      await this.ctx.storage.put("chat", chat.slice(-200));
      for (const { ws: w } of this.admitted()) this.send(w, { t: "chat", msg });
      return;
    }

    if (m.t === "state") {
      if (!a.admitted) return;
      if (typeof m.mic === "boolean") a.mic = m.mic;
      if (typeof m.cam === "boolean") a.cam = m.cam;
      if (typeof m.hand === "boolean") a.hand = m.hand;
      ws.serializeAttachment(a);
      this.broadcast({ t: "peer-state", id: a.id, mic: a.mic, cam: a.cam, hand: a.hand }, ws);
      return;
    }

    // ===== أوامر المعلم =====
    if (!host) return;
    const target = m.id ? this.find(m.id) : null;

    if (m.t === "admit" && target && !target.a.admitted) {
      await this.admit(target.ws, target.a);
      this.notifyLobby();
    } else if (m.t === "admit-all") {
      for (const x of this.socks().filter((s) => !s.a.admitted)) await this.admit(x.ws, x.a);
      this.notifyLobby();
    } else if (m.t === "deny" && target && !target.a.admitted) {
      this.send(target.ws, { t: "denied", reason: "host" });
      try { target.ws.close(4003, "denied"); } catch {}
    } else if ((m.t === "mute" || m.t === "cam-off") && target && target.a.role !== "host") {
      this.send(target.ws, { t: "force", what: m.t === "mute" ? "mute" : "cam-off" });
    } else if (m.t === "mute-all") {
      for (const x of this.admitted()) if (x.a.role !== "host") this.send(x.ws, { t: "force", what: "mute" });
    } else if (m.t === "lower-hand" && target) {
      target.a.hand = false;
      target.ws.serializeAttachment(target.a);
      this.broadcast({ t: "peer-state", id: target.a.id, mic: target.a.mic, cam: target.a.cam, hand: false });
    } else if (m.t === "kick" && target && target.a.role !== "host") {
      this.send(target.ws, { t: "kicked" });
      try { target.ws.close(4002, "kicked"); } catch {}
    } else if (m.t === "set") {
      const st = await this.getState();
      if (typeof m.lobby === "boolean") st.lobby = m.lobby;
      if (typeof m.locked === "boolean") st.locked = m.locked;
      if (typeof m.chat === "boolean") st.chat = m.chat;
      await this.ctx.storage.put("st", st);
      for (const { ws: w } of this.socks()) this.send(w, { t: "state", state: st });
      if (m.lobby === false) {
        for (const x of this.socks().filter((s) => !s.a.admitted)) await this.admit(x.ws, x.a);
        this.notifyLobby();
      }
    } else if (m.t === "clear-chat") {
      await this.ctx.storage.put("chat", []);
      for (const { ws: w } of this.admitted()) this.send(w, { t: "chat-cleared" });
    } else if (m.t === "end") {
      for (const { ws: w, a: x } of this.socks()) {
        if (w === ws || x.role === "host") continue;
        this.send(w, { t: "ended" });
        try { w.close(4004, "ended"); } catch {}
      }
    }
  }

  async webSocketClose(ws) {
    this.gone(ws);
  }
  async webSocketError(ws) {
    this.gone(ws);
  }
  gone(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    if (a.admitted) {
      this.broadcast({ t: "peer-left", id: a.id }, ws);
      if (a.role === "host" && !this.admitted().some((x) => x.ws !== ws && x.a.role === "host")) {
        for (const { ws: w } of this.socks()) if (w !== ws) this.send(w, { t: "host-present", value: false });
      }
    } else {
      // تحديث قائمة الانتظار عند المعلم
      const list = this.socks().filter((x) => x.ws !== ws && !x.a.admitted).map((x) => pub(x.a));
      for (const { ws: w, a: x } of this.admitted()) if (x.role === "host") this.send(w, { t: "lobby", list });
    }
  }
}
