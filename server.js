const http = require("http");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PUBLIC_DIR = path.join(__dirname, "public");

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 20000) {
        reject(new Error("Слишком большой запрос"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Некорректные данные"));
      }
    });
    req.on("error", reject);
  });
}
function esc(v) {
  return String(v || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}
async function tg(method, payload = {}) {
  if (!TOKEN) throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.description || "Ошибка Telegram API");
  return j;
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && u.pathname === "/health")
    return json(res, 200, { ok: true });
  if (req.method === "GET" && u.pathname === "/setup") {
    const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Настройка Telegram</title><style>body{font:16px Arial;background:#091323;color:#eef5ff;max-width:650px;margin:45px auto;padding:20px}button{padding:12px 18px;background:#62c5ed;border:0;border-radius:8px;font-weight:bold}pre{white-space:pre-wrap;background:#132238;padding:15px;border-radius:8px}</style><h1>Подключение Telegram</h1><p>Сначала откройте своего бота и отправьте ему <b>/start</b>. Затем нажмите кнопку ниже.</p><button id="b">Получить мой chat ID</button><pre id="o">Ожидание...</pre><script>document.getElementById('b').onclick=async()=>{let o=document.getElementById('o');o.textContent='Проверяем...';try{let r=await fetch('/api/setup-chat-id'),j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Ошибка');o.textContent='Ваш chat ID: '+j.chatId+'\\\\nСкопируйте его в TELEGRAM_CHAT_ID в настройках хостинга.'}catch(e){o.textContent=e.message+'\\\\nУбедитесь, что отправили /start боту.'}}</script></html>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(page);
  }
  if (req.method === "GET" && u.pathname === "/api/setup-chat-id") {
    try {
      const j = await tg("getUpdates", {
        limit: 100,
        allowed_updates: ["message"],
      });
      const msgs = (j.result || []).filter((x) => x.message && x.message.chat);
      if (!msgs.length)
        return json(res, 404, {
          ok: false,
          error: "Сообщений нет. Отправьте боту /start и повторите.",
        });
      return json(res, 200, {
        ok: true,
        chatId: String(msgs[msgs.length - 1].message.chat.id),
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (req.method === "POST" && u.pathname === "/api/register") {
    try {
      if (!CHAT_ID)
        return json(res, 503, {
          ok: false,
          error: "Не настроен получатель Telegram",
        });
      const d = await body(req),
        name = String(d.name || "")
          .trim()
          .slice(0, 100),
        phone = String(d.phone || "")
          .trim()
          .slice(0, 50),
        kind = String(d.format || "Хочу участвовать")
          .trim()
          .slice(0, 100);
      if (!name || !phone)
        return json(res, 400, { ok: false, error: "Укажите имя и телефон" });
      const msg = [
        "🎟 <b>НОВАЯ ЗАЯВКА — КОНГРЕСС-2026</b>",
        "",
        `👤 Имя: ${esc(name)}`,
        `📞 Телефон: ${esc(phone)}`,
        `📌 Запрос: ${esc(kind)}`,
        "💳 Билет: <b>2 500 ₽</b>",
        "📅 19–20 декабря 2026",
        "📍 Барнаул, Сибирская Медиагруппа",
      ].join("\n");
      await tg("sendMessage", {
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      console.error(e.message);
      return json(res, 500, {
        ok: false,
        error: "Не удалось отправить заявку в Telegram",
      });
    }
  }
  if (req.method === "GET") {
    const rel =
        u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, ""),
      file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep))
      return json(res, 403, { error: "Forbidden" });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: "Not found" });
      const ext = path.extname(file);
      res.writeHead(200, {
        "Content-Type":
          ext === ".html"
            ? "text/html; charset=utf-8"
            : "application/octet-stream",
      });
      res.end(data);
    });
    return;
  }
  return json(res, 404, { error: "Not found" });
});
server.listen(PORT, () => console.log("Server listening on " + PORT));
