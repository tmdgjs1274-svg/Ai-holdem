'use strict';

const socket = io();

const el = (id) => document.getElementById(id);
const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);
const POS_LABELS = { BTN: 'D', SB: 'SB', BB: 'BB' };

let myPlayerId = localStorage.getItem('holdem_playerId') || null;
let myRoomId = localStorage.getItem('holdem_roomId') || null;
let latestState = null;
let latestLobby = null;

// ---------- 화면 전환 ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  el(id).classList.add('active');
}

document.querySelectorAll('.btn-back').forEach((btn) => btn.addEventListener('click', () => showScreen('screen-home')));
el('btn-go-create').addEventListener('click', () => showScreen('screen-create'));
el('btn-go-join').addEventListener('click', () => showScreen('screen-join'));

el('create-aiCount').addEventListener('input', (e) => (el('ai-count-label').textContent = e.target.value));
el('create-aiMistake').addEventListener('input', (e) => (el('ai-mistake-label').textContent = e.target.value));

function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function saveSession(roomId, playerId) {
  myRoomId = roomId;
  myPlayerId = playerId;
  localStorage.setItem('holdem_roomId', roomId);
  localStorage.setItem('holdem_playerId', playerId);
}
function clearSession() {
  myRoomId = null;
  myPlayerId = null;
  localStorage.removeItem('holdem_roomId');
  localStorage.removeItem('holdem_playerId');
}

// ---------- 방 만들기 ----------
el('btn-create-submit').addEventListener('click', () => {
  const opts = {
    hostName: el('create-name').value.trim() || '호스트',
    aiCount: Number(el('create-aiCount').value),
    aiMistakeRate: Number(el('create-aiMistake').value) / 100,
    startingStack: Number(el('create-startingStack').value),
    rebuyAmount: Number(el('create-rebuyAmount').value),
    startSb: Number(el('create-sb').value),
    startBb: Number(el('create-bb').value),
    levelDurationMinutes: Number(el('create-levelMinutes').value),
  };
  socket.emit('createRoom', opts, (res) => {
    if (!res.ok) return toast('방 생성 실패: ' + res.error);
    saveSession(res.roomId, res.playerId);
    latestLobby = res.lobby;
    renderLobby();
    showScreen('screen-lobby');
  });
});

// ---------- 참가하기 ----------
el('btn-join-submit').addEventListener('click', () => {
  const roomId = el('join-code').value.trim().toUpperCase();
  const displayName = el('join-name').value.trim() || '게스트';
  if (!roomId) return toast('방 코드를 입력해주세요');
  socket.emit('joinRoom', { roomId, displayName }, (res) => {
    if (!res.ok) return toast('참가 실패: ' + res.error);
    saveSession(res.roomId, res.playerId);
    latestLobby = res.lobby;
    renderLobby();
    showScreen('screen-lobby');
  });
});

// ---------- 로비 ----------
function renderLobby() {
  if (!latestLobby) return;
  el('lobby-roomcode').textContent = latestLobby.roomId;
  const list = el('lobby-seats');
  list.innerHTML = '';
  latestLobby.seats.forEach((s, idx) => {
    const li = document.createElement('li');
    if (!s) {
      li.innerHTML = `<span>좌석 ${idx + 1} (비어있음${idx === 1 ? ' · 게스트 대기' : ''})</span><span class="tag empty">-</span>`;
    } else {
      const tagClass = s.type === 'ai' ? 'ai' : '';
      li.innerHTML = `<span>${escapeHtml(s.displayName)} ${s.playerId === myPlayerId ? '(나)' : ''}</span><span class="tag ${tagClass}">${s.type === 'ai' ? 'AI' : '사람'} · ${s.stack}</span>`;
    }
    list.appendChild(li);
  });

  const amHost = myPlayerId && latestLobby.hostId === myPlayerId;
  el('btn-start-game').classList.toggle('hidden', !amHost);
  el('lobby-wait-msg').textContent = amHost ? '' : '호스트가 게임을 시작할 때까지 기다려주세요.';
}

el('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard && navigator.clipboard.writeText(latestLobby.roomId);
  toast('방 코드를 복사했어요');
});

el('btn-start-game').addEventListener('click', () => {
  socket.emit('startGame', {}, (res) => {
    if (!res.ok) toast('시작 실패: ' + res.error);
  });
});

// ---------- 재연결 시도 ----------
if (myRoomId && myPlayerId) {
  socket.emit('rejoinRoom', { roomId: myRoomId, playerId: myPlayerId }, (res) => {
    if (res.ok) {
      latestLobby = res.lobby;
      if (res.lobby.status === 'lobby') {
        renderLobby();
        showScreen('screen-lobby');
      } else {
        showScreen('screen-table');
      }
    } else {
      clearSession();
    }
  });
}

// ---------- 소켓 이벤트 ----------
socket.on('lobbyState', (lobby) => {
  latestLobby = lobby;
  if (el('screen-lobby').classList.contains('active')) renderLobby();
});

socket.on('gameStarted', () => {
  showScreen('screen-table');
});

socket.on('state', (state) => {
  latestState = state;
  if (state.status === 'in_progress' || state.status === 'closed') {
    if (!el('screen-table').classList.contains('active') && state.status === 'in_progress') {
      showScreen('screen-table');
    }
    renderTable();
  }
});

socket.on('blindLevel', (level) => {
  renderBlindInfo(level);
});

socket.on('handResult', (result) => {
  showHandResultBanner(result);
});

socket.on('rebuyRequired', ({ seatIndex }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    el('rebuy-modal').classList.remove('hidden');
  }
});

socket.on('rebuyResult', ({ seatIndex, accepted }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    el('rebuy-modal').classList.add('hidden');
  }
});

socket.on('roomClosed', ({ reason }) => {
  el('closed-msg').textContent = reason || '게임이 종료되었습니다.';
  el('closed-modal').classList.remove('hidden');
});

el('btn-rebuy-yes').addEventListener('click', () => {
  socket.emit('rebuyDecision', { accept: true }, () => {});
});
el('btn-rebuy-no').addEventListener('click', () => {
  socket.emit('rebuyDecision', { accept: false }, () => {});
});

el('btn-back-home').addEventListener('click', () => {
  el('closed-modal').classList.add('hidden');
  clearSession();
  latestState = null;
  latestLobby = null;
  showScreen('screen-home');
});

el('btn-leave').addEventListener('click', () => {
  const amHost = latestState && myPlayerId && latestState.hostId === myPlayerId;
  const msg = amHost ? '정말 방을 나가시겠어요? 호스트가 나가면 게임이 종료됩니다.' : '방에서 나가시겠어요?';
  if (!confirm(msg)) return;
  if (amHost) {
    socket.emit('closeRoom', {}, () => {});
  } else {
    socket.disconnect();
  }
  clearSession();
  latestState = null;
  showScreen('screen-home');
  if (!amHost) setTimeout(() => socket.connect(), 300);
});

// ---------- 테이블 렌더링 ----------
function renderBlindInfo(level) {
  if (!level) return;
  let text = `블라인드 ${level.sb}/${level.bb}`;
  if (level.ante) text += ` (앤티 ${level.ante})`;
  if (level.msRemaining != null) {
    const m = Math.floor(level.msRemaining / 60000);
    const s = Math.floor((level.msRemaining % 60000) / 1000);
    text += ` · 다음 레벨까지 ${m}:${String(s).padStart(2, '0')}`;
  }
  el('blind-info').textContent = text;
}

function cardEl(str, faceDown) {
  const div = document.createElement('div');
  if (faceDown || str === '??') {
    div.className = 'playing-card back';
    div.textContent = '';
    return div;
  }
  const rank = str.slice(0, -1);
  const suit = str.slice(-1);
  div.className = 'playing-card' + (RED_SUITS.has(suit) ? ' red' : '');
  div.textContent = `${rank}${SUIT_SYMBOL[suit] || ''}`;
  return div;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTable() {
  const state = latestState;
  if (!state) return;

  renderBlindInfo(state.blindLevel);
  el('pot-display').textContent = state.pot ? `팟: ${state.pot}` : '';

  const board = el('board-cards');
  board.innerHTML = '';
  (state.board || []).forEach((c) => board.appendChild(cardEl(c)));

  const container = el('seats-container');
  container.innerHTML = '';

  const occupied = state.seats.map((s, idx) => (s ? { ...s, idx } : null)).filter(Boolean);
  const mySeat = state.mySeatIndex;
  let startOffset = occupied.findIndex((s) => s.idx === mySeat);
  if (startOffset === -1) startOffset = 0;
  const K = occupied.length;

  occupied.forEach((s, i) => {
    const order = (i - startOffset + K) % K;
    const angleDeg = 90 + order * (360 / K);
    const rad = (angleDeg * Math.PI) / 180;
    const x = 50 + 43 * Math.cos(rad);
    const y = 50 + 40 * Math.sin(rad);

    const seatDiv = document.createElement('div');
    seatDiv.className = 'seat' + (s.idx === state.actingSeat ? ' acting' : '') + (s.folded ? ' folded' : '');
    seatDiv.style.left = x + '%';
    seatDiv.style.top = y + '%';

    const holeWrap = document.createElement('div');
    holeWrap.className = 'hole-cards';
    const showFace = s.idx === mySeat || state.street === 'showdown';
    (s.holeCards || []).forEach((c) => holeWrap.appendChild(cardEl(c, !showFace && c === '??')));
    seatDiv.appendChild(holeWrap);

    const plate = document.createElement('div');
    plate.className = 'name-plate';
    plate.innerHTML = `${escapeHtml(s.displayName)}${s.idx === mySeat ? ' (나)' : ''}`;
    if (s.idx === state.buttonIndex || s.idx === state.sbIndex || s.idx === state.bbIndex) {
      const badge = document.createElement('span');
      badge.className = 'pos-badge';
      badge.textContent = s.idx === state.buttonIndex ? 'D' : s.idx === state.sbIndex ? 'SB' : 'BB';
      plate.appendChild(badge);
    }
    seatDiv.appendChild(plate);

    const stackDiv = document.createElement('div');
    stackDiv.className = 'stack';
    stackDiv.textContent = `칩 ${s.stack}${s.allIn ? ' (올인)' : ''}`;
    seatDiv.appendChild(stackDiv);

    if (s.committedThisStreet > 0) {
      const bet = document.createElement('div');
      bet.className = 'bet-chip';
      bet.textContent = `베팅 ${s.committedThisStreet}`;
      seatDiv.appendChild(bet);
    }

    container.appendChild(seatDiv);
  });

  updateActionBar(state);
}

function showHandResultBanner(result) {
  const banner = el('hand-result-banner');
  let text;
  if (result.type === 'fold') {
    text = `상대가 폴드하여 팟을 획득했어요 (+${Object.values(result.winnings)[0] || 0})`;
  } else {
    const lines = (result.pots || []).map((p) => `${p.handName} (+${p.amount})`);
    text = `쇼다운: ${lines.join(', ')}`;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
  clearTimeout(showHandResultBanner._t);
  showHandResultBanner._t = setTimeout(() => banner.classList.add('hidden'), 3200);
}

// ---------- 액션바 ----------
function updateActionBar(state) {
  const bar = el('action-bar');
  const legal = state.legalActions;
  if (!legal || state.mySeatIndex == null || state.actingSeat !== state.mySeatIndex) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  el('btn-check').style.display = legal.canCheck ? 'block' : 'none';
  el('btn-call').style.display = legal.canCall ? 'block' : 'none';
  el('btn-call').textContent = legal.canCall ? `콜 (${legal.callAmount})` : '콜';
  el('btn-raise').style.display = legal.canRaise ? 'block' : 'none';

  const slider = el('raise-slider');
  if (legal.canRaise) {
    slider.min = legal.minRaiseTo;
    slider.max = legal.maxRaiseTo;
    slider.value = legal.minRaiseTo;
    el('raise-amount-label').textContent = legal.minRaiseTo;
    slider.oninput = () => (el('raise-amount-label').textContent = slider.value);
    slider.parentElement.style.display = 'flex';
  } else {
    slider.parentElement.style.display = 'none';
  }
}

el('btn-fold').addEventListener('click', () => sendAction('fold'));
el('btn-check').addEventListener('click', () => sendAction('check'));
el('btn-call').addEventListener('click', () => sendAction('call'));
el('btn-allin').addEventListener('click', () => sendAction('allin'));
el('btn-raise').addEventListener('click', () => sendAction('raise', Number(el('raise-slider').value)));

function sendAction(actionType, amount) {
  socket.emit('action', { actionType, amount }, (res) => {
    if (!res.ok) toast(res.error || '액션 실패');
  });
}
