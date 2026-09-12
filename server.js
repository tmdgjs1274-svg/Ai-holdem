'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TableManager, generateRoomCode } = require('./src/session/TableManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/** roomId -> TableManager */
const rooms = new Map();
/** socket.id -> { roomId, playerId } */
const socketMeta = new Map();

function newPlayerId() {
  return crypto.randomUUID();
}

function broadcastState(table) {
  const sockets = io.sockets.adapter.rooms.get(table.roomId);
  if (!sockets) return;
  for (const socketId of sockets) {
    const meta = socketMeta.get(socketId);
    if (!meta) continue;
    io.to(socketId).emit('state', table.getPublicState(meta.playerId));
  }
}

function broadcastLobby(table) {
  io.to(table.roomId).emit('lobbyState', table.getLobbyState());
}

function attachTableEvents(table) {
  table.on('state', () => broadcastState(table));
  // 올인 쇼다운 카드를 한 장씩 순서대로 공개하는 중간 스냅샷. 일반 state 이벤트와 달리
  // "지금 엔진의 실제 상태"가 아니라 그중 일부(보드 카드 수)만 담은 스냅샷이므로,
  // broadcastState(table)로 다시 계산하지 않고 전달받은 보드로 각자에게 맞춰 내려보낸다.
  table.on('boardReveal', ({ board }) => {
    const sockets = io.sockets.adapter.rooms.get(table.roomId);
    if (!sockets) return;
    for (const socketId of sockets) {
      const meta = socketMeta.get(socketId);
      if (!meta) continue;
      io.to(socketId).emit('state', table.getPublicState(meta.playerId, board));
    }
  });
  table.on('gameStarted', () => {
    broadcastLobby(table);
    broadcastState(table);
  });
  table.on('handResult', (result) => io.to(table.roomId).emit('handResult', result));
  table.on('blindLevel', (level) => io.to(table.roomId).emit('blindLevel', level));
  table.on('playerJoined', () => broadcastLobby(table));
  table.on('playerDisconnected', () => broadcastLobby(table));
  table.on('playerLeft', (payload) => {
    io.to(table.roomId).emit('playerLeft', payload);
    broadcastLobby(table);
  });
  table.on('rebuyRequired', (payload) => {
    io.to(table.roomId).emit('rebuyRequired', payload);
    const targetSocketId = findSocketByPlayer(table.roomId, payload.playerId);
    if (targetSocketId) io.to(targetSocketId).emit('yourRebuyDecision', { seatIndex: payload.seatIndex });
  });
  table.on('rebuyResult', (payload) => io.to(table.roomId).emit('rebuyResult', payload));
  table.on('aiRebuy', (payload) => io.to(table.roomId).emit('aiRebuy', payload));
  table.on('addOnUsed', (payload) => io.to(table.roomId).emit('addOnUsed', payload));
  table.on('playerAction', (payload) => io.to(table.roomId).emit('playerAction', payload));
  table.on('awaitNextHand', (payload) => io.to(table.roomId).emit('awaitNextHand', payload));
  table.on('readyStateChanged', (payload) => io.to(table.roomId).emit('readyStateChanged', payload));
  table.on('configUpdated', () => {
    broadcastLobby(table);
    if (table.status === 'in_progress') broadcastState(table);
  });
  table.on('roomClosed', (payload) => {
    io.to(table.roomId).emit('roomClosed', payload);
    rooms.delete(table.roomId);
  });
}

function findSocketByPlayer(roomId, playerId) {
  const sockets = io.sockets.adapter.rooms.get(roomId);
  if (!sockets) return null;
  for (const socketId of sockets) {
    const meta = socketMeta.get(socketId);
    if (meta && meta.playerId === playerId) return socketId;
  }
  return null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', (opts, cb) => {
    try {
      const playerId = newPlayerId();
      const table = new TableManager({
        hostId: playerId,
        hostName: (opts && opts.hostName) || '호스트',
        aiCount: clampInt(opts && opts.aiCount, 0, 8, 3),
        startingStack: clampInt(opts && opts.startingStack, 100, 10000000, 20000),
        rebuyAmount: clampInt(opts && opts.rebuyAmount, 100, 10000000, 30000),
        startSb: clampInt(opts && opts.startSb, 1, 100000, 100),
        startBb: clampInt(opts && opts.startBb, 2, 200000, 200),
        levelDurationMinutes: clampInt(opts && opts.levelDurationMinutes, 0, 180, 5),
        bbAnte: opts ? opts.bbAnte !== false : true,
        aiMistakeRate: clampFloat(opts && opts.aiMistakeRate, 0, 0.4, 0.08),
        aiSkillLevel: clampInt(opts && opts.aiSkillLevel, 0, 100, 75),
        aiActionDelayMs: clampInt(opts && opts.aiActionDelayMs, 0, 15000, 1500),
        maxRebuys: clampInt(opts && opts.maxRebuys, 0, 999, 1),
        addOnAmount: clampInt(opts && opts.addOnAmount, 0, 10000000, 0),
      });
      // 방 코드가 4자리라 다른 방과 우연히 겹칠 수 있으니, 이미 쓰이고 있는 코드면 다시 뽑는다.
      while (rooms.has(table.roomId)) {
        table.roomId = generateRoomCode();
      }
      attachTableEvents(table);
      rooms.set(table.roomId, table);
      socket.join(table.roomId);
      socketMeta.set(socket.id, { roomId: table.roomId, playerId });
      cb && cb({ ok: true, roomId: table.roomId, playerId, seatIndex: 0, lobby: table.getLobbyState() });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('joinRoom', ({ roomId, displayName }, cb) => {
    try {
      const table = rooms.get((roomId || '').toUpperCase());
      if (!table) throw new Error('존재하지 않는 방 코드입니다');
      const playerId = newPlayerId();
      const seatIndex = table.addGuest(playerId, displayName);
      socket.join(table.roomId);
      socketMeta.set(socket.id, { roomId: table.roomId, playerId });
      cb && cb({ ok: true, roomId: table.roomId, playerId, seatIndex, lobby: table.getLobbyState() });
      broadcastLobby(table);
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('rejoinRoom', ({ roomId, playerId }, cb) => {
    try {
      const table = rooms.get((roomId || '').toUpperCase());
      if (!table) throw new Error('방을 찾을 수 없습니다 (이미 종료되었을 수 있습니다)');
      const seatIndex = table.reconnect(playerId);
      if (seatIndex == null) throw new Error('이 방의 참가자가 아닙니다');
      socket.join(table.roomId);
      socketMeta.set(socket.id, { roomId: table.roomId, playerId });
      cb && cb({ ok: true, roomId: table.roomId, playerId, seatIndex, lobby: table.getLobbyState() });
      broadcastState(table);
      // 접속이 끊긴 사이 놓쳤을 수 있는 "한 번뿐인" 이벤트(핸드 결과 / 리바인 요청 / 다음 핸드 대기)를
      // 재접속한 이 소켓에게만 다시 보내준다. 이게 없으면 결과 확인 화면을 놓친 채로 재접속했을 때
      // 클라이언트가 그 상태를 복구할 방법이 없어 게임이 멈춘 것처럼 보이는 문제가 있었다.
      const extras = table.getReconnectExtras(playerId);
      if (extras) {
        if (extras.handResult) socket.emit('handResult', extras.handResult);
        if (extras.rebuyRequired) socket.emit('rebuyRequired', extras.rebuyRequired);
        if (extras.awaitNextHand) socket.emit('awaitNextHand', extras.awaitNextHand);
      }
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('startGame', (_, cb) => {
    withTable(socket, cb, (table, meta) => {
      if (meta.playerId !== table.hostId) throw new Error('호스트만 게임을 시작할 수 있습니다');
      table.start();
      cb && cb({ ok: true });
    });
  });

  socket.on('action', ({ actionType, amount }, cb) => {
    withTable(socket, cb, (table, meta) => {
      table.handleAction(meta.playerId, actionType, amount);
      cb && cb({ ok: true });
    });
  });

  socket.on('rebuyDecision', ({ accept }, cb) => {
    withTable(socket, cb, (table, meta) => {
      table.handleRebuyDecision(meta.playerId, !!accept);
      cb && cb({ ok: true });
    });
  });

  socket.on('aiRebuyDecision', ({ seatIndex, accept }, cb) => {
    withTable(socket, cb, (table, meta) => {
      const result = table.handleAiRebuyDecision(meta.playerId, seatIndex, !!accept);
      cb && cb({ ok: true, result });
    });
  });

  socket.on('closeRoom', (_, cb) => {
    withTable(socket, cb, (table, meta) => {
      table.closeByHost(meta.playerId);
      cb && cb({ ok: true });
    });
  });

  socket.on('updateSettings', (patch, cb) => {
    withTable(socket, cb, (table, meta) => {
      const config = table.updateConfig(meta.playerId, patch || {});
      cb && cb({ ok: true, config });
    });
  });

  socket.on('useAddOn', (_, cb) => {
    withTable(socket, cb, (table, meta) => {
      table.useAddOn(meta.playerId);
      cb && cb({ ok: true });
    });
  });

  socket.on('readyForNextHand', (_, cb) => {
    withTable(socket, cb, (table, meta) => {
      table.handleReadyForNextHand(meta.playerId);
      cb && cb({ ok: true });
    });
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const table = rooms.get(meta.roomId);
    if (table) table.disconnect(meta.playerId);
  });

  function withTable(socket, cb, fn) {
    try {
      const meta = socketMeta.get(socket.id);
      if (!meta) throw new Error('방에 참가하지 않은 상태입니다');
      const table = rooms.get(meta.roomId);
      if (!table) throw new Error('방을 찾을 수 없습니다');
      fn(table, meta);
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  }
});

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, def) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`홀덤 AI 서버 실행 중: http://localhost:${PORT}`);
});

module.exports = { app, server, io };
