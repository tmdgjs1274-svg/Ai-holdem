'use strict';

const socket = io();

const el = (id) => document.getElementById(id);
const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);
const ACTION_LABEL = {
  fold: '폴드', check: '체크', call: '콜', bet: '베팅', raise: '레이즈', allin: '올인',
};

let myPlayerId = localStorage.getItem('holdem_playerId') || null;
let myRoomId = localStorage.getItem('holdem_roomId') || null;
let latestState = null;
let latestLobby = null;

// 좌석별 트랜션트 액션 말풍선 상태: { [seatIndex]: { text, cls } }
const activeBubbles = {};
// 블라인드 카운트다운을 실시간으로 표시하기 위한 로컬 기준점
let blindTickBase = null; // { level, receivedAt }
let blindTickTimer = null;

// 결과 모달 상태
let resultAutoTimer = null;
let awaitingConfirm = false;
let iAmReady = false;
let lastRenderedHandNumber = null;
let resultModalHandNumber = null;

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
el('set-aiCount').addEventListener('input', (e) => (el('set-aiCount-label').textContent = e.target.value));
el('set-aiMistake').addEventListener('input', (e) => (el('set-aiMistake-label').textContent = e.target.value));

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
    maxRebuys: Number(el('create-maxRebuys').value),
    addOnAmount: Number(el('create-addOnAmount').value),
    aiActionDelayMs: Math.round(Number(el('create-aiActionDelay').value) * 1000),
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
  el('btn-lobby-settings').classList.toggle('hidden', !amHost);
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

// ---------- 설정 모달 (로비 / 게임 중 공용) ----------
function currentConfig() {
  if (latestState && latestState.config) return latestState.config;
  if (latestLobby && latestLobby.config) return latestLobby.config;
  return null;
}
function currentStatus() {
  return (latestState && latestState.status) || (latestLobby && latestLobby.status) || 'lobby';
}
function amIHost() {
  const hostId = (latestState && latestState.hostId) || (latestLobby && latestLobby.hostId);
  return !!(myPlayerId && hostId === myPlayerId);
}

function openSettingsModal() {
  const cfg = currentConfig();
  if (!cfg || !amIHost()) return;
  const isLobby = currentStatus() === 'lobby';

  document.querySelectorAll('#settings-modal [data-lobby-only]').forEach((n) => n.classList.toggle('hidden', !isLobby));

  el('set-aiCount').value = cfg.aiCount;
  el('set-aiCount-label').textContent = cfg.aiCount;
  el('set-startingStack').value = cfg.startingStack;
  el('set-startSb').value = cfg.startSb;
  el('set-startBb').value = cfg.startBb;
  el('set-levelMinutes').value = cfg.levelDurationMinutes;
  el('set-rebuyAmount').value = cfg.rebuyAmount;
  el('set-maxRebuys').value = cfg.maxRebuys;
  el('set-addOnAmount').value = cfg.addOnAmount;
  el('set-aiActionDelay').value = Math.round((cfg.aiActionDelayMs / 1000) * 10) / 10;
  el('set-aiMistake').value = Math.round(cfg.aiMistakeRate * 100);
  el('set-aiMistake-label').textContent = Math.round(cfg.aiMistakeRate * 100);

  el('settings-modal').classList.remove('hidden');
}
function closeSettingsModal() {
  el('settings-modal').classList.add('hidden');
}
el('btn-lobby-settings').addEventListener('click', openSettingsModal);
el('btn-table-settings').addEventListener('click', openSettingsModal);
el('btn-settings-cancel').addEventListener('click', closeSettingsModal);

el('btn-settings-save').addEventListener('click', () => {
  const isLobby = currentStatus() === 'lobby';
  const patch = {
    rebuyAmount: Number(el('set-rebuyAmount').value),
    maxRebuys: Number(el('set-maxRebuys').value),
    addOnAmount: Number(el('set-addOnAmount').value),
    aiActionDelayMs: Math.round(Number(el('set-aiActionDelay').value) * 1000),
    aiMistakeRate: Number(el('set-aiMistake').value) / 100,
  };
  if (isLobby) {
    patch.aiCount = Number(el('set-aiCount').value);
    patch.startingStack = Number(el('set-startingStack').value);
    patch.startSb = Number(el('set-startSb').value);
    patch.startBb = Number(el('set-startBb').value);
    patch.levelDurationMinutes = Number(el('set-levelMinutes').value);
  }
  socket.emit('updateSettings', patch, (res) => {
    if (!res.ok) return toast('설정 변경 실패: ' + res.error);
    toast('설정을 변경했어요');
    closeSettingsModal();
  });
});

// ---------- 애드온 ----------
el('btn-addon').addEventListener('click', () => {
  socket.emit('useAddOn', {}, (res) => {
    if (!res.ok) toast('애드온 실패: ' + res.error);
  });
});

// ---------- 소켓 연결/재연결 ----------
socket.on('connect', () => {
  if (myRoomId && myPlayerId) {
    socket.emit('rejoinRoom', { roomId: myRoomId, playerId: myPlayerId }, (res) => {
      if (res.ok) {
        latestLobby = res.lobby;
        if (res.lobby.status === 'lobby') {
          renderLobby();
          showScreen('screen-lobby');
        } else if (res.lobby.status === 'in_progress') {
          showScreen('screen-table');
        }
      } else {
        clearSession();
      }
    });
  }
});

// ---------- 소켓 이벤트 ----------
socket.on('lobbyState', (lobby) => {
  latestLobby = lobby;
  if (el('screen-lobby').classList.contains('active')) renderLobby();
});

socket.on('gameStarted', () => {
  showScreen('screen-table');
});

socket.on('state', (state) => {
  const isNewHand = latestState && state.handNumber !== latestState.handNumber;
  latestState = state;
  if (state.status === 'in_progress' || state.status === 'closed') {
    if (!el('screen-table').classList.contains('active') && state.status === 'in_progress') {
      showScreen('screen-table');
    }
    renderTable();
  }
  if (isNewHand) {
    hideResultModal();
  }
});

socket.on('blindLevel', (level) => {
  blindTickBase = { level, receivedAt: Date.now() };
  renderBlindInfo();
});

socket.on('handResult', (result) => {
  renderResultModal(result);
});

socket.on('awaitNextHand', ({ humanSeats }) => {
  awaitingConfirm = true;
  iAmReady = false;
  clearTimeout(resultAutoTimer);
  updateResultFooter(humanSeats || [], []);
});

socket.on('readyStateChanged', ({ readySeats }) => {
  if (!awaitingConfirm) return;
  const humanSeats = latestState ? latestState.seats.filter((s) => s && s.type === 'human').map((s) => s.seatIndex) : [];
  updateResultFooter(humanSeats, readySeats || []);
});

socket.on('rebuyRequired', ({ seatIndex }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    el('rebuy-modal').classList.remove('hidden');
  }
});

socket.on('rebuyResult', ({ seatIndex }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    el('rebuy-modal').classList.add('hidden');
  }
});

socket.on('addOnUsed', ({ seatIndex, amount }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    toast(`애드온으로 ${amount}칩을 받았어요`);
  }
});

socket.on('playerAction', (record) => {
  showActionBubble(record);
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

// ---------- 블라인드 정보 (실시간 카운트다운) ----------
function renderBlindInfo() {
  const level = blindTickBase ? blindTickBase.level : latestState && latestState.blindLevel;
  if (!level) return;
  let text = `블라인드 ${level.sb}/${level.bb}`;
  if (level.msRemaining != null && !level.isFinalLevel) {
    const elapsed = blindTickBase ? Date.now() - blindTickBase.receivedAt : 0;
    const remaining = Math.max(0, level.msRemaining - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    text += ` · 다음 레벨까지 ${m}:${String(s).padStart(2, '0')}`;
  }
  el('blind-info').textContent = text;
}
clearInterval(blindTickTimer);
blindTickTimer = setInterval(() => {
  if (latestState && latestState.status === 'in_progress') renderBlindInfo();
}, 1000);

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

// ---------- 테이블 렌더링 ----------
function renderTable() {
  const state = latestState;
  if (!state) return;

  lastRenderedHandNumber = state.handNumber;
  renderBlindInfo();
  el('pot-display').textContent = state.pot ? `팟 ${state.pot}` : '';

  const board = el('board-cards');
  board.innerHTML = '';
  (state.board || []).forEach((c) => board.appendChild(cardEl(c)));

  el('btn-addon').classList.toggle('hidden', !state.addOnAvailable);
  el('btn-table-settings').classList.toggle('hidden', !amIHost());

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
    seatDiv.dataset.seat = s.idx;
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
    if (s.position) {
      const badge = document.createElement('span');
      badge.className = 'pos-badge';
      badge.textContent = s.position;
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

    const stampDiv = document.createElement('div');
    stampDiv.className = 'fold-stamp';
    stampDiv.textContent = 'FOLD';
    seatDiv.appendChild(stampDiv);

    const bubble = activeBubbles[s.idx];
    if (bubble) {
      const bubbleDiv = document.createElement('div');
      bubbleDiv.className = 'action-bubble' + (bubble.cls ? ' ' + bubble.cls : '');
      bubbleDiv.textContent = bubble.text;
      seatDiv.appendChild(bubbleDiv);
    }

    container.appendChild(seatDiv);
  });

  updateActionBar(state);
}

function showActionBubble(record) {
  const cls = record.actionType === 'fold' ? 'fold-bubble' : record.actionType === 'allin' ? 'allin-bubble' : '';
  let text = ACTION_LABEL[record.actionType] || record.actionType;
  if ((record.actionType === 'call' || record.actionType === 'bet' || record.actionType === 'raise' || record.actionType === 'allin') && record.amount) {
    text += ` +${record.amount}`;
  }
  activeBubbles[record.seatIndex] = { text, cls };

  const seatDiv = document.querySelector(`.seat[data-seat="${record.seatIndex}"]`);
  if (seatDiv) {
    const old = seatDiv.querySelector('.action-bubble');
    if (old) old.remove();
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'action-bubble' + (cls ? ' ' + cls : '');
    bubbleDiv.textContent = text;
    seatDiv.appendChild(bubbleDiv);
  }

  clearTimeout(showActionBubble._timers && showActionBubble._timers[record.seatIndex]);
  showActionBubble._timers = showActionBubble._timers || {};
  showActionBubble._timers[record.seatIndex] = setTimeout(() => {
    delete activeBubbles[record.seatIndex];
    const sd = document.querySelector(`.seat[data-seat="${record.seatIndex}"] .action-bubble`);
    if (sd) sd.remove();
  }, 2200);
}

// ---------- 핸드 결과 모달 ----------
function seatDisplayName(seatIndex) {
  if (latestState && latestState.seats && latestState.seats[seatIndex]) {
    return latestState.seats[seatIndex].displayName;
  }
  return `좌석 ${seatIndex + 1}`;
}

function renderResultModal(result) {
  resultModalHandNumber = latestState ? latestState.handNumber : lastRenderedHandNumber;
  clearTimeout(resultAutoTimer);
  awaitingConfirm = false;
  iAmReady = false;

  const board = el('result-board');
  board.innerHTML = '';
  (result.board || []).forEach((c) => board.appendChild(cardEl(c)));

  const list = el('result-list');
  list.innerHTML = '';

  if (result.type === 'fold') {
    el('result-title').textContent = '핸드 결과 (폴드 종료)';
    Object.entries(result.winnings || {}).forEach(([seatIdxStr, amount]) => {
      const seatIdx = Number(seatIdxStr);
      const li = document.createElement('li');
      li.className = 'winner';
      li.innerHTML = `<div><div class="r-name">${escapeHtml(seatDisplayName(seatIdx))}</div><div class="r-hand">상대가 폴드하여 팟 획득</div></div><div class="r-amount">+${amount}</div>`;
      list.appendChild(li);
    });
  } else {
    el('result-title').textContent = '쇼다운 결과';
    (result.showdown || []).forEach((entry) => {
      const amount = (result.winnings && result.winnings[entry.seatIndex]) || 0;
      const li = document.createElement('li');
      if (amount > 0) li.className = 'winner';
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'r-cards';
      (entry.holeCards || []).forEach((c) => cardsWrap.appendChild(cardEl(c)));

      const left = document.createElement('div');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'r-name';
      nameDiv.textContent = seatDisplayName(entry.seatIndex);
      const handDiv = document.createElement('div');
      handDiv.className = 'r-hand';
      handDiv.textContent = entry.hand;
      left.appendChild(nameDiv);
      left.appendChild(cardsWrap);
      left.appendChild(handDiv);

      const amountDiv = document.createElement('div');
      amountDiv.className = 'r-amount';
      amountDiv.textContent = amount > 0 ? `+${amount}` : '-';

      li.appendChild(left);
      li.appendChild(amountDiv);
      list.appendChild(li);
    });
  }

  el('btn-result-next').classList.add('hidden');
  el('btn-result-next').disabled = false;
  el('btn-result-next').textContent = '다음 핸드 준비 완료';

  if (result.requiresConfirm) {
    el('result-hint').textContent = '모든 플레이어가 준비를 완료하면 다음 핸드가 시작됩니다.';
    el('btn-result-next').classList.remove('hidden');
    el('btn-result-close').classList.add('hidden'); // 준비 확인이 필요한 핸드는 버튼으로만 진행
  } else {
    el('result-hint').textContent = '잠시 후 다음 핸드가 자동으로 시작됩니다…';
    el('btn-result-close').classList.remove('hidden');
    resultAutoTimer = setTimeout(hideResultModal, 5200);
  }

  el('result-modal').classList.remove('hidden');
}

function updateResultFooter(humanSeats, readySeats) {
  if (!humanSeats.length) return;
  const readySet = new Set(readySeats);
  el('result-hint').textContent = `다음 핸드 준비: ${readySet.size}/${humanSeats.length}명 완료`;
  if (latestState && readySet.has(latestState.mySeatIndex)) {
    el('btn-result-next').disabled = true;
    el('btn-result-next').textContent = '준비 완료 (다른 플레이어 대기 중…)';
  }
}

function hideResultModal() {
  clearTimeout(resultAutoTimer);
  el('result-modal').classList.add('hidden');
  awaitingConfirm = false;
}

el('btn-result-close').addEventListener('click', hideResultModal);
el('btn-result-next').addEventListener('click', () => {
  iAmReady = true;
  el('btn-result-next').disabled = true;
  el('btn-result-next').textContent = '준비 완료 (다른 플레이어 대기 중…)';
  socket.emit('readyForNextHand', {}, () => {});
});

// ---------- 액션바 ----------
function alignRaiseTo100(value, legal) {
  let v = Math.round(value / 100) * 100;
  if (v < legal.minRaiseTo) v = Math.ceil(legal.minRaiseTo / 100) * 100;
  if (v > legal.maxRaiseTo) v = legal.maxRaiseTo;
  if (v < legal.minRaiseTo) v = legal.minRaiseTo;
  return v;
}

const POT_QUICK_PCTS = [0.3, 0.5, 0.7, 1.0, 1.5];

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
  const quickRow = el('quick-bet-row');
  quickRow.innerHTML = '';

  if (legal.canRaise) {
    const alignedMin = Math.ceil(legal.minRaiseTo / 100) * 100 <= legal.maxRaiseTo
      ? Math.ceil(legal.minRaiseTo / 100) * 100
      : legal.minRaiseTo;
    slider.min = alignedMin;
    slider.max = legal.maxRaiseTo;
    slider.value = alignedMin;
    el('raise-amount-label').textContent = alignedMin;
    slider.oninput = () => (el('raise-amount-label').textContent = slider.value);
    slider.parentElement.style.display = 'flex';

    // 플랍 이후에는 팟 비율 퀵버튼도 제공
    if (state.street && state.street !== 'preflop') {
      POT_QUICK_PCTS.forEach((pct) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = `팟 ${Math.round(pct * 100)}%`;
        btn.addEventListener('click', () => {
          const target = alignRaiseTo100(state.currentBet + state.pot * pct, legal);
          sendAction('raise', target);
        });
        quickRow.appendChild(btn);
      });
      quickRow.classList.remove('hidden');
    } else {
      quickRow.classList.add('hidden');
    }
  } else {
    slider.parentElement.style.display = 'none';
    quickRow.classList.add('hidden');
  }
}

el('btn-fold').addEventListener('click', () => sendAction('fold'));
el('btn-check').addEventListener('click', () => sendAction('check'));
el('btn-call').addEventListener('click', () => sendAction('call'));
el('btn-allin').addEventListener('click', () => sendAction('allin'));
el('btn-raise').addEventListener('click', () => {
  const legal = latestState && latestState.legalActions;
  const raw = Number(el('raise-slider').value);
  const amount = legal ? alignRaiseTo100(raw, legal) : raw;
  sendAction('raise', amount);
});

function sendAction(actionType, amount) {
  socket.emit('action', { actionType, amount }, (res) => {
    if (!res.ok) toast(res.error || '액션 실패');
  });
}
