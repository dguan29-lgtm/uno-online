const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const E = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const CHALLENGE_MS = 12000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> room

function roomCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => abc[crypto.randomInt(abc.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function pid() { return crypto.randomBytes(6).toString('hex'); }

function getPlayer(room, socketId) {
  return room.players.find(p => p.sid === socketId);
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, connected: p.connected, score: p.score, host: p.host };
}

function gameView(room, p) {
  const g = room.game;
  const view = {
    phase: room.phase,
    code: room.code,
    you: p.id,
    players: room.players.map(publicPlayer),
    host: room.players.find(x => x.host)?.id,
  };
  if (!g) return view;
  const nm = id => (room.players.find(x => x.id === id) || {}).name || '?';
  view.turn = E.turnPid(g);
  view.dir = g.dir;
  view.top = E.topCard(g);
  view.pile = g.discard.slice(-6);
  view.currentColor = g.currentColor;
  view.hand = g.hands[p.id] || [];
  view.handCounts = room.players.map(x => ({
    id: x.id, name: x.name, count: (g.hands[x.id] || []).length,
    connected: x.connected, vulnerable: !!g.vulnerable[x.id],
    unoShout: (g.hands[x.id] || []).length === 1 && !g.vulnerable[x.id],
  }));
  view.awaitColor = g.awaitColor;
  view.drewCardId = g.drewCardId;
  view.deckCount = g.deck.length;
  view.challenge = g.challenge
    ? { attacker: g.challenge.attacker, victim: g.challenge.victim, deadline: room.challengeDeadline }
    : null;
  view.winner = g.winner;
  view.winScore = g.winScore;
  view.log = g.log.slice(-8).map(e =>
    ((e.w ? nm(e.w) + ' ' : '') + e.m).replace('{X}', e.x ? nm(e.x) : ''));
  view.vulnerableSelf = !!g.vulnerable[p.id];
  view.unoDeclaredSelf = !!g.unoDeclared[p.id];
  return view;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.sid) io.to(p.sid).emit('state', gameView(room, p));
  }
  scheduleAuto(room);
}

// 行动后公共处理：质疑计时、胜负结算
function postAction(room) {
  const g = room.game;
  if (g && g.challenge) armChallengeTimer(room); else clearTimeout(room.challengeTimer);
  if (g && g.winner) {
    room.phase = 'over';
    const w = room.players.find(p => p.id === g.winner);
    if (w) w.score += g.winScore;
    clearTimeout(room.challengeTimer);
  }
}

// 断线玩家托管：若轮到 TA（或需选色/被质疑），自动行动
function scheduleAuto(room) {
  const g = room.game;
  if (!g || g.winner) return;
  const busy = g.awaitColor || (g.challenge && g.challenge.victim) || E.turnPid(g);
  const p = room.players.find(x => x.id === busy);
  if (!p || p.connected || room.autoTimer) return;
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (!g.winner && room.players.includes(p) && !p.connected) {
      E.autoAct(g, p.id);
      postAction(room);
      broadcast(room);
    }
  }, 1600);
}

function armChallengeTimer(room) {
  clearTimeout(room.challengeTimer);
  room.challengeDeadline = Date.now() + CHALLENGE_MS;
  room.challengeTimer = setTimeout(() => {
    const g = room.game;
    if (g && g.challenge) {
      E.resolveChallenge(g, g.challenge.victim, false); // 超时视为接受
      broadcast(room);
    }
  }, CHALLENGE_MS + 500);
}

function handleResult(room, res) {
  if (!res) return;
  if (!res.ok) return res.error;
  postAction(room);
  broadcast(room);
  return null;
}

function cleanup(room) {
  clearTimeout(room.autoTimer);
  clearTimeout(room.challengeTimer);
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const reply = (cb, obj) => { if (typeof cb === 'function') cb(obj); };

  socket.on('createRoom', ({ name } = {}, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return reply(cb, { ok: false, error: '请输入昵称' });
    const code = roomCode();
    const r = {
      code, phase: 'lobby', game: null,
      players: [], autoTimer: null, challengeTimer: null, challengeDeadline: 0,
    };
    const p = { id: pid(), sid: socket.id, name, connected: true, score: 0, host: true };
    r.players.push(p);
    rooms.set(code, r);
    room = r; me = p;
    reply(cb, { ok: true, code, you: p.id });
    broadcast(r);
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 12);
    const r = rooms.get(code);
    if (!r) return reply(cb, { ok: false, error: '房间不存在' });
    if (!name) return reply(cb, { ok: false, error: '请输入昵称' });

    // 断线重连：同名玩家恢复
    const old = r.players.find(p => p.name === name);
    if (old && !old.connected) {
      old.sid = socket.id;
      old.connected = true;
      room = r; me = old;
      reply(cb, { ok: true, code, you: old.id, rejoined: true });
      return broadcast(r);
    }
    if (old) return reply(cb, { ok: false, error: '昵称已被占用' });
    if (r.phase !== 'lobby') return reply(cb, { ok: false, error: '游戏已开始，无法加入' });
    if (r.players.length >= MAX_PLAYERS) return reply(cb, { ok: false, error: '房间已满（最多8人）' });

    const p = { id: pid(), sid: socket.id, name, connected: true, score: 0, host: false };
    r.players.push(p);
    room = r; me = p;
    reply(cb, { ok: true, code, you: p.id });
    broadcast(r);
  });

  socket.on('startGame', (cb) => {
    if (!room || !me || !me.host) return reply(cb, { ok: false, error: '只有房主可以开始' });
    const active = room.players.filter(p => p.connected);
    if (room.players.length < 2 || active.length < 2) return reply(cb, { ok: false, error: '至少需要2名玩家' });
    cleanup(room);
    room.players = active; // 不在线的不参与本局
    room.phase = 'playing';
    room.game = E.createGame(active.map(p => p.id));
    reply(cb, { ok: true });
    broadcast(room);
  });

  socket.on('restart', (cb) => {
    if (!room || !me || !me.host) return reply(cb, { ok: false, error: '只有房主可以操作' });
    if (room.phase !== 'over') return reply(cb, { ok: false, error: '本局还未结束' });
    const active = room.players.filter(p => p.connected);
    if (active.length < 2) return reply(cb, { ok: false, error: '玩家不足' });
    cleanup(room);
    room.players = active;
    room.phase = 'playing';
    room.game = E.createGame(active.map(p => p.id));
    reply(cb, { ok: true });
    broadcast(room);
  });

  const act = (cb, fn) => {
    if (!room || !me || !room.game) return reply(cb, { ok: false, error: '不在游戏中' });
    const err = handleResult(room, fn(room.game, me.id));
    reply(cb, { ok: !err, error: err || undefined });
  };

  socket.on('playCard', ({ cardId, color } = {}, cb) =>
    act(cb, (g, id) => E.playCard(g, id, cardId, color)));

  socket.on('drawCard', (cb) => act(cb, (g, id) => E.drawCard(g, id)));

  socket.on('passTurn', (cb) => act(cb, (g, id) => E.passTurn(g, id)));

  socket.on('sayUno', (cb) => act(cb, (g, id) => E.sayUno(g, id)));

  socket.on('chooseColor', ({ color } = {}, cb) =>
    act(cb, (g, id) => E.chooseColor(g, id, color)));

  socket.on('challengeResponse', ({ challenge } = {}, cb) => {
    if (!room || !me || !room.game) return reply(cb, { ok: false });
    clearTimeout(room.challengeTimer);
    act(cb, (g, id) => E.resolveChallenge(g, id, !!challenge));
  });

  socket.on('catchUno', ({ target } = {}, cb) =>
    act(cb, (g, id) => E.catchUno(g, id, target)));

  socket.on('leaveRoom', () => doLeave(true));

  socket.on('disconnect', () => doLeave(false));

  function doLeave(voluntary) {
    if (!room || !me) return;
    const r = room;
    // 游戏进行中离开一律按断线处理（保留座位可重连，轮到自动托管）
    const inGame = r.phase === 'playing' && r.game && !r.game.winner && r.game.order.includes(me.id);
    if (!inGame) {
      r.players = r.players.filter(p => p !== me);
      if (r.players.length === 0) {
        cleanup(r);
        rooms.delete(r.code);
      } else if (!r.players.some(p => p.host)) {
        const np = r.players.find(p => p.connected) || r.players[0];
        np.host = true;
      }
    } else {
      me.connected = false;
      me.sid = null;
      if (!r.players.some(p => p.host && p.connected)) {
        const np = r.players.find(p => p.connected);
        if (np) np.host = true;
      }
    }
    room = null; me = null;
    broadcast(r);
  }
});

server.listen(PORT, () => {
  console.log(`UNO server running: http://localhost:${PORT}`);
});
