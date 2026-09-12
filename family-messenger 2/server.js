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
const { v4: uuid } = require('uuid');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ---------- VAPID-КЛЮЧИ ДЛЯ PUSH ----------
// Генерируются один раз и сохраняются в файл, чтобы не менялись при перезапуске.
const vapidPath = path.join(__dirname, 'vapid.json');
let vapidKeys;
if (fs.existsSync(vapidPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(vapidPath, 'utf-8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(vapidKeys, null, 2));
}
webpush.setVapidDetails('mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

// ---------- БАЗА ДАННЫХ ----------
const db = new Database(path.join(__dirname, 'messenger.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'private' | 'group'
  title TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'image' | 'location'
  content TEXT,
  media_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// ---------- EXPRESS ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

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

// ---------- AUTH ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username_taken' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, hash, Date.now());

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ---------- ПОЛЬЗОВАТЕЛИ ----------
app.get('/api/users', authMiddleware, (req, res) => {
  const q = `%${req.query.search || ''}%`;
  const rows = db.prepare('SELECT id, username, avatar FROM users WHERE username LIKE ? AND id != ? LIMIT 20')
    .all(q, req.user.id);
  res.json(rows);
});

// ---------- ЧАТЫ ----------
app.get('/api/chats', authMiddleware, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.title, c.created_by
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
  `).all(req.user.id);

  const result = chats.map(chat => {
    const lastMsg = db.prepare(
      'SELECT type, content, media_url, created_at, sender_id FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(chat.id);

    let title = chat.title;
    let otherUserId = null;
    if (chat.type === 'private') {
      const other = db.prepare(`
        SELECT u.id, u.username FROM chat_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = ? AND cm.user_id != ?
      `).get(chat.id, req.user.id);
      title = other ? other.username : 'Диалог';
      otherUserId = other ? other.id : null;
    }
    return { ...chat, title, otherUserId, lastMessage: lastMsg || null };
  });

  result.sort((a, b) => (b.lastMessage?.created_at || 0) - (a.lastMessage?.created_at || 0));
  res.json(result);
});

app.post('/api/chats', authMiddleware, (req, res) => {
  const { type, title, memberIds } = req.body;
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'members_required' });
  }

  if (type === 'private') {
    const otherId = memberIds[0];
    const existing = db.prepare(`
      SELECT c.id FROM chats c
      JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
      JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
      WHERE c.type = 'private'
    `).get(req.user.id, otherId);
    if (existing) return res.json({ id: existing.id });
  }

  const id = uuid();
  db.prepare('INSERT INTO chats (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, title || null, req.user.id, Date.now());

  const insertMember = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)');
  insertMember.run(id, req.user.id);
  memberIds.forEach(uid => insertMember.run(id, uid));

  res.json({ id });
});

app.get('/api/chats/:id/messages', authMiddleware, (req, res) => {
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!isMember) return res.status(403).json({ error: 'forbidden' });

  const messages = db.prepare(`
    SELECT m.*, u.username as sender_name FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.created_at ASC LIMIT 200
  `).all(req.params.id);
  res.json(messages);
});

// ---------- ЗАГРУЗКА ФАЙЛОВ ----------
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ---------- PUSH-УВЕДОМЛЕНИЯ ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid_subscription' });
  db.prepare(`
    INSERT INTO push_subscriptions (id, user_id, endpoint, subscription_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json, user_id = excluded.user_id
  `).run(uuid(), req.user.id, sub.endpoint, JSON.stringify(sub), Date.now());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

function sendPushToUser(userId, payload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  subs.forEach((row) => {
    const subscription = JSON.parse(row.subscription_json);
    webpush.sendNotification(subscription, JSON.stringify(payload)).catch((err) => {
      // Подписка протухла (пользователь удалил разрешение) — чистим её
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
      }
    });
  });
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

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('presence:update', { userId, online: true });

  const myChats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(userId);
  myChats.forEach(({ chat_id }) => socket.join(chat_id));

  // ---- Сообщения ----
  socket.on('message:send', ({ chatId, content, mediaUrl, type, lat, lng }) => {
    const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId);
    if (!isMember) return;

    const id = uuid();
    const created_at = Date.now();
    const msgType = type === 'location' ? 'location' : (mediaUrl ? 'image' : 'text');
    const finalContent = msgType === 'location' ? JSON.stringify({ lat, lng }) : (content || null);

    db.prepare('INSERT INTO messages (id, chat_id, sender_id, type, content, media_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, chatId, userId, msgType, finalContent, mediaUrl || null, created_at);

    const message = { id, chat_id: chatId, sender_id: userId, sender_name: socket.user.username, type: msgType, content: finalContent, media_url: mediaUrl, created_at };
    io.to(chatId).emit('message:new', message);

    // Пуш офлайн-участникам чата
    const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, userId);
    const previewText = msgType === 'location' ? '📍 Геолокация' : (msgType === 'image' ? '📷 Фото' : (content || ''));
    members.forEach(({ user_id }) => {
      if (!onlineUsers.has(user_id)) {
        sendPushToUser(user_id, { title: socket.user.username, body: previewText, url: '/' });
      }
    });
  });

  socket.on('typing', ({ chatId }) => {
    socket.to(chatId).emit('typing', { chatId, userId, username: socket.user.username });
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

server.listen(PORT, () => {
  console.log(`Family Messenger запущен на порту ${PORT}`);
});
