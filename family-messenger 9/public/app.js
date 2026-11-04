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
applySavedTheme();

// ---------- ПЕРЕКЛЮЧАТЕЛЬ ТЁМНОЙ ТЕМЫ НА ЭКРАНЕ ВХОДА ----------
$('#auth-dark-toggle').checked = document.body.classList.contains('dark-theme');
$('#auth-dark-toggle').addEventListener('change', (e) => {
  document.body.classList.toggle('dark-theme', e.target.checked);
  localStorage.setItem('darkTheme', e.target.checked ? '1' : '0');
});

// ---------- AUTH UI ----------
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');

function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#auth-error').textContent = '';
  $('#auth-invite').classList.toggle('hidden', mode !== 'register');
  $('#auth-email').classList.toggle('hidden', mode !== 'register');
}

$('#auth-submit').onclick = async () => {
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  if (!username || !password) return;

  try {
    const res = await fetch(`/api/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authMode === 'register'
        ? { username, password, inviteCode: $('#auth-invite').value.trim(), email: $('#auth-email').value.trim() }
        : { username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('#auth-error').textContent = authErrorText(data);
      return;
    }
    if (data.needs2fa) {
      start2faStep(data);
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
    invalid_input: 'Проверь имя и пароль',
    weak_password: 'Пароль должен быть от 8 символов',
    invalid_username: 'Имя: от 3 до 24 символов — буквы, цифры или _',
    username_taken: 'Это имя уже занято',
    invalid_credentials: 'Неверный логин или пароль',
    invalid_invite: 'Неверный код приглашения',
    registration_closed: 'Регистрация сейчас закрыта',
    too_many_attempts: 'Слишком много попыток. Подожди 15 минут и попробуй снова',
    rate_limited: 'Слишком много запросов, подожди немного',
    invalid_email: 'Некорректный адрес почты',
    wrong_code: 'Неверный код',
    code_expired: 'Код устарел. Вернись назад и войди снова',
    challenge_expired: 'Время вышло. Войди снова',
    too_soon: 'Подожди минуту перед новой отправкой кода',
    too_many_codes: 'Слишком много кодов за час. Попробуй позже',
    send_failed: 'Не удалось отправить код. Попробуй чуть позже',
    '2fa_unavailable': 'Двухфакторная защита сейчас недоступна. Напиши администратору',
    wrong_password: 'Неверный пароль',
    email_not_configured: 'Отправка писем ещё не настроена',
    telegram_not_configured: 'Telegram-бот ещё не настроен',
    email_not_verified: 'Сначала подтверди почту',
    telegram_not_linked: 'Сначала привяжи Telegram',
    method_in_use: 'Этот способ сейчас выбран. Сначала выбери другой или выключи защиту',
    totp_already_enabled: 'Приложение-аутентификатор уже подключено',
    totp_not_enabled: 'Сначала подключи приложение-аутентификатор',
    totp_unavailable: 'Приложение-аутентификатор сейчас недоступно. Используй резервный код или другой способ',
    banned: 'Аккаунт заблокирован администратором',
    invalid_reason: 'Выбери причину жалобы',
    self_report: 'На себя жаловаться нельзя',
    cannot_ban_admin: 'Администратора заблокировать нельзя',
    cannot_ban_self: 'Себя заблокировать нельзя',
    already_handled: 'Эта жалоба уже обработана',
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
  socket.on('account:banned', handleBanned);
  socket.on('connect_error', (err) => {
    if (err && err.message === 'banned') handleBanned(err.data);
    else if (err && err.message === 'invalid_token') { localStorage.clear(); location.reload(); }
  });
  socket.on('reports:new', () => { showToast('🚩 Новая жалоба'); refreshAdminBadge(); });
  initAdmin();
  socket.on('message:new', onMessageNew);
  socket.on('typing', onTyping);
  socket.on('presence:update', onPresence);
  socket.on('connect', resyncAfterReconnect);
  socket.on('chats:refresh', loadChats);
  socket.on('stories:refresh', loadStories);
  socket.on('chat:cleared', ({ chatId }) => {
    if (chatId === activeChatId) $('#messages').innerHTML = '';
    const chat = chats.find((c) => c.id === chatId);
    if (chat) chat.lastMessage = null;
    renderChatList();
  });
  socket.on('chat:deleted', ({ chatId }) => {
    closeChatAndGoBack(chatId);
    showToast('Собеседник удалил этот чат');
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
  loadStories();
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
  initAdmin();
}

function renderMyAvatar() {
  $('#me-username').innerHTML = escapeHtml(me.display_name || me.username) + statusBadges(me);
  setAvatarEl($('#me-avatar'), { username: me.username, avatar: me.avatar });
}

function setAvatarEl(el, user) {
  if (user && typeof user.avatar === 'string' && /^https:\/\/[^\s"'`<>\\()]+$/.test(user.avatar)) {
    el.style.backgroundImage = `url("${user.avatar}")`;
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
  const data = await res.json();
  if (res.status === 403 && data && data.error === 'banned') handleBanned(data);
  return data;
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

// ========== ИСТОРИИ ==========
let storiesRaw = [];
let currentStoryGroup = null;
let currentStoryIndex = 0;
let storyTimer = null;
let storyProgressStart = 0;
let storyProgressDuration = 5000;
let storyPaused = false;

let storiesExpanded = false;
function setStoriesExpanded(value) {
  storiesExpanded = value;
  $('#stories-bar').classList.toggle('expanded', value);
  $('#stories-handle-chevron').classList.toggle('open', value);
}
let storiesHandleLastTouch = 0;
$('#stories-handle').onclick = () => {
  if (Date.now() - storiesHandleLastTouch < 600) return;
  setStoriesExpanded(!storiesExpanded);
};

let storiesHandleTouchY = 0;
$('#stories-handle').addEventListener('touchstart', (e) => {
  storiesHandleTouchY = e.touches[0].clientY;
}, { passive: true });
$('#stories-handle').addEventListener('touchend', (e) => {
  storiesHandleLastTouch = Date.now();
  const deltaY = e.changedTouches[0].clientY - storiesHandleTouchY;
  if (deltaY < -12) setStoriesExpanded(true);
  else if (deltaY > 12) setStoriesExpanded(false);
  else setStoriesExpanded(!storiesExpanded);
});

async function loadStories() {
  try {
    storiesRaw = await api('/api/stories');
  } catch {
    storiesRaw = [];
  }
  renderStoriesBar();
}

function groupStories() {
  const groups = new Map();
  storiesRaw.forEach((s) => {
    if (!groups.has(s.user_id)) groups.set(s.user_id, []);
    groups.get(s.user_id).push(s);
  });
  return groups;
}

function renderStoriesBar() {
  const bar = $('#stories-bar');
  bar.innerHTML = '';
  const groups = groupStories();

  // Моя история (или кнопка добавления)
  const mine = groups.get(me.id) || [];
  const myItem = document.createElement('div');
  myItem.className = 'story-ring-item';
  const allMineSeen = mine.length > 0 && mine.every((s) => s.viewed);
  myItem.innerHTML = `
    <span class="story-ring ${mine.length === 0 ? 'add-story' : (allMineSeen ? 'seen' : '')}">
      <span class="story-ring-inner">
        <span class="avatar-circle"></span>
        ${me.premium ? '<span class="story-add-plus">+</span>' : ''}
      </span>
    </span>
    <span class="story-ring-label">${mine.length ? 'Ваша история' : 'Добавить'}</span>`;
  setAvatarEl(myItem.querySelector('.avatar-circle'), me);
  myItem.onclick = () => {
    if (mine.length > 0) openStoryViewer(me.id);
    else if (me.premium) openStoryCreateModal();
    else showToast('Публикация историй доступна только с Premium-подпиской');
  };
  bar.appendChild(myItem);

  // Истории остальных (сначала непросмотренные)
  const others = Array.from(groups.entries()).filter(([uid]) => uid !== me.id);
  others.sort((a, b) => {
    const aUnseen = a[1].some((s) => !s.viewed);
    const bUnseen = b[1].some((s) => !s.viewed);
    return aUnseen === bUnseen ? 0 : aUnseen ? -1 : 1;
  });

  others.forEach(([uid, stories]) => {
    const allSeen = stories.every((s) => s.viewed);
    const first = stories[0];
    const item = document.createElement('div');
    item.className = 'story-ring-item';
    item.innerHTML = `
      <span class="story-ring ${allSeen ? 'seen' : ''}">
        <span class="story-ring-inner"><span class="avatar-circle"></span></span>
      </span>
      <span class="story-ring-label">${escapeHtml(first.display_name || first.username)}</span>`;
    setAvatarEl(item.querySelector('.avatar-circle'), first);
    item.onclick = () => openStoryViewer(uid);
    bar.appendChild(item);
  });
}

function openStoryViewer(userId) {
  const groups = groupStories();
  currentStoryGroup = groups.get(userId) || [];
  if (currentStoryGroup.length === 0) return;
  currentStoryIndex = 0;
  $('#story-viewer').classList.remove('hidden');
  renderStoryProgressBars();
  showCurrentStory();
}

function renderStoryProgressBars() {
  const row = $('#story-progress-row');
  row.innerHTML = currentStoryGroup.map(() => '<div class="story-progress-track"><div class="story-progress-fill"></div></div>').join('');
}

function showCurrentStory() {
  const story = currentStoryGroup[currentStoryIndex];
  if (!story) { closeStoryViewer(); return; }

  setAvatarEl($('#story-viewer-avatar'), story);
  $('#story-viewer-name').textContent = story.display_name || story.username;
  $('#story-viewer-time').textContent = formatStoryTime(story.created_at);
  $('#story-caption').textContent = story.caption || '';
  $('#story-delete-btn').classList.toggle('hidden', story.user_id !== me.id);

  const wrap = $('#story-media-wrap');
  wrap.innerHTML = '';
  if (story.type === 'video') {
    const video = document.createElement('video');
    video.src = story.media_url;
    video.autoplay = true;
    video.playsInline = true;
    wrap.appendChild(video);
    video.onloadedmetadata = () => startStoryProgress(video.duration * 1000 || 5000, video);
  } else {
    const img = document.createElement('img');
    img.src = story.media_url;
    wrap.appendChild(img);
    startStoryProgress(5000);
  }

  if (!story.viewed) {
    api(`/api/stories/${story.id}/view`, { method: 'POST' }).catch(() => {});
    story.viewed = true;
  }

  // сброс всех полосок прогресса кроме уже пройденных
  document.querySelectorAll('.story-progress-fill').forEach((el, i) => {
    el.style.transition = 'none';
    el.style.width = i < currentStoryIndex ? '100%' : '0%';
  });
}

function startStoryProgress(duration, videoEl) {
  clearTimeout(storyTimer);
  storyProgressDuration = duration;
  storyProgressStart = Date.now();
  const fill = document.querySelectorAll('.story-progress-fill')[currentStoryIndex];
  if (fill) {
    requestAnimationFrame(() => {
      fill.style.transition = `width ${duration}ms linear`;
      fill.style.width = '100%';
    });
  }
  storyTimer = setTimeout(() => nextStory(), duration);
  if (videoEl) videoEl.play().catch(() => {});
}

function nextStory() {
  clearTimeout(storyTimer);
  if (currentStoryIndex < currentStoryGroup.length - 1) {
    currentStoryIndex++;
    showCurrentStory();
  } else {
    closeStoryViewer();
  }
}
function prevStory() {
  clearTimeout(storyTimer);
  if (currentStoryIndex > 0) {
    currentStoryIndex--;
    showCurrentStory();
  } else {
    closeStoryViewer();
  }
}

function closeStoryViewer() {
  clearTimeout(storyTimer);
  $('#story-viewer').classList.add('hidden');
  $('#story-media-wrap').innerHTML = '';
  currentStoryGroup = null;
  renderStoriesBar();
}

function formatStoryTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  return `${Math.floor(diffMin / 60)} ч назад`;
}

$('#story-close-btn').onclick = closeStoryViewer;
$('#story-tap-next').onclick = nextStory;
$('#story-tap-prev').onclick = prevStory;
$('#story-delete-btn').onclick = async () => {
  const story = currentStoryGroup[currentStoryIndex];
  if (!story) return;
  if (!confirm('Удалить эту историю?')) return;
  await api(`/api/stories/${story.id}`, { method: 'DELETE' });
  storiesRaw = storiesRaw.filter((s) => s.id !== story.id);
  currentStoryGroup.splice(currentStoryIndex, 1);
  if (currentStoryGroup.length === 0) closeStoryViewer();
  else { renderStoryProgressBars(); showCurrentStory(); }
};

// ---- Публикация истории (только Premium) ----
let pendingStoryFile = null;
function openStoryCreateModal() {
  pendingStoryFile = null;
  $('#story-create-preview').classList.add('hidden');
  $('#story-create-preview').innerHTML = '';
  $('#story-caption-input').value = '';
  $('#story-publish-btn').disabled = true;
  $('#story-create-modal').classList.remove('hidden');
}
$('#close-story-create-btn').onclick = () => $('#story-create-modal').classList.add('hidden');
$('#story-file-input').addEventListener('change', () => {
  const file = $('#story-file-input').files[0];
  if (!file) return;
  pendingStoryFile = file;
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video');
  $('#story-create-preview').innerHTML = isVideo ? `<video src="${url}" controls></video>` : `<img src="${url}" />`;
  $('#story-create-preview').classList.remove('hidden');
  $('#story-publish-btn').disabled = false;
});
$('#story-publish-btn').onclick = async () => {
  if (!pendingStoryFile) return;
  $('#story-publish-btn').disabled = true;
  $('#story-publish-btn').textContent = 'Публикация...';
  try {
    const mediaUrl = await uploadFile(pendingStoryFile);
    const type = pendingStoryFile.type.startsWith('video') ? 'video' : 'image';
    await api('/api/stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, mediaUrl, caption: $('#story-caption-input').value }),
    });
    $('#story-create-modal').classList.add('hidden');
    showToast('История опубликована');
    loadStories();
  } catch (err) {
    showToast(err.message || 'Не удалось опубликовать историю');
  } finally {
    $('#story-publish-btn').disabled = false;
    $('#story-publish-btn').textContent = 'Опубликовать';
  }
};

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
      else if (chat.lastMessage.type === 'file') preview = '📄 Файл';
      else if (chat.lastMessage.media_url) preview = '📷 Фото';
      else preview = chat.lastMessage.content || '';
    }
    div.innerHTML = `
      <span class="avatar-circle"></span>
      <span class="chat-item-texts">
        <span class="chat-item-title">${escapeHtml(chat.title || 'Чат')}${statusBadges({ verified: chat.otherVerified, is_admin: chat.otherIsAdmin, premium: chat.otherPremium, premium_emoji: chat.otherPremiumEmoji })}</span>
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
  $('#chat-title').innerHTML = chat ? escapeHtml(chat.title) + statusBadges({ verified: chat.otherVerified, is_admin: chat.otherIsAdmin, premium: chat.otherPremium, premium_emoji: chat.otherPremiumEmoji }) : '';
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
  if (m.type === 'file') {
    try { return `📄 ${JSON.parse(m.content).name || 'Файл'}`; } catch { return '📄 Файл'; }
  }
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
      const parsedLoc = JSON.parse(msg.content);
      const lat = Number(parsedLoc.lat);
      const lng = Number(parsedLoc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('bad coords');
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
    bodyHtml = `<div class="media-wrap"><video class="video-bubble" src="${safeUrl(msg.media_url)}" controls playsinline></video><span class="media-time-overlay">${timeStatusInner}</span></div>`;
    timeHtml = '';
  } else if (msg.type === 'voice') {
    bodyHtml = `
      <div class="voice-bubble">
        <button type="button" class="voice-play-btn"></button>
        <div class="voice-progress"><div class="voice-progress-fill"></div></div>
        <span class="voice-duration">0:00</span>
        <audio class="voice-audio-el" src="${safeUrl(msg.media_url)}" preload="metadata"></audio>
      </div>
      <div class="time-block">${timeStatusInner}</div>`;
    timeHtml = '';
  } else if (msg.type === 'missed_call') {
    bodyHtml = `<div class="missed-call">📵 Пропущенный звонок</div><div class="time-block">${timeStatusInner}</div>`;
    timeHtml = '';
  } else if (msg.type === 'file') {
    let fileMeta = { name: 'Файл', size: 0 };
    try { fileMeta = JSON.parse(msg.content); } catch { /* оставляем значения по умолчанию */ }
    bodyHtml = `
      <div class="file-bubble" data-file-url="${safeUrl(msg.media_url)}" data-file-name="${escapeHtml(fileMeta.name || 'file')}">
        <span class="file-bubble-icon">${fileIconFor(fileMeta.name || '')}</span>
        <span class="file-bubble-info">
          <span class="file-bubble-name">${escapeHtml(fileMeta.name || 'Файл')}</span>
          <span class="file-bubble-size">${formatFileSize(fileMeta.size)}</span>
        </span>
      </div>
      <div class="time-block">${timeStatusInner}</div>`;
    timeHtml = '';
  } else {
    if (msg.content) bodyHtml += renderTextWithMentions(msg.content);
    if (msg.media_url) {
      bodyHtml += `<div class="media-wrap"><img src="${safeUrl(msg.media_url)}" /><span class="media-time-overlay">${timeStatusInner}</span></div>`;
      timeHtml = msg.content ? timeHtml : '';
    }
  }

  let quoteHtml = '';
  if (msg.reply_to) {
    let preview = msg.reply_type === 'image' ? '📷 Фото'
      : msg.reply_type === 'video' ? '🎥 Видео'
      : msg.reply_type === 'voice' ? '🎤 Голосовое сообщение'
      : msg.reply_type === 'location' ? '📍 Геолокация'
      : msg.reply_type === 'missed_call' ? '📵 Пропущенный звонок'
      : (msg.reply_content || '');
    if (msg.reply_type === 'file') {
      try { preview = `📄 ${JSON.parse(msg.reply_content).name || 'Файл'}`; } catch { preview = '📄 Файл'; }
    }
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
    return `<span class="reaction-pill${mine ? ' mine' : ''}" data-emoji="${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} ${Number(r.count) || 0}</span>`;
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
  $('#profile-name').innerHTML = escapeHtml(user.display_name || user.username) + statusBadges(user);
  $('#profile-username').textContent = '@' + user.username;
  setAvatarEl($('#profile-avatar'), user);
  $('#profile-presence').textContent = onlineUserIds.has(user.id) ? 'в сети' : formatLastSeen(user.last_seen);

  const details = $('#profile-details');
  details.innerHTML = '';
  const rows = [
    user.bio && ['📝', 'О себе', user.bio],
    user.phone && ['📞', 'Телефон', user.phone],
    user.birthday && ['🎂', 'Дата рождения', formatBirthday(user.birthday)],
  ].filter(Boolean);
  rows.forEach(([icon, caption, value]) => {
    const row = document.createElement('div');
    row.className = 'profile-info-row';
    row.innerHTML = `<span class="profile-info-icon">${icon}</span>
      <div class="profile-info-field"><span class="profile-info-caption">${caption}</span><span class="profile-info-value">${escapeHtml(value)}</span></div>`;
    details.appendChild(row);
  });

  const verifyBtn = $('#toggle-verify-btn');
  if (me.is_admin) {
    verifyBtn.textContent = user.verified ? '🚫 Снять верификацию' : '✅ Верифицировать';
    verifyBtn.classList.remove('hidden');
    verifyBtn.onclick = async () => {
      await api(`/api/users/${user.id}/verify`, { method: user.verified ? 'DELETE' : 'POST' });
      showToast(user.verified ? 'Верификация снята' : 'Аккаунт верифицирован');
      $('#profile-modal').classList.add('hidden');
      loadChats();
    };
  } else {
    verifyBtn.classList.add('hidden');
  }

  const premiumBtn = $('#toggle-premium-btn');
  if (me.is_admin) {
    premiumBtn.textContent = user.premium ? '🚫 Забрать Premium' : '⭐ Выдать Premium';
    premiumBtn.classList.remove('hidden');
    premiumBtn.onclick = async () => {
      let emoji = '⭐';
      if (!user.premium) {
        emoji = prompt('Какой эмодзи поставить рядом с именем? (оставь пустым для ⭐)', '⭐') || '⭐';
      }
      await api(`/api/users/${user.id}/premium`, {
        method: user.premium ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      showToast(user.premium ? 'Premium снят' : 'Premium выдан');
      $('#profile-modal').classList.add('hidden');
      loadChats();
    };
  } else {
    premiumBtn.classList.add('hidden');
  }

  const reportBtn = $('#report-user-btn');
  reportBtn.classList.toggle('hidden', user.id === me.id);
  reportBtn.onclick = () => {
    $('#profile-modal').classList.add('hidden');
    openReportModal({ userId: user.id, label: `на пользователя @${user.username}` });
  };

  $('#profile-modal').classList.remove('hidden');
};
$('#close-profile-btn').onclick = () => $('#profile-modal').classList.add('hidden');
$('#close-group-info-btn').onclick = () => $('#group-info-modal').classList.add('hidden');

function formatBirthday(iso) {
  try {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  } catch { return iso; }
}

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
      <span>${escapeHtml((m.display_name || m.username) + (isMe ? ' (вы)' : ''))}${statusBadges(m)}</span>
      ${!isMe ? '<button type="button" class="remove-member-btn" title="Убрать из группы">✕</button>' : ''}`;
    setAvatarEl(row.querySelector('.avatar-circle'), m);
    if (!isMe) {
      row.querySelector('.remove-member-btn').onclick = async () => {
        if (!confirm(`Убрать ${m.display_name || m.username} из группы?`)) return;
        const rmRes = await api(`/api/chats/${activeChatId}/members/${m.id}`, { method: 'DELETE' });
        if (rmRes.error) showToast('Убирать участников может только создатель группы');
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
  const clearRes = await api(`/api/chats/${activeChatId}/messages`, { method: 'DELETE' });
  if (clearRes.error) {
    showToast(clearRes.error === 'owner_only' ? 'Это может сделать только создатель группы' : 'Не получилось очистить историю');
    return;
  }
  $('#messages').innerHTML = '';
};

$('#delete-chat-btn').onclick = async () => {
  if (!activeChatId) return;
  $('#chat-menu').classList.add('hidden');
  if (!confirm('Удалить этот чат целиком? Он пропадёт из списка у обеих сторон, история сотрётся безвозвратно.')) return;
  const chatId = activeChatId;
  const delRes = await api(`/api/chats/${chatId}`, { method: 'DELETE' });
  if (delRes.error) {
    showToast(delRes.error === 'owner_only' ? 'Удалить группу может только её создатель. Можно выйти из неё' : 'Не получилось удалить чат');
    return;
  }
  closeChatAndGoBack(chatId);
  showToast('Чат удалён');
};

function closeChatAndGoBack(chatId) {
  chats = chats.filter((c) => c.id !== chatId);
  if (activeChatId === chatId) {
    activeChatId = null;
    activeChatObj = null;
    $('#app-screen').classList.remove('chat-open');
    $('#active-chat').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
  }
  renderChatList();
}

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
      else if (msg.type === 'file') {
        try {
          const meta = JSON.parse(msg.content);
          payload = { chatId: chat.id, type: 'file', mediaUrl: msg.media_url, fileName: meta.name, fileSize: meta.size };
        } catch { /* пропускаем битые метаданные файла */ }
      } else if (msg.type === 'location') {
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
  let fileName = null;
  let fileSize = null;
  if (pendingAttachment) {
    try {
      mediaUrl = await uploadFile(pendingAttachment.file);
    } catch (err) {
      alert(err.message || 'Не удалось загрузить файл');
      return;
    }
    sendType = pendingAttachment.kind === 'video' ? 'video' : pendingAttachment.kind === 'file' ? 'file' : undefined;
    if (pendingAttachment.kind === 'file') {
      fileName = pendingAttachment.file.name;
      fileSize = pendingAttachment.file.size;
    }
    clearAttachmentPreview();
  }

  if (!content && !mediaUrl) return;
  socket.emit('message:send', { chatId: activeChatId, content, mediaUrl, type: sendType, replyTo: replyingToId, fileName, fileSize });
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
  $('#attachment-preview-file').classList.add('hidden');
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
  $('#attachment-preview-file').classList.add('hidden');
  $('#attachment-preview-video').src = URL.createObjectURL(file);
  $('#attachment-preview').classList.remove('hidden');
  updateSendButtonMode();
});

$('#doc-input').addEventListener('change', () => {
  $('#attach-menu').classList.add('hidden');
  const file = $('#doc-input').files[0];
  if (!file) return;
  pendingAttachment = { file, kind: 'file' };
  $('#attachment-preview-img').hidden = true;
  $('#attachment-preview-video').hidden = true;
  $('#attachment-preview-file').classList.remove('hidden');
  $('#attachment-preview-file-icon').textContent = fileIconFor(file.name);
  $('#attachment-preview-file-name').textContent = file.name;
  $('#attachment-preview').classList.remove('hidden');
  updateSendButtonMode();
});

$('#remove-attachment-btn').onclick = () => clearAttachmentPreview();
function clearAttachmentPreview() {
  pendingAttachment = null;
  $('#file-input').value = '';
  $('#video-input').value = '';
  $('#doc-input').value = '';
  $('#attachment-preview-img').src = '';
  $('#attachment-preview-video').src = '';
  $('#attachment-preview-file').classList.add('hidden');
  $('#attachment-preview').classList.add('hidden');
  updateSendButtonMode();
}

function fileIconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['txt'].includes(ext)) return '📃';
  return '📄';
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
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
    return;
  }
  const fileBubble = e.target.closest('.file-bubble');
  if (fileBubble) window.open(fileBubble.dataset.fileUrl, '_blank');
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
      } else {
        const fileBubble = target.closest('.file-bubble');
        if (fileBubble) window.open(fileBubble.dataset.fileUrl, '_blank');
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
  if (!isOut && msg.type !== 'missed_call') {
    actions.push({ label: '🚩 Пожаловаться', run: () => openReportModal({ messageId, label: 'на это сообщение' }) });
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

function verifiedBadge(user) {
  if (!user || !user.verified) return '';
  const text = user.is_admin ? 'Официальный аккаунт разработчика' : 'Этот аккаунт верифицирован';
  return `<span class="verified-badge" data-tooltip="${escapeHtml(text)}">
    <svg viewBox="0 0 24 24" width="15" height="15">
      <path fill="var(--accent)" d="M12 1l2.39 2.39 3.3-.4.62 3.28 3.28.62-.4 3.3L23 12l-2.39 2.39.4 3.3-3.28.62-.62 3.28-3.3-.4L12 23l-2.39-2.39-3.3.4-.62-3.28-3.28-.62.4-3.3L1 12l2.39-2.39-.4-3.3 3.28-.62.62-3.28 3.3.4z"/>
      <path fill="white" d="M9.3 12.4l1.9 1.9 3.6-4.4" stroke="white" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>`;
}

function premiumBadge(user) {
  if (!user || !user.premium) return '';
  const emoji = user.premium_emoji || '⭐';
  return `<span class="premium-badge" data-tooltip="Premium-подписка">${emoji}</span>`;
}

function statusBadges(user) {
  return verifiedBadge(user) + premiumBadge(user);
}
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.verified-badge, .premium-badge');
  if (badge) { showToast(badge.dataset.tooltip); return; }
});

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  return String(str ?? '').replace(/[&<>"'`]/g, (c) => map[c]);
}

// Ссылки на медиа вставляем в страницу только если это обычный https-адрес без опасных символов
function safeUrl(u) {
  if (typeof u !== 'string') return '';
  return /^https:\/\/[^\s"'`<>\\]+$/.test(u) ? escapeHtml(u) : '';
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
    btn.classList.remove('playing');
    fill.style.width = '0%';
    durationEl.textContent = formatDuration(audio.duration);
  });

  btn.onclick = () => {
    if (audio.paused) {
      if (currentlyPlayingAudio && currentlyPlayingAudio !== audio) {
        currentlyPlayingAudio.pause();
        const otherBtn = currentlyPlayingAudio.closest('.voice-bubble')?.querySelector('.voice-play-btn');
        if (otherBtn) otherBtn.classList.remove('playing');
      }
      audio.play();
      currentlyPlayingAudio = audio;
      btn.classList.add('playing');
    } else {
      audio.pause();
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
  $('#username-readonly-label').textContent = '@' + me.username;
  $('#bio-input').value = me.bio || '';
  $('#phone-input').value = me.phone || '';
  $('#birthday-input').value = me.birthday || '';
  const savedColor = localStorage.getItem('themeColor') || '#2AABEE';
  document.querySelectorAll('.swatch:not(.custom-swatch)').forEach((el) => {
    el.classList.toggle('selected', el.dataset.color.toLowerCase() === savedColor.toLowerCase());
  });
  $('#dark-mode-toggle').checked = document.body.classList.contains('dark-theme');
  renderSavedThemes();
  loadSecurityStatus();

  const selfVerifyBtn = $('#self-verify-btn');
  if (me.is_admin) {
    selfVerifyBtn.textContent = me.verified ? '🚫 Снять верификацию с себя' : '✅ Верифицировать себя';
    selfVerifyBtn.classList.remove('hidden');
    selfVerifyBtn.onclick = async () => {
      await api(`/api/users/${me.id}/verify`, { method: me.verified ? 'DELETE' : 'POST' });
      await refreshMyProfile();
      selfVerifyBtn.textContent = me.verified ? '🚫 Снять верификацию с себя' : '✅ Верифицировать себя';
      showToast(me.verified ? 'Аккаунт верифицирован' : 'Верификация снята');
    };
  } else {
    selfVerifyBtn.classList.add('hidden');
  }

  const selfPremiumBtn = $('#self-premium-btn');
  if (me.is_admin) {
    selfPremiumBtn.textContent = me.premium ? '🚫 Забрать Premium у себя' : '⭐ Выдать Premium себе';
    selfPremiumBtn.classList.remove('hidden');
    selfPremiumBtn.onclick = async () => {
      let emoji = '⭐';
      if (!me.premium) {
        emoji = prompt('Какой эмодзи поставить себе? (оставь пустым для ⭐)', '⭐') || '⭐';
      }
      await api(`/api/users/${me.id}/premium`, {
        method: me.premium ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      await refreshMyProfile();
      selfPremiumBtn.textContent = me.premium ? '🚫 Забрать Premium у себя' : '⭐ Выдать Premium себе';
      showToast(me.premium ? 'Premium выдан' : 'Premium снят');
    };
  } else {
    selfPremiumBtn.classList.add('hidden');
  }

  $('#settings-modal').classList.remove('hidden');
};
$('#close-settings-btn').onclick = () => {
  $('#settings-modal').classList.add('hidden');
  $('#sec-backup-list').textContent = '';
  $('#sec-backup-box').classList.add('hidden');
  $('#sec-password').value = '';
};

$('#save-name-btn').onclick = async () => {
  const displayName = $('#display-name-input').value.trim();
  const bio = $('#bio-input').value.trim();
  const phone = $('#phone-input').value.trim();
  const birthday = $('#birthday-input').value;
  const { user } = await api('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, bio, phone, birthday }),
  });
  me = user;
  localStorage.setItem('me', JSON.stringify(me));
  renderMyAvatar();
  loadChats();
  showToast('Профиль сохранён');
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


// ========== ДВУХФАКТОРНАЯ ЗАЩИТА: ВХОД ==========
let pending2fa = null; // { challengeToken, method, methods, backup, kind: 'code' | 'backup', hint }

function showAuthStep(step) {
  const is2fa = step === '2fa';
  ['.auth-card .tabs', '#auth-username', '#auth-password', '#auth-submit'].forEach((sel) => {
    $(sel).classList.toggle('hidden', is2fa);
  });
  $('#auth-2fa').classList.toggle('hidden', !is2fa);
  if (is2fa) {
    $('#auth-email').classList.add('hidden');
    $('#auth-invite').classList.add('hidden');
  } else {
    setAuthMode(authMode);
  }
  $('#auth-error').textContent = '';
}

function describe2fa(method, hint) {
  if (method === 'totp') return 'Открой приложение-аутентификатор и введи 6-значный код для «Mío».';
  if (method === 'email') return `Мы отправили код на почту ${hint}. Введи его ниже.`;
  return `Мы отправили код в Telegram (${hint}). Введи его ниже.`;
}

const METHOD_SWITCH_LABELS = {
  totp: 'Ввести код из приложения',
  email: 'Получить код на почту',
  telegram: 'Получить код в Telegram',
};

function render2faStep() {
  const p = pending2fa;
  const isBackup = p.kind === 'backup';
  $('#auth-2fa-text').textContent = isBackup
    ? 'Введи один из резервных кодов (вида a1b2c-3d4e5). Каждый работает только один раз.'
    : describe2fa(p.method, p.hint);

  const input = $('#auth-2fa-code');
  input.value = '';
  input.maxLength = isBackup ? 11 : 6;
  input.placeholder = isBackup ? 'Резервный код' : 'Код из 6 цифр';
  input.inputMode = isBackup ? 'text' : 'numeric';

  $('#auth-2fa-resend').classList.toggle('hidden', p.method === 'totp' || isBackup);

  const bk = $('#auth-2fa-backup');
  bk.classList.toggle('hidden', !p.backup);
  bk.textContent = isBackup ? '← Вернуться к обычному коду' : 'Использовать резервный код';

  const sw = $('#auth-2fa-switch');
  const idx = p.methods.indexOf(p.method);
  const next = p.methods.length > 1 ? p.methods[(idx + 1) % p.methods.length] : null;
  sw.classList.toggle('hidden', !next || next === p.method || isBackup);
  if (next) {
    sw.dataset.method = next;
    sw.textContent = METHOD_SWITCH_LABELS[next] || 'Другой способ';
  }
}

function start2faStep(data) {
  pending2fa = {
    challengeToken: data.challengeToken,
    method: data.method,
    methods: data.methods || [data.method],
    backup: !!data.backup,
    kind: 'code',
    hint: data.hint || '',
  };
  showAuthStep('2fa');
  render2faStep();
  $('#auth-2fa-code').focus();
}

async function post2fa(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  return { ok: res.ok, data };
}

$('#auth-2fa-submit').onclick = async () => {
  if (!pending2fa) return;
  const code = $('#auth-2fa-code').value.trim();
  const isBackup = pending2fa.kind === 'backup';
  if (!isBackup && !/^\d{6}$/.test(code)) {
    $('#auth-error').textContent = 'Введи 6 цифр';
    return;
  }
  if (isBackup && code.replace(/[^a-fA-F0-9]/g, '').length !== 10) {
    $('#auth-error').textContent = 'Резервный код состоит из 10 символов: цифры и буквы a–f';
    return;
  }
  try {
    const r = await post2fa('/api/login/2fa', {
      challengeToken: pending2fa.challengeToken,
      code,
      method: isBackup ? 'backup' : pending2fa.method,
    });
    if (!r.ok) {
      if (r.data.error === 'challenge_expired' || r.data.error === 'too_many_attempts') {
        pending2fa = null;
        showAuthStep('main');
      }
      $('#auth-error').textContent = translateError(r.data.error);
      return;
    }
    token = r.data.token;
    me = r.data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('me', JSON.stringify(me));
    pending2fa = null;
    startApp();
  } catch (e) {
    $('#auth-error').textContent = 'Ошибка соединения с сервером';
  }
};
$('#auth-2fa-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#auth-2fa-submit').click();
});

async function resend2fa(method) {
  if (!pending2fa) return;
  try {
    const r = await post2fa('/api/login/2fa/resend', { challengeToken: pending2fa.challengeToken, method });
    if (!r.ok) {
      $('#auth-error').textContent = translateError(r.data.error);
      return;
    }
    pending2fa.method = r.data.method;
    pending2fa.hint = r.data.hint || '';
    pending2fa.kind = 'code';
    render2faStep();
    $('#auth-error').textContent = '';
  } catch (e) {
    $('#auth-error').textContent = 'Ошибка соединения с сервером';
  }
}
$('#auth-2fa-resend').onclick = () => resend2fa(pending2fa && pending2fa.method);
$('#auth-2fa-switch').onclick = () => resend2fa($('#auth-2fa-switch').dataset.method);
$('#auth-2fa-backup').onclick = () => {
  if (!pending2fa) return;
  pending2fa.kind = pending2fa.kind === 'backup' ? 'code' : 'backup';
  render2faStep();
  $('#auth-error').textContent = '';
  $('#auth-2fa-code').focus();
};
$('#auth-2fa-cancel').onclick = () => {
  pending2fa = null;
  showAuthStep('main');
};

// ========== ДВУХФАКТОРНАЯ ЗАЩИТА: НАСТРОЙКИ ==========
let secState = null;
let secPollTimer = null;

function secMsg(text, isError = false) {
  const el = $('#sec-msg');
  el.textContent = text;
  el.className = 'sec-msg' + (isError ? ' error' : '');
}

async function secPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  return { ok: res.ok, data };
}

async function loadSecurityStatus() {
  try {
    const res = await fetch('/api/2fa/status', { headers: { Authorization: `Bearer ${token}` } });
    const s = await res.json();
    if (!res.ok) {
      $('#sec-status').textContent = 'Не удалось загрузить настройки защиты';
      return;
    }
    secState = s;
    const lines = [];
    lines.push(
      s.method === 'totp' ? '✅ Защита включена: код из приложения-аутентификатора'
        : s.method === 'email' ? '✅ Защита включена: код приходит на почту'
        : s.method === 'telegram' ? '✅ Защита включена: код приходит в Telegram'
        : '⚠️ Защита выключена: вход только по паролю'
    );
    lines.push(s.totpEnabled ? `Приложение-аутентификатор: подключено ✔ (резервных кодов: ${s.backupLeft})` : 'Приложение-аутентификатор: не подключено');
    lines.push(s.emailVerified ? `Почта: ${s.email} ✔` : s.email ? `Почта: ${s.email} (не подтверждена)` : 'Почта: не указана');
    if (s.available.telegram) lines.push(s.telegramLinked ? `Telegram: ${s.telegramPhone || 'привязан'} ✔` : 'Telegram: не привязан');
    $('#sec-status').textContent = lines.join('\n');

    $('#sec-email-block').classList.toggle('hidden', !s.available.email);
    $('#sec-tg-block').classList.toggle('hidden', !s.available.telegram);
    $('#sec-tg-link').classList.toggle('hidden', s.telegramLinked);
    $('#sec-tg-unlink').classList.toggle('hidden', !s.telegramLinked);
    if (s.telegramLinked) $('#sec-tg-open').classList.add('hidden');

    $('#sec-totp-start').classList.toggle('hidden', s.totpEnabled);
    if (s.totpEnabled) $('#sec-totp-setup').classList.add('hidden');
    $('#sec-backup-new').classList.toggle('hidden', !s.totpEnabled);
    $('#sec-totp-disable').classList.toggle('hidden', !s.totpEnabled);

    const sel = $('#sec-method');
    Array.from(sel.options).forEach((o) => {
      o.disabled = (o.value === 'totp' && !s.totpEnabled)
        || (o.value === 'email' && !s.emailVerified)
        || (o.value === 'telegram' && !s.telegramLinked);
    });
    sel.value = s.method || 'off';
  } catch (e) {
    $('#sec-status').textContent = 'Нет связи с сервером';
  }
}

function secPassword() {
  const p = $('#sec-password').value;
  if (!p) secMsg('Сначала введи свой пароль в поле выше', true);
  return p;
}

$('#sec-email-send').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  const email = $('#sec-email').value.trim();
  if (!email) return secMsg('Введи адрес почты', true);
  const r = await secPost('/api/2fa/email/start', { password, email });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-email-code').classList.remove('hidden');
  $('#sec-email-confirm').classList.remove('hidden');
  secMsg('Код отправлен. Проверь входящие и папку «Спам».');
};

$('#sec-email-confirm').onclick = async () => {
  const code = $('#sec-email-code').value.trim();
  const r = await secPost('/api/2fa/email/confirm', { code });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-email-code').value = '';
  $('#sec-email-code').classList.add('hidden');
  $('#sec-email-confirm').classList.add('hidden');
  secMsg('Почта подтверждена ✔ Теперь выбери способ ниже и сохрани.');
  await loadSecurityStatus();
};

function startSecPolling() {
  if (secPollTimer) clearInterval(secPollTimer);
  let n = 0;
  secPollTimer = setInterval(async () => {
    n++;
    await loadSecurityStatus();
    if ((secState && secState.telegramLinked) || n > 40) {
      clearInterval(secPollTimer);
      secPollTimer = null;
      if (secState && secState.telegramLinked) secMsg('Telegram привязан ✔ Теперь выбери способ ниже и сохрани.');
    }
  }, 3000);
}

$('#sec-tg-link').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  const r = await secPost('/api/2fa/telegram/link', { password });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  const a = $('#sec-tg-open');
  a.href = r.data.url;
  a.classList.remove('hidden');
  secMsg('Нажми «Открыть бота», потом Start и кнопку «Поделиться номером». Затем вернись сюда.');
  startSecPolling();
};

$('#sec-tg-unlink').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  if (!confirm('Отвязать Telegram?')) return;
  const r = await secPost('/api/2fa/telegram/unlink', { password });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  secMsg('Telegram отвязан');
  await loadSecurityStatus();
};

$('#sec-method-save').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  const value = $('#sec-method').value;
  const r = await secPost('/api/2fa/method', { password, method: value === 'off' ? null : value });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-password').value = '';
  secMsg(value === 'off' ? 'Двухфакторная защита выключена' : 'Готово! Теперь при входе будет приходить код.');
  await loadSecurityStatus();
};


// ========== ПРИЛОЖЕНИЕ-АУТЕНТИФИКАТОР (TOTP): НАСТРОЙКИ ==========
function showBackupCodes(codes) {
  $('#sec-backup-list').textContent = codes.join('\n');
  $('#sec-backup-box').classList.remove('hidden');
}

$('#sec-totp-start').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  const r = await secPost('/api/2fa/totp/start', { password });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-totp-secret').value = r.data.secret;
  $('#sec-totp-open').href = r.data.uri;
  $('#sec-totp-code').value = '';
  $('#sec-totp-setup').classList.remove('hidden');
  secMsg('Добавь ключ в приложение-аутентификатор, потом введи код из него ниже.');
};

$('#sec-totp-confirm').onclick = async () => {
  const code = $('#sec-totp-code').value.trim();
  if (!/^\d{6}$/.test(code)) return secMsg('Введи 6 цифр из приложения', true);
  const r = await secPost('/api/2fa/totp/confirm', { code });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-totp-setup').classList.add('hidden');
  $('#sec-totp-secret').value = '';
  $('#sec-totp-code').value = '';
  showBackupCodes(r.data.backupCodes);
  secMsg('Приложение подключено ✔ Обязательно сохрани резервные коды ниже!');
  await loadSecurityStatus();
};

$('#sec-backup-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#sec-backup-list').textContent);
    showToast('Скопировано');
  } catch (e) {
    secMsg('Не получилось скопировать. Выдели коды пальцем и скопируй вручную', true);
  }
};

$('#sec-backup-new').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  if (!confirm('Выпустить новые коды? Старые перестанут работать.')) return;
  const r = await secPost('/api/2fa/totp/backup-new', { password });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  showBackupCodes(r.data.backupCodes);
  secMsg('Новые резервные коды выпущены. Сохрани их!');
  await loadSecurityStatus();
};

$('#sec-totp-disable').onclick = async () => {
  const password = secPassword();
  if (!password) return;
  if (!confirm('Отключить приложение-аутентификатор?')) return;
  const r = await secPost('/api/2fa/totp/disable', { password });
  if (!r.ok) return secMsg(translateError(r.data.error), true);
  $('#sec-backup-box').classList.add('hidden');
  $('#sec-backup-list').textContent = '';
  secMsg('Приложение-аутентификатор отключено');
  await loadSecurityStatus();
};


// ========== БАН: ВЫХОД ИЗ АККАУНТА ==========
let bannedShown = false;
function handleBanned(info) {
  if (bannedShown) return;
  bannedShown = true;
  const reason = info && info.reason ? `\nПричина: ${info.reason}` : '';
  const until = info && info.until ? `\nДо: ${new Date(info.until).toLocaleString('ru-RU')}` : '';
  localStorage.clear();
  alert(`Ваш аккаунт заблокирован.${reason}${until}`);
  location.reload();
}
function authErrorText(data) {
  const base = translateError(data.error);
  return data.error === 'banned' && data.reason ? `${base}. Причина: ${data.reason}` : base;
}

// ========== ЖАЛОБЫ ==========
let reportCtx = null; // { messageId? | userId?, label }
function openReportModal(ctx) {
  reportCtx = ctx;
  $('#report-target').textContent = `Жалоба ${ctx.label}`;
  $('#report-reason').value = 'spam';
  $('#report-details').value = '';
  $('#report-modal').classList.remove('hidden');
}
function closeReportModal() {
  $('#report-modal').classList.add('hidden');
  reportCtx = null;
}
$('#report-cancel').onclick = closeReportModal;
$('#report-modal').addEventListener('click', (e) => { if (e.target.id === 'report-modal') closeReportModal(); });
$('#report-send').onclick = async () => {
  if (!reportCtx) return;
  const body = { reason: $('#report-reason').value, details: $('#report-details').value.trim() };
  if (reportCtx.messageId) body.messageId = reportCtx.messageId;
  else body.userId = reportCtx.userId;
  const data = await api('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (data.error) {
    showToast(translateError(data.error));
    return;
  }
  closeReportModal();
  showToast('Жалоба отправлена. Спасибо!');
};

// ========== АДМИН-ПАНЕЛЬ ==========
const ADMIN_RESOLUTION_LABELS = { dismiss: 'Отклонена', resolve: 'Закрыта без бана', ban: 'Пользователь заблокирован' };
const ADMIN_ACTION_LABELS = {
  ban: '🔨 Бан',
  unban: '♻️ Разбан',
  delete_message: '🗑 Удалено сообщение',
  dismiss_report: 'Жалоба отклонена',
  resolve_report: 'Жалоба закрыта',
};

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fmtTs(ts) {
  return ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
function isHttpsUrl(u) {
  return typeof u === 'string' && /^https:\/\/[^\s"'`<>\\]+$/.test(u);
}

async function adminCall(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (res.status === 403 && data.error === 'banned') handleBanned(data);
  return { ok: res.ok, data };
}

function initAdmin() {
  const isAdmin = !!(me && me.is_admin);
  $('#admin-btn').classList.toggle('hidden', !isAdmin);
  if (isAdmin) refreshAdminBadge();
}

async function refreshAdminBadge() {
  if (!me || !me.is_admin) return;
  const r = await adminCall('/api/admin/stats');
  if (!r.ok) return;
  const badge = $('#admin-badge');
  badge.textContent = r.data.openReports;
  badge.classList.toggle('hidden', !r.data.openReports);
  $('#admin-stats').textContent = `Людей: ${r.data.users} · Заблокировано: ${r.data.banned} · Новых жалоб: ${r.data.openReports}`;
}

function showAdminTab(name) {
  ['reports', 'users', 'log'].forEach((t) => {
    $(`#admin-${t}-view`).classList.toggle('hidden', t !== name);
    $(`#admin-tab-${t}`).classList.toggle('active', t === name);
  });
  if (name === 'reports') loadAdminReports();
  else if (name === 'users') loadAdminUsers();
  else loadAdminLog();
}

$('#admin-btn').onclick = () => {
  $('#admin-modal').classList.remove('hidden');
  refreshAdminBadge();
  showAdminTab('reports');
};
$('#close-admin-btn').onclick = () => $('#admin-modal').classList.add('hidden');
$('#admin-tab-reports').onclick = () => showAdminTab('reports');
$('#admin-tab-users').onclick = () => showAdminTab('users');
$('#admin-tab-log').onclick = () => showAdminTab('log');
$('#admin-reports-filter').onchange = loadAdminReports;

// --- жалобы ---
async function loadAdminReports() {
  const list = $('#admin-reports-list');
  list.textContent = 'Загрузка…';
  const r = await adminCall(`/api/admin/reports?status=${encodeURIComponent($('#admin-reports-filter').value)}`);
  if (!r.ok) { list.textContent = 'Не удалось загрузить'; return; }
  list.textContent = '';
  if (!r.data.length) { list.appendChild(mk('p', 'admin-muted', 'Здесь пока пусто')); return; }
  r.data.forEach((rep) => list.appendChild(renderAdminReport(rep)));
}

function renderAdminReport(rep) {
  const card = mk('div', 'admin-item');
  const head = mk('div', 'admin-item-head');
  head.appendChild(mk('strong', '', `🚩 ${rep.reasonLabel}`));
  head.appendChild(mk('span', 'admin-muted', fmtTs(rep.createdAt)));
  card.appendChild(head);

  const who = `@${rep.reporterName} → @${rep.targetName}${rep.targetDisplay ? ` (${rep.targetDisplay})` : ''}`;
  card.appendChild(mk('div', 'admin-line', who));
  const meta = [`Жалоб на этого человека: ${rep.targetTotal}`];
  if (rep.targetBanned) meta.push('🔨 уже заблокирован');
  if (rep.targetIsAdmin) meta.push('админ');
  card.appendChild(mk('div', 'admin-muted', meta.join(' · ')));

  if (rep.snapshot) {
    card.appendChild(mk('div', 'admin-quote', rep.snapshot.text || ''));
    if (isHttpsUrl(rep.snapshot.mediaUrl)) {
      const a = mk('a', 'admin-link', 'Открыть вложение');
      a.href = rep.snapshot.mediaUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      card.appendChild(a);
    }
  }
  if (rep.details) card.appendChild(mk('div', 'admin-line', `Комментарий: ${rep.details}`));

  if (rep.status === 'open') {
    const actions = mk('div', 'admin-actions');
    const btn = (label, fn) => {
      const b = mk('button', 'secondary-btn', label);
      b.type = 'button';
      b.onclick = fn;
      actions.appendChild(b);
    };
    btn('Отклонить', () => resolveAdminReport(rep, 'dismiss'));
    btn('Закрыть без бана', () => resolveAdminReport(rep, 'resolve'));
    if (rep.messageId) {
      btn('🗑 Удалить сообщение', () => {
        if (confirm('Удалить это сообщение у всех?')) resolveAdminReport(rep, 'resolve', { deleteMessage: true });
      });
    }
    if (!rep.targetIsAdmin) {
      btn('🔨 Бан на 7 дней', () => banFromReport(rep, 7));
      btn('🔨 Бан навсегда', () => banFromReport(rep, null));
    }
    card.appendChild(actions);
  } else {
    const who2 = rep.handlerName ? ` · @${rep.handlerName}` : '';
    card.appendChild(mk('div', 'admin-muted', `${ADMIN_RESOLUTION_LABELS[rep.resolution] || rep.status}${who2} · ${fmtTs(rep.handledAt)}`));
  }
  return card;
}

async function resolveAdminReport(rep, action, extra = {}) {
  const r = await adminCall(`/api/admin/reports/${rep.id}/resolve`, 'POST', { action, ...extra });
  if (!r.ok) { showToast(translateError(r.data.error)); return; }
  showToast('Готово');
  loadAdminReports();
  refreshAdminBadge();
}

async function banFromReport(rep, days) {
  const reason = prompt(`Причина блокировки @${rep.targetName} (её увидит сам пользователь):`, rep.reasonLabel);
  if (reason === null) return;
  const deleteMessage = rep.messageId ? confirm('Удалить также само сообщение?') : false;
  await resolveAdminReport(rep, 'ban', { reason, days, deleteMessage });
}

// --- люди ---
let adminUsersTimer = null;
$('#admin-users-search').oninput = () => {
  clearTimeout(adminUsersTimer);
  adminUsersTimer = setTimeout(loadAdminUsers, 300);
};
$('#admin-users-banned').onchange = loadAdminUsers;

async function loadAdminUsers() {
  const list = $('#admin-users-list');
  list.textContent = 'Загрузка…';
  const q = encodeURIComponent($('#admin-users-search').value.trim());
  const banned = $('#admin-users-banned').checked ? 1 : 0;
  const r = await adminCall(`/api/admin/users?search=${q}&banned=${banned}`);
  if (!r.ok) { list.textContent = 'Не удалось загрузить'; return; }
  list.textContent = '';
  if (!r.data.length) { list.appendChild(mk('p', 'admin-muted', 'Никого не найдено')); return; }

  r.data.forEach((u) => {
    const card = mk('div', 'admin-item');
    const head = mk('div', 'admin-item-head');
    head.appendChild(mk('strong', '', `@${u.username}${u.displayName ? ` (${u.displayName})` : ''}`));
    head.appendChild(mk('span', 'admin-muted', u.isAdmin ? 'админ' : ''));
    card.appendChild(head);
    const meta = [`Регистрация: ${fmtTs(u.createdAt) || '—'}`, `Жалоб: ${u.reportsTotal}`];
    if (u.lastSeen) meta.push(`Был(а): ${fmtTs(u.lastSeen)}`);
    card.appendChild(mk('div', 'admin-muted', meta.join(' · ')));
    if (u.banned) {
      const until = u.bannedUntil ? `до ${fmtTs(u.bannedUntil)}` : 'навсегда';
      card.appendChild(mk('div', 'admin-line', `🔨 Заблокирован ${until}${u.banReason ? `: ${u.banReason}` : ''}`));
    }
    if (!u.isAdmin) {
      const actions = mk('div', 'admin-actions');
      const b = mk('button', 'secondary-btn', u.banned ? '♻️ Разблокировать' : '🔨 Заблокировать');
      b.type = 'button';
      b.onclick = () => (u.banned ? adminUnban(u) : adminBan(u));
      actions.appendChild(b);
      card.appendChild(actions);
    }
    list.appendChild(card);
  });
}

async function adminBan(u) {
  const reason = prompt(`Причина блокировки @${u.username} (её увидит пользователь):`, '');
  if (reason === null) return;
  const d = prompt('На сколько дней? (оставь пустым, чтобы заблокировать навсегда)', '');
  if (d === null) return;
  const days = d.trim() ? Number(d) : null;
  const r = await adminCall(`/api/admin/users/${u.id}/ban`, 'POST', { reason, days });
  if (!r.ok) { showToast(translateError(r.data.error)); return; }
  showToast('Пользователь заблокирован');
  loadAdminUsers();
  refreshAdminBadge();
}

async function adminUnban(u) {
  if (!confirm(`Разблокировать @${u.username}?`)) return;
  const r = await adminCall(`/api/admin/users/${u.id}/unban`, 'POST');
  if (!r.ok) { showToast(translateError(r.data.error)); return; }
  showToast('Разблокирован');
  loadAdminUsers();
  refreshAdminBadge();
}

// --- журнал ---
async function loadAdminLog() {
  const list = $('#admin-log-list');
  list.textContent = 'Загрузка…';
  const r = await adminCall('/api/admin/log');
  if (!r.ok) { list.textContent = 'Не удалось загрузить'; return; }
  list.textContent = '';
  if (!r.data.length) { list.appendChild(mk('p', 'admin-muted', 'Действий пока не было')); return; }
  r.data.forEach((e) => {
    const card = mk('div', 'admin-item');
    const head = mk('div', 'admin-item-head');
    head.appendChild(mk('strong', '', ADMIN_ACTION_LABELS[e.action] || e.action));
    head.appendChild(mk('span', 'admin-muted', fmtTs(e.createdAt)));
    card.appendChild(head);
    const line = `${e.adminName ? '@' + e.adminName : ''}${e.targetName ? ` → @${e.targetName}` : ''}`;
    if (line) card.appendChild(mk('div', 'admin-line', line));
    if (e.details) card.appendChild(mk('div', 'admin-muted', e.details));
    list.appendChild(card);
  });
}
