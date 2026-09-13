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

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

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
webpush.setVapidDetails('mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

// ---------- CLOUDINARY (постоянное хранилище фото/видео/голосовых) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const cloudinaryReady = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

function uploadBufferToCloudinary(buffer, resourceType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: resourceType, folder: 'family-messenger' }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
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
}

// ---------- EXPRESS ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
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
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const exists = await get('SELECT id FROM users WHERE username = ?', [username]);
  if (exists) return res.status(409).json({ error: 'username_taken' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  await run('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [id, username, hash, Date.now()]);

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username } });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  const user = await get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
}));

app.get('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  const user = await get('SELECT id, username, avatar, display_name FROM users WHERE id = ?', [req.user.id]);
  res.json({ user });
}));

app.patch('/api/me', authMiddleware, asyncRoute(async (req, res) => {
  const { avatar, displayName } = req.body;
  if (avatar) await run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.user.id]);
  if (typeof displayName === 'string') {
    const trimmed = displayName.trim().slice(0, 40);
    await run('UPDATE users SET display_name = ? WHERE id = ?', [trimmed || null, req.user.id]);
  }
  const user = await get('SELECT id, username, avatar, display_name FROM users WHERE id = ?', [req.user.id]);
  res.json({ user });
}));

// ---------- ПОЛЬЗОВАТЕЛИ ----------
app.get('/api/users', authMiddleware, asyncRoute(async (req, res) => {
  const q = `%${req.query.search || ''}%`;
  const rows = await all('SELECT id, username, avatar, display_name FROM users WHERE username LIKE ? AND id != ? LIMIT 20', [q, req.user.id]);
  res.json(rows);
}));

app.get('/api/users/:id', authMiddleware, asyncRoute(async (req, res) => {
  const user = await get('SELECT id, username, avatar, display_name FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json(user);
}));

// ---------- ЧАТЫ ----------
app.get('/api/chats', authMiddleware, asyncRoute(async (req, res) => {
  const chatsRaw = await all(`
    SELECT c.id, c.type, c.title, c.created_by
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
    let otherAvatar = null;
    if (chat.type === 'private') {
      const other = await get(`
        SELECT u.id, u.username, u.avatar, u.display_name FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.user_id != ?
      `, [chat.id, req.user.id]);
      title = other ? (other.display_name || other.username) : 'Диалог';
      otherUserId = other ? other.id : null;
      otherAvatar = other ? other.avatar : null;
    }
    result.push({ ...chat, title, otherUserId, otherAvatar, lastMessage: lastMsg || null });
  }

  result.sort((a, b) => (b.lastMessage?.created_at || 0) - (a.lastMessage?.created_at || 0));
  res.json(result);
}));

app.post('/api/chats', authMiddleware, asyncRoute(async (req, res) => {
  const { type, title, memberIds } = req.body;
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'members_required' });
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
  await run('INSERT INTO chats (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, type, title || null, req.user.id, Date.now()]);

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

app.get('/api/chats/:id/messages', authMiddleware, asyncRoute(async (req, res) => {
  const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'forbidden' });

  const messages = await all(`
    SELECT m.*, COALESCE(u.display_name, u.username) as sender_name,
      EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id != m.sender_id) as is_read
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.created_at ASC LIMIT 200
  `, [req.params.id]);
  res.json(messages);
}));

app.delete('/api/chats/:id/messages', authMiddleware, asyncRoute(async (req, res) => {
  const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!isMember) return res.status(403).json({ error: 'forbidden' });

  await run('DELETE FROM messages WHERE chat_id = ?', [req.params.id]);
  io.to(req.params.id).emit('chat:cleared', { chatId: req.params.id });
  res.json({ ok: true });
}));

// ---------- ЗАГРУЗКА ФАЙЛОВ (фото / видео / голосовые) ----------
app.post('/api/upload', authMiddleware, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  if (!cloudinaryReady) {
    return res.status(500).json({
      error: 'storage_not_configured',
      message: 'Облачное хранилище для файлов ещё не настроено (нужны переменные CLOUDINARY_*).',
    });
  }

  const mime = req.file.mimetype || '';
  const resourceType = mime.startsWith('video') || mime.startsWith('audio') ? 'video' : 'image';
  const result = await uploadBufferToCloudinary(req.file.buffer, resourceType);
  res.json({ url: result.secure_url, resourceType: result.resource_type });
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

// ---------- SERVER + SOCKET.IO ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('no_token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('invalid_token'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('presence:update', { userId, online: true });

  try {
    const myChats = await all('SELECT chat_id FROM chat_members WHERE user_id = ?', [userId]);
    myChats.forEach(({ chat_id }) => socket.join(chat_id));
  } catch (err) {
    console.error('Failed to join chat rooms', err);
  }

  socket.on('message:send', async ({ chatId, content, mediaUrl, type, lat, lng }) => {
    try {
      const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
      if (!isMember) return;

      const id = uuid();
      const created_at = Date.now();
      let msgType = 'text';
      if (type === 'location') msgType = 'location';
      else if (type === 'video') msgType = 'video';
      else if (type === 'voice') msgType = 'voice';
      else if (mediaUrl) msgType = 'image';
      const finalContent = msgType === 'location' ? JSON.stringify({ lat, lng }) : (content || null);

      await run('INSERT INTO messages (id, chat_id, sender_id, type, content, media_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, chatId, userId, msgType, finalContent, mediaUrl || null, created_at]);

      const senderRow = await get('SELECT username, display_name FROM users WHERE id = ?', [userId]);
      const senderName = senderRow ? (senderRow.display_name || senderRow.username) : socket.user.username;

      const message = { id, chat_id: chatId, sender_id: userId, sender_name: senderName, type: msgType, content: finalContent, media_url: mediaUrl, created_at };
      io.to(chatId).emit('message:new', message);

      const members = await all('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?', [chatId, userId]);
      const previewText = msgType === 'location' ? '📍 Геолокация'
        : msgType === 'video' ? '🎥 Видео'
        : msgType === 'voice' ? '🎤 Голосовое сообщение'
        : msgType === 'image' ? '📷 Фото'
        : (content || '');
      members.forEach(({ user_id }) => {
        if (!onlineUsers.has(user_id)) {
          sendPushToUser(user_id, { title: senderName, body: previewText, url: '/' });
        }
      });
    } catch (err) {
      console.error('message:send failed', err);
    }
  });

  socket.on('typing', ({ chatId }) => {
    socket.to(chatId).emit('typing', { chatId, userId, username: socket.user.username });
  });

  socket.on('message:read', async ({ chatId, messageIds }) => {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return;
    try {
      const isMember = await get('SELECT 1 as ok FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
      if (!isMember) return;
      const readAt = Date.now();
      for (const messageId of messageIds) {
        await run('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)', [messageId, userId, readAt]);
      }
      io.to(chatId).emit('message:read', { chatId, messageIds, byUserId: userId });
    } catch (err) {
      console.error('message:read failed', err);
    }
  });

  // ---- Сигналинг для аудиозвонков (WebRTC) ----
  socket.on('call:offer', ({ toUserId, chatId, sdp }) => {
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:offer', { fromUserId: userId, fromUsername: socket.user.username, chatId, sdp });
    } else {
      socket.emit('call:unavailable', { toUserId });
    }
  });

  socket.on('call:answer', ({ toUserId, sdp }) => {
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:answer', { fromUserId: userId, sdp });
  });

  socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:ice-candidate', { fromUserId: userId, candidate });
  });

  socket.on('call:end', ({ toUserId }) => {
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('call:end', { fromUserId: userId });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('presence:update', { userId, online: false });
  });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Family Messenger запущен на порту ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Не удалось инициализировать базу данных:', err);
    process.exit(1);
  });
