let token = localStorage.getItem('token');
let me = JSON.parse(localStorage.getItem('me') || 'null');
let socket = null;
let activeChatId = null;
let activeChatOtherUserId = null;
let activeChatObj = null;
let groupMembersCache = [];
let chats = [];
let authMode = 'login';
const unreadIncomingIds = new Set();
const onlineUserIds = new Set();
const messagesById = new Map();
let replyingToId = null;

const $ = (sel) => document.querySelector(sel);

// ---------- AUTH UI ----------
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#auth-error').textContent = '';
}

$('#auth-submit').onclick = async () => {
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  if (!username || !password) return;

  try {
    const res = await fetch(`/api/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('#auth-error').textContent = translateError(data.error);
      return;
    }
    token = data.token;
    me = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('me', JSON.stringify(me));
    startApp();
  } catch (e) {
    $('#auth-error').textContent = 'Ошибка соединения с сервером';
  }
};

function translateError(err) {
  const map = {
    invalid_input: 'Пароль должен быть от 4 символов',
    username_taken: 'Это имя уже занято',
    invalid_credentials: 'Неверный логин или пароль',
  };
  return map[err] || 'Что-то пошло не так';
}

$('#logout-btn').onclick = () => {
  localStorage.clear();
  location.reload();
};

// ---------- APP INIT ----------
if (token && me) startApp();

function startApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  applySavedTheme();
  renderMyAvatar();

  socket = io({ auth: { token } });
  socket.on('message:new', onMessageNew);
  socket.on('typing', onTyping);
  socket.on('presence:update', onPresence);
  socket.on('connect', resyncAfterReconnect);
  socket.on('chats:refresh', loadChats);
  socket.on('chat:cleared', ({ chatId }) => {
    if (chatId === activeChatId) $('#messages').innerHTML = '';
    const chat = chats.find((c) => c.id === chatId);
    if (chat) chat.lastMessage = null;
    renderChatList();
  });
  socket.on('message:read', ({ messageIds }) => {
    messageIds.forEach((id) => {
      const row = document.querySelector(`[data-message-id="${id}"]`);
      const statusEl = row?.querySelector('.msg-status');
      if (statusEl) {
        statusEl.textContent = '✓✓';
        statusEl.classList.add('read');
      }
    });
  });
  socket.on('reaction:update', ({ messageId, reactions }) => {
    const msg = messagesById.get(messageId);
    if (msg) { msg.reactions = reactions; updateMessageRow(messageId); }
  });
  socket.on('message:edited', ({ messageId, content }) => {
    const msg = messagesById.get(messageId);
    if (msg) { msg.content = content; msg.edited = 1; updateMessageRow(messageId); }
  });
  socket.on('message:deleted', ({ messageId }) => {
    const msg = messagesById.get(messageId);
    if (msg) { msg.deleted = 1; msg.content = null; msg.media_url = null; updateMessageRow(messageId); }
  });
  attachCallSocketHandlers();

  loadChats();
  setupPush();
  refreshMyProfile();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncAfterReconnect();
  });
}

async function refreshMyProfile() {
  const { user } = await api('/api/me');
  me = user;
  localStorage.setItem('me', JSON.stringify(me));
  renderMyAvatar();
}

function renderMyAvatar() {
  $('#me-username').textContent = me.display_name || me.username;
  setAvatarEl($('#me-avatar'), { username: me.username, avatar: me.avatar });
}

function setAvatarEl(el, user) {
  if (user && user.avatar) {
    el.style.backgroundImage = `url(${user.avatar})`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (user && user.username ? user.username[0] : '?').toUpperCase();
  }
}

async function resyncAfterReconnect() {
  await loadChats();
  if (activeChatId) {
    const messages = await api(`/api/chats/${activeChatId}/messages`);
    const box = $('#messages');
    box.innerHTML = '';
    unreadIncomingIds.clear();
  messagesById.clear();
  lastRenderedDateKey = null;
    messages.forEach(renderMessage);
    box.scrollTop = box.scrollHeight;
    markVisibleMessagesRead();
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  return res.json();
}

// ---------- CHAT LIST ----------
async function loadChats() {
  chats = await api('/api/chats');
  renderChatList();
  if (activeChatId) {
    const updated = chats.find((c) => c.id === activeChatId);
    if (updated) {
      activeChatObj = updated;
      updatePinnedBanner();
    }
  }
}

function renderChatList() {
  const list = $('#chat-list');
  list.innerHTML = '';
  chats.forEach((chat) => {
    const div = document.createElement('div');
    div.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    let preview = 'Нет сообщений';
    if (chat.lastMessage) {
      if (chat.lastMessage.type === 'location') preview = '📍 Геолокация';
      else if (chat.lastMessage.type === 'video') preview = '🎥 Видео';
      else if (chat.lastMessage.type === 'voice') preview = '🎤 Голосовое сообщение';
      else if (chat.lastMessage.type === 'missed_call') preview = '📵 Пропущенный звонок';
      else if (chat.lastMessage.media_url) preview = '📷 Фото';
      else preview = chat.lastMessage.content || '';
    }
    div.innerHTML = `
      <span class="avatar-circle"></span>
      <span class="chat-item-texts">
        <span class="chat-item-title">${escapeHtml(chat.title || 'Чат')}</span>
        <span class="chat-item-preview">${escapeHtml(preview)}</span>
      </span>`;
    setAvatarEl(div.querySelector('.avatar-circle'), { username: chat.title, avatar: chat.otherAvatar });
    if (chat.type === 'group' && !chat.otherAvatar) div.querySelector('.avatar-circle').textContent = '👥';
    div.onclick = () => openChat(chat.id);
    list.appendChild(div);
  });
}

async function openChat(chatId) {
  activeChatId = chatId;
  renderChatList();
  $('#empty-state').classList.add('hidden');
  $('#active-chat').classList.remove('hidden');
  $('#app-screen').classList.add('chat-open');
  $('#chat-search-bar').classList.add('hidden');
  if (selectionMode) exitSelectionMode();

  const chat = chats.find((c) => c.id === chatId);
  activeChatObj = chat || null;
  $('#chat-title').textContent = chat ? chat.title : '';
  setAvatarEl($('#chat-avatar'), { username: chat?.title, avatar: chat?.otherAvatar });
  if (chat && chat.type === 'group' && !chat.otherAvatar) $('#chat-avatar').textContent = '👥';
  activeChatOtherUserId = chat && chat.type === 'private' ? chat.otherUserId : null;
  $('#call-btn').classList.toggle('hidden', !activeChatOtherUserId);
  lastKnownLastSeen = null;
  $('#presence-label').textContent = '';
  if (activeChatOtherUserId) {
    api(`/api/users/${activeChatOtherUserId}`).then((u) => {
      lastKnownLastSeen = u.last_seen;
      updatePresenceLabel();
    });
  }

  groupMembersCache = [];
  if (chat && chat.type === 'group') {
    api(`/api/chats/${chatId}/members`).then((members) => { groupMembersCache = members; });
  }

  const messages = await api(`/api/chats/${chatId}/messages`);
  const box = $('#messages');
  box.innerHTML = '';
  unreadIncomingIds.clear();
  messagesById.clear();
  lastRenderedDateKey = null;
  applyWallpaper(chatId);
  messages.forEach(renderMessage);
  box.scrollTop = box.scrollHeight;
  markVisibleMessagesRead();
  await updatePinnedBanner();
}

async function updatePinnedBanner() {
  const chat = activeChatObj;
  if (!chat || !chat.pinned_message_id) {
    $('#pinned-banner').classList.add('hidden');
    return;
  }
  let pinned = messagesById.get(chat.pinned_message_id);
  if (!pinned) {
    try { pinned = await api(`/api/messages/${chat.pinned_message_id}`); } catch { pinned = null; }
  }
  if (!pinned) {
    $('#pinned-banner').classList.add('hidden');
    return;
  }
  $('#pinned-banner-text').textContent = replyPreviewText(pinned);
  $('#pinned-banner').classList.remove('hidden');
}

function pinMessage(messageId) {
  api(`/api/chats/${activeChatId}/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
}
function unpinMessage() {
  api(`/api/chats/${activeChatId}/pin`, { method: 'DELETE' });
}
$('#unpin-btn').onclick = (e) => { e.stopPropagation(); unpinMessage(); };
$('#pinned-banner').addEventListener('click', () => {
  const row = document.querySelector(`[data-message-id="${activeChatObj?.pinned_message_id}"]`);
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

function replyPreviewText(m) {
  if (m.type === 'image') return '📷 Фото';
  if (m.type === 'video') return '🎥 Видео';
  if (m.type === 'voice') return '🎤 Голосовое сообщение';
  if (m.type === 'location') return '📍 Геолокация';
  if (m.type === 'missed_call') return '📵 Пропущенный звонок';
  return m.content || '';
}

let lastRenderedDateKey = null;

function formatDateDivider(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function maybeInsertDateDivider(box, msg) {
  const dateKey = new Date(msg.created_at).toDateString();
  if (dateKey === lastRenderedDateKey) return;
  lastRenderedDateKey = dateKey;
  const divider = document.createElement('div');
  divider.className = 'date-divider';
  divider.innerHTML = `<span>${formatDateDivider(msg.created_at)}</span>`;
  box.appendChild(divider);
}

function renderMessage(msg) {
  const box = $('#messages');
  maybeInsertDateDivider(box, msg);
  const row = buildMessageRow(msg);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  if (msg.sender_id !== me.id) unreadIncomingIds.add(msg.id);
}

function updateMessageRow(messageId) {
  const msg = messagesById.get(messageId);
  const oldRow = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msg || !oldRow) return;
  const newRow = buildMessageRow(msg);
  oldRow.replaceWith(newRow);
}

function buildMessageRow(msg) {
  const row = document.createElement('div');
  const isOut = msg.sender_id === me.id;
  row.className = 'msg-row ' + (isOut ? 'out' : 'in');
  row.dataset.messageId = msg.id;
  messagesById.set(msg.id, msg);

  if (msg.deleted) {
    row.innerHTML = `<div class="bubble"><span class="message-deleted">Сообщение удалено</span></div>`;
    return row;
  }

  const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const timeStatusInner = `${time}${msg.edited ? ' <span class="message-edited-tag">ред.</span>' : ''}${isOut ? ` <span class="msg-status${msg.is_read ? ' read' : ''}">${msg.is_read ? '✓✓' : '✓'}</span>` : ''}`;

  let bodyHtml = '';
  let timeHtml = `<span class="time-inline">${timeStatusInner}</span>`;

  if (msg.type === 'location') {
    try {
      const { lat, lng } = JSON.parse(msg.content);
      const d = 0.01;
      const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
      bodyHtml = `
        <div class="location-card">
          <iframe class="location-map" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat}%2C${lng}" loading="lazy"></iframe>
          <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}" target="_blank" rel="noopener">📍 Открыть на карте</a>
        </div>
        <div class="time-block">${timeStatusInner}</div>`;
      timeHtml = '';
    } catch {
      bodyHtml = '📍 Геолокация';
    }
  } else if (msg.type === 'video') {
    bodyHtml = `<div class="media-wrap"><video class="video-bubble" src="${msg.media_url}" controls playsinline></video><span class="media-time-overlay">${timeStatusInner}</span></div>`;
    timeHtml = '';
  } else if (msg.type === 'voice') {
    bodyHtml = `
      <div class="voice-bubble">
        <button type="button" class="voice-play-btn">▶</button>
        <div class="voice-progress"><div class="voice-progress-fill"></div></div>
        <span class="voice-duration">0:00</span>
        <audio class="voice-audio-el" src="${msg.media_url}" preload="metadata"></audio>
      </div>
      <div class="time-block">${timeStatusInner}</div>`;
    timeHtml = '';
  } else if (msg.type === 'missed_call') {
    bodyHtml = `<div class="missed-call">📵 Пропущенный звонок</div><div class="time-block">${timeStatusInner}</div>`;
    timeHtml = '';
  } else {
    if (msg.content) bodyHtml += renderTextWithMentions(msg.content);
    if (msg.media_url) {
      bodyHtml += `<div class="media-wrap"><img src="${msg.media_url}" /><span class="media-time-overlay">${timeStatusInner}</span></div>`;
      timeHtml = msg.content ? timeHtml : '';
    }
  }

  let quoteHtml = '';
  if (msg.reply_to) {
    const preview = msg.reply_type === 'image' ? '📷 Фото'
      : msg.reply_type === 'video' ? '🎥 Видео'
      : msg.reply_type === 'voice' ? '🎤 Голосовое сообщение'
      : msg.reply_type === 'location' ? '📍 Геолокация'
      : msg.reply_type === 'missed_call' ? '📵 Пропущенный звонок'
      : (msg.reply_content || '');
    quoteHtml = `<div class="reply-quote">
      <span class="reply-quote-sender">${escapeHtml(msg.reply_sender_name || '')}</span>
      <span class="reply-quote-text">${escapeHtml(preview)}</span>
    </div>`;
  }

  row.innerHTML = `
    <span class="select-checkbox"></span>
    <div class="bubble">
      ${!isOut && activeChatObj?.type === 'group' ? `<span class="sender">${escapeHtml(msg.sender_name || '')}</span>` : ''}
      ${quoteHtml}
      <div class="bubble-text-wrap">${bodyHtml}${timeHtml}</div>
      <div class="reactions-row">${renderReactionsRow(msg)}</div>
    </div>`;
  return row;
}

function renderReactionsRow(msg) {
  if (!msg.reactions || msg.reactions.length === 0) return '';
  return msg.reactions.map((r) => {
    const mine = r.userIds && r.userIds.includes(me.id);
    return `<span class="reaction-pill${mine ? ' mine' : ''}" data-emoji="${r.emoji}">${r.emoji} ${r.count}</span>`;
  }).join('');
}

function onMessageNew(msg) {
  if (msg.chat_id === activeChatId) {
    renderMessage(msg);
    if (msg.sender_id !== me.id) markVisibleMessagesRead();
  }
  const chat = chats.find((c) => c.id === msg.chat_id);
  if (chat) chat.lastMessage = msg;
  renderChatList();
}

function markVisibleMessagesRead() {
  if (!activeChatId || unreadIncomingIds.size === 0) return;
  const ids = Array.from(unreadIncomingIds);
  unreadIncomingIds.clear();
  socket.emit('message:read', { chatId: activeChatId, messageIds: ids });
}

function onTyping({ chatId, username }) {
  if (chatId !== activeChatId) return;
  const el = $('#typing-indicator');
  el.textContent = `${username} печатает...`;
  clearTimeout(onTyping._t);
  onTyping._t = setTimeout(() => (el.textContent = ''), 2000);
}

function onPresence({ userId, online }) {
  if (online) onlineUserIds.add(userId);
  else onlineUserIds.delete(userId);
  if (activeChatOtherUserId === userId) updatePresenceLabel();
}

function updatePresenceLabel() {
  const el = $('#presence-label');
  if (!activeChatOtherUserId) { el.textContent = ''; return; }
  if (onlineUserIds.has(activeChatOtherUserId)) {
    el.textContent = 'в сети';
  } else if (lastKnownLastSeen) {
    el.textContent = formatLastSeen(lastKnownLastSeen);
  } else {
    el.textContent = '';
  }
}

function formatLastSeen(ts) {
  if (!ts) return 'давно не в сети';
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'был(а) в сети только что';
  if (diffMin < 60) return `был(а) в сети ${diffMin} мин назад`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `был(а) в сети ${diffHours} ч назад`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'был(а) в сети вчера';
  if (diffDays < 7) return `был(а) в сети ${diffDays} дн назад`;
  return 'давно не в сети';
}
let lastKnownLastSeen = null;

$('#back-btn').onclick = () => {
  $('#app-screen').classList.remove('chat-open');
};

$('#chat-header-info').onclick = async () => {
  if (activeChatObj && activeChatObj.type === 'group') {
    openGroupInfo();
    return;
  }
  if (!activeChatOtherUserId) return;
  const user = await api(`/api/users/${activeChatOtherUserId}`);
  $('#profile-name').textContent = user.display_name || user.username;
  $('#profile-username').textContent = '@' + user.username;
  setAvatarEl($('#profile-avatar'), user);
  $('#profile-presence').textContent = onlineUserIds.has(user.id) ? 'в сети' : formatLastSeen(user.last_seen);
  $('#profile-modal').classList.remove('hidden');
};
$('#close-profile-btn').onclick = () => $('#profile-modal').classList.add('hidden');
$('#close-group-info-btn').onclick = () => $('#group-info-modal').classList.add('hidden');

async function openGroupInfo() {
  const members = await api(`/api/chats/${activeChatId}/members`);
  $('#group-info-title-input').value = activeChatObj.title;
  $('#group-info-count').textContent = `${members.length} участник(ов)`;
  setAvatarEl($('#group-info-avatar'), { username: activeChatObj.title, avatar: activeChatObj.avatar });
  if (!activeChatObj.avatar) $('#group-info-avatar').textContent = '👥';
  renderGroupMembers(members);
  $('#group-add-user-search').value = '';
  $('#group-add-user-results').innerHTML = '';
  $('#group-info-modal').classList.remove('hidden');
}

function renderGroupMembers(members) {
  const list = $('#group-members-list');
  list.innerHTML = '';
  members.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const isMe = m.id === me.id;
    row.innerHTML = `
      <span class="avatar-circle"></span>
      <span>${escapeHtml((m.display_name || m.username) + (isMe ? ' (вы)' : ''))}</span>
      ${!isMe ? '<button type="button" class="remove-member-btn" title="Убрать из группы">✕</button>' : ''}`;
    setAvatarEl(row.querySelector('.avatar-circle'), m);
    if (!isMe) {
      row.querySelector('.remove-member-btn').onclick = async () => {
        if (!confirm(`Убрать ${m.display_name || m.username} из группы?`)) return;
        await api(`/api/chats/${activeChatId}/members/${m.id}`, { method: 'DELETE' });
        openGroupInfo();
      };
    }
    list.appendChild(row);
  });
}

$('#group-info-title-input').addEventListener('change', async (e) => {
  const title = e.target.value.trim();
  if (!title) return;
  await api(`/api/chats/${activeChatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  await loadChats();
});

$('#group-avatar-input').addEventListener('change', async () => {
  const file = $('#group-avatar-input').files[0];
  if (!file) return;
  try {
    const url = await uploadFile(file);
    await api(`/api/chats/${activeChatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: url }),
    });
    await loadChats();
    setAvatarEl($('#group-info-avatar'), { username: activeChatObj.title, avatar: url });
  } catch (err) {
    showToast(err.message || 'Не удалось загрузить фото');
  }
});

let groupAddSearchTimeout;
$('#group-add-user-search').addEventListener('input', (e) => {
  clearTimeout(groupAddSearchTimeout);
  groupAddSearchTimeout = setTimeout(async () => {
    const results = await api(`/api/users?search=${encodeURIComponent(e.target.value)}`);
    const box = $('#group-add-user-results');
    box.innerHTML = '';
    results.forEach((u) => {
      const div = document.createElement('div');
      div.className = 'user-result-item';
      div.textContent = u.display_name || u.username;
      div.onclick = async () => {
        await api(`/api/chats/${activeChatId}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberIds: [u.id] }),
        });
        $('#group-add-user-search').value = '';
        box.innerHTML = '';
        openGroupInfo();
      };
      box.appendChild(div);
    });
  }, 300);
});

$('#leave-group-btn').onclick = async () => {
  if (!confirm('Покинуть группу? Вернуться сможет только тот, кто добавит тебя заново.')) return;
  await api(`/api/chats/${activeChatId}/members/${me.id}`, { method: 'DELETE' });
  $('#group-info-modal').classList.add('hidden');
  activeChatId = null;
  activeChatObj = null;
  $('#app-screen').classList.remove('chat-open');
  $('#active-chat').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  await loadChats();
};

// ---------- МЕНЮ НАСТРОЕК ЧАТА ----------
$('#chat-menu-btn').onclick = (e) => {
  e.stopPropagation();
  if (activeChatObj) {
    $('#mute-chat-btn').textContent = activeChatObj.muted ? '🔔 Включить уведомления' : '🔕 Отключить уведомления';
  }
  $('#chat-menu').classList.toggle('hidden');
};
$('#chat-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#chat-menu').classList.add('hidden'));

$('#mute-chat-btn').onclick = async () => {
  if (!activeChatId || !activeChatObj) return;
  $('#chat-menu').classList.add('hidden');
  const newMuted = !activeChatObj.muted;
  await api(`/api/chats/${activeChatId}/mute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: newMuted }),
  });
  activeChatObj.muted = newMuted;
  showToast(newMuted ? 'Уведомления для этого чата отключены' : 'Уведомления включены');
  loadChats();
};

$('#clear-history-btn').onclick = async () => {
  if (!activeChatId) return;
  $('#chat-menu').classList.add('hidden');
  if (!confirm('Удалить всю переписку в этом чате? Это затронет обе стороны и необратимо.')) return;
  await api(`/api/chats/${activeChatId}/messages`, { method: 'DELETE' });
  $('#messages').innerHTML = '';
};

// ---------- ФОН ЧАТА (хранится локально на устройстве, свой для каждого чата) ----------
const WALLPAPER_PRESETS = [
  { id: 'default', label: 'По умолчанию', css: null },
  { id: 'sunset', css: 'linear-gradient(160deg, #ff9a76, #ff6b81)' },
  { id: 'ocean', css: 'linear-gradient(160deg, #36d1dc, #5b86e5)' },
  { id: 'mint', css: 'linear-gradient(160deg, #a8ff78, #78ffd6)' },
  { id: 'violet', css: 'linear-gradient(160deg, #a18cd1, #fbc2eb)' },
  { id: 'night', css: 'linear-gradient(160deg, #232526, #414345)' },
  { id: 'peach', css: 'linear-gradient(160deg, #ffecd2, #fcb69f)' },
  { id: 'slate', css: 'linear-gradient(160deg, #485563, #29323c)' },
];

function getWallpaper(chatId) {
  try { return JSON.parse(localStorage.getItem(`wallpaper:${chatId}`)); } catch { return null; }
}
function setWallpaper(chatId, value) {
  if (value) localStorage.setItem(`wallpaper:${chatId}`, JSON.stringify(value));
  else localStorage.removeItem(`wallpaper:${chatId}`);
}
function applyWallpaper(chatId) {
  const wp = getWallpaper(chatId);
  const box = $('#messages');
  if (!wp) {
    box.style.background = '';
    box.style.backgroundSize = '';
  } else if (wp.type === 'image') {
    box.style.background = `url(${wp.value}) center/cover no-repeat`;
  } else {
    box.style.background = wp.value;
    box.style.backgroundSize = 'cover';
  }
}

$('#wallpaper-btn').onclick = () => {
  $('#chat-menu').classList.add('hidden');
  const current = getWallpaper(activeChatId);
  const box = $('#wallpaper-presets');
  box.innerHTML = '';
  WALLPAPER_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wallpaper-swatch';
    btn.style.background = p.css || 'var(--bg)';
    if ((!current && p.id === 'default') || (current && current.value === p.css)) btn.classList.add('selected');
    btn.onclick = () => {
      setWallpaper(activeChatId, p.css ? { type: 'color', value: p.css } : null);
      applyWallpaper(activeChatId);
      $('#wallpaper-modal').classList.add('hidden');
    };
    box.appendChild(btn);
  });
  $('#wallpaper-modal').classList.remove('hidden');
};
$('#close-wallpaper-btn').onclick = () => $('#wallpaper-modal').classList.add('hidden');
$('#wallpaper-reset-btn').onclick = () => {
  setWallpaper(activeChatId, null);
  applyWallpaper(activeChatId);
  $('#wallpaper-modal').classList.add('hidden');
};
$('#wallpaper-upload-input').addEventListener('change', async () => {
  const file = $('#wallpaper-upload-input').files[0];
  if (!file) return;
  try {
    const url = await uploadFile(file);
    setWallpaper(activeChatId, { type: 'image', value: url });
    applyWallpaper(activeChatId);
    $('#wallpaper-modal').classList.add('hidden');
  } catch (err) {
    showToast(err.message || 'Не удалось загрузить фото');
  }
});

// ---------- ПЕРЕСЫЛКА СООБЩЕНИЯ ----------
function openForwardModal(msg) {
  const list = $('#forward-chat-list');
  list.innerHTML = '';
  chats.forEach((chat) => {
    const div = document.createElement('div');
    div.className = 'user-result-item';
    div.textContent = chat.title || 'Чат';
    div.onclick = () => {
      let payload = { chatId: chat.id, content: msg.content, type: undefined, mediaUrl: msg.media_url };
      if (msg.type === 'video') payload.type = 'video';
      else if (msg.type === 'voice') payload.type = 'voice';
      else if (msg.type === 'location') {
        try {
          const { lat, lng } = JSON.parse(msg.content);
          payload = { chatId: chat.id, type: 'location', lat, lng };
        } catch { /* пропускаем битые данные геолокации */ }
      }
      socket.emit('message:send', payload);
      $('#forward-modal').classList.add('hidden');
      showToast('Переслано');
    };
    list.appendChild(div);
  });
  $('#forward-modal').classList.remove('hidden');
}
$('#close-forward-btn').onclick = () => $('#forward-modal').classList.add('hidden');

// ---------- ПОИСК ПО ЧАТУ ----------
let searchMatches = [];
let searchMatchIndex = -1;

$('#search-in-chat-btn').onclick = () => {
  $('#chat-menu').classList.add('hidden');
  $('#chat-search-bar').classList.remove('hidden');
  $('#chat-search-input').value = '';
  $('#chat-search-count').textContent = '';
  $('#chat-search-input').focus();
};

$('#chat-search-close').onclick = () => {
  $('#chat-search-bar').classList.add('hidden');
  clearSearchHighlights();
  searchMatches = [];
  searchMatchIndex = -1;
};

$('#chat-search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  clearSearchHighlights();
  if (!q) {
    searchMatches = [];
    $('#chat-search-count').textContent = '';
    return;
  }
  searchMatches = [];
  messagesById.forEach((msg, id) => {
    if (!msg.deleted && msg.content && msg.content.toLowerCase().includes(q)) searchMatches.push(id);
  });
  searchMatchIndex = searchMatches.length ? 0 : -1;
  updateSearchUI();
});

$('#chat-search-next').onclick = () => {
  if (searchMatches.length === 0) return;
  searchMatchIndex = (searchMatchIndex + 1) % searchMatches.length;
  updateSearchUI();
};
$('#chat-search-prev').onclick = () => {
  if (searchMatches.length === 0) return;
  searchMatchIndex = (searchMatchIndex - 1 + searchMatches.length) % searchMatches.length;
  updateSearchUI();
};

function updateSearchUI() {
  clearSearchHighlights();
  if (searchMatches.length === 0) {
    $('#chat-search-count').textContent = 'Нет совпадений';
    return;
  }
  $('#chat-search-count').textContent = `${searchMatchIndex + 1} из ${searchMatches.length}`;
  const id = searchMatches[searchMatchIndex];
  const row = document.querySelector(`[data-message-id="${id}"]`);
  if (row) {
    row.classList.add('search-highlight');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function clearSearchHighlights() {
  document.querySelectorAll('.msg-row.search-highlight').forEach((r) => r.classList.remove('search-highlight'));
}

// ---------- ПАНЕЛЬ ЭМОДЗИ ----------
const EMOJI_LIST = [
  '😀','😂','🥰','😍','😊','😉','😎','🤔','😢','😭',
  '😡','😱','🥳','😴','🤒','👍','👎','🙏','👏','💪',
  '❤️','💔','🔥','⭐','🎉','✅','❌','😅','😘','🤗',
  '🙄','😬','🤝','👋','🍕','☕','🎂','🌞','🌧️','❄️',
];
const emojiPanel = $('#emoji-panel');
EMOJI_LIST.forEach((emoji) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.onclick = (e) => {
    e.stopPropagation();
    const input = $('#message-input');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
  };
  emojiPanel.appendChild(btn);
});

$('#emoji-toggle-btn').onclick = (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle('hidden');
};
emojiPanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => emojiPanel.classList.add('hidden'));

// ---------- SEND MESSAGE ----------
let pendingAttachment = null; // { file, kind: 'image' | 'video' }

$('#message-form').onsubmit = (e) => {
  e.preventDefault();
  if (sendBtnMode === 'send') sendCurrentMessage();
};

async function sendCurrentMessage() {
  if (!activeChatId) return;
  const input = $('#message-input');
  const content = input.value.trim();

  if (editingMessageId) {
    if (!content) return;
    await api(`/api/messages/${editingMessageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    editingMessageId = null;
    input.value = '';
    $('#reply-preview').classList.add('hidden');
    updateSendButtonMode();
    return;
  }

  let mediaUrl = null;
  let sendType = null;
  if (pendingAttachment) {
    try {
      mediaUrl = await uploadFile(pendingAttachment.file);
    } catch (err) {
      alert(err.message || 'Не удалось загрузить файл');
      return;
    }
    sendType = pendingAttachment.kind === 'video' ? 'video' : undefined;
    clearAttachmentPreview();
  }

  if (!content && !mediaUrl) return;
  socket.emit('message:send', { chatId: activeChatId, content, mediaUrl, type: sendType, replyTo: replyingToId });
  input.value = '';
  replyingToId = null;
  $('#reply-preview').classList.add('hidden');
  updateSendButtonMode();
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Ошибка загрузки файла');
  return data.url;
}

// ---------- УМНАЯ КНОПКА: МИКРОФОН ⇄ ОТПРАВИТЬ (как в Telegram) ----------
let sendBtnMode = 'mic';
function updateSendButtonMode() {
  const hasContent = $('#message-input').value.trim().length > 0 || !!pendingAttachment;
  sendBtnMode = hasContent ? 'send' : 'mic';
  const btn = $('#send-or-mic-btn');
  btn.textContent = hasContent ? '➤' : '🎤';
  btn.title = hasContent ? 'Отправить' : 'Голосовое сообщение';
}

$('#send-or-mic-btn').onclick = () => {
  if (sendBtnMode === 'send') sendCurrentMessage();
  else startVoiceRecording();
};

$('#message-input').addEventListener('input', () => {
  if (activeChatId) socket.emit('typing', { chatId: activeChatId });
  updateSendButtonMode();
});

// ---------- МЕНЮ ВЛОЖЕНИЙ (фото + геолокация спрятаны за "+") ----------
$('#attach-toggle-btn').onclick = (e) => {
  e.stopPropagation();
  $('#attach-menu').classList.toggle('hidden');
};
document.addEventListener('click', () => $('#attach-menu').classList.add('hidden'));
$('#attach-menu').addEventListener('click', (e) => e.stopPropagation());

$('#file-input').addEventListener('change', () => {
  $('#attach-menu').classList.add('hidden');
  const file = $('#file-input').files[0];
  if (!file) return;
  pendingAttachment = { file, kind: 'image' };
  $('#attachment-preview-video').hidden = true;
  $('#attachment-preview-img').hidden = false;
  $('#attachment-preview-img').src = URL.createObjectURL(file);
  $('#attachment-preview').classList.remove('hidden');
  updateSendButtonMode();
});

$('#video-input').addEventListener('change', () => {
  $('#attach-menu').classList.add('hidden');
  const file = $('#video-input').files[0];
  if (!file) return;
  pendingAttachment = { file, kind: 'video' };
  $('#attachment-preview-img').hidden = true;
  $('#attachment-preview-video').hidden = false;
  $('#attachment-preview-video').src = URL.createObjectURL(file);
  $('#attachment-preview').classList.remove('hidden');
  updateSendButtonMode();
});

$('#remove-attachment-btn').onclick = () => clearAttachmentPreview();
function clearAttachmentPreview() {
  pendingAttachment = null;
  $('#file-input').value = '';
  $('#video-input').value = '';
  $('#attachment-preview-img').src = '';
  $('#attachment-preview-video').src = '';
  $('#attachment-preview').classList.add('hidden');
  updateSendButtonMode();
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const NON_MENU_TARGETS = 'img, a, audio, video, iframe, .reaction-pill, source, .select-checkbox, .voice-play-btn, .voice-progress';

let lastTouchHandledAt = 0;

// ---- Клик мышью (десктоп, без тачскрина) ----
$('#messages').addEventListener('click', (e) => {
  if (Date.now() - lastTouchHandledAt < 600) return; // уже обработано через touch ниже
  const row = e.target.closest('.msg-row');
  if (selectionMode) {
    if (row) toggleMessageSelected(row.dataset.messageId);
    return;
  }
  const reactionPill = e.target.closest('.reaction-pill');
  if (reactionPill) {
    socket.emit('reaction:toggle', { messageId: row.dataset.messageId, emoji: reactionPill.dataset.emoji });
    return;
  }
  if (e.target.tagName === 'IMG' && e.target.closest('.bubble')) {
    $('#lightbox-img').src = e.target.src;
    $('#image-lightbox').classList.remove('hidden');
  }
});
// Долгое нажатие мышью (десктоп) — через задержку на mousedown
let mouseLongPressTimer = null;
$('#messages').addEventListener('mousedown', (e) => {
  if (selectionMode) return;
  const row = e.target.closest('.msg-row');
  if (!row || e.target.closest(NON_MENU_TARGETS)) return;
  mouseLongPressTimer = setTimeout(() => openMessageMenu(row.dataset.messageId), 480);
});
['mouseup', 'mouseleave'].forEach((ev) => $('#messages').addEventListener(ev, () => clearTimeout(mouseLongPressTimer)));

$('#image-lightbox').addEventListener('click', () => $('#image-lightbox').classList.add('hidden'));

// ---- Телефон: зажатие = меню, свайп влево = ответить, свайп вправо = назад, тап (в режиме выбора) = выделить ----
let touchStartX = 0, touchStartY = 0, touchCurrentX = 0, touchCurrentY = 0;
let swipingRow = null, isHorizontalSwipe = false, longPressTimer = null, longPressTriggered = false;

$('#messages').addEventListener('touchstart', (e) => {
  const row = e.target.closest('.msg-row');
  touchStartX = touchCurrentX = e.touches[0].clientX;
  touchStartY = touchCurrentY = e.touches[0].clientY;
  swipingRow = row;
  isHorizontalSwipe = false;
  longPressTriggered = false;
  clearTimeout(longPressTimer);

  if (row && !selectionMode && !e.target.closest(NON_MENU_TARGETS)) {
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      if (navigator.vibrate) navigator.vibrate(12);
      openMessageMenu(row.dataset.messageId);
    }, 480);
  }
}, { passive: true });

$('#messages').addEventListener('touchmove', (e) => {
  touchCurrentX = e.touches[0].clientX;
  touchCurrentY = e.touches[0].clientY;
  const deltaX = touchCurrentX - touchStartX;
  const deltaY = touchCurrentY - touchStartY;

  if (Math.hypot(deltaX, deltaY) > 10) clearTimeout(longPressTimer);

  if (!isHorizontalSwipe && Math.abs(deltaX) > 15 && Math.abs(deltaX) > Math.abs(deltaY) * 1.8) {
    isHorizontalSwipe = true;
  }
  if (isHorizontalSwipe && swipingRow && !selectionMode && deltaX < 0) {
    const bubble = swipingRow.querySelector('.bubble');
    const clamped = Math.max(deltaX, -80);
    bubble.style.transform = `translateX(${clamped}px)`;
    swipingRow.classList.toggle('swipe-armed', clamped <= -45);
  }
}, { passive: true });

$('#messages').addEventListener('touchend', (e) => {
  clearTimeout(longPressTimer);
  lastTouchHandledAt = Date.now();
  const deltaX = touchCurrentX - touchStartX;
  const deltaY = touchCurrentY - touchStartY;
  const totalMovement = Math.hypot(deltaX, deltaY);

  if (swipingRow) {
    const bubble = swipingRow.querySelector('.bubble');
    bubble.style.transform = '';
    swipingRow.classList.remove('swipe-armed');
  }

  if (longPressTriggered) {
    // меню уже открыто по долгому нажатию
  } else if (isHorizontalSwipe && deltaX <= -45 && swipingRow && !selectionMode) {
    startReply(swipingRow.dataset.messageId);
  } else if (isHorizontalSwipe && deltaX >= 80 && !selectionMode) {
    if ($('#app-screen').classList.contains('chat-open')) $('#back-btn').click();
  } else if (totalMovement < 10 && swipingRow) {
    const touch = e.changedTouches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (selectionMode) {
      toggleMessageSelected(swipingRow.dataset.messageId);
    } else if (target) {
      const reactionPill = target.closest('.reaction-pill');
      if (reactionPill) {
        socket.emit('reaction:toggle', { messageId: swipingRow.dataset.messageId, emoji: reactionPill.dataset.emoji });
      } else if (target.tagName === 'IMG' && target.closest('.bubble')) {
        $('#lightbox-img').src = target.src;
        $('#image-lightbox').classList.remove('hidden');
      }
      // обычный короткий тап по остальному содержимому теперь ничего не делает — как в Telegram
    }
  }
  swipingRow = null;
  isHorizontalSwipe = false;
  longPressTriggered = false;
});

// ---- Множественный выбор сообщений ----
let selectionMode = false;
const selectedMessageIds = new Set();

function enterSelectionMode(initialId) {
  selectionMode = true;
  selectedMessageIds.clear();
  if (initialId) selectedMessageIds.add(initialId);
  $('#messages').classList.add('selection-mode');
  $('#chat-header').classList.add('hidden');
  $('#selection-bar').classList.remove('hidden');
  refreshSelectionCheckboxes();
  updateSelectionCount();
}
function exitSelectionMode() {
  selectionMode = false;
  selectedMessageIds.clear();
  $('#messages').classList.remove('selection-mode');
  $('#chat-header').classList.remove('hidden');
  $('#selection-bar').classList.add('hidden');
  refreshSelectionCheckboxes();
}
function toggleMessageSelected(id) {
  if (selectedMessageIds.has(id)) selectedMessageIds.delete(id);
  else selectedMessageIds.add(id);
  if (selectedMessageIds.size === 0) { exitSelectionMode(); return; }
  updateSelectionCount();
  refreshSelectionCheckboxes();
}
function updateSelectionCount() {
  $('#selection-count').textContent = `Выбрано ${selectedMessageIds.size}`;
}
function refreshSelectionCheckboxes() {
  document.querySelectorAll('#messages .select-checkbox').forEach((cb) => {
    const id = cb.closest('.msg-row')?.dataset.messageId;
    const checked = selectedMessageIds.has(id);
    cb.classList.toggle('checked', checked);
    cb.textContent = checked ? '✓' : '';
  });
}
$('#selection-cancel-btn').onclick = exitSelectionMode;
$('#selection-delete-btn').onclick = async () => {
  if (selectedMessageIds.size === 0) return;
  if (!confirm(`Удалить ${selectedMessageIds.size} сообщени(й)?`)) return;
  const ids = Array.from(selectedMessageIds);
  exitSelectionMode();
  for (const id of ids) {
    await api(`/api/messages/${id}`, { method: 'DELETE' }).catch(() => {});
  }
};


// ---- Меню действий с сообщением (реакции + список действий + статус) ----
function openMessageMenu(messageId) {
  const msg = messagesById.get(messageId);
  if (!msg || msg.deleted) return;
  const isOut = msg.sender_id === me.id;

  const reactBox = $('#message-menu-reactions');
  reactBox.innerHTML = REACTION_EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join('');
  reactBox.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('reaction:toggle', { messageId, emoji: btn.dataset.emoji });
      closeMessageMenu();
    };
  });

  const actions = [{ label: '↩ Ответить', run: () => startReply(messageId) }];
  const isPinned = activeChatObj?.pinned_message_id === messageId;
  actions.push({
    label: isPinned ? '📌 Открепить' : '📌 Закрепить',
    run: () => isPinned ? unpinMessage() : pinMessage(messageId),
  });
  if (msg.type !== 'missed_call') {
    actions.push({ label: '➡️ Переслать', run: () => openForwardModal(msg) });
  }
  if (msg.type === 'text' && msg.content) {
    actions.push({ label: '📋 Копировать текст', run: () => {
      navigator.clipboard?.writeText(msg.content);
      showToast('Текст скопирован');
    } });
  }
  if (isOut && msg.type === 'text') {
    actions.push({ label: '✏️ Изменить', run: () => startEdit(messageId) });
  }
  if (isOut) {
    actions.push({ label: '🗑 Удалить', run: async () => {
      if (confirm('Удалить это сообщение?')) await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    } });
  }
  actions.push({ label: '☑️ Выделить', run: () => enterSelectionMode(messageId) });
  const actionsBox = $('#message-menu-actions');
  actionsBox.innerHTML = '';
  actions.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attach-menu-item';
    btn.textContent = a.label;
    btn.onclick = () => { closeMessageMenu(); a.run(); };
    actionsBox.appendChild(btn);
  });

  const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('#message-menu-status').textContent = isOut
    ? `Отправлено в ${time} · ${msg.is_read ? 'Прочитано' : 'Не прочитано'}`
    : `Получено в ${time}`;

  $('#message-menu').classList.remove('hidden');
}
function closeMessageMenu() {
  $('#message-menu').classList.add('hidden');
}
$('#message-menu-cancel').onclick = closeMessageMenu;
$('#message-menu').addEventListener('click', (e) => { if (e.target.id === 'message-menu') closeMessageMenu(); });

function startReply(messageId) {
  cancelEdit();
  const msg = messagesById.get(messageId);
  if (!msg) return;
  replyingToId = messageId;
  const isMe = msg.sender_id === me.id;
  $('#reply-preview-sender').textContent = isMe ? 'Вы' : (msg.sender_name || '');
  $('#reply-preview-text').textContent = replyPreviewText(msg);
  $('#reply-preview').classList.remove('hidden');
  $('#message-input').focus();
}
$('#cancel-reply-btn').onclick = () => {
  replyingToId = null;
  if (editingMessageId) {
    editingMessageId = null;
    $('#message-input').value = '';
    updateSendButtonMode();
  }
  $('#reply-preview').classList.add('hidden');
};

// ---------- РЕДАКТИРОВАНИЕ СВОЕГО СООБЩЕНИЯ ----------
let editingMessageId = null;
function startEdit(messageId) {
  cancelReplyOnly();
  const msg = messagesById.get(messageId);
  if (!msg || msg.type !== 'text') return;
  editingMessageId = messageId;
  $('#reply-preview-sender').textContent = 'Редактирование';
  $('#reply-preview-text').textContent = msg.content || '';
  $('#reply-preview').classList.remove('hidden');
  $('#message-input').value = msg.content || '';
  updateSendButtonMode();
  $('#message-input').focus();
}
function cancelEdit() {
  if (editingMessageId) {
    editingMessageId = null;
    $('#message-input').value = '';
    updateSendButtonMode();
  }
  $('#reply-preview').classList.add('hidden');
}
function cancelReplyOnly() {
  replyingToId = null;
}

// ---------- NEW CHAT MODAL ----------
$('#new-chat-btn').onclick = () => {
  $('#new-chat-modal').classList.remove('hidden');
  $('#user-search').value = '';
  $('#user-results').innerHTML = '';
  switchNewChatTab('private');
  $('#user-search').focus();
};
$('#close-modal-btn').onclick = () => $('#new-chat-modal').classList.add('hidden');

function switchNewChatTab(tab) {
  $('#new-chat-tab-private').classList.toggle('active', tab === 'private');
  $('#new-chat-tab-group').classList.toggle('active', tab === 'group');
  $('#private-chat-section').classList.toggle('hidden', tab !== 'private');
  $('#group-chat-section').classList.toggle('hidden', tab !== 'group');
}
$('#new-chat-tab-private').onclick = () => switchNewChatTab('private');
$('#new-chat-tab-group').onclick = () => {
  switchNewChatTab('group');
  $('#group-name-input').value = '';
  $('#group-user-search').value = '';
  $('#group-user-results').innerHTML = '';
  groupSelectedUsers.clear();
  renderGroupChips();
};

let searchTimeout;
$('#user-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const results = await api(`/api/users?search=${encodeURIComponent(e.target.value)}`);
    const box = $('#user-results');
    box.innerHTML = '';
    results.forEach((u) => {
      const div = document.createElement('div');
      div.className = 'user-result-item';
      div.textContent = u.display_name || u.username;
      div.onclick = async () => {
        const { id } = await api('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'private', memberIds: [u.id] }),
        });
        $('#new-chat-modal').classList.add('hidden');
        await loadChats();
        openChat(id);
      };
      box.appendChild(div);
    });
  }, 300);
});

// ---------- СОЗДАНИЕ ГРУППЫ ----------
const groupSelectedUsers = new Map(); // id -> {id, username, display_name}

function renderGroupChips() {
  const box = $('#group-selected-chips');
  box.innerHTML = '';
  groupSelectedUsers.forEach((u) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(u.display_name || u.username)} <button type="button">✕</button>`;
    chip.querySelector('button').onclick = () => {
      groupSelectedUsers.delete(u.id);
      renderGroupChips();
      updateCreateGroupBtn();
    };
    box.appendChild(chip);
  });
}

function updateCreateGroupBtn() {
  const nameOk = $('#group-name-input').value.trim().length > 0;
  $('#create-group-btn').disabled = !(nameOk && groupSelectedUsers.size > 0);
}
$('#group-name-input').addEventListener('input', updateCreateGroupBtn);

let groupSearchTimeout;
$('#group-user-search').addEventListener('input', (e) => {
  clearTimeout(groupSearchTimeout);
  groupSearchTimeout = setTimeout(async () => {
    const results = await api(`/api/users?search=${encodeURIComponent(e.target.value)}`);
    const box = $('#group-user-results');
    box.innerHTML = '';
    results
      .filter((u) => !groupSelectedUsers.has(u.id))
      .forEach((u) => {
        const div = document.createElement('div');
        div.className = 'user-result-item';
        div.textContent = u.display_name || u.username;
        div.onclick = () => {
          groupSelectedUsers.set(u.id, u);
          renderGroupChips();
          updateCreateGroupBtn();
          box.innerHTML = '';
          $('#group-user-search').value = '';
        };
        box.appendChild(div);
      });
  }, 300);
});

$('#create-group-btn').onclick = async () => {
  const title = $('#group-name-input').value.trim();
  const memberIds = Array.from(groupSelectedUsers.keys());
  if (!title || memberIds.length === 0) return;
  const { id } = await api('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'group', title, memberIds }),
  });
  $('#new-chat-modal').classList.add('hidden');
  await loadChats();
  openChat(id);
};

// ========== АУДИОЗВОНКИ (WebRTC) ==========
let pc = null;
let localStream = null;
let currentCallPeerId = null;
let currentCallChatId = null;
let pendingOffer = null;
let ringingTimeout = null;
let cachedIceServers = null;

async function getIceServers() {
  if (cachedIceServers) return cachedIceServers;
  try {
    const { iceServers } = await api('/api/ice-servers');
    cachedIceServers = (iceServers && iceServers.length) ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
  } catch {
    cachedIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  return cachedIceServers;
}

// ---- Гудки (генерируются на лету, без аудиофайлов) ----
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// "Прогреваем" звук по первому тапу в приложении — иначе браузер может
// заблокировать автоматическое воспроизведение гудков по входящему звонку.
document.addEventListener('click', function warmupAudio() {
  getAudioCtx();
  document.removeEventListener('click', warmupAudio);
}, { once: true });

function beep(freq, duration, volume = 0.15) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.value = volume;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

let ringbackInterval = null;
function startRingback() {
  stopRingback();
  beep(425, 1);
  ringbackInterval = setInterval(() => beep(425, 1), 3000);
}
function stopRingback() {
  if (ringbackInterval) { clearInterval(ringbackInterval); ringbackInterval = null; }
}

let ringtoneInterval = null;
function startRingtone() {
  stopRingtone();
  const pattern = () => { beep(600, 0.3); setTimeout(() => beep(740, 0.3), 350); };
  pattern();
  ringtoneInterval = setInterval(pattern, 2000);
}
function stopRingtone() {
  if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
}

// ---- Небольшое всплывающее уведомление вместо alert() ----
function showToast(text) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2800);
}

function sendMissedCallMessage() {
  if (!currentCallChatId) return;
  socket.emit('message:send', { chatId: currentCallChatId, type: 'missed_call' });
}

function attachCallSocketHandlers() {
  socket.on('call:offer', ({ fromUserId, fromUsername, chatId, sdp }) => {
    if (currentCallPeerId) return;
    pendingOffer = { fromUserId, fromUsername, chatId, sdp };
    currentCallChatId = chatId;
    $('#incoming-call-name').textContent = `Звонок от ${fromUsername}`;
    $('#incoming-call-modal').classList.remove('hidden');
    startRingtone();
  });

  socket.on('call:answer', async ({ sdp }) => {
    if (!pc) return;
    clearTimeout(ringingTimeout);
    stopRingback();
    await pc.setRemoteDescription(sdp);
    showActiveCallBar();
  });

  socket.on('call:ice-candidate', async ({ candidate }) => {
    if (!pc) return;
    try { await pc.addIceCandidate(candidate); } catch (e) { /* ignore */ }
  });

  socket.on('call:end', () => {
    endCallCleanup();
  });

  socket.on('call:unavailable', () => {
    showToast('Собеседник сейчас не в сети — отметил звонок как пропущенный');
    sendMissedCallMessage();
    endCallCleanup();
  });
}

async function createPeerConnection(peerId) {
  const iceServers = await getIceServers();
  const conn = new RTCPeerConnection({ iceServers });
  conn.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call:ice-candidate', { toUserId: peerId, candidate: e.candidate });
  };
  conn.ontrack = (e) => {
    $('#remote-audio').srcObject = e.streams[0];
  };
  return conn;
}

$('#call-btn').onclick = async () => {
  if (!activeChatOtherUserId || currentCallPeerId) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showToast('Нет доступа к микрофону — разреши доступ в настройках браузера');
    return;
  }
  currentCallPeerId = activeChatOtherUserId;
  currentCallChatId = activeChatId;
  pc = await createPeerConnection(currentCallPeerId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:offer', { toUserId: currentCallPeerId, chatId: activeChatId, sdp: offer });
  $('#active-call-name').textContent = 'Вызов...';
  $('#active-call-bar').classList.remove('hidden');
  startRingback();

  ringingTimeout = setTimeout(() => {
    stopRingback();
    if (currentCallPeerId) socket.emit('call:end', { toUserId: currentCallPeerId });
    sendMissedCallMessage();
    showToast('Абонент не отвечает');
    endCallCleanup();
  }, 10000);
};

$('#accept-call-btn').onclick = async () => {
  if (!pendingOffer) return;
  const { fromUserId, fromUsername, sdp } = pendingOffer;
  stopRingtone();
  $('#incoming-call-modal').classList.add('hidden');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showToast('Нет доступа к микрофону — разреши доступ в настройках браузера');
    socket.emit('call:end', { toUserId: fromUserId });
    pendingOffer = null;
    return;
  }
  currentCallPeerId = fromUserId;
  pc = await createPeerConnection(currentCallPeerId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call:answer', { toUserId: fromUserId, sdp: answer });
  pendingOffer = null;
  $('#active-call-name').textContent = fromUsername;
  showActiveCallBar();
};

$('#decline-call-btn').onclick = () => {
  stopRingtone();
  if (pendingOffer) socket.emit('call:end', { toUserId: pendingOffer.fromUserId });
  pendingOffer = null;
  $('#incoming-call-modal').classList.add('hidden');
};

$('#hangup-call-btn').onclick = () => {
  if (currentCallPeerId) socket.emit('call:end', { toUserId: currentCallPeerId });
  endCallCleanup();
};

let micMuted = false;
$('#mute-call-btn').onclick = () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  $('#mute-call-btn').textContent = micMuted ? '🔇' : '🎙️';
};

function showActiveCallBar() {
  $('#active-call-bar').classList.remove('hidden');
}

function endCallCleanup() {
  clearTimeout(ringingTimeout);
  ringingTimeout = null;
  stopRingback();
  stopRingtone();
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  currentCallPeerId = null;
  currentCallChatId = null;
  pendingOffer = null;
  micMuted = false;
  $('#mute-call-btn').textContent = '🎙️';
  $('#active-call-bar').classList.add('hidden');
  $('#incoming-call-modal').classList.add('hidden');
}

// ========== PUSH-УВЕДОМЛЕНИЯ ==========
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const { publicKey } = await api('/api/push/vapid-public-key');

    // Всегда пересоздаём подписку начисто — если ключи на сервере вдруг
    // поменялись, старая "залипшая" подписка тихо переставала бы работать.
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
  } catch (e) {
    console.warn('Push setup failed', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderTextWithMentions(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(^|\s)@(\w+)/g, '$1<span class="mention">@$2</span>');
}

// ========== УПОМИНАНИЯ (@username) В ГРУППАХ ==========
$('#message-input').addEventListener('input', (e) => {
  if (!activeChatObj || activeChatObj.type !== 'group' || groupMembersCache.length === 0) {
    $('#mention-suggestions').classList.add('hidden');
    return;
  }
  const input = e.target;
  const cursorPos = input.selectionStart;
  const textBeforeCursor = input.value.slice(0, cursorPos);
  const match = textBeforeCursor.match(/(^|\s)@(\w*)$/);
  if (!match) {
    $('#mention-suggestions').classList.add('hidden');
    return;
  }
  const query = match[2].toLowerCase();
  const matches = groupMembersCache.filter((m) =>
    m.id !== me.id && (m.username.toLowerCase().includes(query) || (m.display_name || '').toLowerCase().includes(query))
  );
  const box = $('#mention-suggestions');
  if (matches.length === 0) {
    box.classList.add('hidden');
    return;
  }
  box.innerHTML = '';
  matches.slice(0, 6).forEach((m) => {
    const div = document.createElement('div');
    div.className = 'user-result-item';
    div.textContent = m.display_name || m.username;
    div.onclick = () => {
      const before = textBeforeCursor.slice(0, match.index) + match[1] + `@${m.username} `;
      const after = input.value.slice(cursorPos);
      input.value = before + after;
      input.focus();
      input.selectionStart = input.selectionEnd = before.length;
      box.classList.add('hidden');
      updateSendButtonMode();
    };
    box.appendChild(div);
  });
  box.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mention-suggestions') && e.target.id !== 'message-input') {
    $('#mention-suggestions').classList.add('hidden');
  }
});

// ========== ПЛЕЕР ГОЛОСОВЫХ СООБЩЕНИЙ ==========
function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

let currentlyPlayingAudio = null;

function setupVoicePlayer(bubble) {
  const btn = bubble.querySelector('.voice-play-btn');
  const progress = bubble.querySelector('.voice-progress');
  const fill = bubble.querySelector('.voice-progress-fill');
  const durationEl = bubble.querySelector('.voice-duration');
  const audio = bubble.querySelector('.voice-audio-el');
  if (!btn || audio.dataset.wired) return;
  audio.dataset.wired = '1';

  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration)) durationEl.textContent = formatDuration(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    durationEl.textContent = formatDuration(audio.duration - audio.currentTime);
  });
  audio.addEventListener('ended', () => {
    btn.textContent = '▶';
    btn.classList.remove('playing');
    fill.style.width = '0%';
    durationEl.textContent = formatDuration(audio.duration);
  });

  btn.onclick = () => {
    if (audio.paused) {
      if (currentlyPlayingAudio && currentlyPlayingAudio !== audio) {
        currentlyPlayingAudio.pause();
        const otherBtn = currentlyPlayingAudio.closest('.voice-bubble')?.querySelector('.voice-play-btn');
        if (otherBtn) { otherBtn.textContent = '▶'; otherBtn.classList.remove('playing'); }
      }
      audio.play();
      currentlyPlayingAudio = audio;
      btn.textContent = '❚❚';
      btn.classList.add('playing');
    } else {
      audio.pause();
      btn.textContent = '▶';
      btn.classList.remove('playing');
    }
  };

  progress.onclick = (e) => {
    if (!audio.duration) return;
    const rect = progress.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * audio.duration;
  };
}

// Подключаем плеер к каждому новому сообщению с голосовым
const messagesObserver = new MutationObserver((mutations) => {
  mutations.forEach((m) => {
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      node.querySelectorAll?.('.voice-bubble').forEach(setupVoicePlayer);
      if (node.classList?.contains('voice-bubble')) setupVoicePlayer(node);
    });
  });
});
messagesObserver.observe($('#messages'), { childList: true, subtree: true });

// ========== ГОЛОСОВЫЕ СООБЩЕНИЯ (запись) ==========
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

async function startVoiceRecording() {
  if (!activeChatId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();

    recordingSeconds = 0;
    $('#recording-time').textContent = '0:00';
    $('#recording-bar').classList.remove('hidden');
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = Math.floor(recordingSeconds / 60);
      const s = String(recordingSeconds % 60).padStart(2, '0');
      $('#recording-time').textContent = `${m}:${s}`;
    }, 1000);
  } catch {
    alert('Нет доступа к микрофону — разреши доступ в настройках браузера.');
  }
}

$('#cancel-recording-btn').onclick = () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(recordingTimer);
  $('#recording-bar').classList.add('hidden');
  recordedChunks = [];
};

$('#stop-recording-btn').onclick = () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  clearInterval(recordingTimer);
  $('#recording-bar').classList.add('hidden');

  mediaRecorder.addEventListener('stop', async () => {
    if (recordedChunks.length === 0) return;
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
    try {
      const mediaUrl = await uploadFile(file);
      socket.emit('message:send', { chatId: activeChatId, type: 'voice', mediaUrl });
    } catch (err) {
      alert(err.message || 'Не удалось отправить голосовое сообщение');
    }
  }, { once: true });

  mediaRecorder.stop();
};

// ========== НАСТРОЙКИ ПРОФИЛЯ ==========
$('#settings-btn').onclick = () => {
  setAvatarEl($('#avatar-preview'), me);
  $('#display-name-input').value = me.display_name || '';
  $('#username-readonly').value = '@' + me.username;
  const savedColor = localStorage.getItem('themeColor') || '#2AABEE';
  document.querySelectorAll('.swatch:not(.custom-swatch)').forEach((el) => {
    el.classList.toggle('selected', el.dataset.color.toLowerCase() === savedColor.toLowerCase());
  });
  $('#dark-mode-toggle').checked = document.body.classList.contains('dark-theme');
  renderSavedThemes();
  $('#settings-modal').classList.remove('hidden');
};
$('#close-settings-btn').onclick = () => $('#settings-modal').classList.add('hidden');

$('#save-name-btn').onclick = async () => {
  const displayName = $('#display-name-input').value.trim();
  const { user } = await api('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  me = user;
  localStorage.setItem('me', JSON.stringify(me));
  renderMyAvatar();
  loadChats();
};

$('#avatar-input').addEventListener('change', async () => {
  const file = $('#avatar-input').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const { url } = await res.json();
  const { user } = await api('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar: url }),
  });
  me = user;
  localStorage.setItem('me', JSON.stringify(me));
  renderMyAvatar();
  setAvatarEl($('#avatar-preview'), me);
  loadChats(); // чтобы новый аватар подтянулся у собеседников при следующем открытии
});

document.querySelectorAll('.swatch:not(.custom-swatch)').forEach((el) => {
  el.onclick = () => {
    applyThemeColor(el.dataset.color);
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
    el.classList.add('selected');
  };
});

$('#custom-color-input').addEventListener('input', (e) => {
  applyThemeColor(e.target.value);
  document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
  $('.custom-swatch')?.classList.add('selected');
});

$('#dark-mode-toggle').addEventListener('change', (e) => {
  document.body.classList.toggle('dark-theme', e.target.checked);
  localStorage.setItem('darkTheme', e.target.checked ? '1' : '0');
});

$('#save-theme-btn').onclick = () => {
  const name = prompt('Название темы:');
  if (!name || !name.trim()) return;
  const themes = getSavedThemes();
  themes.push({
    name: name.trim(),
    color: localStorage.getItem('themeColor') || '#2AABEE',
    dark: document.body.classList.contains('dark-theme'),
  });
  localStorage.setItem('savedThemes', JSON.stringify(themes));
  renderSavedThemes();
  showToast('Тема сохранена');
};

function getSavedThemes() {
  try { return JSON.parse(localStorage.getItem('savedThemes')) || []; } catch { return []; }
}

function renderSavedThemes() {
  const box = $('#saved-themes-list');
  const themes = getSavedThemes();
  box.innerHTML = '';
  if (themes.length === 0) {
    box.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">Пока нет сохранённых тем</span>';
    return;
  }
  themes.forEach((t, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'saved-theme-chip';
    chip.innerHTML = `<span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}${t.dark ? ' 🌙' : ''} <span class="remove-theme">✕</span>`;
    chip.onclick = (e) => {
      if (e.target.classList.contains('remove-theme')) {
        const themes2 = getSavedThemes();
        themes2.splice(i, 1);
        localStorage.setItem('savedThemes', JSON.stringify(themes2));
        renderSavedThemes();
        return;
      }
      applyThemeColor(t.color);
      document.body.classList.toggle('dark-theme', t.dark);
      localStorage.setItem('darkTheme', t.dark ? '1' : '0');
      $('#dark-mode-toggle').checked = t.dark;
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
    };
    box.appendChild(chip);
  });
}

function applyThemeColor(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-dark', shadeColor(hex, -12));
  localStorage.setItem('themeColor', hex);
}

function applySavedTheme() {
  const savedColor = localStorage.getItem('themeColor');
  if (savedColor) applyThemeColor(savedColor);
  if (localStorage.getItem('darkTheme') === '1') document.body.classList.add('dark-theme');
}

function shadeColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  let r = (num >> 16) + Math.round(2.55 * percent);
  let g = ((num >> 8) & 0x00ff) + Math.round(2.55 * percent);
  let b = (num & 0x0000ff) + Math.round(2.55 * percent);
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
