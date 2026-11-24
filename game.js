// UNO 经典规则引擎（纯逻辑，不依赖 socket）
// 108 张牌：4 色 x (1张0 + 2张1-9 + 2张跳过 + 2张反转 + 2张+2) + 4张变色 + 4张+4

const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_NAMES = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };

let nextId = 1;
function mkCard(color, type, value) {
  return { id: nextId++, color, type, value: value === undefined ? null : value };
}

function buildDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push(mkCard(c, 'num', 0));
    for (let v = 1; v <= 9; v++) { d.push(mkCard(c, 'num', v)); d.push(mkCard(c, 'num', v)); }
    for (const t of ['skip', 'reverse', 'draw2']) { d.push(mkCard(c, t)); d.push(mkCard(c, t)); }
  }
  for (let i = 0; i < 4; i++) { d.push(mkCard('wild', 'wild')); d.push(mkCard('wild', 'wild4')); }
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mod(n, m) { return ((n % m) + m) % m; }

function topCard(g) { return g.discard[g.discard.length - 1]; }
function turnPid(g) { return g.order[g.turnIdx]; }
function nextPid(g) { return g.order[mod(g.turnIdx + g.dir, g.order.length)]; }

function drawFromDeck(g, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!g.deck.length) {
      // 摸牌堆用尽：保留顶牌，其余洗回
      const top = g.discard.pop();
      g.deck = shuffle(g.discard);
      g.discard = top ? [top] : [];
      if (!g.deck.length) break;
    }
    out.push(g.deck.pop());
  }
  return out;
}

function give(g, pid, n) {
  const cards = drawFromDeck(g, n);
  g.hands[pid].push(...cards);
  return cards;
}

function cardPoints(c) {
  if (c.type === 'num') return c.value;
  if (c.type === 'wild' || c.type === 'wild4') return 50;
  return 20;
}

function cardName(c) {
  if (c.type === 'num') return `${COLOR_NAMES[c.color]}${c.value}`;
  if (c.type === 'skip') return `${COLOR_NAMES[c.color]}跳过`;
  if (c.type === 'reverse') return `${COLOR_NAMES[c.color]}反转`;
  if (c.type === 'draw2') return `${COLOR_NAMES[c.color]}+2`;
  if (c.type === 'wild4') return '+4变色';
  return '变色';
}

function canPlay(g, c) {
  const top = topCard(g);
  if (c.color === 'wild') return true;
  if (g.currentColor && c.color === g.currentColor) return true;
  if (c.type === 'num' && top.type === 'num' && c.value === top.value) return true;
  if (c.type !== 'num' && top.type !== 'num' && c.type === top.type) return true;
  return false;
}

// order: [pid, ...] 按加入顺序；返回 game 状态对象
function createGame(order) {
  const g = {
    deck: shuffle(buildDeck()),
    discard: [],
    hands: {},
    order: [...order],
    dir: 1,
    turnIdx: 0,
    currentColor: null,
    awaitColor: null,      // pid 需要选颜色（出变色牌 / 开局翻出变色牌）
    pendingWild4: false,   // awaitColor 是为 +4 选色
    wild4Guilty: false,    // 出 +4 时手里是否有同色牌（用于质疑判定）
    startWild: false,      // 开局顶牌是变色，由首玩家选色
    challenge: null,       // { attacker, victim, guilty }
    drewCardId: null,      // 本回合摸到的牌（只能出它或跳过）
    unoDeclared: {},       // pid -> true，出牌时消耗
    vulnerable: {},        // pid -> true，剩1张且没喊UNO，可被抓
    winner: null,
    winScore: 0,
    log: [],
  };
  for (const p of order) g.hands[p] = drawFromDeck(g, 7);

  // 翻开局牌：+4 放回重洗
  let top;
  while (true) {
    top = g.deck.pop();
    if (top.type === 'wild4') { g.deck.push(top); g.deck = shuffle(g.deck); continue; }
    break;
  }
  g.discard.push(top);
  g.log.push({ w: null, m: `开局翻出 ${cardName(top)}` });

  const first = order[0];
  if (top.type === 'wild') {
    g.startWild = true;
    g.awaitColor = first; // 首玩家选色后再出牌
  } else {
    g.currentColor = top.color;
    if (top.type === 'skip') { advance(g, 1); }
    else if (top.type === 'reverse') { g.dir *= -1; }
    else if (top.type === 'draw2') { give(g, first, 2); advance(g, 1); }
  }
  return g;
}

function advance(g, steps) {
  g.turnIdx = mod(g.turnIdx + g.dir * steps, g.order.length);
}

function err(msg) { return { ok: false, error: msg }; }
function ok(extra) { return Object.assign({ ok: true }, extra); }

// 轮到的人行动后，上一家“没喊UNO”的窗口关闭
function closeCatchWindow(g) { g.vulnerable = {}; }

function playCard(g, pid, cardId, color) {
  if (g.winner) return err('本局已结束');
  if (g.awaitColor) return err('等待选择颜色');
  if (g.challenge) return err('等待质疑结果');
  if (turnPid(g) !== pid) return err('还没轮到你');
  const hand = g.hands[pid];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx < 0) return err('没有这张牌');
  const c = hand[idx];
  if (g.drewCardId !== null && c.id !== g.drewCardId) return err('摸牌后只能出刚摸的牌，或选择跳过');
  if (!canPlay(g, c)) return err('这张牌不能出');
  if ((c.type === 'wild' || c.type === 'wild4') && !COLORS.includes(color)) return err('请选择颜色');

  closeCatchWindow(g);
  hand.splice(idx, 1);
  g.discard.push(c);
  g.drewCardId = null;
  if (c.color !== 'wild') g.currentColor = c.color;
  const declared = !!g.unoDeclared[pid];
  g.unoDeclared[pid] = false;
  g.log.push({ w: pid, m: `出了 ${cardName(c)}` });

  if (hand.length === 0) {
    // 经典规则：最后一张是+2/+4，下家仍须摸牌并计入得分
    if (c.type === 'draw2') give(g, nextPid(g), 2);
    else if (c.type === 'wild4') give(g, nextPid(g), 4);
    g.winner = pid;
    g.winScore = g.order.reduce((s, p) => s + (p === pid ? 0 : g.hands[p].reduce((a, x) => a + cardPoints(x), 0)), 0);
    return ok({ event: 'win' });
  }
  if (hand.length === 1 && !declared) g.vulnerable[pid] = true;

  switch (c.type) {
    case 'num': advance(g, 1); break;
    case 'skip': advance(g, 2); break;
    case 'reverse':
      if (g.order.length === 2) advance(g, 2); // 双人局反转=跳过
      else { g.dir *= -1; advance(g, 1); }
      break;
    case 'draw2': {
      const v = nextPid(g);
      give(g, v, 2);
      advance(g, 2);
      break;
    }
    case 'wild':
      if (color) { g.currentColor = color; g.log.push({ w: pid, m: `选择了${COLOR_NAMES[color]}` }); advance(g, 1); }
      else { g.awaitColor = pid; g.pendingWild4 = false; }
      break;
    case 'wild4':
      g.wild4Guilty = hand.some(x => x.color === g.currentColor);
      if (color) {
        g.currentColor = color;
        g.log.push({ w: pid, m: `选择了${COLOR_NAMES[color]}` });
        g.challenge = { attacker: pid, victim: nextPid(g), guilty: g.wild4Guilty };
      } else { g.awaitColor = pid; g.pendingWild4 = true; }
      break;
  }
  return ok({});
}

function chooseColor(g, pid, color) {
  if (g.awaitColor !== pid) return err('现在不需要你选颜色');
  if (!COLORS.includes(color)) return err('颜色无效');
  g.currentColor = color;
  g.awaitColor = null;
  g.log.push({ w: pid, m: `选择了${COLOR_NAMES[color]}` });
  if (g.startWild) { g.startWild = false; return ok({}); } // 仍由首玩家出牌
  if (g.pendingWild4) {
    g.pendingWild4 = false;
    g.challenge = { attacker: pid, victim: nextPid(g), guilty: g.wild4Guilty };
    return ok({ event: 'challenge' });
  }
  advance(g, 1);
  return ok({});
}

// challenged: 受害者是否选择质疑
function resolveChallenge(g, pid, challenged) {
  const ch = g.challenge;
  if (!ch || ch.victim !== pid) return err('无需处理');
  closeCatchWindow(g);
  g.challenge = null;
  if (!challenged) {
    give(g, ch.victim, 4);
    g.log.push({ w: ch.victim, m: '接受 +4，摸4张并跳过' });
    advance(g, 2); // 跳过受害者
  } else if (ch.guilty) {
    give(g, ch.attacker, 4);
    g.log.push({ w: ch.victim, m: '质疑成功！{X} 被罚摸4张', x: ch.attacker });
    advance(g, 1); // 受害者正常出牌
  } else {
    give(g, ch.victim, 6);
    g.log.push({ w: ch.victim, m: '质疑失败，摸6张并跳过' });
    advance(g, 2);
  }
  return ok({});
}

function drawCard(g, pid) {
  if (g.winner) return err('本局已结束');
  if (g.awaitColor) return err('等待选择颜色');
  if (g.challenge) return err('等待质疑结果');
  if (turnPid(g) !== pid) return err('还没轮到你');
  if (g.drewCardId !== null) return err('本回合已摸过牌');
  closeCatchWindow(g);
  const cards = give(g, pid, 1);
  if (!cards.length) { advance(g, 1); return ok({ playable: false }); } // 极端情况：无牌可摸直接过
  g.drewCardId = cards[0].id;
  g.log.push({ w: pid, m: '摸了1张牌' });
  return ok({ playable: canPlay(g, cards[0]) });
}

function passTurn(g, pid) {
  if (g.winner) return err('本局已结束');
  if (g.awaitColor || g.challenge) return err('等待处理');
  if (turnPid(g) !== pid) return err('还没轮到你');
  if (g.drewCardId === null) return err('现在不能跳过');
  g.drewCardId = null;
  g.log.push({ w: pid, m: '保留摸的牌，跳过' });
  advance(g, 1);
  return ok({});
}

function sayUno(g, pid) {
  const n = g.hands[pid] ? g.hands[pid].length : 0;
  if (n === 2) { g.unoDeclared[pid] = true; g.log.push({ w: pid, m: '喊了 UNO!' }); return ok({}); }
  if (n === 1 && g.vulnerable[pid]) { delete g.vulnerable[pid]; g.log.push({ w: pid, m: '补喊了 UNO!' }); return ok({}); }
  return err('现在不需要喊 UNO');
}

function catchUno(g, actor, target) {
  if (actor === target) return err('不能抓自己');
  if (!g.vulnerable[target]) return err('TA 已经喊过 UNO 了');
  delete g.vulnerable[target];
  give(g, target, 4);
  g.log.push({ w: actor, m: '抓到 {X} 没喊UNO，罚摸4张！', x: target });
  return ok({});
}

// 断线托管：轮到的人自动行动一次（摸牌或跳过/随机选色/放弃质疑）
function autoAct(g, pid) {
  if (g.winner) return;
  if (g.awaitColor === pid) { chooseColor(g, pid, COLORS[Math.floor(Math.random() * 4)]); return; }
  if (g.challenge && g.challenge.victim === pid) { resolveChallenge(g, pid, false); return; }
  if (turnPid(g) !== pid) return;
  if (g.drewCardId === null) drawCard(g, pid); else passTurn(g, pid);
}

module.exports = {
  COLORS, COLOR_NAMES, createGame, playCard, chooseColor, resolveChallenge,
  drawCard, passTurn, sayUno, catchUno, canPlay, autoAct,
  turnPid, nextPid, topCard, cardPoints, cardName,
};
