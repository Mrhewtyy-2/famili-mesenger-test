let token = localStorage.getItem('token');
let me = JSON.parse(localStorage.getItem('me') || 'null');
let socket = null;
let activeChatId = null;
let activeChatOtherUserId = null;
let chats = [];
let authMode = 'login';

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
  $('#me-username').textContent = me.username;

  socket = io({ auth: { token } });
  socket.on('message:new', onMessageNew);
  socket.on('typing', onTyping);
  socket.on('presence:update', onPresence);
  socket.on('connect', resyncAfterReconnect);
  socket.on('chats:refresh', loadChats);
  attachCallSocketHandlers();

  loadChats();
  setupPush();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncAfterReconnect();
  });
}

async function resyncAfterReconnect() {
  await loadChats();
  if (activeChatId) {
    const messages = await api(`/api/chats/${activeChatId}/messages`);
    const box = $('#messages');
    box.innerHTML = '';
    messages.forEach(renderMessage);
    box.scrollTop = box.scrollHeight;
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
      else if (chat.lastMessage.media_url) preview = '📷 Фото';
      else preview = chat.lastMessage.content || '';
    }
    div.innerHTML = `<span class="chat-item-title">${escapeHtml(chat.title || 'Чат')}</span>
                      <span class="chat-item-preview">${escapeHtml(preview)}</span>`;
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

  const chat = chats.find((c) => c.id === chatId);
  $('#chat-title').textContent = chat ? chat.title : '';
  activeChatOtherUserId = chat && chat.type === 'private' ? chat.otherUserId : null;
  $('#call-btn').classList.toggle('hidden', !activeChatOtherUserId);

  const messages = await api(`/api/chats/${chatId}/messages`);
  const box = $('#messages');
  box.innerHTML = '';
  messages.forEach(renderMessage);
  box.scrollTop = box.scrollHeight;
}

function renderMessage(msg) {
  const box = $('#messages');
  const row = document.createElement('div');
  const isOut = msg.sender_id === me.id;
  row.className = 'msg-row ' + (isOut ? 'out' : 'in');

  const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  let bodyHtml = '';
  if (msg.type === 'location') {
    try {
      const { lat, lng } = JSON.parse(msg.content);
      const d = 0.01;
      const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
      bodyHtml = `
        <div class="location-card">
          <iframe class="location-map" src="https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat}%2C${lng}" loading="lazy"></iframe>
          <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}" target="_blank" rel="noopener">📍 Открыть на карте</a>
        </div>`;
    } catch {
      bodyHtml = '📍 Геолокация';
    }
  } else {
    if (msg.content) bodyHtml += escapeHtml(msg.content);
    if (msg.media_url) bodyHtml += `<img src="${msg.media_url}" />`;
  }

  row.innerHTML = `
    <div class="bubble">
      ${!isOut ? `<span class="sender">${escapeHtml(msg.sender_name || '')}</span>` : ''}
      ${bodyHtml}
      <div class="time">${time}</div>
    </div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function onMessageNew(msg) {
  if (msg.chat_id === activeChatId) renderMessage(msg);
  const chat = chats.find((c) => c.id === msg.chat_id);
  if (chat) chat.lastMessage = msg;
  renderChatList();
}

function onTyping({ chatId, username }) {
  if (chatId !== activeChatId) return;
  const el = $('#typing-indicator');
  el.textContent = `${username} печатает...`;
  clearTimeout(onTyping._t);
  onTyping._t = setTimeout(() => (el.textContent = ''), 2000);
}

function onPresence() {
  // можно расширить: показывать точку "онлайн" рядом с чатом
}

$('#back-btn').onclick = () => {
  $('#app-screen').classList.remove('chat-open');
};

// ---------- SEND MESSAGE ----------
$('#message-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!activeChatId) return;
  const input = $('#message-input');
  const content = input.value.trim();
  const file = $('#file-input').files[0];

  let mediaUrl = null;
  if (file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    mediaUrl = data.url;
    $('#file-input').value = '';
  }

  if (!content && !mediaUrl) return;
  socket.emit('message:send', { chatId: activeChatId, content, mediaUrl });
  input.value = '';
};

$('#message-input').addEventListener('input', () => {
  if (activeChatId) socket.emit('typing', { chatId: activeChatId });
});

// ---------- МЕНЮ ВЛОЖЕНИЙ (фото + геолокация спрятаны за "+") ----------
$('#attach-toggle-btn').onclick = (e) => {
  e.stopPropagation();
  $('#attach-menu').classList.toggle('hidden');
};
document.addEventListener('click', () => $('#attach-menu').classList.add('hidden'));
$('#attach-menu').addEventListener('click', (e) => e.stopPropagation());
$('#file-input').addEventListener('change', () => $('#attach-menu').classList.add('hidden'));

$('#location-btn').onclick = () => {
  $('#attach-menu').classList.add('hidden');
  if (!activeChatId) return;
  if (!navigator.geolocation) {
    alert('Браузер не поддерживает геолокацию');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      socket.emit('message:send', {
        chatId: activeChatId,
        type: 'location',
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    },
    () => alert('Не удалось определить местоположение — проверь разрешение для сайта в настройках браузера.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

// ---------- NEW CHAT MODAL ----------
$('#new-chat-btn').onclick = () => {
  $('#new-chat-modal').classList.remove('hidden');
  $('#user-search').value = '';
  $('#user-results').innerHTML = '';
  $('#user-search').focus();
};
$('#close-modal-btn').onclick = () => $('#new-chat-modal').classList.add('hidden');

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
      div.textContent = u.username;
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

// ========== АУДИОЗВОНКИ (WebRTC) ==========
let pc = null;
let localStream = null;
let currentCallPeerId = null;
let pendingOffer = null;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function attachCallSocketHandlers() {
  socket.on('call:offer', ({ fromUserId, fromUsername, sdp }) => {
    if (currentCallPeerId) {
      // уже говорим по другому звонку — просто игнорируем новый
      return;
    }
    pendingOffer = { fromUserId, fromUsername, sdp };
    $('#incoming-call-name').textContent = `Звонок от ${fromUsername}`;
    $('#incoming-call-modal').classList.remove('hidden');
  });

  socket.on('call:answer', async ({ sdp }) => {
    if (!pc) return;
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
    alert('Собеседник сейчас не в сети');
    endCallCleanup();
  });
}

function createPeerConnection(peerId) {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
    alert('Нет доступа к микрофону — разреши доступ в настройках браузера.');
    return;
  }
  currentCallPeerId = activeChatOtherUserId;
  pc = createPeerConnection(currentCallPeerId);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:offer', { toUserId: currentCallPeerId, chatId: activeChatId, sdp: offer });
  $('#active-call-name').textContent = 'Вызов...';
  $('#active-call-bar').classList.remove('hidden');
};

$('#accept-call-btn').onclick = async () => {
  if (!pendingOffer) return;
  const { fromUserId, fromUsername, sdp } = pendingOffer;
  $('#incoming-call-modal').classList.add('hidden');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert('Нет доступа к микрофону — разреши доступ в настройках браузера.');
    socket.emit('call:end', { toUserId: fromUserId });
    pendingOffer = null;
    return;
  }
  currentCallPeerId = fromUserId;
  pc = createPeerConnection(currentCallPeerId);
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
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  currentCallPeerId = null;
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
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
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
