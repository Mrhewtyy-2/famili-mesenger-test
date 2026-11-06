require('dotenv').config();
const fs = require('fs');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const webpush = require('web-push');
const cloudinary = require('cloudinary').v2;
const { v4: uuid } = require('uuid');
const { createClient } = require('@libsql/client');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'dev_secret_change_me') {
  console.error('❌ JWT_SECRET не задан или слишком короткий (нужно минимум 32 символа).');
  console.error('   Сгенерируй: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('   и добавь в Render → Environment → JWT_SECRET.');
  process.exit(1);
}
// Код приглашения: без него никто посторонний не сможет зарегистрироваться
const INVITE_CODE = process.env.INVITE_CODE || '';
if (!INVITE_CODE) {
  console.warn('⚠️  INVITE_CODE не задан — регистрация новых пользователей закрыта.');
}
// Если сайт и сервер на одном адресе (как у тебя), ALLOWED_ORIGIN не нужен.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || false;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// ---------- 2FA: настройки ----------
// Временный "пропуск" между вводом пароля и вводом кода подписывается ДРУГИМ ключом,
// поэтому его нельзя использовать как обычный токен входа.
const CHALLENGE_SECRET = crypto.createHmac('sha256', JWT_SECRET).update('mio-2fa-challenge').digest('hex');
const TG_WEBHOOK_SECRET = crypto.createHmac('sha256', JWT_SECRET).update('mio-telegram-webhook').digest('hex').slice(0, 48);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const telegramConfigured = () => !!(TG_TOKEN && TG_BOT_USERNAME);
const emailConfigured = () => !!(process.env.MAIL_FROM && (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY));

// ---------- VAPID-КЛЮЧИ ДЛЯ PUSH ----------
// Раньше ключи хранились в файле на диске Render, который сбрасывался при
// пересборке — из-за этого все подписки на пуши "ломались" каждый раз.
// Теперь предпочтительно брать их из переменных окружения (стабильны всегда).
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  console.warn('⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY не заданы в переменных окружения.');
  console.warn('    Ключи сгенерированы временно, но пропадут при следующей пересборке — push перестанет работать.');
  console.warn('    Чтобы это исправить один раз и навсегда, добавь в Render → Environment:');
  console.warn(`    VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
  console.warn(`    VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
}
webpush.setVapidDetails(`mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`, vapidKeys.publicKey, vapidKeys.privateKey);

// ---------- CLOUDINARY (постоянное хранилище фото/видео/голосовых) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const cloudinaryReady = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

function uploadBufferToCloudinary(buffer, resourceType, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder: 'family-messenger', ...extraOptions },
      (err, result) => {
        if (err) reject(err); else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// ---------- БАЗА ДАННЫХ (Turso / libSQL) ----------
// Если TURSO_DATABASE_URL не задан — используется локальный файл (для разработки на своём компьютере).
// В проде (Render) обязательно нужно задать TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function run(sql, args = []) {
  return db.execute({ sql, args });
}
async function get(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows[0] || null;
}
async function all(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows;
}

// ---------- ПРОВЕРКИ БЕЗОПАСНОСТИ ----------
// Ссылки на файлы принимаем ТОЛЬКО с нашего Cloudinary (иначе можно подсунуть вредный код в страницу)
function isSafeMediaUrl(u) {
  if (typeof u !== 'string' || u.length > 600) return false;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return false;
  if (!u.startsWith(`https://res.cloudinary.com/${cloud}/`)) return false;
  return /^[^\s"'`<>\\]+$/.test(u);
}
function isValidEmoji(e) {
  return typeof e === 'string' && e.length > 0 && e.length <= 16 && !/[<>"'&`\\\/\x00-\x1f]/.test(e);
}
const obj = (x) => (x && typeof x === 'object' ? x : {});

async function isChatMember(chatId, userId) {
  if (typeof chatId !== 'string') return false;
  const row = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  return !!row;
}
async function sharesChat(a, b) {
  if (a === b) return true;
  const row = await get(
    'SELECT 1 as ok FROM chat_members m1 JOIN chat_members m2 ON m1.chat_id = m2.chat_id WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1',
    [a, b]
  );
  return !!row;
}
async function loadChat(id) {
  return get('SELECT id, type, created_by FROM chats WHERE id = ?', [id]);
}
// ---------- ИМЕНА, БЛОКИРОВКИ, PREMIUM ----------
const RESERVED_NAMES = new Set(['admin', 'administrator', 'root', 'support', 'moderator', 'mod', 'system', 'mio', 'mío', 'official', 'staff', 'help', 'security', 'telegram', 'null', 'undefined', 'api', 'owner']);
const LOOKALIKES = { 'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ɡ': 'g', '0': 'o', '1': 'l', 'i': 'l', 'í': 'l' };
function nameSkeleton(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split('').map((ch) => LOOKALIKES[ch] || ch).join('');
}
// Проверка формата имени; allowReserved — для админа / первого входа владельца
function validateUsername(raw, allowReserved = false) {
  if (typeof raw !== 'string') return 'invalid_username';
  const u = raw.trim();
  if (!/^[\p{L}\p{N}_]{3,24}$/u.test(u)) return 'invalid_username';
  if (!allowReserved) {
    const skel = nameSkeleton(u);
    const admin = process.env.ADMIN_USERNAME ? nameSkeleton(process.env.ADMIN_USERNAME) : null;
    if (RESERVED_NAMES.has(u.toLowerCase()) || [...RESERVED_NAMES].some((r) => nameSkeleton(r) === skel) || (admin && skel === admin)) {
      return 'username_reserved';
    }
  }
  return null;
}
// Занято ли имя (в том числе похожее по написанию и недавно освобождённое другим человеком)
async function usernameTaken(name, exceptUserId) {
  const skel = nameSkeleton(name);
  const ex = exceptUserId || '';
  const a = await get('SELECT id FROM users WHERE (LOWER(username) = LOWER(?) OR username_skel = ?) AND id != ? LIMIT 1', [name, skel, ex]);
  if (a) return true;
  const b = await get('SELECT id FROM username_history WHERE old_skel = ? AND user_id != ? AND changed_at > ? LIMIT 1', [skel, ex, Date.now() - 30 * 86400000]);
  return !!b;
}

async function isBlockedEither(a, b) {
  const row = await get('SELECT 1 AS ok FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1', [a, b, b, a]);
  return !!row;
}

function isPremiumRow(r) {
  return !!(r && Number(r.premium) && (!r.premium_until || Number(r.premium_until) > Date.now()));
}
async function expirePremium() {
  try {
    await run('UPDATE users SET premium = 0 WHERE premium = 1 AND premium_until IS NOT NULL AND premium_until < ?', [Date.now()]);
  } catch (e) {
    console.error('expirePremium failed:', e.message);
  }
}

// Поиск людей: только по началу логина, от 3 символов, без скрытых и заблокированных
async function searchUsersFor(userId, rawQuery) {
  const raw = String(rawQuery || '').trim().replace(/^@/, '').slice(0, 30);
  if (raw.length < 3) return [];
  const prefix = `${raw.replace(/[!%_]/g, '!$&')}%`;
  const rows = await all(`
    SELECT u.id, u.username, u.avatar, u.display_name, u.verified, u.premium, u.premium_emoji, u.premium_until, u.hide_from_search, u.banned, u.ban_reason, u.banned_until
    FROM users u
    WHERE u.username LIKE ? ESCAPE '!' AND u.id != ?
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))
    ORDER BY LENGTH(u.username), u.username
    LIMIT 30
  `, [prefix, userId, userId, userId]);
  const low = raw.toLowerCase();
  return rows
    .filter((u) => !activeBan(u) && (!Number(u.hide_from_search) || String(u.username).toLowerCase() === low))
    .slice(0, 10)
    .map((u) => ({
      id: u.id, username: u.username, avatar: u.avatar, display_name: u.display_name,
      verified: u.verified, premium: isPremiumRow(u) ? 1 : 0, premium_emoji: u.premium_emoji,
    }));
}

const USERNAME_COOLDOWN = 14 * 86400000;
async function changeUsername(user, rawNew) {
  const newName = typeof rawNew === 'string' ? rawNew.trim() : '';
  if (newName === user.username) return { code: 400, json: { error: 'same_username' } };
  const err = validateUsername(newName, !!Number(user.is_admin));
  if (err) return { code: 400, json: { error: err } };
  if (user.username_changed_at && Date.now() - Number(user.username_changed_at) < USERNAME_COOLDOWN) {
    return { code: 429, json: { error: 'username_cooldown', until: Number(user.username_changed_at) + USERNAME_COOLDOWN } };
  }
  if (await usernameTaken(newName, user.id)) return { code: 409, json: { error: 'username_taken' } };

  const now = Date.now();
  await run('UPDATE users SET username = ?, username_skel = ?, username_changed_at = ? WHERE id = ?', [newName, nameSkeleton(newName), now, user.id]);
  await run('INSERT INTO username_history (id, user_id, old_username, new_username, old_skel, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uuid(), user.id, user.username, newName, nameSkeleton(user.username), now]);
  return { code: 200, json: { ok: true, username: newName }, newName };
}

// Заглушка-хеш, чтобы вход под несуществующим логином занимал столько же времени, сколько и обычный
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ---------- 2FA: КОДЫ, ПОЧТА, TELEGRAM ----------
const OTP_TTL = 10 * 60 * 1000;
const hashToken = (v) => crypto.createHash('sha256').update(`${JWT_SECRET}:${v}`).digest('hex');
const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]{1,255}\.[^\s@<>"'`]{2,}$/;
const normalizeEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase().slice(0, 254) : '');

function maskEmail(e) {
  if (typeof e !== 'string' || !e.includes('@')) return '';
  const [name, domain] = e.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}
function maskPhone(p) {
  const d = String(p || '');
  return d.length > 5 ? `${d.slice(0, 3)}***${d.slice(-2)}` : '***';
}
// Какими способами этот человек реально может получить код прямо сейчас
function userMethods(user) {
  const m = [];
  if (user.totp_enabled && user.totp_secret) m.push('totp');
  if (user.email && user.email_verified && emailConfigured()) m.push('email');
  if (user.tg_chat_id && telegramConfigured()) m.push('telegram');
  return m;
}
const methodHint = (user, method) => (method === 'email' ? maskEmail(user.email) : maskPhone(user.tg_phone));

// Создать одноразовый код. В базе хранится только хеш, не сам код.
async function createOtp(userId, purpose, channel, extra = null) {
  const now = Date.now();
  await run('DELETE FROM otp_codes WHERE expires_at < ?', [now - 3600 * 1000]);
  const last = await get('SELECT created_at FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1', [userId, purpose]);
  if (last && now - Number(last.created_at) < 45000) return { error: 'too_soon' };
  const cnt = await get('SELECT COUNT(*) AS c FROM otp_codes WHERE user_id = ? AND created_at > ?', [userId, now - 3600 * 1000]);
  if (Number(cnt && cnt.c) >= 10) return { error: 'too_many_codes' };

  const id = uuid();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await run(
    'INSERT INTO otp_codes (id, user_id, purpose, channel, code_hash, extra, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
    [id, userId, purpose, channel, hashToken(`${id}:${code}`), extra, now + OTP_TTL, now]
  );
  return { id, code };
}

// Проверить код: живёт 10 минут, 5 попыток, после успеха удаляется (одноразовый)
async function verifyOtp(userId, purpose, code) {
  const row = await get('SELECT * FROM otp_codes WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1', [userId, purpose]);
  if (!row || Number(row.expires_at) < Date.now()) return { ok: false, error: 'code_expired' };
  if (Number(row.attempts) >= 5) return { ok: false, error: 'too_many_attempts' };
  await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  const clean = typeof code === 'string' ? code.trim() : '';
  if (!/^\d{6}$/.test(clean)) return { ok: false, error: 'wrong_code' };
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hashToken(`${row.id}:${clean}`), 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, error: 'wrong_code' };
  await run('DELETE FROM otp_codes WHERE id = ?', [row.id]);
  return { ok: true, row };
}

// Почта через HTTP-API (на бесплатном Render обычный SMTP заблокирован)
async function sendEmail(to, subject, text) {
  const from = process.env.MAIL_FROM;
  const name = process.env.MAIL_FROM_NAME || 'Mío';
  try {
    let r;
    if (process.env.BREVO_API_KEY && from) {
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name, email: from }, to: [{ email: to }], subject, textContent: text }),
        signal: AbortSignal.timeout(10000),
      });
    } else if (process.env.RESEND_API_KEY && from) {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${name} <${from}>`, to: [to], subject, text }),
        signal: AbortSignal.timeout(10000),
      });
    } else {
      return false;
    }
    if (!r.ok) console.error('sendEmail failed:', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error('sendEmail error:', e.message);
    return false;
  }
}

async function tgCall(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return r.json().catch(() => ({ ok: false }));
}
async function sendTelegram(chatId, text, extra = {}) {
  if (!TG_TOKEN) return false;
  try {
    const j = await tgCall('sendMessage', { chat_id: chatId, text, ...extra });
    if (!j.ok) console.error('telegram sendMessage failed:', j.description);
    return !!j.ok;
  } catch (e) {
    console.error('telegram error:', e.message);
    return false;
  }
}

async function deliverCode(user, method, code, reason) {
  const text = `Mío: ${reason}\nКод: ${code}\nДействует 10 минут. Никому его не сообщайте.`;
  if (method === 'email') return sendEmail(user.email, 'Код подтверждения Mío', text);
  if (method === 'telegram') return sendTelegram(user.tg_chat_id, text);
  return false;
}

// ---------- TOTP (приложение-аутентификатор, RFC 6238) ----------
// Работает без интернета и без сторонних сервисов: код считает приложение на телефоне.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter, digits = 6) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(b).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
// Возвращает номер 30-секундного шага, если код подошёл (допускаем ±1 шаг на разницу часов),
// и только если этот шаг новее уже использованного (один код нельзя применить дважды)
function totpFindStep(secretB32, code, lastStep = 0, now = Date.now()) {
  const secret = base32Decode(secretB32);
  const cur = Math.floor(now / 30000);
  const given = Buffer.from(String(code));
  let found = null;
  for (let d = -1; d <= 1; d++) {
    const step = cur + d;
    const expected = Buffer.from(hotp(secret, step));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected) && step > lastStep) found = step;
  }
  return found;
}

// Секрет TOTP хранится в базе зашифрованным (AES-256-GCM). Ключ: TOTP_ENCRYPTION_KEY или, если не задан, производный от JWT_SECRET.
const TOTP_KEY = crypto.createHash('sha256').update(`mio-totp:${process.env.TOTP_ENCRYPTION_KEY || JWT_SECRET}`).digest();
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', TOTP_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(b64) {
  try {
    const b = Buffer.from(String(b64), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', TOTP_KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// Резервные коды на случай потери телефона: 8 штук, каждый работает один раз, в базе только хеши
function makeBackupCodes() {
  return Array.from({ length: 8 }, () => {
    const h = crypto.randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}
const normBackup = (c) => String(c || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
const hashBackup = (userId, code) => hashToken(`backup:${userId}:${normBackup(code)}`);
function parseBackup(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// Счётчик попыток для входа по TOTP (не сбрасывается повторным вводом пароля)
async function startTotpChallenge(userId) {
  const now = Date.now();
  const row = await get("SELECT id, expires_at FROM otp_codes WHERE user_id = ? AND purpose = 'login_totp' ORDER BY created_at DESC LIMIT 1", [userId]);
  if (row && Number(row.expires_at) > now) return;
  await run("DELETE FROM otp_codes WHERE user_id = ? AND purpose = 'login_totp'", [userId]);
  await run(
    "INSERT INTO otp_codes (id, user_id, purpose, channel, code_hash, extra, expires_at, attempts, created_at) VALUES (?, ?, 'login_totp', 'totp', 'totp', NULL, ?, 0, ?)",
    [uuid(), userId, now + OTP_TTL, now]
  );
}

async function verifyTotpLogin(user, code, kind) {
  const row = await get("SELECT * FROM otp_codes WHERE user_id = ? AND purpose = 'login_totp' ORDER BY created_at DESC LIMIT 1", [user.id]);
  if (!row || Number(row.expires_at) < Date.now()) return { ok: false, error: 'code_expired' };
  if (Number(row.attempts) >= 5) return { ok: false, error: 'too_many_attempts' };
  await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  const clean = typeof code === 'string' ? code.trim() : '';

  if (kind === 'backup') {
    const norm = normBackup(clean);
    if (norm.length !== 10) return { ok: false, error: 'wrong_code' };
    const list = parseBackup(user.backup_codes);
    const idx = list.indexOf(hashBackup(user.id, norm));
    if (idx === -1) return { ok: false, error: 'wrong_code' };
    list.splice(idx, 1);
    await run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(list), user.id]);
  } else {
    if (!/^\d{6}$/.test(clean)) return { ok: false, error: 'wrong_code' };
    const secret = decryptSecret(user.totp_secret);
    if (!secret) return { ok: false, error: 'totp_unavailable' };
    const step = totpFindStep(secret, clean, Number(user.totp_last_step || 0));
    if (step === null) return { ok: false, error: 'wrong_code' };
    await run('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, user.id]);
  }
  await run('DELETE FROM otp_codes WHERE id = ?', [row.id]);
  return { ok: true };
}

function readChallenge(token) {
  if (typeof token !== 'string') return null;
  try { return jwt.verify(token, CHALLENGE_SECRET, { algorithms: ['HS256'] }); } catch { return null; }
}

// Привязка Telegram: бот получает /start <токен>, затем контакт, и сверяет, что номер принадлежит самому человеку
async function handleTelegramUpdate(update) {
  const msg = obj(update.message);
  const from = obj(msg.from);
  const chat = obj(msg.chat);
  if (chat.type !== 'private' || !from.id) return;
  const chatId = String(chat.id);
  const now = Date.now();

  if (typeof msg.text === 'string' && msg.text.startsWith('/start')) {
    const token = msg.text.split(/\s+/)[1] || '';
    if (!/^[a-f0-9]{32}$/.test(token)) {
      await sendTelegram(chatId, 'Привет! Это бот семейного мессенджера Mío. Чтобы привязать Telegram, откройте в приложении Настройки → Безопасность и нажмите «Привязать Telegram».');
      return;
    }
    const row = await get("SELECT * FROM otp_codes WHERE id = ? AND purpose = 'tg_link'", [hashToken(`tg:${token}`)]);
    if (!row || Number(row.expires_at) < now) {
      await sendTelegram(chatId, 'Ссылка устарела. Вернитесь в приложение и нажмите «Привязать Telegram» ещё раз.');
      return;
    }
    await run('UPDATE otp_codes SET extra = ? WHERE id = ?', [String(from.id), row.id]);
    await sendTelegram(chatId, 'Чтобы подтвердить номер телефона, нажмите кнопку ниже и поделитесь своим контактом.', {
      reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return;
  }

  if (msg.contact) {
    const contact = obj(msg.contact);
    if (String(contact.user_id) !== String(from.id)) {
      await sendTelegram(chatId, 'Нужен именно ваш номер: нажмите кнопку «Поделиться номером», а не отправляйте чужой контакт.');
      return;
    }
    const row = await get("SELECT * FROM otp_codes WHERE purpose = 'tg_link' AND extra = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1", [String(from.id), now]);
    if (!row) {
      await sendTelegram(chatId, 'Не нашёл запрос на привязку. Нажмите «Привязать Telegram» в приложении ещё раз.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    const digits = String(contact.phone_number || '').replace(/[^\d]/g, '');
    await run('UPDATE users SET tg_chat_id = ?, tg_phone = ? WHERE id = ?', [chatId, digits ? `+${digits}` : null, row.user_id]);
    await run('DELETE FROM otp_codes WHERE id = ?', [row.id]);
    await sendTelegram(chatId, '✅ Готово! Telegram привязан к вашему аккаунту Mío. Вернитесь в приложение.', { reply_markup: { remove_keyboard: true } });
  }
}

async function registerTelegramWebhook() {
  if (!telegramConfigured()) return;
  if (!PUBLIC_URL) {
    console.warn('⚠️  Telegram настроен, но не найден PUBLIC_URL — вебхук не установлен. Добавь PUBLIC_URL=https://твой-сайт.onrender.com');
    return;
  }
  try {
    const j = await tgCall('setWebhook', { url: `${PUBLIC_URL}/api/telegram/webhook`, secret_token: TG_WEBHOOK_SECRET, allowed_updates: ['message'] });
    console.log(j.ok ? '✅ Telegram-вебхук установлен' : `⚠️  Не удалось установить Telegram-вебхук: ${j.description}`);
  } catch (e) {
    console.error('Telegram setWebhook error:', e.message);
  }
}

async function initDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT,
      media_url TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      subscription_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS message_reads (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
    )`,
  ];
  for (const sql of statements) {
    await db.execute(sql);
  }

  // Миграция: добавляем display_name, если базы созданы раньше без него
  try {
    await db.execute("ALTER TABLE users ADD COLUMN display_name TEXT");
  } catch (e) {
    // колонка уже существует — это нормально
  }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN last_seen INTEGER");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN bio TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN phone TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN birthday TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN premium INTEGER DEFAULT 0");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE users ADD COLUMN premium_emoji TEXT DEFAULT '⭐'");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE chats ADD COLUMN avatar TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE chats ADD COLUMN pinned_message_id TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE messages ADD COLUMN reply_to TEXT");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute("ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0");
  } catch (e) { /* уже существует */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    )`);
  } catch (e) { /* уже существует */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS muted_chats (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      PRIMARY KEY (user_id, chat_id)
    )`);
  } catch (e) { /* уже существует */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      media_url TEXT NOT NULL,
      caption TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
  } catch (e) { /* уже существует */ }
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS story_views (
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      viewed_at INTEGER NOT NULL,
      PRIMARY KEY (story_id, user_id)
    )`);
  } catch (e) { /* уже существует */ }

  // 2FA: почта, Telegram, выбранный способ, одноразовые коды
  for (const col of ['email TEXT', 'email_verified INTEGER DEFAULT 0', 'tg_chat_id TEXT', 'tg_phone TEXT', 'twofa_method TEXT', 'totp_secret TEXT', 'totp_enabled INTEGER DEFAULT 0', 'totp_last_step INTEGER DEFAULT 0', 'backup_codes TEXT']) {
    try { await db.execute(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { /* уже существует */ }
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    channel TEXT,
    code_hash TEXT NOT NULL,
    extra TEXT,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_codes(user_id, purpose, created_at)');

  // Модерация: баны, жалобы, журнал действий админа
  for (const col of ['banned INTEGER DEFAULT 0', 'ban_reason TEXT', 'banned_until INTEGER', 'banned_at INTEGER']) {
    try { await db.execute(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { /* уже существует */ }
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    message_id TEXT,
    chat_id TEXT,
    reason TEXT NOT NULL,
    details TEXT,
    snapshot TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    handled_by TEXT,
    handled_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)');
  await db.execute(`CREATE TABLE IF NOT EXISTS admin_actions (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id TEXT,
    report_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
  )`);

  // v3: Premium со сроком, приватность, блокировки, смена имени
  for (const col of ['premium_until INTEGER', 'hide_last_seen INTEGER DEFAULT 0', 'hide_from_search INTEGER DEFAULT 0', 'username_changed_at INTEGER', 'username_skel TEXT']) {
    try { await db.execute(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { /* уже существует */ }
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id)');
  await db.execute(`CREATE TABLE IF NOT EXISTS username_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    old_username TEXT NOT NULL,
    new_username TEXT NOT NULL,
    old_skel TEXT,
    changed_at INTEGER NOT NULL
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_uname_hist ON username_history(old_skel, changed_at)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_skel ON users(username_skel)');
  // "Скелет" имени (похожие кириллические/латинские буквы считаются одинаковыми) для защиты от подделки ников
  try {
    const missing = await db.execute('SELECT id, username FROM users WHERE username_skel IS NULL');
    for (const row of missing.rows) {
      await db.execute({ sql: 'UPDATE users SET username_skel = ? WHERE id = ?', args: [nameSkeleton(row.username), row.id] });
    }
  } catch (e) {
    console.error('Не удалось заполнить username_skel:', e.message);
  }

  // Назначаем администратора (право верифицировать аккаунты) по логину из переменной окружения
  if (process.env.ADMIN_USERNAME) {
    try {
      // Выдаём права только если администратора ещё нет (иначе после смены логина его старое имя мог бы занять кто-то другой)
      const existing = await db.execute('SELECT username FROM users WHERE is_admin = 1 LIMIT 1');
      if (existing.rows.length > 0) {
        console.log(`✅ Администратор уже назначен: "${existing.rows[0].username}"`);
        throw { skipAdminGrant: true };
      }
      const result = await db.execute('UPDATE users SET is_admin = 1 WHERE username = ?', [process.env.ADMIN_USERNAME]);
      const affected = result.rowsAffected ?? 0;
      if (affected > 0) {
        console.log(`✅ Права администратора выданы пользователю "${process.env.ADMIN_USERNAME}"`);
      } else {
        console.warn(`⚠️  ADMIN_USERNAME="${process.env.ADMIN_USERNAME}" — такого пользователя не найдено в базе.`);
        console.warn('    Проверь точное написание логина (регистр важен!) — как он указан при регистрации, БЕЗ символа @.');
      }
    } catch (e) {
      if (!(e && e.skipAdminGrant)) console.error('Не удалось назначить администратора:', e.message);
    }
  } else {
    console.warn('⚠️  Переменная ADMIN_USERNAME не задана — функция верификации недоступна никому.');
  }
}

// ---------- EXPRESS ----------
const app = express();
app.set('trust proxy', 1); // Render стоит за прокси — нужно, чтобы лимиты считались по реальному IP

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
  mediaSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
  connectSrc: ["'self'", 'ws:', 'wss:', 'https://res.cloudinary.com'],
  frameSrc: ['https://www.openstreetmap.org'],
  fontSrc: ["'self'", 'data:'],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'self'"],
};
app.use(helmet({
  // Если после обновления что-то сломается — добавь в Render DISABLE_CSP=1, чтобы быстро отключить
  contentSecurityPolicy: process.env.DISABLE_CSP === '1' ? false : { useDefaults: false, directives: cspDirectives },
}));
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '100kb' }));

const limiterOpts = { standardHeaders: true, legacyHeaders: false };
const authLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, message: { error: 'too_many_attempts' } });
const apiLimiter = rateLimit({ ...limiterOpts, windowMs: 60 * 1000, limit: 300, message: { error: 'rate_limited' } });
const uploadLimiter = rateLimit({ ...limiterOpts, windowMs: 10 * 60 * 1000, limit: 60, message: { error: 'rate_limited', message: 'Слишком много загрузок, подожди немного' } });
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use('/api', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/2fa', rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 15, skipSuccessfulRequests: true, message: { error: 'too_many_attempts' } }));

// Активен ли бан у пользователя (временный бан сам заканчивается)
function activeBan(u) {
  if (!u || !Number(u.banned)) return null;
  if (u.banned_until && Number(u.banned_until) < Date.now()) return null;
  return { reason: u.ban_reason || '', until: u.banned_until ? Number(u.banned_until) : null };
}
// Статус бана кешируем на 15 секунд, чтобы не ходить в базу на каждый запрос
const banCache = new Map();
async function getBanStatus(userId) {
  const c = banCache.get(userId);
  if (c && Date.now() - c.at < 15000) return c.val;
  const u = await get('SELECT banned, ban_reason, banned_until FROM users WHERE id = ?', [userId]);
  const val = u ? { exists: true, ban: activeBan(u) } : { exists: false, ban: null };
  banCache.set(userId, { at: Date.now(), val });
  return val;
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  try {
    const st = await getBanStatus(payload.id);
    if (!st.exists) return res.status(401).json({ error: 'invalid_token' });
    if (st.ban) return res.status(403).json({ error: 'banned', reason: st.ban.reason, until: st.ban.until });
    req.user = payload;
    next();
  } catch (e) {
    console.error('authMiddleware error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });
}

// ---------- AUTH ----------
app.post('/api/register', asyncRoute(async (req, res) => {
  if (!INVITE_CODE) return res.status(403).json({ error: 'registration_closed' });
  const { username, password, inviteCode, email: rawEmail } = obj(req.body);

  const given = Buffer.from(typeof inviteCode === 'string' ? inviteCode : '');
  const expected = Buffer.from(INVITE_CODE);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(403).json({ error: 'invalid_invite' });
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const uname = username.trim();
  // имя владельца (ADMIN_USERNAME) можно занять только пока админа ещё нет
  const adminExists = !!(await get('SELECT 1 AS ok FROM users WHERE is_admin = 1 LIMIT 1'));
  const isOwnerName = !!(process.env.ADMIN_USERNAME && uname === process.env.ADMIN_USERNAME && !adminExists);
  const nameErr = validateUsername(uname, isOwnerName);
  if (nameErr) return res.status(400).json({ error: nameErr });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'weak_password' });

  // Почта необязательна при регистрации; подтверждается позже в Настройки → Безопасность
  let email = null;
  if (rawEmail !== undefined && rawEmail !== null && String(rawEmail).trim() !== '') {
    email = normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  }

  if (await usernameTaken(uname, null)) return res.status(409).json({ error: 'username_taken' });

  const id = uuid();
  const hash = await bcrypt.hash(password, 11);
  await run('INSERT INTO users (id, username, password_hash, created_at, email, email_verified, username_skel) VALUES (?, ?, ?, ?, ?, 0, ?)', [id, uname, hash, Date.now(), email, nameSkeleton(uname)]);
  if (isOwnerName) {
    await run('UPDATE users SET is_admin = 1 WHERE id = ?', [id]);
  }

  const token = jwt.sign({ id, username: uname }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username: uname } });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = obj(req.body);
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const user = await get('SELECT * FROM users WHERE username = ?', [username]);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const loginBan = activeBan(user);
  if (loginBan) return res.status(403).json({ error: 'banned', reason: loginBan.reason, until: loginBan.until });

  // Двухфакторная защита: пароль верный, но токен входа выдаём только после кода
  if (user.twofa_method) {
    const methods = userMethods(user);
    const method = methods.includes(user.twofa_method) ? user.twofa_method : methods[0];
    if (!method) return res.status(503).json({ error: '2fa_unavailable' });

    if (method === 'totp') {
      await startTotpChallenge(user.id);
    } else {
      const otp = await createOtp(user.id, 'login', method);
      if (otp.error && otp.error !== 'too_soon') return res.status(429).json({ error: otp.error });
      if (!otp.error) {
        const sent = await deliverCode(user, method, otp.code, 'вход в аккаунт');
        if (!sent) return res.status(502).json({ error: 'send_failed' });
      }
    }
    const challengeToken = jwt.sign({ uid: user.id, m: method }, CHALLENGE_SECRET, { expiresIn: '10m' });
    return res.json({ needs2fa: true, method, methods, backup: !!user.totp_enabled, challengeToken, hint: methodHint(user, method) });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
}));

app.post('/api/login/2fa', asyncRoute(async (req, res) => {
  const { challengeToken, code, method } = obj(req.body);
  const ch = readChallenge(challengeToken);
  if (!ch) return res.status(401).json({ error: 'challenge_expired' });
  const user = await get('SELECT * FROM users WHERE id = ?', [ch.uid]);
  if (!user) return res.status(401).json({ error: 'challenge_expired' });

  const secondBan = activeBan(user);
  if (secondBan) return res.status(403).json({ error: 'banned', reason: secondBan.reason, until: secondBan.until });

  const m = ['totp', 'backup', 'email', 'telegram'].includes(method) ? method : ch.m;
  let v;
  if (m === 'totp' || m === 'backup') {
    if (!user.totp_enabled || !user.totp_secret) return res.status(400).json({ error: 'invalid_input' });
    v = await verifyTotpLogin(user, code, m);
  } else if (m === 'email' || m === 'telegram') {
    if (!userMethods(user).includes(m)) return res.status(400).json({ error: 'invalid_input' });
    v = await verifyOtp(user.id, 'login', code);
  } else {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (!v.ok) return res.status(v.error === 'too_many_attempts' ? 429 : 401).json({ error: v.error });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
}));

app.post('/api/login/2fa/resend', asyncRoute(async (req, res) => {
  const { challengeToken, method } = obj(req.body);
  const ch = readChallenge(challengeToken);
  if (!ch) return res.status(401).json({ error: 'challenge_expired' });
  const user = await get('SELECT * FROM users WHERE id = ?', [ch.uid]);
  if (!user) return res.status(401).json({ error: 'challenge_expired' });

  const methods = userMethods(user);
  const m = methods.includes(method) ? method : methods[0];
  if (!m) return res.status(503).json({ error: '2fa_unavailable' });

  if (m === 'totp') {
    await startTotpChallenge(user.id);
    return res.json({ ok: true, method: 'totp', hint: '' });
  }
  const otp = await createOtp(user.id, 'login', m);
  if (otp.error) return res.status(429).json({ error: otp.error });
  if (!(await deliverCode(user, m, otp.code, 'вход в аккаунт'))) return res.status(502).json({ error: 'send_failed' });
  res.json({ ok: true, method: m, hint: methodHint(user, m) });
}));

// Изменения защиты требуют пароля: даже украденный токен входа не позволит подменить почту или выключить 2FA
async function requirePassword(req, res) {
  const { password } = obj(req.body);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) { res.status(401).json({ error: 'invalid_token' }); return null; }
  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(403).json({ error: 'wrong_password' });
    return null;
  }
  return user;
}

app.get('/api/2fa/status', authMiddleware, asyncRoute(async (req, res) => {
  const u = await get('SELECT email, email_verified, tg_chat_id, tg_phone, twofa_method, totp_enabled, totp_secret, backup_codes FROM users WHERE id = ?', [req.user.id]);
  if (!u) return res.status(401).json({ error: 'invalid_token' });
  res.json({
    method: u.twofa_method || null,
    email: u.email ? maskEmail(u.email) : null,
    emailVerified: !!u.email_verified,
    telegramLinked: !!u.tg_chat_id,
    telegramPhone: u.tg_phone ? maskPhone(u.tg_phone) : null,
    totpEnabled: !!u.totp_enabled,
    totpPending: !u.totp_enabled && !!u.totp_secret,
    backupLeft: parseBackup(u.backup_codes).length,
    available: { email: emailConfigured(), telegram: telegramConfigured() },
  });
}));

app.post('/api/2fa/email/start', authMiddleware, asyncRoute(async (req, res) => {
  if (!emailConfigured()) return res.status(503).json({ error: 'email_not_configured' });
  const user = await requirePassword(req, res);
  if (!user) return;
  const email = normalizeEmail(obj(req.body).email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

  const otp = await createOtp(user.id, 'email_verify', 'email', email);
  if (otp.error) return res.status(429).json({ error: otp.error });
  const sent = await sendEmail(email, 'Подтверждение почты в Mío', `Mío: подтверждение почты\nКод: ${otp.code}\nДействует 10 минут. Если это были не вы — просто игнорируйте письмо.`);
  if (!sent) return res.status(502).json({ error: 'send_failed' });
  res.json({ ok: true });
}));

app.post('/api/2fa/email/confirm', authMiddleware, asyncRoute(async (req, res) => {
  const v = await verifyOtp(req.user.id, 'email_verify', obj(req.body).code);
  if (!v.ok) return res.status(v.error === 'too_many_attempts' ? 429 : 400).json({ error: v.error });
  const email = normalizeEmail(v.row.extra);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
  await run('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [email, req.user.id]);
  res.json({ ok: true });
}));

app.post('/api/2fa/telegram/link', authMiddleware, asyncRoute(async (req, res) => {
  if (!telegramConfigured()) return res.status(503).json({ error: 'telegram_not_configured' });
  const user = await requirePassword(req, res);
  if (!user) return;
  await run("DELETE FROM otp_codes WHERE user_id = ? AND purpose = 'tg_link'", [user.id]);
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const rowId = hashToken(`tg:${token}`);
  await run(
    'INSERT INTO otp_codes (id, user_id, purpose, channel, code_hash, extra, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)',
    [rowId, user.id, 'tg_link', 'telegram', rowId, now + OTP_TTL, now]
  );
  res.json({ url: `https://t.me/${TG_BOT_USERNAME}?start=${token}` });
}));

app.post('/api/2fa/telegram/unlink', authMiddleware, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  if (user.twofa_method === 'telegram') return res.status(400).json({ error: 'method_in_use' });
  await run('UPDATE users SET tg_chat_id = NULL, tg_phone = NULL WHERE id = ?', [user.id]);
  res.json({ ok: true });
}));

app.post('/api/2fa/method', authMiddleware, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  const { method } = obj(req.body);
  if (method === null || method === 'off') {
    await run('UPDATE users SET twofa_method = NULL WHERE id = ?', [user.id]);
    return res.json({ ok: true, method: null });
  }
  if (method !== 'email' && method !== 'telegram' && method !== 'totp') return res.status(400).json({ error: 'invalid_input' });
  if (method === 'totp' && !(user.totp_enabled && user.totp_secret)) return res.status(400).json({ error: 'totp_not_enabled' });
  if (method === 'email' && !(user.email && user.email_verified && emailConfigured())) return res.status(400).json({ error: 'email_not_verified' });
  if (method === 'telegram' && !(user.tg_chat_id && telegramConfigured())) return res.status(400).json({ error: 'telegram_not_linked' });
  await run('UPDATE users SET twofa_method = ? WHERE id = ?', [method, user.id]);
  res.json({ ok: true, method });
}));

app.post('/api/2fa/totp/start', authMiddleware, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  if (user.totp_enabled) return res.status(400).json({ error: 'totp_already_enabled' });
  const secret = base32Encode(crypto.randomBytes(20));
  await run('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?', [encryptSecret(secret), user.id]);
  const issuer = encodeURIComponent('Mío');
  const uri = `otpauth://totp/${issuer}:${encodeURIComponent(user.username)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret: secret.match(/.{1,4}/g).join(' '), uri });
}));

app.post('/api/2fa/totp/confirm', authMiddleware, asyncRoute(async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.totp_enabled || !user.totp_secret) return res.status(400).json({ error: 'invalid_input' });
  const secret = decryptSecret(user.totp_secret);
  const raw = obj(req.body).code;
  const code = typeof raw === 'string' ? raw.trim() : '';
  const step = secret && /^\d{6}$/.test(code) ? totpFindStep(secret, code, 0) : null;
  if (step === null) return res.status(400).json({ error: 'wrong_code' });

  const codes = makeBackupCodes();
  await run(
    'UPDATE users SET totp_enabled = 1, totp_last_step = ?, backup_codes = ?, twofa_method = COALESCE(twofa_method, ?) WHERE id = ?',
    [step, JSON.stringify(codes.map((c) => hashBackup(user.id, c))), 'totp', user.id]
  );
  res.json({ ok: true, backupCodes: codes });
}));

app.post('/api/2fa/totp/backup-new', authMiddleware, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  if (!user.totp_enabled) return res.status(400).json({ error: 'totp_not_enabled' });
  const codes = makeBackupCodes();
  await run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(codes.map((c) => hashBackup(user.id, c))), user.id]);
  res.json({ ok: true, backupCodes: codes });
}));

app.post('/api/2fa/totp/disable', authMiddleware, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  if (user.twofa_method === 'totp') return res.status(400).json({ error: 'method_in_use' });
  await run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, backup_codes = NULL WHERE id = ?', [user.id]);
  res.json({ ok: true });
}));

// Сюда Telegram присылает сообщения бота (проверяем секретный заголовок)
app.post('/api/telegram/webhook', asyncRoute(async (req, res) => {
  const given = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
  const expected = Buffer.from(TG_WEBHOOK_SECRET);
  if (!TG_TOKEN || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  try {
    await handleTelegramUpdate(obj(req.body));
  } catch (e) {
    console.error('telegram update failed:', e);
  }
}));

app.get('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  const user = await get('SELECT id, username, avatar, display_name, bio, phone, birthday, verified, premium, premium_emoji, premium_until, hide_last_seen, hide_from_search, username_changed_at, is_admin FROM users WHERE id = ?', [req.user.id]);
  res.json({ user });
}));

app.patch('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  const { avatar, displayName, bio, phone, birthday } = req.body;
  if (avatar) {
    if (!isSafeMediaUrl(avatar)) return res.status(400).json({ error: 'invalid_avatar' });
    await run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);
  }
  if (typeof displayName === 'string') {
    const trimmed = displayName.trim().slice(0, 40);
    await run('UPDATE users SET display_name = ? WHERE id = ?', [trimmed || null, req.user.id]);
  }
  if (typeof bio === 'string') await run('UPDATE users SET bio = ? WHERE id = ?', [bio.trim().slice(0, 140) || null, req.user.id]);
  if (typeof phone === 'string') await run('UPDATE users SET phone = ? WHERE id = ?', [phone.trim().slice(0, 30) || null, req.user.id]);
  if (typeof birthday === 'string') await run('UPDATE users SET birthday = ? WHERE id = ?', [birthday.slice(0, 20) || null, req.user.id]);
  const user = await get('SELECT id, username, avatar, display_name, bio, phone, birthday, verified, premium, premium_emoji, premium_until, hide_last_seen, hide_from_search, username_changed_at, is_admin FROM users WHERE id = ?', [req.user.id]);
  res.json({ user });
}));

// ---------- ПОЛЬЗОВАТЕЛИ ----------
const searchLimiter = rateLimit({
  ...limiterOpts, windowMs: 60 * 1000, limit: 40,
  keyGenerator: (req) => String(req.user && req.user.id),
  message: { error: 'rate_limited' },
});
app.get('/api/users', authMiddleware, searchLimiter, asyncRoute(async (req, res) => {
  res.json(await searchUsersFor(req.user.id, req.query.search));
}));

app.get('/api/users/:id', authMiddleware, asyncRoute(async (req, res) => {
  const user = await get('SELECT id, username, avatar, display_name, last_seen, hide_last_seen, bio, phone, birthday, verified, premium, premium_emoji, premium_until, is_admin FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const blockedByMe = !!(await get('SELECT 1 AS ok FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, user.id]));
  const premium = isPremiumRow(user) ? 1 : 0;
  // Личные данные (телефон, день рождения, "был в сети") видят только те, у кого есть общий чат
  if (!(await sharesChat(req.user.id, user.id))) {
    const { id, username, avatar, display_name, verified, premium_emoji, is_admin } = user;
    return res.json({ id, username, avatar, display_name, verified, premium, premium_emoji, is_admin, blockedByMe });
  }
  const { hide_last_seen, premium_until, ...pub } = user;
  pub.premium = premium;
  // Premium-функция: скрыть "был в сети" (-1 = "был(а) недавно")
  if (premium && Number(hide_last_seen) && user.id !== req.user.id) pub.last_seen = -1;
  res.json({ ...pub, blockedByMe });
}));

app.post('/api/users/:id/verify', authMiddleware, asyncRoute(async (req, res) => {
  const requester = await get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
  if (!requester?.is_admin) return res.status(403).json({ error: 'forbidden' });
  await run('UPDATE users SET verified = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/users/:id/verify', authMiddleware, asyncRoute(async (req, res) => {
  const requester = await get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
  if (!requester?.is_admin) return res.status(403).json({ error: 'forbidden' });
  await run('UPDATE users SET verified = 0 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/users/:id/premium', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const target = await get('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'not_found' });
  const emoji = (typeof req.body?.emoji === 'string' ? req.body.emoji.trim() : '').slice(0, 8) || '⭐';
  const days = parseDays(req.body?.days);
  const until = days ? Date.now() + days * 86400000 : null;
  await run('UPDATE users SET premium = 1, premium_emoji = ?, premium_until = ? WHERE id = ?', [emoji, until, req.params.id]);
  await logAdmin(req.user.id, 'grant_premium', req.params.id, null, days ? `${days} дн.` : 'без срока');
  res.json({ ok: true, until });
}));

app.delete('/api/users/:id/premium', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await run('UPDATE users SET premium = 0, premium_until = NULL, hide_last_seen = 0 WHERE id = ?', [req.params.id]);
  await logAdmin(req.user.id, 'revoke_premium', req.params.id, null, null);
  res.json({ ok: true });
}));

// ---------- ПРИВАТНОСТЬ, СМЕНА ИМЕНИ, БЛОКИРОВКИ ----------
const pwLimiter = rateLimit({ ...limiterOpts, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, message: { error: 'too_many_attempts' } });

app.post('/api/me/username', authMiddleware, pwLimiter, asyncRoute(async (req, res) => {
  const user = await requirePassword(req, res);
  if (!user) return;
  const r = await changeUsername(user, obj(req.body).username);
  if (r.code !== 200) return res.status(r.code).json(r.json);
  // старый токен хранит старое имя, поэтому выдаём новый
  const token = jwt.sign({ id: user.id, username: r.newName }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, username: r.newName, token });
}));

app.post('/api/me/privacy', authMiddleware, asyncRoute(async (req, res) => {
  const b = obj(req.body);
  if (typeof b.hideFromSearch === 'boolean') {
    await run('UPDATE users SET hide_from_search = ? WHERE id = ?', [b.hideFromSearch ? 1 : 0, req.user.id]);
  }
  if (typeof b.hideLastSeen === 'boolean') {
    const u = await get('SELECT premium, premium_until FROM users WHERE id = ?', [req.user.id]);
    if (b.hideLastSeen && !isPremiumRow(u)) return res.status(403).json({ error: 'premium_required' });
    await run('UPDATE users SET hide_last_seen = ? WHERE id = ?', [b.hideLastSeen ? 1 : 0, req.user.id]);
    if (b.hideLastSeen) emitPresence(req.user.id, false, true);
  }
  res.json({ ok: true });
}));

app.get('/api/blocks', authMiddleware, asyncRoute(async (req, res) => {
  const rows = await all(`
    SELECT u.id, u.username, u.display_name, u.avatar FROM blocks b
    JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT 200
  `, [req.user.id]);
  res.json(rows);
}));

app.post('/api/blocks', authMiddleware, asyncRoute(async (req, res) => {
  const { userId } = obj(req.body);
  if (typeof userId !== 'string') return res.status(400).json({ error: 'invalid_input' });
  if (userId === req.user.id) return res.status(400).json({ error: 'self_block' });
  const target = await get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!target) return res.status(404).json({ error: 'not_found' });
  await run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', [req.user.id, userId, Date.now()]);
  res.json({ ok: true });
}));

app.delete('/api/blocks/:userId', authMiddleware, asyncRoute(async (req, res) => {
  await run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, req.params.userId]);
  res.json({ ok: true });
}));

// ---------- ЧАТЫ ----------
app.get('/api/chats', authMiddleware, asyncRoute(async (req, res) => {
  const chatsRaw = await all(`
    SELECT c.id, c.type, c.title, c.avatar, c.created_by, c.pinned_message_id
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
  `, [req.user.id]);

  const result = [];
  for (const chat of chatsRaw) {
    const lastMsg = await get(
      'SELECT type, content, media_url, created_at, sender_id FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1',
      [chat.id]
    );

    let title = chat.title;
    let otherUserId = null;
    let otherAvatar = chat.avatar;
    let otherVerified = false;
    let otherIsAdmin = false;
    let otherPremium = false;
    let otherPremiumEmoji = '⭐';
    if (chat.type === 'private') {
      const other = await get(`
        SELECT u.id, u.username, u.avatar, u.display_name, u.verified, u.premium, u.premium_emoji, u.is_admin FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.user_id != ?
      `, [chat.id, req.user.id]);
      title = other ? (other.display_name || other.username) : 'Диалог';
      otherUserId = other ? other.id : null;
      otherAvatar = other ? other.avatar : null;
      otherVerified = other ? !!other.verified : false;
      otherIsAdmin = other ? !!other.is_admin : false;
      otherPremium = other ? !!other.premium : false;
      otherPremiumEmoji = other ? (other.premium_emoji || '⭐') : '⭐';
    }
    const mutedRow = await get('SELECT 1 as ok FROM muted_chats WHERE user_id = ? AND chat_id = ?', [req.user.id, chat.id]);
    result.push({ ...chat, title, otherUserId, otherAvatar, otherVerified, otherIsAdmin, otherPremium, otherPremiumEmoji, muted: !!mutedRow, lastMessage: lastMsg || null });
  }

  result.sort((a, b) => (b.lastMessage?.created_at || 0) - (a.lastMessage?.created_at || 0));
  res.json(result);
}));

app.post('/api/chats', authMiddleware, asyncRoute(async (req, res) => {
  const { type, title } = obj(req.body);
  if (type !== 'private' && type !== 'group') return res.status(400).json({ error: 'invalid_type' });
  const rawIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  if (rawIds.length === 0 || rawIds.length > 50 || rawIds.some((m) => typeof m !== 'string')) {
    return res.status(400).json({ error: 'members_required' });
  }
  let memberIds = [...new Set(rawIds)].filter((m) => m !== req.user.id);
  if (memberIds.length === 0 || (type === 'private' && memberIds.length !== 1)) {
    return res.status(400).json({ error: 'members_required' });
  }
  const found = await all(`SELECT id FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`, memberIds);
  if (found.length !== memberIds.length) return res.status(400).json({ error: 'user_not_found' });

  if (type === 'private') {
    if (await isBlockedEither(req.user.id, memberIds[0])) return res.status(403).json({ error: 'blocked' });
  } else {
    // в группу не добавляем тех, кто заблокировал создателя (или кого заблокировал он)
    const ph = memberIds.map(() => '?').join(',');
    const bl = await all(
      `SELECT blocker_id, blocked_id FROM blocks WHERE (blocker_id = ? AND blocked_id IN (${ph})) OR (blocked_id = ? AND blocker_id IN (${ph}))`,
      [req.user.id, ...memberIds, req.user.id, ...memberIds]
    );
    const bad = new Set(bl.map((r) => (r.blocker_id === req.user.id ? r.blocked_id : r.blocker_id)));
    memberIds = memberIds.filter((id) => !bad.has(id));
    if (memberIds.length === 0) return res.status(400).json({ error: 'members_required' });
  }

  if (type === 'private') {
    const otherId = memberIds[0];
    const existing = await get(`
      SELECT c.id FROM chats c
      JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
      JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private'
    `, [req.user.id, otherId]);
    if (existing) return res.json({ id: existing.id });
  }

  const id = uuid();
  const safeTitle = typeof title === 'string' ? title.trim().slice(0, 60) : '';
  await run('INSERT INTO chats (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, type, safeTitle || null, req.user.id, Date.now()]);

  const allMemberIds = [req.user.id, ...memberIds];
  for (const uid of allMemberIds) {
    await run('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', [id, uid]);
  }

  // Сразу подключаем обе стороны (если онлайн) к живой комнате чата
  allMemberIds.forEach((uid) => {
    const sockId = onlineUsers.get(uid);
    if (sockId) {
      const s = io.sockets.sockets.get(sockId);
      if (s) s.join(id);
      io.to(sockId).emit('chats:refresh');
    }
  });

  res.json({ id });
}));

app.get('/api/chats/:id/members', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });

  const members = await all(`
    SELECT u.id, u.username, u.avatar, u.display_name, u.verified, u.premium, u.premium_emoji FROM chat_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ?
  `, [req.params.id]);
  res.json(members);
}));

app.patch('/api/chats/:id', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });

  const { title, avatar } = obj(req.body);
  if (typeof title === 'string' && title.trim()) await run('UPDATE chats SET title = ? WHERE id = ?', [title.trim().slice(0, 60), req.params.id]);
  if (avatar) {
    if (!isSafeMediaUrl(avatar)) return res.status(400).json({ error: 'invalid_avatar' });
    await run('UPDATE chats SET avatar = ? WHERE id = ?', [avatar, req.params.id]);
  }

  io.to(req.params.id).emit('chats:refresh');
  res.json({ ok: true });
}));

app.post('/api/chats/:id/members', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const chat = await loadChat(req.params.id);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'not_group' });

  const { memberIds } = obj(req.body);
  if (!Array.isArray(memberIds)) return res.status(400).json({ error: 'members_required' });
  const ids = [...new Set(memberIds.filter((m) => typeof m === 'string'))].slice(0, 50);
  const found = ids.length
    ? await all(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    : [];

  for (const { id: uid } of found) {
    if (await isBlockedEither(req.user.id, uid)) continue;
    await run('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', [req.params.id, uid]);
    const sockId = onlineUsers.get(uid);
    if (sockId) {
      const s = io.sockets.sockets.get(sockId);
      if (s) s.join(req.params.id);
      io.to(sockId).emit('chats:refresh');
    }
  }
  io.to(req.params.id).emit('chats:refresh');
  res.json({ ok: true });
}));

app.delete('/api/chats/:id/members/:userId', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not_found' });

  // Выйти из чата может каждый, а выгнать другого — только создатель группы
  const isSelf = req.params.userId === req.user.id;
  if (!isSelf && !(chat.type === 'group' && chat.created_by === req.user.id)) {
    return res.status(403).json({ error: 'owner_only' });
  }

  await run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.id, req.params.userId]);

  const sockId = onlineUsers.get(req.params.userId);
  if (sockId) {
    const s = io.sockets.sockets.get(sockId);
    if (s) s.leave(req.params.id);
    io.to(sockId).emit('chats:refresh');
  }
  io.to(req.params.id).emit('chats:refresh');
  res.json({ ok: true });
}));

app.get('/api/messages/:id', authMiddleware, asyncRoute(async (req, res) => {
  const msg = await get(`
    SELECT m.*, COALESCE(u.display_name, u.username) as sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
  `, [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [msg.chat_id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'forbidden' });
  res.json(msg);
}));

app.post('/api/chats/:id/pin', authMiddleware, asyncRoute(async (req, res) => {
  const { messageId } = obj(req.body);
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const inChat = typeof messageId === 'string'
    ? await get('SELECT 1 as ok FROM messages WHERE id = ? AND chat_id = ?', [messageId, req.params.id])
    : null;
  if (!inChat) return res.status(400).json({ error: 'invalid' });
  await run('UPDATE chats SET pinned_message_id = ? WHERE id = ?', [messageId, req.params.id]);
  io.to(req.params.id).emit('chats:refresh');
  res.json({ ok: true });
}));

app.delete('/api/chats/:id/pin', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  await run('UPDATE chats SET pinned_message_id = NULL WHERE id = ?', [req.params.id]);
  io.to(req.params.id).emit('chats:refresh');
  res.json({ ok: true });
}));

app.post('/api/chats/:id/mute', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const { muted } = obj(req.body);
  if (muted) {
    await run('INSERT OR IGNORE INTO muted_chats (user_id, chat_id) VALUES (?, ?)', [req.user.id, req.params.id]);
  } else {
    await run('DELETE FROM muted_chats WHERE user_id = ? AND chat_id = ?', [req.user.id, req.params.id]);
  }
  res.json({ ok: true });
}));

app.get('/api/chats/:id/messages', authMiddleware, asyncRoute(async (req, res) => {
  const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'forbidden' });

  const messages = await all(`
    SELECT m.*, COALESCE(u.display_name, u.username) as sender_name,
      EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id != m.sender_id) as is_read,
      rm.type as reply_type, rm.content as reply_content,
      COALESCE(ru.display_name, ru.username) as reply_sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages rm ON rm.id = m.reply_to
    LEFT JOIN users ru ON ru.id = rm.sender_id
    WHERE m.chat_id = ? ORDER BY m.created_at ASC LIMIT 200
  `, [req.params.id]);

  const reactionRows = await all(`
    SELECT mr.message_id, mr.emoji, mr.user_id FROM message_reactions mr
    JOIN messages m ON m.id = mr.message_id WHERE m.chat_id = ?
  `, [req.params.id]);
  const reactionsByMessage = {};
  reactionRows.forEach((r) => {
    if (!reactionsByMessage[r.message_id]) reactionsByMessage[r.message_id] = {};
    if (!reactionsByMessage[r.message_id][r.emoji]) reactionsByMessage[r.message_id][r.emoji] = [];
    reactionsByMessage[r.message_id][r.emoji].push(r.user_id);
  });
  messages.forEach((m) => {
    const grouped = reactionsByMessage[m.id] || {};
    m.reactions = Object.entries(grouped).map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
  });

  res.json(messages);
}));

app.delete('/api/chats/:id/messages', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not_found' });
  // В личном чате — любой из двоих, в группе — только создатель
  if (!(chat.type === 'private' || chat.created_by === req.user.id)) return res.status(403).json({ error: 'owner_only' });

  await run('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', [req.params.id]);
  await run('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', [req.params.id]);
  await run('DELETE FROM messages WHERE chat_id = ?', [req.params.id]);
  await run('UPDATE chats SET pinned_message_id = NULL WHERE id = ?', [req.params.id]);
  io.to(req.params.id).emit('chat:cleared', { chatId: req.params.id });
  res.json({ ok: true });
}));

app.delete('/api/chats/:id', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'forbidden' });
  const chat = await loadChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'not_found' });
  if (!(chat.type === 'private' || chat.created_by === req.user.id)) return res.status(403).json({ error: 'owner_only' });

  const members = await all('SELECT user_id FROM chat_members WHERE chat_id = ?', [req.params.id]);

  await run('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', [req.params.id]);
  await run('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', [req.params.id]);
  await run('DELETE FROM messages WHERE chat_id = ?', [req.params.id]);
  await run('DELETE FROM chat_members WHERE chat_id = ?', [req.params.id]);
  await run('DELETE FROM muted_chats WHERE chat_id = ?', [req.params.id]);
  await run('DELETE FROM chats WHERE id = ?', [req.params.id]);

  members.forEach(({ user_id }) => {
    const sockId = onlineUsers.get(user_id);
    if (sockId) {
      const s = io.sockets.sockets.get(sockId);
      if (s) s.leave(req.params.id);
      io.to(sockId).emit('chat:deleted', { chatId: req.params.id });
    }
  });
  res.json({ ok: true });
}));

// ---------- ИСТОРИИ (24 часа, публикация только для Premium) ----------
app.get('/api/stories', authMiddleware, asyncRoute(async (req, res) => {
  const now = Date.now();
  // лёгкая уборка просроченных историй заодно
  await run('DELETE FROM stories WHERE expires_at <= ?', [now]);
  const uid = req.user.id;

  const rows = await all(`
    SELECT s.id, s.user_id, s.type, s.media_url, s.caption, s.created_at, s.expires_at,
      u.username, u.display_name, u.avatar, u.premium, u.premium_emoji, u.verified, u.is_admin,
      EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = ?) AS viewed,
      CASE WHEN s.user_id = ? THEN (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id AND v.user_id != s.user_id) ELSE NULL END AS views
    FROM stories s
    JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
      AND (u.banned IS NULL OR u.banned = 0 OR (u.banned_until IS NOT NULL AND u.banned_until < ?))
      AND (
        s.user_id = ? OR (
          s.user_id IN (
            SELECT cm2.user_id FROM chat_members cm1
            JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
            WHERE cm1.user_id = ? AND cm2.user_id != ?
          )
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = s.user_id) OR (b.blocker_id = s.user_id AND b.blocked_id = ?))
        )
      )
    ORDER BY s.created_at ASC
  `, [uid, uid, now, now, uid, uid, uid, uid, uid]);

  res.json(rows.map((r) => ({ ...r, viewed: Number(r.viewed), views: r.views === null ? null : Number(r.views) })));
}));

app.post('/api/stories', authMiddleware, asyncRoute(async (req, res) => {
  const requester = await get('SELECT premium, premium_until FROM users WHERE id = ?', [req.user.id]);
  if (!isPremiumRow(requester)) return res.status(403).json({ error: 'premium_required' });

  const { type, mediaUrl, caption } = obj(req.body);
  if (!isSafeMediaUrl(mediaUrl) || (type !== 'image' && type !== 'video')) return res.status(400).json({ error: 'invalid' });

  const active = await get('SELECT COUNT(*) AS c FROM stories WHERE user_id = ? AND expires_at > ?', [req.user.id, Date.now()]);
  if (Number(active && active.c) >= 15) return res.status(400).json({ error: 'too_many_stories' });

  const id = uuid();
  const created_at = Date.now();
  const expires_at = created_at + 24 * 60 * 60 * 1000;
  await run('INSERT INTO stories (id, user_id, type, media_url, caption, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, req.user.id, type, mediaUrl, (typeof caption === 'string' ? caption.trim().slice(0, 200) : '') || null, created_at, expires_at]);

  // Уведомляем всех, у кого есть с нами общий чат — обновить ленту историй
  const contacts = await all(`
    SELECT DISTINCT cm2.user_id FROM chat_members cm1
    JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
    WHERE cm1.user_id = ? AND cm2.user_id != ?
  `, [req.user.id, req.user.id]);
  contacts.forEach(({ user_id }) => {
    const sockId = onlineUsers.get(user_id);
    if (sockId) io.to(sockId).emit('stories:refresh');
  });

  res.json({ id });
}));

// Кто посмотрел историю (видит только автор)
app.get('/api/stories/:id/viewers', authMiddleware, asyncRoute(async (req, res) => {
  const story = await get('SELECT user_id FROM stories WHERE id = ?', [req.params.id]);
  if (!story) return res.status(404).json({ error: 'not_found' });
  if (story.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const rows = await all(`
    SELECT u.id, u.username, u.display_name, u.avatar, sv.viewed_at
    FROM story_views sv JOIN users u ON u.id = sv.user_id
    WHERE sv.story_id = ? AND sv.user_id != ? ORDER BY sv.viewed_at DESC LIMIT 100
  `, [req.params.id, req.user.id]);
  res.json(rows);
}));

app.post('/api/stories/:id/view', authMiddleware, asyncRoute(async (req, res) => {
  const story = await get('SELECT user_id FROM stories WHERE id = ?', [req.params.id]);
  if (story && story.user_id === req.user.id) return res.json({ ok: true }); // свои просмотры не считаем
  if (!story || !(await sharesChat(req.user.id, story.user_id))) return res.status(404).json({ error: 'not_found' });
  await run('INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) VALUES (?, ?, ?)', [req.params.id, req.user.id, Date.now()]);
  res.json({ ok: true });
}));

app.delete('/api/stories/:id', authMiddleware, asyncRoute(async (req, res) => {
  const story = await get('SELECT user_id FROM stories WHERE id = ?', [req.params.id]);
  if (!story) return res.status(404).json({ error: 'not_found' });
  if (story.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  await run('DELETE FROM story_views WHERE story_id = ?', [req.params.id]);
  await run('DELETE FROM stories WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/ice-servers', authMiddleware, asyncRoute(async (req, res) => {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Вариант 1: готовый массив, скопированный из кнопки "Show ICE Servers Array" в Metered
  if (process.env.METERED_ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.METERED_ICE_SERVERS_JSON);
      const servers = Array.isArray(parsed) && parsed[0]?.iceServers ? parsed[0].iceServers : parsed;
      return res.json({ iceServers: servers });
    } catch (e) {
      console.error('Не удалось распарсить METERED_ICE_SERVERS_JSON:', e.message);
    }
  }

  // Вариант 2 (старый способ через домен+ключ, если вдруг используется)
  if (process.env.METERED_API_KEY && process.env.METERED_DOMAIN) {
    try {
      const url = `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
      const r = await fetch(url);
      const iceServers = await r.json();
      if (Array.isArray(iceServers) && iceServers.length) return res.json({ iceServers });
    } catch (err) {
      console.error('Не удалось получить TURN-креды:', err.message);
    }
  }

  res.json({ iceServers: fallback });
}));

app.patch('/api/messages/:id', authMiddleware, asyncRoute(async (req, res) => {
  const { content } = obj(req.body);
  const msg = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (msg.deleted || msg.type !== 'text' || typeof content !== 'string' || !content.trim() || content.length > 4000) return res.status(400).json({ error: 'invalid' });

  await run('UPDATE messages SET content = ?, edited = 1 WHERE id = ?', [content.trim(), req.params.id]);
  io.to(msg.chat_id).emit('message:edited', { messageId: req.params.id, content: content.trim() });
  res.json({ ok: true });
}));

app.delete('/api/messages/:id', authMiddleware, asyncRoute(async (req, res) => {
  const msg = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

  await run('UPDATE messages SET deleted = 1, content = NULL, media_url = NULL WHERE id = ?', [req.params.id]);
  io.to(msg.chat_id).emit('message:deleted', { messageId: req.params.id });
  res.json({ ok: true });
}));

// ---------- ЖАЛОБЫ И МОДЕРАЦИЯ ----------
const REPORT_REASONS = {
  spam: 'Спам',
  abuse: 'Оскорбления или травля',
  illegal: 'Запрещённый контент',
  fraud: 'Мошенничество',
  other: 'Другое',
};

function safeJson(str) {
  try { return str ? JSON.parse(str) : null; } catch (e) { return null; }
}
function parseDays(x) {
  const d = Number(x);
  return Number.isFinite(d) && d >= 1 ? Math.min(Math.floor(d), 3650) : null;
}
// Короткое описание сообщения для жалобы (чтобы админ видел, на что именно жалуются)
function snapshotText(msg) {
  const t = msg.type;
  if (t === 'text') return String(msg.content || '').slice(0, 1000);
  if (t === 'location') return '📍 Геолокация';
  if (t === 'image') return '🖼 Фото';
  if (t === 'video') return '🎞 Видео';
  if (t === 'voice') return '🎤 Голосовое сообщение';
  if (t === 'file') {
    const j = safeJson(msg.content);
    return `📎 Файл: ${String((j && j.name) || '').slice(0, 120)}`.trim();
  }
  return `[${t}]`;
}

async function logAdmin(adminId, action, targetUserId, reportId, details) {
  await run(
    'INSERT INTO admin_actions (id, admin_id, action, target_user_id, report_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuid(), adminId, action, targetUserId || null, reportId || null, details || null, Date.now()]
  );
}
async function requireAdmin(req, res) {
  const u = await get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
  if (!u || !Number(u.is_admin)) { res.status(403).json({ error: 'forbidden' }); return false; }
  return true;
}
async function notifyAdmins(event) {
  try {
    const admins = await all('SELECT id FROM users WHERE is_admin = 1');
    admins.forEach(({ id }) => {
      const sid = onlineUsers.get(id);
      if (sid) io.to(sid).emit(event);
    });
  } catch (e) { /* не критично */ }
}

async function createReport(reporterId, body) {
  const { userId, messageId, reason, details } = obj(body);
  if (!Object.prototype.hasOwnProperty.call(REPORT_REASONS, reason)) return { code: 400, json: { error: 'invalid_reason' } };
  const note = typeof details === 'string' ? details.trim().slice(0, 500) : '';

  let targetId = null;
  let chatId = null;
  let snapshot = null;
  let msgId = null;

  if (messageId !== undefined && messageId !== null) {
    if (typeof messageId !== 'string') return { code: 400, json: { error: 'invalid_input' } };
    const msg = await get('SELECT id, chat_id, sender_id, type, content, media_url, created_at, deleted FROM messages WHERE id = ?', [messageId]);
    if (!msg || Number(msg.deleted)) return { code: 404, json: { error: 'not_found' } };
    // жаловаться можно только на сообщение из своего чата
    if (!(await isChatMember(msg.chat_id, reporterId))) return { code: 403, json: { error: 'forbidden' } };
    if (msg.sender_id === reporterId) return { code: 400, json: { error: 'self_report' } };
    targetId = msg.sender_id;
    chatId = msg.chat_id;
    msgId = msg.id;
    snapshot = JSON.stringify({ type: msg.type, text: snapshotText(msg), mediaUrl: msg.media_url || null, at: Number(msg.created_at) });
  } else if (typeof userId === 'string') {
    if (userId === reporterId) return { code: 400, json: { error: 'self_report' } };
    const t = await get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!t) return { code: 404, json: { error: 'not_found' } };
    targetId = t.id;
  } else {
    return { code: 400, json: { error: 'invalid_input' } };
  }

  // одну и ту же жалобу за сутки второй раз не создаём
  const dup = await get(
    "SELECT id FROM reports WHERE reporter_id = ? AND target_user_id = ? AND COALESCE(message_id, '') = COALESCE(?, '') AND created_at > ?",
    [reporterId, targetId, msgId, Date.now() - 24 * 3600 * 1000]
  );
  if (dup) return { code: 200, json: { ok: true } };

  await run(
    'INSERT INTO reports (id, reporter_id, target_user_id, message_id, chat_id, reason, details, snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid(), reporterId, targetId, msgId, chatId, reason, note || null, snapshot, 'open', Date.now()]
  );
  notifyAdmins('reports:new');
  return { code: 200, json: { ok: true } };
}

async function banUser(adminId, targetId, reason, days, reportId) {
  const target = await get('SELECT id, is_admin FROM users WHERE id = ?', [targetId]);
  if (!target) return { error: 'not_found' };
  if (Number(target.is_admin)) return { error: 'cannot_ban_admin' };
  if (targetId === adminId) return { error: 'cannot_ban_self' };

  const until = days ? Date.now() + days * 86400000 : null;
  const why = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  await run('UPDATE users SET banned = 1, ban_reason = ?, banned_until = ?, banned_at = ? WHERE id = ?', [why || null, until, Date.now(), targetId]);
  banCache.delete(targetId);

  // выкидываем из приложения сразу
  const sid = onlineUsers.get(targetId);
  if (sid) {
    io.to(sid).emit('account:banned', { reason: why, until });
    setTimeout(() => { const sk = io.sockets.sockets.get(sid); if (sk) sk.disconnect(true); }, 300);
  }
  await logAdmin(adminId, 'ban', targetId, reportId, `${why || 'без причины'} · ${days ? `${days} дн.` : 'навсегда'}`);
  return { ok: true };
}

async function unbanUser(adminId, targetId) {
  const target = await get('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) return { error: 'not_found' };
  await run('UPDATE users SET banned = 0, ban_reason = NULL, banned_until = NULL WHERE id = ?', [targetId]);
  banCache.delete(targetId);
  await logAdmin(adminId, 'unban', targetId, null, null);
  return { ok: true };
}

async function adminDeleteMessage(adminId, messageId, reportId) {
  const msg = await get('SELECT id, chat_id, sender_id FROM messages WHERE id = ?', [messageId]);
  if (!msg) return { error: 'not_found' };
  await run('UPDATE messages SET deleted = 1, content = NULL, media_url = NULL WHERE id = ?', [messageId]);
  io.to(msg.chat_id).emit('message:deleted', { messageId });
  await logAdmin(adminId, 'delete_message', msg.sender_id, reportId, null);
  return { ok: true };
}

async function resolveReport(adminId, reportId, body) {
  const { action, reason, days, deleteMessage } = obj(body);
  if (!['dismiss', 'resolve', 'ban'].includes(action)) return { code: 400, json: { error: 'invalid_input' } };
  const report = await get('SELECT * FROM reports WHERE id = ?', [reportId]);
  if (!report) return { code: 404, json: { error: 'not_found' } };
  if (report.status !== 'open') return { code: 400, json: { error: 'already_handled' } };

  const now = Date.now();
  if (action === 'ban') {
    const r = await banUser(adminId, report.target_user_id, reason, parseDays(days), report.id);
    if (r.error) return { code: 400, json: { error: r.error } };
  }
  if (deleteMessage && report.message_id) await adminDeleteMessage(adminId, report.message_id, report.id);

  await run('UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?',
    [action === 'dismiss' ? 'dismissed' : 'resolved', action, adminId, now, report.id]);
  if (action === 'ban') {
    // остальные открытые жалобы на этого человека закрываем вместе с баном
    await run("UPDATE reports SET status = 'resolved', resolution = 'ban', handled_by = ?, handled_at = ? WHERE target_user_id = ? AND status = 'open'",
      [adminId, now, report.target_user_id]);
  } else {
    await logAdmin(adminId, action === 'dismiss' ? 'dismiss_report' : 'resolve_report', report.target_user_id, report.id, null);
  }
  return { code: 200, json: { ok: true } };
}

// не больше 10 жалоб в час с одного аккаунта
const reportLimiter = rateLimit({
  ...limiterOpts, windowMs: 60 * 60 * 1000, limit: 10,
  keyGenerator: (req) => String(req.user && req.user.id),
  message: { error: 'rate_limited' },
});

app.post('/api/reports', authMiddleware, reportLimiter, asyncRoute(async (req, res) => {
  const r = await createReport(req.user.id, req.body);
  res.status(r.code).json(r.json);
}));

app.get('/api/admin/stats', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const users = await get('SELECT COUNT(*) AS c FROM users');
  const banned = await get('SELECT COUNT(*) AS c FROM users WHERE banned = 1 AND (banned_until IS NULL OR banned_until > ?)', [Date.now()]);
  const open = await get("SELECT COUNT(*) AS c FROM reports WHERE status = 'open'");
  res.json({ users: Number(users.c), banned: Number(banned.c), openReports: Number(open.c) });
}));

app.get('/api/admin/reports', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = await all(`
    SELECT r.id, r.reason, r.details, r.snapshot, r.message_id, r.status, r.resolution, r.created_at, r.handled_at, r.target_user_id,
           ru.username AS reporter_name, tu.username AS target_name, tu.display_name AS target_display,
           tu.banned AS t_banned, tu.banned_until AS t_until, tu.ban_reason AS t_reason, tu.is_admin AS t_admin,
           hu.username AS handler_name,
           (SELECT COUNT(*) FROM reports r2 WHERE r2.target_user_id = r.target_user_id) AS target_total
    FROM reports r
    JOIN users ru ON ru.id = r.reporter_id
    JOIN users tu ON tu.id = r.target_user_id
    LEFT JOIN users hu ON hu.id = r.handled_by
    WHERE r.status = ?
    ORDER BY r.created_at DESC LIMIT 50
  `, [status]);
  res.json(rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    reasonLabel: REPORT_REASONS[r.reason] || r.reason,
    details: r.details,
    snapshot: safeJson(r.snapshot),
    messageId: r.message_id,
    status: r.status,
    resolution: r.resolution,
    createdAt: Number(r.created_at),
    handledAt: r.handled_at ? Number(r.handled_at) : null,
    handlerName: r.handler_name,
    reporterName: r.reporter_name,
    targetId: r.target_user_id,
    targetName: r.target_name,
    targetDisplay: r.target_display,
    targetIsAdmin: !!Number(r.t_admin),
    targetBanned: !!activeBan({ banned: r.t_banned, banned_until: r.t_until, ban_reason: r.t_reason }),
    targetTotal: Number(r.target_total),
  })));
}));

app.post('/api/admin/reports/:id/resolve', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const r = await resolveReport(req.user.id, req.params.id, req.body);
  res.status(r.code).json(r.json);
}));

app.get('/api/admin/users', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const raw = String(req.query.search || '').slice(0, 30);
  const q = `%${raw.replace(/[!%_]/g, '!$&')}%`;
  const onlyBanned = req.query.banned === '1';
  const rows = await all(`
    SELECT id, username, display_name, created_at, last_seen, banned, ban_reason, banned_until, is_admin,
           (SELECT COUNT(*) FROM reports r WHERE r.target_user_id = users.id) AS reports_total
    FROM users
    WHERE username LIKE ? ESCAPE '!' ${onlyBanned ? 'AND banned = 1 AND (banned_until IS NULL OR banned_until > ?)' : ''}
    ORDER BY created_at DESC LIMIT 30
  `, onlyBanned ? [q, Date.now()] : [q]);
  res.json(rows.map((u) => {
    const ban = activeBan(u);
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      createdAt: u.created_at ? Number(u.created_at) : null,
      lastSeen: u.last_seen ? Number(u.last_seen) : null,
      isAdmin: !!Number(u.is_admin),
      banned: !!ban,
      banReason: ban ? ban.reason : null,
      bannedUntil: ban ? ban.until : null,
      reportsTotal: Number(u.reports_total),
    };
  }));
}));

app.post('/api/admin/users/:id/ban', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const { reason, days } = obj(req.body);
  const r = await banUser(req.user.id, req.params.id, reason, parseDays(days), null);
  if (r.error) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error });
  res.json({ ok: true });
}));

app.post('/api/admin/users/:id/unban', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const r = await unbanUser(req.user.id, req.params.id);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
}));

app.post('/api/admin/messages/:id/delete', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const r = await adminDeleteMessage(req.user.id, req.params.id, null);
  if (r.error) return res.status(404).json({ error: r.error });
  res.json({ ok: true });
}));

app.get('/api/admin/log', authMiddleware, asyncRoute(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const rows = await all(`
    SELECT a.action, a.details, a.created_at, au.username AS admin_name, tu.username AS target_name
    FROM admin_actions a
    LEFT JOIN users au ON au.id = a.admin_id
    LEFT JOIN users tu ON tu.id = a.target_user_id
    ORDER BY a.created_at DESC LIMIT 50
  `);
  res.json(rows.map((r) => ({
    action: r.action, details: r.details, createdAt: Number(r.created_at), adminName: r.admin_name, targetName: r.target_name,
  })));
}));

// ---------- ЗАГРУЗКА ФАЙЛОВ (фото / видео / голосовые) ----------
const FREE_UPLOAD_LIMIT = 15 * 1024 * 1024;
const FREE_LIMIT_MESSAGE = 'Бесплатно можно отправлять файлы до 15 МБ. С Premium — до 50 МБ.';
async function uploadSizeGate(req, res, next) {
  try {
    const r = await get('SELECT premium, premium_until FROM users WHERE id = ?', [req.user.id]);
    req.isPremium = isPremiumRow(r);
    const len = Number(req.headers['content-length'] || 0);
    if (!req.isPremium && len > FREE_UPLOAD_LIMIT + 4096) {
      return res.status(413).json({ error: 'file_too_large_free', message: FREE_LIMIT_MESSAGE });
    }
    next();
  } catch (e) {
    next(e);
  }
}
app.post('/api/upload', authMiddleware, uploadLimiter, uploadSizeGate, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  if (!req.isPremium && req.file.size > FREE_UPLOAD_LIMIT) return res.status(413).json({ error: 'file_too_large_free', message: FREE_LIMIT_MESSAGE });

  if (!cloudinaryReady) {
    return res.status(500).json({
      error: 'storage_not_configured',
      message: 'Облачное хранилище для файлов ещё не настроено (нужны переменные CLOUDINARY_*).',
    });
  }

  const mime = req.file.mimetype || '';
  const resourceType = mime.startsWith('image') ? 'image' : (mime.startsWith('video') || mime.startsWith('audio')) ? 'video' : 'raw';

  const extraOptions = {};
  if (resourceType === 'raw') {
    // Сохраняем оригинальное расширение, иначе скачанный файл может открыться некорректно
    const dotIndex = req.file.originalname.lastIndexOf('.');
    if (dotIndex > -1) {
      const ext = req.file.originalname.slice(dotIndex + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      if (ext) extraOptions.format = ext;
    }
  }

  const result = await uploadBufferToCloudinary(req.file.buffer, resourceType, extraOptions);
  res.json({
    url: result.secure_url,
    resourceType: result.resource_type,
    fileName: req.file.originalname,
    fileSize: req.file.size,
  });
}));

// ---------- PUSH-УВЕДОМЛЕНИЯ ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', authMiddleware, asyncRoute(async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid_subscription' });
  await run(`
    INSERT INTO push_subscriptions (id, user_id, endpoint, subscription_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json, user_id = excluded.user_id
  `, [uuid(), req.user.id, sub.endpoint, JSON.stringify(sub), Date.now()]);
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', authMiddleware, asyncRoute(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  res.json({ ok: true });
}));

async function sendPushToUser(userId, payload) {
  const subs = await all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  for (const row of subs) {
    const subscription = JSON.parse(row.subscription_json);
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [row.endpoint]);
      }
    }
  }
}

// ---------- ОБРАБОТКА ОШИБОК ----------
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'Файл слишком большой (максимум 50 МБ)' });
  }
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: 'bad_request' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

// ---------- SERVER + SOCKET.IO ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGIN }, maxHttpBufferSize: 1e5 });

const onlineUsers = new Map(); // userId -> socketId

// "В сети" видят только те, у кого есть общий чат (а не вообще все)
async function emitPresence(userId, online, force = false) {
  try {
    if (!force) {
      const pr = await get('SELECT premium, premium_until, hide_last_seen FROM users WHERE id = ?', [userId]);
      if (pr && isPremiumRow(pr) && Number(pr.hide_last_seen)) return;
    }
    const rows = await all('SELECT chat_id FROM chat_members WHERE user_id = ?', [userId]);
    const rooms = rows.map((r) => r.chat_id);
    if (rooms.length) io.to(rooms).emit('presence:update', { userId, online });
  } catch (err) {
    console.error('emitPresence failed', err);
  }
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || typeof token !== 'string') return next(new Error('no_token'));
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return next(new Error('invalid_token'));
  }
  try {
    const st = await getBanStatus(payload.id);
    if (!st.exists) return next(new Error('invalid_token'));
    if (st.ban) {
      const err = new Error('banned');
      err.data = { reason: st.ban.reason, until: st.ban.until };
      return next(err);
    }
  } catch (e) {
    return next(new Error('server_error'));
  }
  socket.user = payload;
  next();
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  try {
    const myChats = await all('SELECT chat_id FROM chat_members WHERE user_id = ?', [userId]);
    myChats.forEach(({ chat_id }) => socket.join(chat_id));
  } catch (err) {
    console.error('Failed to join chat rooms', err);
  }
  emitPresence(userId, true);

  // Защита от флуда: не больше 30 сообщений за 10 секунд с одного соединения
  let sendTimes = [];
  const allowSend = () => {
    const now = Date.now();
    sendTimes = sendTimes.filter((t) => now - t < 10000);
    if (sendTimes.length >= 30) return false;
    sendTimes.push(now);
    return true;
  };

  socket.on('message:send', async (raw) => {
    try {
      if (!allowSend()) return;
      const r = obj(raw);
      const chatId = typeof r.chatId === 'string' ? r.chatId : '';
      const type = r.type;
      const content = typeof r.content === 'string' ? r.content.slice(0, 4000) : null;
      const fileName = typeof r.fileName === 'string' ? r.fileName.slice(0, 255) : '';
      const fileSize = Number.isFinite(Number(r.fileSize)) ? Number(r.fileSize) : 0;
      const mediaUrl = r.mediaUrl || null;
      if (mediaUrl && !isSafeMediaUrl(mediaUrl)) return;
      const lat = Number(r.lat);
      const lng = Number(r.lng);

      if (!(await isChatMember(chatId, userId))) return;
      if (type === 'location' && !(Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180)) return;

      // Личный чат с заблокированным (в любую сторону): сообщение не отправляем
      const blockedPair = await get(
        `SELECT 1 AS ok FROM chats c JOIN chat_members m ON m.chat_id = c.id AND m.user_id != ?
         WHERE c.id = ? AND c.type = 'private'
           AND EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = m.user_id) OR (b.blocker_id = m.user_id AND b.blocked_id = ?))
         LIMIT 1`,
        [userId, chatId, userId, userId]
      );
      if (blockedPair) {
        socket.emit('message:rejected', { chatId, reason: 'blocked' });
        return;
      }

      // Ответить можно только на сообщение из этого же чата
      let replyTo = typeof r.replyTo === 'string' ? r.replyTo : null;
      if (replyTo) {
        const sameChat = await get('SELECT 1 as ok FROM messages WHERE id = ? AND chat_id = ?', [replyTo, chatId]);
        if (!sameChat) replyTo = null;
      }

      const id = uuid();
      const created_at = Date.now();
      let msgType = 'text';
      if (type === 'location') msgType = 'location';
      else if (type === 'video') msgType = 'video';
      else if (type === 'voice') msgType = 'voice';
      else if (type === 'file') msgType = 'file';
      else if (type === 'missed_call') msgType = 'missed_call';
      else if (mediaUrl) msgType = 'image';
      const finalContent = msgType === 'location' ? JSON.stringify({ lat, lng })
        : msgType === 'file' ? JSON.stringify({ name: fileName, size: fileSize })
        : (content || null);

      await run('INSERT INTO messages (id, chat_id, sender_id, type, content, media_url, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, chatId, userId, msgType, finalContent, mediaUrl || null, replyTo || null, created_at]);

      const senderRow = await get('SELECT username, display_name FROM users WHERE id = ?', [userId]);
      const senderName = senderRow ? (senderRow.display_name || senderRow.username) : socket.user.username;

      let replyInfo = {};
      if (replyTo) {
        const rm = await get(`
          SELECT m.type as reply_type, m.content as reply_content, COALESCE(u.display_name, u.username) as reply_sender_name
          FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
        `, [replyTo]);
        if (rm) replyInfo = rm;
      }

      const message = { id, chat_id: chatId, sender_id: userId, sender_name: senderName, type: msgType, content: finalContent, media_url: mediaUrl, reply_to: replyTo || null, created_at, ...replyInfo };
      io.to(chatId).emit('message:new', message);

      const members = await all(`
        SELECT cm.user_id, u.username FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.user_id != ?
      `, [chatId, userId]);
      const previewText = msgType === 'location' ? '📍 Геолокация'
        : msgType === 'video' ? '🎥 Видео'
        : msgType === 'voice' ? '🎤 Голосовое сообщение'
        : msgType === 'file' ? `📄 Файл: ${fileName || ''}`
        : msgType === 'missed_call' ? '📵 Пропущенный звонок'
        : msgType === 'image' ? '📷 Фото'
        : (content || '');
      for (const { user_id, username } of members) {
        if (onlineUsers.has(user_id)) continue;
        const isMentioned = msgType === 'text' && content && new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content);
        if (!isMentioned) {
          const isMuted = await get('SELECT 1 as ok FROM muted_chats WHERE user_id = ? AND chat_id = ?', [user_id, chatId]);
          if (isMuted) continue;
        }
        sendPushToUser(user_id, { title: senderName, body: isMentioned ? `Упомянул(а) вас: ${previewText}` : previewText, url: '/' });
      }
    } catch (err) {
      console.error('message:send failed', err);
    }
  });

  socket.on('typing', (raw) => {
    const { chatId } = obj(raw);
    if (typeof chatId !== 'string' || !socket.rooms.has(chatId)) return;
    socket.to(chatId).emit('typing', { chatId, userId, username: socket.user.username });
  });

  socket.on('reaction:toggle', async (raw) => {
    try {
      const { messageId, emoji } = obj(raw);
      if (typeof messageId !== 'string' || !isValidEmoji(emoji)) return;
      const msg = await get('SELECT chat_id FROM messages WHERE id = ?', [messageId]);
      if (!msg) return;
      const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [msg.chat_id, userId]);
      if (!isMember) return;

      const existing = await get('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?', [messageId, userId]);
      if (existing && existing.emoji === emoji) {
        await run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [messageId, userId]);
      } else {
        await run(`
          INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji
        `, [messageId, userId, emoji]);
      }

      const rows = await all('SELECT emoji, user_id FROM message_reactions WHERE message_id = ?', [messageId]);
      const grouped = {};
      rows.forEach((r) => {
        if (!grouped[r.emoji]) grouped[r.emoji] = [];
        grouped[r.emoji].push(r.user_id);
      });
      const reactions = Object.entries(grouped).map(([e, userIds]) => ({ emoji: e, count: userIds.length, userIds }));
      io.to(msg.chat_id).emit('reaction:update', { messageId, reactions });
    } catch (err) {
      console.error('reaction:toggle failed', err);
    }
  });

  socket.on('message:read', async (raw) => {
    const r = obj(raw);
    const chatId = r.chatId;
    const messageIds = Array.isArray(r.messageIds) ? r.messageIds.filter((m) => typeof m === 'string').slice(0, 200) : [];
    if (typeof chatId !== 'string' || messageIds.length === 0) return;
    try {
      if (!(await isChatMember(chatId, userId))) return;
      const readAt = Date.now();
      for (const messageId of messageIds) {
        // отмечаем прочитанным только сообщение из ЭТОГО чата
        await run('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) SELECT id, ?, ? FROM messages WHERE id = ? AND chat_id = ?', [userId, readAt, messageId, chatId]);
      }
      io.to(chatId).emit('message:read', { chatId, messageIds, byUserId: userId });
    } catch (err) {
      console.error('message:read failed', err);
    }
  });

  // ---- Сигналинг для аудиозвонков (WebRTC) ----
  socket.on('call:offer', async (raw) => {
    try {
      const { toUserId, chatId, sdp } = obj(raw);
      if (typeof toUserId !== 'string') return;
      // Звонить можно только тем, с кем у тебя есть общий чат
      if (!(await sharesChat(userId, toUserId)) || (await isBlockedEither(userId, toUserId))) return socket.emit('call:unavailable', { toUserId });
      const targetSocketId = onlineUsers.get(toUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call:offer', { fromUserId: userId, fromUsername: socket.user.username, chatId, sdp });
      } else {
        socket.emit('call:unavailable', { toUserId });
      }
    } catch (err) {
      console.error('call:offer failed', err);
    }
  });

  socket.on('call:answer', (raw) => {
    const { toUserId, sdp } = obj(raw);
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:answer', { fromUserId: userId, sdp });
  });

  socket.on('call:ice-candidate', (raw) => {
    const { toUserId, candidate } = obj(raw);
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:ice-candidate', { fromUserId: userId, candidate });
  });

  socket.on('call:end', (raw) => {
    const { toUserId } = obj(raw);
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:end', { fromUserId: userId });
  });

  socket.on('disconnect', async () => {
    // если у человека открыта ещё одна вкладка/устройство — он всё ещё онлайн
    if (onlineUsers.get(userId) !== socket.id) return;
    onlineUsers.delete(userId);
    try {
      await run('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]);
    } catch (err) {
      console.error('Не удалось сохранить last_seen', err);
    }
    await emitPresence(userId, false);
  });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Family Messenger запущен на порту ${PORT}`);
      console.log(`2FA: почта — ${emailConfigured() ? 'настроена' : 'не настроена'}, Telegram — ${telegramConfigured() ? 'настроен' : 'не настроен'}`);
      registerTelegramWebhook();
      expirePremium();
      setInterval(expirePremium, 10 * 60 * 1000);
    });
  })
  .catch((err) => {
    console.error('Не удалось инициализировать базу данных:', err);
    process.exit(1);
  });
