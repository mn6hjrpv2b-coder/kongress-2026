const http = require("http");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

// ---- Настройки: меняются здесь или в переменных окружения хостинга ----
const TICKET_PRICE = process.env.TICKET_PRICE ?? "2 500 ₽"; // пустая строка — строка о билете в заявку не попадёт
const EVENT_DATES = "19–20 декабря 2026";
const EVENT_PLACE = "Барнаул, Сибирская Медиагруппа";
const FORMATS = ["Хочу участвовать", "Хочу узнать подробности", "Рассматриваю партнёрство"];
const LIMIT_PER_ADDRESS = 5;            // заявок с одного адреса
const LIMIT_WINDOW_MS = 10 * 60 * 1000; // за 10 минут
const LIMIT_TOTAL_PER_HOUR = 300;       // всего заявок в час со всех адресов
// -----------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const SETUP_SECRET = String(process.env.SETUP_SECRET || "").trim();
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org"; // менять только для проверки на заглушке
const PUBLIC_DIR = path.join(__dirname, "public");
const CHAT_READY = CHAT_ID !== "" && CHAT_ID !== "0";
// Почта: заявка уходит письмом организатору. Пароль — «пароль для внешнего приложения» mail.ru, не пароль от ящика.
const SMTP_HOST = process.env.SMTP_HOST || "smtp.mail.ru";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
// 465 — сразу защищённое соединение, 587 — защита включается после подключения (STARTTLS).
const SMTP_SECURE = process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== "false" : SMTP_PORT === 465;
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const MAIL_TO = String(process.env.MAIL_TO || SMTP_USER).trim();
const MAIL_READY = SMTP_USER !== "" && SMTP_PASS !== "" && MAIL_TO !== "";
const mailer = MAIL_READY ? nodemailer.createTransport({host:SMTP_HOST,port:SMTP_PORT,secure:SMTP_SECURE,auth:{user:SMTP_USER,pass:SMTP_PASS},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000}) : null;
// Заявки с отметкой согласия хранятся на этом сервере (файл JSON Lines, одна заявка — одна строка).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const REG_FILE = path.join(DATA_DIR, "registrations.jsonl");
// Настройка открыта, только пока получатель не задан и только по секретному слову из SETUP_SECRET.
const SETUP_OPEN = !CHAT_READY && SETUP_SECRET.length >= 8;
const TYPES = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".svg":"image/svg+xml",".ico":"image/x-icon",".webp":"image/webp",".txt":"text/plain; charset=utf-8"};

function json(res, status, data) {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on("data",chunk=>{size+=chunk.length;if(size>20000){reject(new Error("Слишком большой запрос"));req.destroy();return;}chunks.push(chunk);});
    req.on("end",()=>{try{const d=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");resolve(d&&typeof d==="object"?d:{});}catch{reject(new Error("Некорректные данные"));}});
    req.on("error",reject);
  });
}
function esc(v){return String(v||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function clean(v,max){return String(v||"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);}
async function tg(method,payload={}) {
  if(!TOKEN) throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  const r=await fetch(`${API_BASE}/bot${TOKEN}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.description||"Ошибка Telegram API"); return j;
}
function saveRegistration(rec){
  fs.mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
  fs.appendFileSync(REG_FILE,JSON.stringify(rec)+"\n",{encoding:"utf8",mode:0o600});
}
async function sendMail(rec){
  const lines=[
    "Новая заявка на форум",
    "",
    `Имя: ${rec.first_name}`,
    `Фамилия: ${rec.last_name}`,
    `Телефон: ${rec.phone}`,
    `Запрос: ${rec.format}`,
  ];
  if(TICKET_PRICE.trim())lines.push(`Билет: ${TICKET_PRICE.trim()}`);
  lines.push(`Даты: ${EVENT_DATES}`,`Место: ${EVENT_PLACE}`,"",`Согласие на обработку персональных данных: дано ${rec.consent_at} (UTC)`,`Номер заявки: ${rec.id}`);
  await mailer.sendMail({from:SMTP_USER,to:MAIL_TO,subject:`Заявка на форум: ${rec.first_name} ${rec.last_name}`.trim(),text:lines.join("\n")});
}
function sameKey(a,b){
  if(a.length!==b.length) return false;
  let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0;
}

// Простой счётчик заявок в памяти. При перезапуске сервера обнуляется.
const hits=new Map(); let total=[];
function address(req){
  // За прокси хостинга адрес посетителя — первый в X-Forwarded-For. Его можно подделать, поэтому есть ещё общий предел в час.
  const xff=String(req.headers["x-forwarded-for"]||"").split(",").map(s=>s.trim()).filter(Boolean);
  return (xff.length?xff[0]:(req.socket.remoteAddress||"?")).slice(0,64);
}
function allowed(addr){
  const now=Date.now();
  total=total.filter(t=>now-t<3600000);
  if(total.length>=LIMIT_TOTAL_PER_HOUR) return false;
  const list=(hits.get(addr)||[]).filter(t=>now-t<LIMIT_WINDOW_MS);
  if(list.length>=LIMIT_PER_ADDRESS){hits.set(addr,list);return false;}
  list.push(now);hits.set(addr,list);total.push(now);
  if(hits.size>5000){for(const [k,v] of hits){if(!v.some(t=>now-t<LIMIT_WINDOW_MS))hits.delete(k);}}
  return true;
}

const server=http.createServer(async(req,res)=>{
  let u;
  try{u=new URL(req.url,"http://localhost");}catch{return json(res,400,{error:"Bad request"});}
  if(req.method==="GET"&&u.pathname==="/health") return json(res,200,{ok:true});

  if(u.pathname==="/setup"||u.pathname==="/api/setup-chat-id"){
    // Закрыто для всех, как только задан TELEGRAM_CHAT_ID или не задано секретное слово.
    if(req.method!=="GET"||!SETUP_OPEN||!sameKey(String(u.searchParams.get("key")||""),SETUP_SECRET)) return json(res,404,{error:"Not found"});
    if(u.pathname==="/setup"){
      const page=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Настройка Telegram</title><style>body{font:16px Arial;background:#091323;color:#eef5ff;max-width:650px;margin:45px auto;padding:20px}button{padding:12px 18px;background:#62c5ed;border:0;border-radius:8px;font-weight:bold}pre{white-space:pre-wrap;background:#132238;padding:15px;border-radius:8px}</style><h1>Подключение Telegram</h1><p>Сначала откройте своего бота и отправьте ему <b>/start</b>. Затем нажмите кнопку ниже.</p><button id="b">Получить мой chat ID</button><pre id="o">Ожидание...</pre><script>document.getElementById('b').onclick=async()=>{let o=document.getElementById('o');o.textContent='Проверяем...';try{let r=await fetch('/api/setup-chat-id'+location.search),j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Ошибка');o.textContent='Ваш chat ID: '+j.chatId+'\\nОт кого последнее сообщение: '+j.from+'\\nСкопируйте число в TELEGRAM_CHAT_ID в настройках хостинга. После этого страница настройки закроется сама.'}catch(e){o.textContent=e.message+'\\nУбедитесь, что отправили /start боту.'}}</script></html>`;
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}); return res.end(page);
    }
    try{
      const j=await tg("getUpdates",{limit:100,allowed_updates:["message"]});
      const msgs=(j.result||[]).filter(x=>x.message&&x.message.chat);
      if(!msgs.length)return json(res,404,{ok:false,error:"Сообщений нет. Отправьте боту /start и повторите."});
      const chat=msgs[msgs.length-1].message.chat;
      return json(res,200,{ok:true,chatId:String(chat.id),from:clean(chat.title||chat.first_name||chat.username||"без имени",60)});
    }catch(e){console.error("setup:",e.message);return json(res,500,{ok:false,error:"Telegram не ответил: "+e.message});}
  }

  if(req.method==="POST"&&u.pathname==="/api/register"){
    try{
      if(!MAIL_READY)return json(res,503,{ok:false,error:"Не настроена почта для заявок"});
      if(!String(req.headers["content-type"]||"").toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Некорректные данные"});
      const d=await body(req);
      // Скрытое поле-ловушка: человек его не видит и не заполняет. Заполнено — молча отвечаем «принято» и ничего не шлём.
      if(clean(d.website,200))return json(res,200,{ok:true});
      let first=clean(d.first_name,100),last=clean(d.last_name,100);
      if(!first&&!last){const parts=clean(d.name,100).split(/\s+/);first=parts.shift()||"";last=parts.join(" ");} // старая форма присылала одно поле name
      const phone=clean(d.phone,50),kindRaw=clean(d.format,100);
      const kind=FORMATS.includes(kindRaw)?kindRaw:FORMATS[0];
      if(!first||!phone)return json(res,400,{ok:false,error:"Укажите имя и телефон"});
      const digits=phone.replace(/\D/g,"");
      if(digits.length<7||digits.length>15||/[^\d\s()+\-.]/.test(phone))return json(res,400,{ok:false,error:"Проверьте номер телефона"});
      if(d.consent!==true&&d.consent!=="yes"&&d.consent!=="on")return json(res,400,{ok:false,error:"Отметьте согласие на обработку персональных данных"});
      if(!allowed(address(req)))return json(res,429,{ok:false,error:"Слишком много заявок. Попробуйте через несколько минут."});
      const now=new Date().toISOString();
      const rec={id:now.replace(/\D/g,"").slice(0,14)+"-"+Math.random().toString(36).slice(2,6),received_at:now,first_name:first,last_name:last,phone,format:kind,consent:true,consent_at:now,consent_doc:"/soglasie.html"};
      // Сначала запись на сервер: если почта не ответит, заявка всё равно не потеряется.
      saveRegistration(rec);
      let mailed=true;
      try{await sendMail(rec);}catch(e){mailed=false;console.error("mail:",e.message);}
      // В Telegram — только сигнал, без имени и телефона.
      if(TOKEN&&CHAT_READY){
        const signal=mailed?"Новая заявка на сайте, проверьте почту.":"Новая заявка на сайте. Письмо не ушло – заявка сохранена на сервере, проверьте настройки почты.";
        try{await tg("sendMessage",{chat_id:CHAT_ID,text:signal,disable_web_page_preview:true});}catch(e){console.error("telegram:",e.message);}
      }
      return json(res,200,{ok:true});
    }catch(e){
      console.error("register:",e.message); // в журнал — только текст ошибки, без имени и телефона
      if(e.message==="Слишком большой запрос"||e.message==="Некорректные данные")return json(res,400,{ok:false,error:e.message});
      return json(res,500,{ok:false,error:"Не удалось отправить заявку"});
    }
  }

  if(req.method==="GET"||req.method==="HEAD"){
    let rel;
    try{rel=u.pathname==="/"?"index.html":decodeURIComponent(u.pathname).replace(/^\/+/,"");}catch{return json(res,400,{error:"Bad request"});}
    if(rel.includes("\0"))return json(res,400,{error:"Bad request"}); // нулевой байт роняет fs.readFile
    let file=path.resolve(PUBLIC_DIR,rel);
    if(!file.startsWith(PUBLIC_DIR+path.sep))return json(res,403,{error:"Forbidden"});
    // Если папки public нет (файлы загружены с телефона в корень), главная страница берётся из index.html рядом с server.js.
    if(rel==="index.html"&&!fs.existsSync(file))file=path.join(__dirname,"index.html");
    const type=TYPES[path.extname(file).toLowerCase()];
    if(!type)return json(res,404,{error:"Not found"});
    fs.readFile(file,(err,data)=>{
      if(err)return json(res,404,{error:"Not found"});
      res.writeHead(200,{"Content-Type":type,"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"strict-origin-when-cross-origin","Cache-Control":"no-cache"});
      res.end(req.method==="HEAD"?undefined:data);
    });
    return;
  }
  return json(res,404,{error:"Not found"});
});
server.listen(PORT,HOST,()=>console.log(`Server listening on ${PORT}; почта ${MAIL_READY?"задана":"НЕ задана"}; Telegram ${CHAT_READY?"задан":"НЕ задан"}; настройка ${SETUP_OPEN?"открыта по секретному слову":"закрыта"}`));
