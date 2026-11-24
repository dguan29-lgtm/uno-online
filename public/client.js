const socket = io();

let view = null;          // 最近一次服务器状态
let myId = null;
let pendingWildCard = null; // 点了变色牌，等待选色
let toastTimer = null;
let cdTimer = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function emit(event, data, onErr) {
  const cb = (res) => {
    if (res && res.error) toast(res.error);
    if (onErr) onErr(res);
  };
  if (data === undefined) socket.emit(event, cb);
  else socket.emit(event, data, cb);
}

/* ---------- 凭证 & 自动重连 ---------- */
function saveCreds(code, name) { localStorage.setItem('uno_creds', JSON.stringify({ code, name })); }
function loadCreds() { try { return JSON.parse(localStorage.getItem('uno_creds')); } catch { return null; } }
function clearCreds() { localStorage.removeItem('uno_creds'); }

socket.on('connect', () => {
  const c = loadCreds();
  if (c && c.code && c.name) {
    socket.emit('joinRoom', { code: c.code, name: c.name }, (res) => {
      if (!res || !res.ok) { clearCreds(); toast(res && res.error || '重连失败'); }
      else { myId = res.you; toast('已重新连接'); }
    });
  }
});

/* ---------- 首页 ---------- */
$('btn-create').onclick = () => {
  const name = $('inp-name').value.trim();
  if (!name) return toast('请输入昵称');
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return toast(res.error);
    myId = res.you;
    saveCreds(res.code, name);
  });
};

$('btn-join').onclick = () => {
  const name = $('inp-name').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) return toast('请输入昵称');
  if (code.length !== 4) return toast('请输入4位房间码');
  socket.emit('joinRoom', { code, name }, (res) => {
    if (!res.ok) return toast(res.error);
    myId = res.you;
    saveCreds(res.code, name);
  });
};

$('inp-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

/* ---------- 大厅 ---------- */
$('btn-copy').onclick = () => {
  const code = $('lobby-code').textContent;
  const url = location.origin;
  navigator.clipboard.writeText(code).then(
    () => toast('房间码已复制'),
    () => toast('房间码：' + code)
  );
};

$('btn-start').onclick = () => emit('startGame');
$('btn-leave').onclick = () => { socket.emit('leaveRoom'); clearCreds(); showScreen('screen-home'); };
$('btn-again').onclick = () => emit('restart');

/* ---------- 行动 ---------- */
$('btn-draw').onclick = () => emit('drawCard');
$('btn-pass').onclick = () => emit('passTurn');
$('btn-uno').onclick = () => emit('sayUno');
$('draw-pile').onclick = () => { if (!$('draw-pile').classList.contains('disabled')) emit('drawCard'); };

$('btn-accept4').onclick = () => { $('modal-challenge').classList.add('hidden'); emit('challengeResponse', { challenge: false }); };
$('btn-challenge').onclick = () => { $('modal-challenge').classList.add('hidden'); emit('challengeResponse', { challenge: true }); };

document.querySelectorAll('.cbtn').forEach(b => {
  b.onclick = () => {
    $('modal-color').classList.add('hidden');
    const color = b.dataset.color;
    if (pendingWildCard !== null) {
      emit('playCard', { cardId: pendingWildCard, color });
      pendingWildCard = null;
    } else {
      emit('chooseColor', { color }); // 开局变色牌选色
    }
  };
});

/* ---------- 状态渲染 ---------- */
let prev = null; // 上一帧状态（用于音效/语音触发）

socket.on('state', (v) => {
  const o = prev || {};
  if (v.phase === 'playing' || v.phase === 'over') {
    // 新出的牌 → 音效 + 语音报名
    topJustChanged = !!(v.top && v.top.id !== o.topId);
    if (topJustChanged) { AudioKit.card(); speak(speakCard(v.top)); }
    // 变色牌选色完成 → 报新颜色
    if (v.top && v.top.color === 'wild' && v.currentColor && v.currentColor !== o.currentColor)
      speak('变' + CN_FULL[v.currentColor]);
    // 轮到我 → 提示音 + 播报
    if (!v.winner && v.turn === v.you && o.turn !== v.you) { AudioKit.turn(); speak('轮到你了'); }
    // 有人 UNO
    const nowUno = new Set((v.handCounts || []).filter(h => h.unoShout).map(h => h.id));
    const oldUno = o.unoSet || new Set();
    for (const id of nowUno) if (!oldUno.has(id)) { AudioKit.uno(); speak('UNO!'); }
    // 被抓
    const lastLog = (v.log || [])[v.log.length - 1] || '';
    if (lastLog !== o.lastLog && lastLog.includes('没喊UNO')) AudioKit.catch();
    // 胜负
    if (v.winner && !o.winner) {
      AudioKit.win();
      const w = (v.players.find(p => p.id === v.winner) || {}).name || '';
      speak(v.winner === v.you ? '你赢了！' : w + ' 获胜');
    }
    prev = {
      topId: v.top && v.top.id, currentColor: v.currentColor, turn: v.turn,
      winner: v.winner, unoSet: nowUno, lastLog,
      joined: new Set(v.players.map(p => p.id)),
    };
  } else {
    // 大厅：新人加入提示
    const ids = new Set(v.players.map(p => p.id));
    if (o.joined) for (const id of ids) {
      if (!o.joined.has(id)) { const p = v.players.find(x => x.id === id); if (p) toast(p.name + ' 加入了房间'); }
    }
    prev = { joined: ids };
  }

  view = v;
  if (v.phase === 'lobby') renderLobby(v);
  else renderGame(v);
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function renderLobby(v) {
  showScreen('screen-lobby');
  $('modal-over').classList.add('hidden');
  $('modal-challenge').classList.add('hidden');
  $('modal-color').classList.add('hidden');
  $('lobby-code').textContent = v.code;
  const ul = $('lobby-players');
  ul.innerHTML = v.players.map(p => `
    <li class="${p.id === v.you ? 'me' : ''} ${p.connected ? '' : 'off'}">
      <span>${esc(p.name)}${p.id === v.you ? '（你）' : ''}</span>
      <span class="badge">${p.host ? '房主' : ''}${p.connected ? '' : ' 离线'}</span>
    </li>`).join('');
  const amHost = v.host === v.you;
  $('btn-start').classList.toggle('hidden', !amHost);
  $('lobby-wait').textContent = amHost
    ? (v.players.length >= 2 ? '人齐了就开始吧！' : '至少还需要1位玩家')
    : '等待房主开始…';
}

const SYM = { num: null, skip: '⊘', reverse: '⇋', draw2: '+2', wild: '', wild4: '+4' };
const CN = { red: '红', yellow: '黄', green: '绿', blue: '蓝', wild: '' };
const CN_FULL = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色' };

/* ---------- 音效 & 语音（斗地主式喊牌） ---------- */
let muted = localStorage.getItem('uno_mute') === '1';

const AudioKit = {
  ctx: null,
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
    if (muted || disguised) return;
    try {
      this.ensure();
      const t = this.ctx.currentTime + when;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* 无音频环境 */ }
  },
  card() { this.tone(620, .07, 'triangle', .22); this.tone(330, .1, 'triangle', .16, .03); },
  draw() { this.tone(210, .13, 'sawtooth', .12); },
  turn() { this.tone(880, .12, 'sine', .2); this.tone(1320, .2, 'sine', .2, .11); },
  uno() { this.tone(523, .1, 'square', .12); this.tone(784, .16, 'square', .12, .09); },
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, .22, 'triangle', .18, i * .13)); },
  catch() { this.tone(392, .09, 'square', .15); this.tone(392, .09, 'square', .15, .13); },
};
document.addEventListener('pointerdown', () => { if (!muted) AudioKit.ensure(); }, { once: true });

function speak(text) {
  if (muted || disguised || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.15;
  const v = speechSynthesis.getVoices().find(x => x.lang && x.lang.startsWith('zh'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

function speakCard(c) {
  if (c.type === 'num') return CN_FULL[c.color] + c.value;
  if (c.type === 'skip') return CN_FULL[c.color] + '跳过';
  if (c.type === 'reverse') return CN_FULL[c.color] + '反转';
  if (c.type === 'draw2') return CN_FULL[c.color] + '加二';
  if (c.type === 'wild4') return '加四！';
  return '变色！';
}

$('btn-sound').onclick = () => {
  muted = !muted;
  localStorage.setItem('uno_mute', muted ? '1' : '0');
  $('btn-sound').textContent = muted ? '🔇' : '🔊';
  if (muted) speechSynthesis.cancel(); else AudioKit.ensure();
};
$('btn-sound').textContent = muted ? '🔇' : '🔊';

/* ---------- 老板键：伪装成 Excel ---------- */
let disguised = false;

function buildFakeSheet() {
  const cols = ['大区', '10月', '11月', '12月', '合计', '同比', '负责人', '备注'];
  const areas = ['华东', '华南', '华北', '西南', '华中', '西北', '电商', 'KA渠道', '海外', '新零售'];
  let h = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';
  for (let i = 0; i < 26; i++) {
    const a = 120 + Math.floor(Math.random() * 380),
          b = 120 + Math.floor(Math.random() * 380),
          c = 120 + Math.floor(Math.random() * 380);
    h += `<tr><td class="l">${areas[i % areas.length]}·${String.fromCharCode(65 + (i % 26))}组</td>` +
         `<td>${a}</td><td>${b}</td><td>${c}</td><td class="sum">${a + b + c}</td>` +
         `<td>${(Math.random() * 22 - 6).toFixed(1)}%</td><td>${'张王李赵刘陈周吴'[i % 8]}某</td><td></td></tr>`;
  }
  return h;
}

function toggleDisguise(force) {
  disguised = force === undefined ? !disguised : force;
  $('disguise').classList.toggle('hidden', !disguised);
  document.title = disguised ? '2025年Q4销售数据汇总.xlsx - WPS 表格' : 'UNO · 好友联机';
  if (disguised) {
    if ('speechSynthesis' in window) speechSynthesis.cancel(); // 伪装时静音
    $('fake-sheet').innerHTML = buildFakeSheet();
  }
}

$('btn-moyu').onclick = () => { toggleDisguise(); if (disguised) toast('已伪装成表格：按 ~ 或双击页面恢复'); };
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '`' || e.key === '~') toggleDisguise();
});
$('disguise').addEventListener('dblclick', () => toggleDisguise(false));

function cardFace(c) {
  return c.type === 'num' ? String(c.value) : SYM[c.type];
}

function cardHTML(c, extra = '') {
  const f = cardFace(c);
  const corner = c.type === 'wild' ? 'W' : f;
  return `<div class="card ${c.color} ${extra}">
    <span class="corner">${corner}</span>
    <span class="face">${f}</span>
    <span class="corner b">${corner}</span>
  </div>`;
}

const AV_COLORS = ['#e53935', '#f9a825', '#43a047', '#1e88e5', '#8e24aa', '#00897b', '#d81b60', '#5e35b1', '#f4511e', '#039be5'];
function avatarColor(id) {
  let s = 0;
  for (const ch of String(id)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[s % AV_COLORS.length];
}

// 圆桌座位：自己固定底部，对手沿椭圆分布（左下→左→上→右→右下）
function seatPos(i, n) {
  if (n === 1) return { x: 50, y: 13 };
  const deg = 150 + i * (240 / (n - 1));
  const rad = deg * Math.PI / 180;
  return { x: 50 + 42 * Math.cos(rad), y: 46 + 31 * Math.sin(rad) };
}

let topJustChanged = false;

function canPlayLocal(v, c) {
  if (c.color === 'wild') return true;
  if (v.currentColor && c.color === v.currentColor) return true;
  const t = v.top;
  if (c.type === 'num' && t.type === 'num' && c.value === t.value) return true;
  if (c.type !== 'num' && t.type !== 'num' && c.type === t.type) return true;
  return false;
}

function renderGame(v) {
  showScreen('screen-game');
  const myTurn = v.turn === v.you && !v.winner;
  const blocked = !!(v.awaitColor || v.challenge);
  $('table').classList.toggle('myturn', myTurn && !blocked);

  // 对手：圆桌座位
  const opps = v.handCounts.filter(h => h.id !== v.you);
  $('seats').innerHTML = opps.map((h, i) => {
    const pos = seatPos(i, opps.length);
    return `<div class="seat ${h.id === v.turn && !v.winner ? 'current' : ''} ${h.connected ? '' : 'off'}"
      style="left:${pos.x}%;top:${pos.y}%">
      <div class="avatar" style="background:${avatarColor(h.id)}">${esc((h.name || '?')[0])}<span class="hcount">${h.count}</span></div>
      <div class="sname">${esc(h.name)}${h.connected ? '' : ' ✂'}</div>
      ${h.unoShout ? '<div class="uno-tag">UNO!</div>' : ''}
      ${h.vulnerable ? `<button class="catch-btn" onclick="catchPlayer('${h.id}')">抓！没喊UNO</button>` : ''}
    </div>`;
  }).join('');

  // 弃牌堆：最近出的几张散开摆在桌上
  const pileCards = v.pile || (v.top ? [v.top] : []);
  const OFFS = [[0, 0, -4], [-6, -4, 7], [5, -6, -9], [-4, 4, 3], [7, 2, -6], [2, -3, 8]];
  $('discard').innerHTML = pileCards.map((c, i) => {
    const isTop = i === pileCards.length - 1;
    const [dx, dy, rot] = OFFS[i % OFFS.length];
    const extra = isTop && topJustChanged ? 'pop' : '';
    return `<div style="position:absolute;left:calc(50% + ${dx}px);top:calc(50% + ${dy}px);transform:translate(-50%,-50%) rotate(${isTop ? -4 : rot}deg)">${cardHTML(c, extra)}</div>`;
  }).join('');
  const pile = $('draw-pile');
  const canDraw = myTurn && !blocked && v.drewCardId === null;
  pile.classList.toggle('disabled', !canDraw);
  $('deck-count').textContent = v.deckCount ? `剩${v.deckCount}` : '';

  // 方向 & 当前颜色
  $('dir-arrow').classList.toggle('rev', v.dir === -1);
  const chip = $('color-chip');
  if (v.currentColor) { chip.className = ''; chip.classList.add(v.currentColor); }
  else chip.classList.add('hidden');

  // 回合提示
  const turnName = (v.handCounts.find(h => h.id === v.turn) || {}).name || '';
  const vicName = (v.challenge && (v.handCounts.find(h => h.id === v.challenge.victim) || {}).name) || '';
  $('turn-tip').textContent = v.winner ? '' :
    v.awaitColor === v.you ? '请选择颜色' :
    v.awaitColor ? `等待 ${(v.handCounts.find(h => h.id === v.awaitColor) || {}).name || ''} 选色…` :
    v.challenge ? (v.challenge.victim === v.you ? '有人出了+4，请选择' : `等待 ${vicName} 决定是否质疑…`) :
    myTurn ? (v.drewCardId ? '出刚摸的牌，或跳过' : '轮到你出牌') :
    `等待 ${turnName} 出牌…`;
  if (myTurn && !blocked && v.drewCardId === null && !v.hand.some(c => canPlayLocal(v, c)))
    $('turn-tip').textContent = '没有能出的牌，点击左边牌堆摸一张';

  // 手牌（按颜色排序展示）
  const drew = v.drewCardId;
  const cord = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const tord = { num: 0, draw2: 1, skip: 2, reverse: 3, wild: 4, wild4: 5 };
  const sortedHand = v.hand.slice().sort((a, b) =>
    cord[a.color] - cord[b.color] || tord[a.type] - tord[b.type] || (a.value || 0) - (b.value || 0));
  $('hand').innerHTML = sortedHand.map(c => {
    let cls = '';
    if (myTurn && !blocked) {
      const allowed = drew !== null ? c.id === drew : canPlayLocal(v, c);
      cls = allowed ? 'playable' : 'dim';
      if (drew === c.id) cls += ' drew';
    } else cls = 'dim';
    return `<div class="hand-card" data-cid="${c.id}">${cardHTML(c, cls)}</div>`;
  }).join('');

  document.querySelectorAll('#hand .hand-card').forEach(el => {
    el.onclick = () => {
      const cid = +el.dataset.cid;
      const card = view.hand.find(x => x.id === cid);
      if (!card || !el.querySelector('.card').classList.contains('playable')) return;
      if (card.color === 'wild') {
        pendingWildCard = cid;
        $('modal-color').classList.remove('hidden');
      } else {
        emit('playCard', { cardId: cid });
      }
    };
  });

  // 按钮
  $('btn-draw').disabled = !canDraw;
  $('btn-pass').disabled = !(myTurn && !blocked && drew !== null);
  $('btn-uno').disabled = !(v.hand.length === 2 || v.vulnerableSelf);
  $('btn-uno').textContent = v.vulnerableSelf ? '补喊UNO!' : 'UNO!';
  $('btn-uno').classList.toggle('pulse-uno', v.hand.length === 2 && myTurn && !v.unoDeclaredSelf);

  // 我
  const me = v.players.find(p => p.id === v.you) || {};
  $('me-name').innerHTML = `<span class="me-avatar" style="background:${avatarColor(v.you)}">${esc((me.name || '?')[0])}</span>${esc(me.name || '')}（你） 积分:${me.score || 0}`;
  $('me-count').textContent = `${v.hand.length} 张`;

  // 日志
  $('log').innerHTML = (v.log || []).map(l => esc(l)).join('<br>');

  // +4 质疑弹窗
  const ch = v.challenge;
  clearInterval(cdTimer);
  if (ch && ch.victim === v.you) {
    const atk = v.players.find(p => p.id === ch.attacker) || {};
    $('challenge-text').textContent = `${atk.name || '对方'} 打出了 +4！`;
    $('modal-challenge').classList.remove('hidden');
    const tick = () => {
      const left = Math.max(0, Math.ceil((ch.deadline - Date.now()) / 1000));
      $('challenge-count').textContent = `${left}s 后自动接受`;
      if (left <= 0) { $('modal-challenge').classList.add('hidden'); clearInterval(cdTimer); }
    };
    tick();
    cdTimer = setInterval(tick, 300);
  } else {
    $('modal-challenge').classList.add('hidden');
  }

  // 开局变色牌选色
  if (v.awaitColor === v.you && pendingWildCard === null) {
    $('modal-color').classList.remove('hidden');
  } else if (v.awaitColor !== v.you && pendingWildCard === null) {
    $('modal-color').classList.add('hidden');
  }

  // 结算
  if (v.winner) {
    const w = v.players.find(p => p.id === v.winner) || {};
    $('over-title').textContent = v.winner === v.you ? '🎉 你赢了！' : `${w.name || ''} 获胜`;
    $('over-score').textContent = `本局得分 +${v.winScore}`;
    $('score-list').innerHTML = v.players
      .slice().sort((a, b) => b.score - a.score)
      .map(p => `<li class="${p.id === v.you ? 'me' : ''}"><span>${esc(p.name)}</span><span>${p.score} 分</span></li>`).join('');
    $('modal-over').classList.remove('hidden');
    const amHost = v.host === v.you;
    $('btn-again').classList.toggle('hidden', !amHost);
    $('over-wait').classList.toggle('hidden', amHost);
  } else {
    $('modal-over').classList.add('hidden');
  }
}

window.catchPlayer = (id) => emit('catchUno', { target: id });
