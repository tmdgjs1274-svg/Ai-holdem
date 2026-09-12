'use strict';

const socket = io();

const el = (id) => document.getElementById(id);
// 칩/금액 표시는 항상 천 단위 콤마를 넣어 보여준다 (입력 칸은 그대로 숫자만 받음)
function fmt(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}
const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED_SUITS = new Set(['h', 'd']);
const ACTION_LABEL = {
  fold: '폴드', check: '체크', call: '콜', bet: '베팅', raise: '레이즈', allin: '올인',
};

// ---------- 액션 음성 안내 (체크/레이즈/폴드만, 중저음 남자 목소리 느낌) ----------
// 브라우저 내장 Web Speech API를 사용하므로 별도 음원 파일이 필요 없지만,
// 음색(성별) 자체를 강제로 고를 수는 없어서 "남성"류 이름의 한국어 음성을 우선 선택하고
// 피치를 낮춰 중저음 느낌을 낸다 (브라우저/OS에 따라 결과가 다를 수 있음).
const VOICE_ACTION_TEXT = { check: '체크', fold: '폴드', raise: '레이즈' };
let cachedTtsVoice = null;
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { cachedTtsVoice = null; };
  // 크롬 계열 브라우저는 음성 합성 엔진이 한동안 가만히 있으면(화면이 꺼지거나 탭이
  // 백그라운드로 가는 등) 내부적으로 멈춰(paused) 그 뒤로 speak()를 불러도 조용히
  // 무시되는 알려진 버그가 있다. 주기적으로 resume()을 불러서 이를 방지한다.
  setInterval(() => {
    try { window.speechSynthesis.resume(); } catch (e) { /* 무시 */ }
  }, 5000);
}
// 모바일 브라우저 중 일부(특히 iOS 계열 WebKit)는 사용자가 직접 화면을 탭한 반응이 아니면
// speak()가 막혀있을 수 있다. 앱을 처음 터치하는 순간 짧은 발화를 한 번 시도해 이후의 액션
// 음성 안내가 막히지 않도록 미리 풀어둔다(브라우저에 따라 효과가 없을 수도 있음 - 아래 참고).
let ttsUnlocked = false;
function unlockTts() {
  if (ttsUnlocked || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  ttsUnlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0.01;
    window.speechSynthesis.speak(u);
  } catch (e) {
    // 무시: 잠금 해제가 실패해도 이후 시도에서 다시 자연스럽게 걸릴 수 있음
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', unlockTts, { once: true, passive: true });
  document.addEventListener('touchend', unlockTts, { once: true, passive: true });
}
function pickTtsVoice() {
  if (cachedTtsVoice) return cachedTtsVoice;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;
  const ko = voices.filter((v) => /^ko|kor/i.test(v.lang));
  const pool = ko.length ? ko : voices;
  const male = pool.find((v) => /male|남성|man\b/i.test(v.name) && !/female|여성/i.test(v.name));
  cachedTtsVoice = male || pool[0] || voices[0];
  return cachedTtsVoice;
}
// 테이블에 있는 사람들이 전부 폴드/아웃해서 이번 핸드가 AI끼리만 진행 중이면
// 아무도 듣지 않으므로 음성 안내를 생략한다.
function humanStillInHandNow() {
  if (!latestState || !Array.isArray(latestState.seats)) return true;
  return latestState.seats.some(
    (s) => s && s.type !== 'ai' && Array.isArray(s.holeCards) && s.holeCards.length > 0 && !s.folded
  );
}
// 실제 음성 합성 호출부. 예전에는 매번 speak() 전에 cancel()을 불렀는데, 일부 모바일
// 브라우저에서는 cancel() 직후의 speak()가 내부적으로 씹혀버리는(아무 소리도 안 나는) 경우가
// 보고되어 있어 제거했다 - 어차피 체크/레이즈/폴드는 짧은 한 단어라 자연스럽게 큐잉되어도 된다.
function speakText(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR';
    utter.pitch = 0.55; // 중저음 느낌을 위해 피치를 낮춤
    utter.rate = 1.05;
    const voice = pickTtsVoice();
    if (voice) utter.voice = voice;
    utter.onerror = (e) => {
      // 사용자에게는 조용히 무시하되, 개발자 콘솔에서는 원인을 확인할 수 있게 남겨둔다
      console.warn('[voice] 음성 재생 실패:', e && e.error);
    };
    window.speechSynthesis.speak(utter);
    return true;
  } catch (e) {
    console.warn('[voice] 음성 재생 예외:', e);
    return false;
  }
}
function speakAction(record) {
  const text = VOICE_ACTION_TEXT[record && record.actionType];
  if (!text) return; // 체크/레이즈/폴드가 아니면 소리 없음
  if (!humanStillInHandNow()) return; // 사람이 모두 죽고 AI끼리만 진행 중이면 생략
  speakText(text);
}
// 설정 화면의 "소리 테스트" 버튼에서 호출한다. 사용자가 직접 탭한 순간 곧바로 speak()를
// 호출하므로, 브라우저의 오디오 정책과 무관하게 소리가 나는지 그 자리에서 확인할 수 있다.
// 여기서도 안 들린다면 코드 문제라기보다 기기의 미디어 볼륨이 꺼져있거나, 브라우저/OS에
// 음성 합성(TTS) 엔진·한국어 음성 데이터가 설치되어 있지 않을 가능성이 크다.
function testVoice() {
  ttsUnlocked = true;
  const ok = speakText('체크, 레이즈, 폴드');
  if (!ok) toast('이 브라우저는 음성 합성을 지원하지 않아요');
}

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

// 보드 카드가 새로 늘어났을 때만 뒤집히는 애니메이션을 주기 위한 기준값
// (올인 쇼다운에서 한 장씩 순서대로 공개될 때도, 평소 스트리트 진행에도 동일하게 적용됨)
let lastBoardCount = 0;

// ---------- 화면 전환 ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  el(id).classList.add('active');
}

document.querySelectorAll('.btn-back').forEach((btn) => btn.addEventListener('click', () => showScreen('screen-home')));
el('btn-go-create').addEventListener('click', () => showScreen('screen-create'));
el('btn-go-join').addEventListener('click', () => showScreen('screen-join'));

// 방 코드가 채워진 링크(QR 스캔 등, ?join=코드)로 들어온 경우, 참가 화면으로 바로 이동하고
// 코드를 미리 입력해둔다. (기존에 진행 중이던 내 세션이 있다면 그 세션 재접속이 우선된다.)
(function handleJoinLinkParam() {
  const joinCode = new URLSearchParams(location.search).get('join');
  if (!joinCode) return;
  el('join-code').value = joinCode.toUpperCase();
  showScreen('screen-join');
  history.replaceState(null, '', location.pathname);
})();

el('create-aiCount').addEventListener('input', (e) => (el('ai-count-label').textContent = e.target.value));
el('create-aiMistake').addEventListener('input', (e) => (el('ai-mistake-label').textContent = e.target.value));
el('create-aiSkill').addEventListener('input', (e) => (el('ai-skill-label').textContent = e.target.value));
el('set-aiCount').addEventListener('input', (e) => (el('set-aiCount-label').textContent = e.target.value));
el('set-aiMistake').addEventListener('input', (e) => (el('set-aiMistake-label').textContent = e.target.value));
el('set-aiSkill').addEventListener('input', (e) => (el('set-aiSkill-label').textContent = e.target.value));

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
    aiSkillLevel: Number(el('create-aiSkill').value),
    startingStack: Number(el('create-startingStack').value),
    rebuyAmount: Number(el('create-rebuyAmount').value),
    startSb: Number(el('create-sb').value),
    startBb: Number(el('create-bb').value),
    levelDurationMinutes: Number(el('create-levelMinutes').value),
    bbAnte: el('create-bbAnte').checked,
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
// 방 코드가 입력된 채로 참가 화면으로 바로 이동하는 링크 (QR로 스캔했을 때 열리는 주소)
function joinUrlFor(roomId) {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(roomId)}`;
}

function renderLobby() {
  if (!latestLobby) return;
  el('lobby-roomcode').textContent = latestLobby.roomId;
  const qrData = encodeURIComponent(joinUrlFor(latestLobby.roomId));
  el('lobby-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=0&data=${qrData}`;
  const list = el('lobby-seats');
  list.innerHTML = '';
  latestLobby.seats.forEach((s, idx) => {
    const li = document.createElement('li');
    if (!s) {
      // 좌석 0(호스트) 이후의 빈 좌석은 전부 사람이 합류할 수 있는 자리다.
      li.innerHTML = `<span>좌석 ${idx + 1} (비어있음${idx >= 1 ? ' · 참가 대기' : ''})</span><span class="tag empty">-</span>`;
    } else {
      const tagClass = s.type === 'ai' ? 'ai' : '';
      li.innerHTML = `<span>${escapeHtml(s.displayName)} ${s.playerId === myPlayerId ? '(나)' : ''}</span><span class="tag ${tagClass}">${s.type === 'ai' ? 'AI' : '사람'} · ${fmt(s.stack)}</span>`;
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
  el('set-bbAnte').checked = cfg.bbAnte !== false;
  el('set-rebuyAmount').value = cfg.rebuyAmount;
  el('set-maxRebuys').value = cfg.maxRebuys;
  el('set-addOnAmount').value = cfg.addOnAmount;
  el('set-aiActionDelay').value = Math.round((cfg.aiActionDelayMs / 1000) * 10) / 10;
  el('set-aiMistake').value = Math.round(cfg.aiMistakeRate * 100);
  el('set-aiMistake-label').textContent = Math.round(cfg.aiMistakeRate * 100);
  el('set-aiSkill').value = cfg.aiSkillLevel;
  el('set-aiSkill-label').textContent = cfg.aiSkillLevel;

  el('settings-modal').classList.remove('hidden');
}
function closeSettingsModal() {
  el('settings-modal').classList.add('hidden');
}
el('btn-lobby-settings').addEventListener('click', openSettingsModal);
el('btn-table-settings').addEventListener('click', openSettingsModal);
el('btn-settings-cancel').addEventListener('click', closeSettingsModal);
el('btn-test-voice').addEventListener('click', testVoice);

el('btn-settings-save').addEventListener('click', () => {
  const isLobby = currentStatus() === 'lobby';
  const patch = {
    rebuyAmount: Number(el('set-rebuyAmount').value),
    maxRebuys: Number(el('set-maxRebuys').value),
    addOnAmount: Number(el('set-addOnAmount').value),
    aiActionDelayMs: Math.round(Number(el('set-aiActionDelay').value) * 1000),
    aiMistakeRate: Number(el('set-aiMistake').value) / 100,
    aiSkillLevel: Number(el('set-aiSkill').value),
    // 블라인드 상승 주기(레벨당 지속시간)는 게임 진행 중에도 바꿀 수 있다 (지금 레벨은 유지한 채
    // 그 순간부터 새 주기로 다시 카운트다운됨)
    levelDurationMinutes: Number(el('set-levelMinutes').value),
  };
  if (isLobby) {
    patch.aiCount = Number(el('set-aiCount').value);
    patch.startingStack = Number(el('set-startingStack').value);
    patch.startSb = Number(el('set-startSb').value);
    patch.startBb = Number(el('set-startBb').value);
    patch.bbAnte = el('set-bbAnte').checked;
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
    lastBoardCount = 0;
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

socket.on('rebuyRequired', ({ seatIndex, rebuysUsed, maxRebuys }) => {
  if (!latestState || seatIndex !== latestState.mySeatIndex) return;
  // 결과 모달과 별개의 팝업을 띄우지 않고, 이미 열려있는(또는 곧 열릴) 결과 모달 안에 이어서 표시한다.
  clearTimeout(resultAutoTimer);
  el('rebuy-msg').textContent = maxRebuys > 0
    ? `다시 리바인하고 계속 플레이하시겠어요? (리바인 ${rebuysUsed}/${maxRebuys}회 사용)`
    : '다시 리바인하고 계속 플레이하시겠어요?';
  el('result-rebuy').classList.remove('hidden');
  el('btn-result-next').classList.add('hidden');
  el('btn-result-close').classList.add('hidden');
  el('result-hint').textContent = '리바인 여부를 선택해주세요.';
  el('result-modal').classList.remove('hidden');
});

socket.on('rebuyResult', ({ seatIndex }) => {
  if (!latestState || seatIndex !== latestState.mySeatIndex) return;
  el('result-rebuy').classList.add('hidden');
  applyResultFooterState();
});

socket.on('addOnUsed', ({ seatIndex, amount }) => {
  if (latestState && seatIndex === latestState.mySeatIndex) {
    toast(`애드온으로 ${fmt(amount)}칩을 받았어요`);
  }
});

socket.on('aiRebuy', ({ seatIndex, stack }) => {
  toast(`${seatDisplayName(seatIndex)}이(가) 리바인했어요 (칩 ${fmt(stack)})`);
});

socket.on('playerAction', (record) => {
  showActionBubble(record);
  speakAction(record);
});

socket.on('playerLeft', ({ seatIndex }) => {
  const name = seatDisplayName(seatIndex);
  toast(`${name}님이 접속이 끊겨 게임에서 나갔습니다`);
});

socket.on('roomClosed', ({ reason }) => {
  hideResultModal();
  el('result-rebuy').classList.add('hidden');
  el('closed-msg').textContent = reason || '게임이 종료되었습니다.';
  el('closed-modal').classList.remove('hidden');
});

el('btn-rebuy-yes').addEventListener('click', () => {
  socket.emit('rebuyDecision', { accept: true }, () => {});
});
el('btn-rebuy-no').addEventListener('click', () => {
  socket.emit('rebuyDecision', { accept: false }, () => {});
});

// ---------- AI 리바인 (사람이 직접 클릭해서 결정) ----------
let pendingAiRebuySeat = null;

function openAiRebuyConfirm(seatIndex) {
  const s = latestState && latestState.seats && latestState.seats[seatIndex];
  const cfg = currentConfig();
  if (!s || !cfg) return;
  const used = s.rebuysUsed || 0;
  const canRebuy = used < cfg.maxRebuys;
  pendingAiRebuySeat = seatIndex;
  el('ai-rebuy-msg').textContent = canRebuy
    ? `${s.displayName}이(가) 파산했습니다. 리바인시켜서 계속 플레이하게 할까요? (리바인 ${used}/${cfg.maxRebuys}회 사용, 리바인 시 칩 ${fmt(cfg.rebuyAmount)})`
    : `${s.displayName}은(는) 최대 리바인 횟수(${cfg.maxRebuys}회)를 모두 사용해 더 이상 리바인할 수 없습니다.`;
  el('btn-ai-rebuy-yes').classList.toggle('hidden', !canRebuy);
  el('ai-rebuy-modal').classList.remove('hidden');
}

el('btn-ai-rebuy-yes').addEventListener('click', () => {
  if (pendingAiRebuySeat == null) return;
  socket.emit('aiRebuyDecision', { seatIndex: pendingAiRebuySeat, accept: true }, (res) => {
    if (!res.ok) toast(res.error || '리바인 실패');
  });
  el('ai-rebuy-modal').classList.add('hidden');
  pendingAiRebuySeat = null;
});
el('btn-ai-rebuy-no').addEventListener('click', () => {
  el('ai-rebuy-modal').classList.add('hidden');
  pendingAiRebuySeat = null;
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
// 블라인드 액수와 "다음 레벨까지 남은 시간"을 한 줄로 이어붙이면 가로로 너무 길어져서
// 팟 표시 아래 네모 박스가 커지고 뒤의 카드/좌석을 가린다는 피드백이 있어, 두 줄로 나눠 표시한다.
function renderBlindInfo() {
  const level = blindTickBase ? blindTickBase.level : latestState && latestState.blindLevel;
  if (!level) return;
  let line1 = `블라인드 ${fmt(level.sb)}/${fmt(level.bb)}`;
  if (level.ante > 0) line1 += ` (BB 앤티 ${fmt(level.ante)})`;
  let line2 = '';
  if (level.msRemaining != null && !level.isFinalLevel) {
    const elapsed = blindTickBase ? Date.now() - blindTickBase.receivedAt : 0;
    const remaining = Math.max(0, level.msRemaining - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    line2 = `다음 레벨까지 ${m}:${String(s).padStart(2, '0')}`;
  }
  const box = el('blind-info');
  box.innerHTML = '';
  const l1 = document.createElement('div');
  l1.textContent = line1;
  box.appendChild(l1);
  if (line2) {
    const l2 = document.createElement('div');
    l2.className = 'blind-info-timer';
    l2.textContent = line2;
    box.appendChild(l2);
  }
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
  el('pot-display').textContent = state.pot ? `팟 ${fmt(state.pot)}` : '';

  const board = el('board-cards');
  board.innerHTML = '';
  (state.board || []).forEach((c, i) => {
    const cardDiv = cardEl(c);
    if (i >= lastBoardCount) {
      // 새로 공개된 카드에만 뒤집히는 애니메이션을 준다(이미 있던 카드는 다시 애니메이션되지 않음)
      cardDiv.classList.add('card-flip-in');
      cardDiv.style.animationDelay = `${(i - lastBoardCount) * 90}ms`;
    }
    board.appendChild(cardDiv);
  });
  lastBoardCount = (state.board || []).length;

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

    // 파산해서 비활성화(sitting-out)된 AI 좌석: 더 이상 자동으로 리바인되지 않으므로,
    // 사람이 직접 클릭해서 리바인 여부를 결정하게 한다.
    const isBustedAi = s.type === 'ai' && s.isSittingOut && s.stack <= 0;
    // 아웃된(sitting-out) 좌석인데 위의 "탭해서 리바인" 케이스가 아닌 경우
    // (예: 사람이 파산해서 본인이 리바인 여부를 결정 중인 동안, 다른 사람 화면에 보이는 좌석)
    const isOtherSittingOut = !isBustedAi && s.isSittingOut;

    const seatDiv = document.createElement('div');
    seatDiv.className = 'seat'
      + (s.idx === state.actingSeat ? ' acting' : '')
      + (s.folded ? ' folded' : '')
      + (isBustedAi ? ' busted-ai' : '')
      + (isOtherSittingOut ? ' sitting-out' : '');
    seatDiv.dataset.seat = s.idx;
    if (isBustedAi) {
      seatDiv.addEventListener('click', () => openAiRebuyConfirm(s.idx));
    }
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
    stackDiv.textContent = `칩 ${fmt(s.stack)}${s.allIn ? ' (올인)' : ''}`;
    seatDiv.appendChild(stackDiv);

    if (s.committedThisStreet > 0) {
      const bet = document.createElement('div');
      bet.className = 'bet-chip';
      bet.textContent = `베팅 ${fmt(s.committedThisStreet)}`;
      seatDiv.appendChild(bet);
    }

    const stampDiv = document.createElement('div');
    stampDiv.className = 'fold-stamp';
    const rebuyCount = s.rebuysUsed || 0;
    if (isBustedAi) {
      stampDiv.textContent = rebuyCount > 0 ? `탭해서 리바인 (리바인 ${rebuyCount}회 사용)` : '탭해서 리바인';
    } else if (isOtherSittingOut) {
      stampDiv.textContent = rebuyCount > 0 ? `대기 중 (리바인 ${rebuyCount}회 사용)` : '대기 중';
    } else {
      stampDiv.textContent = 'FOLD';
    }
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
    text += ` +${fmt(record.amount)}`;
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

let lastResult = null; // rebuy 확인 뒤 하단 안내를 복원하기 위해 마지막 결과를 기억해둔다

function renderResultModal(result) {
  resultModalHandNumber = latestState ? latestState.handNumber : lastRenderedHandNumber;
  clearTimeout(resultAutoTimer);
  awaitingConfirm = false;
  iAmReady = false;
  lastResult = result;
  el('result-rebuy').classList.add('hidden');

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
      li.innerHTML = `<div><div class="r-name">${escapeHtml(seatDisplayName(seatIdx))}<span class="r-badge">승리</span></div><div class="r-hand">상대가 폴드하여 팟 획득</div></div><div class="r-amount">+${fmt(amount)}</div>`;
      list.appendChild(li);
    });
  } else {
    el('result-title').textContent = '쇼다운 결과';
    // 누가 어떤 핸드로 이기고 졌는지 한눈에 비교할 수 있도록, 획득한 금액이 큰 순서(승자 먼저)로 정렬한다.
    const entries = (result.showdown || []).slice().sort((a, b) => {
      const wa = (result.winnings && result.winnings[a.seatIndex]) || 0;
      const wb = (result.winnings && result.winnings[b.seatIndex]) || 0;
      return wb - wa;
    });
    entries.forEach((entry) => {
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
      if (amount > 0) {
        const badge = document.createElement('span');
        badge.className = 'r-badge';
        badge.textContent = '승리';
        nameDiv.appendChild(badge);
      }
      const handDiv = document.createElement('div');
      handDiv.className = 'r-hand';
      handDiv.textContent = entry.hand;
      left.appendChild(nameDiv);
      left.appendChild(cardsWrap);
      left.appendChild(handDiv);

      const amountDiv = document.createElement('div');
      amountDiv.className = 'r-amount';
      amountDiv.textContent = amount > 0 ? `+${fmt(amount)}` : '패배';

      li.appendChild(left);
      li.appendChild(amountDiv);
      list.appendChild(li);
    });
  }

  applyResultFooterState();
  el('result-modal').classList.remove('hidden');
}

// 결과 화면 하단(자동 진행 안내 / 다음 핸드 준비 버튼)을 마지막 결과 기준으로 다시 그린다.
// 리바인 확인이 끝난 뒤 원래 안내로 복귀할 때도 재사용한다.
function applyResultFooterState() {
  if (!lastResult) return;
  el('btn-result-next').classList.add('hidden');
  el('btn-result-next').disabled = false;
  el('btn-result-next').textContent = '다음 핸드 준비 완료';

  if (lastResult.requiresConfirm) {
    el('result-hint').textContent = '모든 플레이어가 준비를 완료하면 다음 핸드가 시작됩니다.';
    el('btn-result-next').classList.remove('hidden');
    el('btn-result-close').classList.add('hidden'); // 준비 확인이 필요한 핸드는 버튼으로만 진행
  } else {
    el('result-hint').textContent = '잠시 후 다음 핸드가 자동으로 시작됩니다…';
    el('btn-result-close').classList.remove('hidden');
    resultAutoTimer = setTimeout(hideResultModal, 5200);
  }
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
  el('result-rebuy').classList.add('hidden');
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

// 슬라이더와 직접입력 칸의 값을 항상 같이 맞춰준다.
function setRaiseAmount(v) {
  el('raise-slider').value = v;
  el('raise-amount-input').value = v;
}

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
  el('btn-call').textContent = legal.canCall ? `콜 (${fmt(legal.callAmount)})` : '콜';
  el('btn-raise').style.display = legal.canRaise ? 'block' : 'none';

  const slider = el('raise-slider');
  const amountInput = el('raise-amount-input');
  const quickRow = el('quick-bet-row');
  const potRaiseWrap = el('pot-raise-wrap');
  quickRow.innerHTML = '';
  quickRow.classList.add('hidden');

  if (legal.canRaise) {
    const alignedMin = Math.ceil(legal.minRaiseTo / 100) * 100 <= legal.maxRaiseTo
      ? Math.ceil(legal.minRaiseTo / 100) * 100
      : legal.minRaiseTo;
    slider.min = alignedMin;
    slider.max = legal.maxRaiseTo;
    amountInput.min = alignedMin;
    amountInput.max = legal.maxRaiseTo;
    setRaiseAmount(alignedMin);
    slider.disabled = false;
    amountInput.disabled = false;
    slider.parentElement.style.display = 'flex';

    // 플랍 이후에는 팟 비율 퀵버튼을 레이즈/올인 버튼 사이의 콤보로 제공
    if (state.street && state.street !== 'preflop') {
      POT_QUICK_PCTS.forEach((pct) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = `팟 ${Math.round(pct * 100)}%`;
        btn.addEventListener('click', () => {
          const target = alignRaiseTo100(state.currentBet + state.pot * pct, legal);
          quickRow.classList.add('hidden');
          sendAction('raise', target);
        });
        quickRow.appendChild(btn);
      });
      potRaiseWrap.classList.remove('hidden');
    } else {
      potRaiseWrap.classList.add('hidden');
    }
  } else {
    slider.disabled = true;
    amountInput.disabled = true;
    slider.parentElement.style.display = 'none';
    potRaiseWrap.classList.add('hidden');
  }
}

el('btn-fold').addEventListener('click', () => sendAction('fold'));
el('btn-check').addEventListener('click', () => sendAction('check'));
el('btn-call').addEventListener('click', () => sendAction('call'));
el('btn-allin').addEventListener('click', () => sendAction('allin'));
el('btn-raise').addEventListener('click', () => {
  const legal = latestState && latestState.legalActions;
  const raw = Number(el('raise-amount-input').value);
  const amount = legal ? alignRaiseTo100(raw, legal) : raw;
  sendAction('raise', amount);
});

// ---------- 베팅 금액 직접 조작: 슬라이더 <-> +/- 스테퍼 <-> 직접입력 3방향 동기화 ----------
el('raise-slider').addEventListener('input', () => {
  el('raise-amount-input').value = el('raise-slider').value;
});
el('btn-raise-minus').addEventListener('click', () => {
  const legal = latestState && latestState.legalActions;
  if (!legal) return;
  const current = Number(el('raise-amount-input').value) || Number(el('raise-slider').value) || 0;
  setRaiseAmount(alignRaiseTo100(current - 100, legal));
});
el('btn-raise-plus').addEventListener('click', () => {
  const legal = latestState && latestState.legalActions;
  if (!legal) return;
  const current = Number(el('raise-amount-input').value) || Number(el('raise-slider').value) || 0;
  setRaiseAmount(alignRaiseTo100(current + 100, legal));
});
el('raise-amount-input').addEventListener('input', () => {
  // 타이핑 중에는 100단위 정렬을 강제하지 않고 슬라이더만 실시간으로 맞춰준다.
  // (정렬은 change/blur 시점에만 적용해야 입력이 편함)
  const v = Number(el('raise-amount-input').value);
  if (!Number.isNaN(v)) el('raise-slider').value = v;
});
el('raise-amount-input').addEventListener('change', () => {
  const legal = latestState && latestState.legalActions;
  if (!legal) return;
  const v = Number(el('raise-amount-input').value) || legal.minRaiseTo;
  setRaiseAmount(alignRaiseTo100(v, legal));
});

// ---------- 팟레이즈 콤보 드롭다운: 토글 + 바깥 클릭 시 닫기 ----------
el('btn-pot-raise').addEventListener('click', (e) => {
  e.stopPropagation();
  el('quick-bet-row').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  const wrap = el('pot-raise-wrap');
  if (wrap && !wrap.contains(e.target)) el('quick-bet-row').classList.add('hidden');
});

function sendAction(actionType, amount) {
  socket.emit('action', { actionType, amount }, (res) => {
    if (!res.ok) toast(res.error || '액션 실패');
  });
}
