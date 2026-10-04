import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import D from "./defaults.mjs";

export const config = { path: "/api/*" };

const st = () => getStore("ro-terzi");
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cut = (v, n) => String(v ?? "").trim().slice(0, n);

// ---- Kimlik doğrulama (şifre Netlify ortam değişkeninden: ADMIN_PASSWORD) ----
const secret = () => process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "";
const sign = (p) => crypto.createHmac("sha256", secret()).update(p).digest("base64url");
const mkToken = () => { const e = String(Date.now() + 12 * 3600e3); return e + "." + sign(e); };
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function authed(req) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  const [e, s] = t.split(".");
  if (!e || !s || !secret() || Number(e) < Date.now()) return false;
  const a = Buffer.from(s), b = Buffer.from(sign(e));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- E-posta bildirimi (Resend). Ayarlı değilse sessizce atlanır ----
const h = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function notify(name, text, origin) {
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({
        from: "RO Terzi <onboarding@resend.dev>", to: [to], subject: "Yeni yorum onay bekliyor",
        html: `<p><b>${h(name)}</b> yeni bir yorum yazdı:</p><blockquote>${h(text)}</blockquote><p><a href="${origin}/admin">Panele gir ve onayla</a></p>`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

// ---- Veri ----
async function load() {
  const s = st();
  const site = (await s.get("site", { type: "json" })) || { content: D.content, services: D.services, gallery: D.gallery };
  const comments = (await s.get("comments", { type: "json" })) || D.comments;
  return { site, comments };
}

export default async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const m = req.method;
  let body = {};
  if (m === "POST" || m === "PUT") { try { body = await req.json(); } catch { return J({ error: "bad json" }, 400); } }
  const s = st();

  // ---------- Herkese açık ----------
  if (path === "public" && m === "GET") {
    const { site, comments } = await load();
    return J({ ...site, comments: comments.filter((c) => c.approved).slice(0, 60) });
  }

  if (path === "comment" && m === "POST") {
    if (body.website) return J({ ok: true }); // bot tuzağı
    const name = cut(body.name, 60), text = cut(body.text, 600);
    if (name.length < 2 || text.length < 5) return J({ error: "invalid" }, 400);
    const { comments } = await load();
    if (comments.filter((c) => !c.approved).length >= 200) return J({ error: "busy" }, 429);
    comments.unshift({ id: crypto.randomUUID(), name, text, date: new Date().toISOString(), approved: false });
    await s.setJSON("comments", comments);
    await notify(name, text, new URL(req.url).origin);
    return J({ ok: true });
  }

  if (path.startsWith("img/") && m === "GET") {
    const id = path.slice(4);
    if (!/^[\w-]+$/.test(id)) return J({ error: "nf" }, 404);
    const r = await s.getWithMetadata("img/" + id, { type: "arrayBuffer" });
    if (!r) return J({ error: "nf" }, 404);
    return new Response(r.data, { headers: { "content-type": r.metadata?.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }

  if (path === "login" && m === "POST") {
    await new Promise((r) => setTimeout(r, 700)); // kaba kuvveti yavaşlat
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) return J({ error: "ADMIN_PASSWORD ayarlanmamış" }, 500);
    if (crypto.timingSafeEqual(sha(body.password), sha(pw))) return J({ token: mkToken() });
    return J({ error: "Yanlış şifre" }, 401);
  }

  // ---------- Admin ----------
  if (!path.startsWith("admin/")) return J({ error: "not found" }, 404);
  if (!authed(req)) return J({ error: "unauthorized" }, 401);

  if (path === "admin/data" && m === "GET") {
    const { site, comments } = await load();
    return J({ ...site, comments });
  }

  if (path === "admin/data" && m === "PUT") {
    const cur = (await load()).site;
    const content = {};
    for (const k of Object.keys(D.content)) content[k] = cut(body.content?.[k] ?? cur.content[k], 800);
    if (!/^https:\/\/[^\s"'<>]+$/i.test(content.instagram)) content.instagram = "";
    const services = (body.services || []).slice(0, 20).map((x) => ({
      icon: /^[a-z-]{2,30}$/.test(x.icon) ? x.icon : "star", title: cut(x.title, 80), text: cut(x.text, 300),
    }));
    const gallery = (body.gallery || []).slice(0, 24)
      .filter((g) => /^(\/api\/img\/[\w-]+|https:\/\/[^\s"'<>]+)$/.test(g.src))
      .map((g) => ({ src: g.src, label: cut(g.label, 60) }));
    await s.setJSON("site", { content, services, gallery });
    // Galeriden çıkarılan yüklenmiş fotoğrafları temizle
    try {
      const used = new Set(gallery.map((g) => g.src));
      const { blobs } = await s.list({ prefix: "img/" });
      for (const b of blobs) if (!used.has("/api/" + b.key)) await s.delete(b.key);
    } catch {}
    return J({ ok: true });
  }

  if (path === "admin/comment" && m === "POST") {
    let { comments } = await load();
    const c = comments.find((x) => x.id === body.id);
    if (!c) return J({ error: "nf" }, 404);
    if (body.action === "approve") c.approved = true;
    else if (body.action === "unapprove") c.approved = false;
    else if (body.action === "delete") comments = comments.filter((x) => x.id !== body.id);
    else return J({ error: "bad action" }, 400);
    await s.setJSON("comments", comments);
    return J({ comments });
  }

  if (path === "admin/upload" && m === "POST") {
    const r = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl || "");
    if (!r) return J({ error: "Geçersiz görsel" }, 400);
    const buf = Buffer.from(r[2], "base64");
    if (buf.length > 1.5 * 1024 * 1024) return J({ error: "Görsel çok büyük" }, 413);
    const id = crypto.randomUUID();
    await s.set("img/" + id, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { metadata: { type: "image/" + r[1] } });
    return J({ src: "/api/img/" + id });
  }

  return J({ error: "not found" }, 404);
};
