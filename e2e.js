// 端到端测试：两名真实 socket 客户端打完一局
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const COLORS = ['red', 'yellow', 'green', 'blue'];

const p = (name) => new Promise((res, rej) => {
  const s = io(URL);
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emit = (s, ev, data) => new Promise(res =>
  data === undefined ? s.emit(ev, res) : s.emit(ev, data, res));

function canPlay(v, c) {
  if (c.color === 'wild') return true;
  if (v.currentColor && c.color === v.currentColor) return true;
  const t = v.top;
  if (c.type === 'num' && t.type === 'num' && c.value === t.value) return true;
  if (c.type !== 'num' && t.type !== 'num' && c.type === t.type) return true;
  return false;
}

async function main() {
  const A = await p('A'), B = await p('B');
  const views = { A: null, B: null };
  A.on('state', v => views.A = v);
  B.on('state', v => views.B = v);

  const r1 = await emit(A, 'createRoom', { name: '甲' });
  console.log('createRoom:', r1);
  const r2 = await emit(B, 'joinRoom', { code: r1.code, name: '乙' });
  console.log('joinRoom:', r2);
  const r3 = await emit(A, 'startGame');
  console.log('startGame:', r3);

  const sockets = { A, B };
  const ids = {};
  await new Promise(r => setTimeout(r, 300));
  ids[views.A.you] = 'A'; ids[views.B.you] = 'B';

  for (let i = 0; i < 5000; i++) {
    const v = views.A.you === views.A.turn ? views.A : views.B;
    const me = v.turn === views.A.you ? 'A' : 'B';
    const s = sockets[me];
    if (v.winner) break;
    if (v.awaitColor === v.you) { await emit(s, 'chooseColor', { color: 'red' }); continue; }
    if (v.challenge && v.challenge.victim === v.you) { await emit(s, 'challengeResponse', { challenge: false }); continue; }
    if (v.turn !== v.you) { await new Promise(r => setTimeout(r, 50)); continue; }

    if (v.hand.length === 2) await emit(s, 'sayUno');
    if (v.drewCardId === null) {
      const c = v.hand.find(x => canPlay(v, x));
      if (c) await emit(s, 'playCard', { cardId: c.id, color: c.color === 'wild' ? COLORS[i % 4] : undefined });
      else await emit(s, 'drawCard');
    } else {
      const drew = v.hand.find(x => x.id === v.drewCardId);
      if (drew && canPlay(v, drew)) await emit(s, 'playCard', { cardId: drew.id, color: drew.color === 'wild' ? 'blue' : undefined });
      else await emit(s, 'passTurn');
    }
    await new Promise(r => setTimeout(r, 20));
  }

  const v = views.A.winner ? views.A : views.B;
  console.log('winner:', v.winner, '(A=' + views.A.you + ' B=' + views.B.you + ')', 'phase:', v.phase);
  const r4 = await emit(A, 'restart');
  console.log('restart:', r4, 'newPhase:', views.A.phase);
  A.close(); B.close();
  process.exit(v.winner ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
