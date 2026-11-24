// 引擎冒烟测试：随机模拟对局，校验不变量
const E = require('./game');

const COLORS = E.COLORS;
let failures = 0;

function assert(cond, msg, ctx) {
  if (!cond) { failures++; console.error('FAIL:', msg, ctx || ''); }
}

function totalCards(g) {
  let n = g.deck.length + g.discard.length;
  for (const p of g.order) n += g.hands[p].length;
  return n;
}

function simGame(nPlayers, maxSteps = 20000) {
  const ids = Array.from({ length: nPlayers }, (_, i) => 'p' + i);
  const g = E.createGame(ids);
  let steps = 0;
  while (!g.winner && steps++ < maxSteps) {
    assert(totalCards(g) === 108, `牌数不守恒: ${totalCards(g)}`);

    // 需要选色
    if (g.awaitColor) {
      const r = E.chooseColor(g, g.awaitColor, COLORS[Math.floor(Math.random() * 4)]);
      assert(r.ok, 'chooseColor 失败', r.error);
      continue;
    }
    // +4 质疑：50% 概率质疑
    if (g.challenge) {
      const r = E.resolveChallenge(g, g.challenge.victim, Math.random() < 0.5);
      assert(r.ok, 'resolveChallenge 失败', r.error);
      continue;
    }

    const pid = E.turnPid(g);
    const hand = g.hands[pid];

    // 剩2张时30%概率喊UNO
    if (hand.length === 2 && Math.random() < 0.3) E.sayUno(g, pid);

    // 抓UNO：若有可抓对象，30%概率抓
    const vuln = Object.keys(g.vulnerable).find(x => x !== pid);
    if (vuln && Math.random() < 0.3) {
      const r = E.catchUno(g, pid, vuln);
      assert(r.ok, 'catchUno 失败', r.error);
      continue;
    }

    if (g.drewCardId === null) {
      const playable = hand.filter(c => E.canPlay(g, c));
      if (playable.length && Math.random() < 0.85) {
        const c = playable[Math.floor(Math.random() * playable.length)];
        const color = c.color === 'wild' ? COLORS[Math.floor(Math.random() * 4)] : undefined;
        const r = E.playCard(g, pid, c.id, color);
        assert(r.ok, `playCard 失败: ${r.error}`, JSON.stringify(c));
      } else {
        const r = E.drawCard(g, pid);
        assert(r.ok, `drawCard 失败: ${r.error}`);
      }
    } else {
      const drew = hand.find(c => c.id === g.drewCardId);
      if (drew && E.canPlay(g, drew) && Math.random() < 0.6) {
        const color = drew.color === 'wild' ? COLORS[Math.floor(Math.random() * 4)] : undefined;
        const r = E.playCard(g, pid, drew.id, color);
        assert(r.ok, `出刚摸的牌失败: ${r.error}`);
      } else {
        const r = E.passTurn(g, pid);
        assert(r.ok, `passTurn 失败: ${r.error}`);
      }
    }
  }
  assert(g.winner, `超过 ${maxSteps} 步未分胜负 (${nPlayers}人)`);
  if (g.winner) assert(g.hands[g.winner].length === 0, '胜者手牌应为0');
  return g;
}

// 覆盖 2-8 人局
for (const n of [2, 3, 4, 5, 8]) {
  for (let i = 0; i < 40; i++) simGame(n);
}

// 专项：双人局反转=跳过
{
  const g = E.createGame(['a', 'b']);
  // 构造：a 出反转后仍应轮到 a
  g.discard = [{ id: 9999, color: 'red', type: 'num', value: 5 }];
  g.currentColor = 'red';
  g.hands.a = [{ id: 1, color: 'red', type: 'reverse' }];
  g.hands.b = [{ id: 2, color: 'red', type: 'num', value: 3 }];
  g.turnIdx = 0;
  const r = E.playCard(g, 'a', 1);
  assert(r.ok && E.turnPid(g) === 'a', '双人局反转后应仍轮到a');
}

// 专项：+2 叠加到下家
{
  const g = E.createGame(['a', 'b', 'c']);
  g.discard = [{ id: 9999, color: 'red', type: 'num', value: 5 }];
  g.currentColor = 'red';
  g.hands.a = [{ id: 1, color: 'red', type: 'draw2' }, { id: 3, color: 'red', type: 'num', value: 1 }];
  const before = g.hands.b.length;
  const r = E.playCard(g, 'a', 1);
  assert(r.ok && g.hands.b.length === before + 2 && E.turnPid(g) === 'c', '+2 应让b摸2张并轮到c');
}

console.log(failures === 0 ? '全部测试通过 ✓' : `发现 ${failures} 个问题`);
process.exit(failures ? 1 : 0);
