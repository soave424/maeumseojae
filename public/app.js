// 무드리딩 — 프런트엔드 (의존성 없는 해시 라우팅 SPA)

const view = document.getElementById('view');
const authEl = document.getElementById('auth');
const navEl = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const state = {
  me: null,
  meta: { emotions: [], modes: [], helplines: [], stages: [], pointRules: [] },
  emotion: null,
  destination: null,
  customDest: '',
  copySource: 'classic',
  librarySort: 'recent',
  lastPrescription: null,
  savedIds: new Set()
};

// ── 유틸 ─────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '문제가 발생했어요.');
  return data;
}

const fmtDate = ts => new Date(ts).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });

// 조사 로/으로 선택 (받침 없거나 ㄹ 받침이면 '로', 그 외 '으로')
function particleRo(word) {
  const last = String(word || '').trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return '로';
  const jong = (code - 0xAC00) % 28;
  return (jong === 0 || jong === 8) ? '로' : '으로';
}
// 감정/책 태그 → 이모지 (지금 감정 8종 + 책 emotion 태그 모두 포함)
const TAG_ICON = {
  '불안': '🌊', '무기력': '🕯️', '분노': '🔥', '외로움': '🌙', '슬픔': '💧', '공허': '🌫️', '조급': '⏳', '상처': '🩹',
  '설렘': '🌱', '뿌듯': '🌟', '평온': '🍃', '그리움': '🍂',
  '위로': '🫖', '회복': '🌤️', '도전': '🧭'
};
function iconOf(key) { return TAG_ICON[key] || '📖'; }
function moodByKey(key) { return (state.meta.moods || []).find(m => m.key === key); }
// 책 emotion 태그 → 표지 색
const TAG_COLOR = {
  '불안': '#6E8FA6', '외로움': '#7C6E9B', '분노': '#C06A4A', '무기력': '#9A8F7E',
  '설렘': '#7FA86B', '위로': '#C98A86', '회복': '#D3A85B', '도전': '#B08A3E'
};
function tagColor(key) { return TAG_COLOR[key] || '#9A8F7E'; }

// 필사 정확도(클라이언트 실시간 미터용, 서버와 동일 로직)
const normJ = s => String(s || '').trim().replace(/\s+/g, ' ');
function levJ(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[n];
}
function simJ(input, target) {
  const a = normJ(input), b = normJ(target);
  if (!a && !b) return 1;
  return Math.max(0, 1 - levJ(a, b) / Math.max(a.length, b.length, 1));
}

// ── 칼림바 오디오 (Web Audio API) — 필사 타이핑 피드백 ──
// C장조 펜타토닉 음계를 한 음씩 올려 잔잔한 멜로디가 만들어진다.
const kal = {
  ctx: null, master: null,
  on: (typeof localStorage !== 'undefined' && localStorage.getItem('ms_sound') === 'off') ? false : true,
  scale: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00],
  i: 0
};
function kalInit() {
  if (kal.ctx) { if (kal.ctx.state === 'suspended') kal.ctx.resume(); return; }
  try {
    kal.ctx = new (window.AudioContext || window.webkitAudioContext)();
    kal.master = kal.ctx.createGain();
    kal.master.gain.value = 1.0;
    kal.master.connect(kal.ctx.destination);
  } catch { kal.ctx = null; }
}
// 칼림바: 펜타토닉에서 무작위 한 음. 부드러운 타격 + 1.2초 지수 감쇠, 최대 볼륨 ~0.055.
function kalPluck(step) {
  if (!kal.on || !kal.ctx) return;
  const t = kal.ctx.currentTime;
  const idx = (step == null ? Math.floor(Math.random() * kal.scale.length) : step) % kal.scale.length;
  const freq = kal.scale[idx];
  const g = kal.ctx.createGain();
  const o1 = kal.ctx.createOscillator(), o2 = kal.ctx.createOscillator(), g2 = kal.ctx.createGain();
  o1.type = 'triangle'; o2.type = 'sine';
  o1.frequency.value = freq; o2.frequency.value = freq * 2.01; // 옥타브 배음(칼림바의 금속성)
  g2.gain.value = 0.2;
  o1.connect(g); o2.connect(g2); g2.connect(g);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.055, t + 0.006);       // 부드러운 어택
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);         // 1.2초 지수 감쇠
  g.connect(kal.master);
  o1.start(t); o2.start(t); o1.stop(t + 1.3); o2.stop(t + 1.3);
}
function kalSuccess() {
  if (!kal.on || !kal.ctx) return;
  [0, 2, 4, 7, 9].forEach((s, n) => setTimeout(() => kalPluck(s), n * 95));
}
function kalToggle() {
  kal.on = !kal.on;
  try { localStorage.setItem('ms_sound', kal.on ? 'on' : 'off'); } catch {}
  if (kal.on) kalInit();
  return kal.on;
}

// ── 마음 포인트 연출 ──────────────────────────────
function flashAward(award) {
  if (!award || !award.amount) return;
  toast(`+${award.amount} 마음 포인트 ${award.stageEmoji || ''}`.trim());
  if (state.me) {
    state.me.points = award.points;
    if (award.stage) state.me.stage = { ...(state.me.stage || {}), name: award.stage, emoji: award.stageEmoji };
    renderAuth();
  }
  if (award.levelUp) celebrateLevelUp(award);
}

function celebrateLevelUp(award) {
  const isButterfly = /나비$/.test(award.stage || '');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal levelup">
      <div class="lu-emoji ${award.stageAura || ''}">${award.stageEmoji}</div>
      <h2>${isButterfly ? '마음이가 나비가 되었어요!' : '마음이가 자랐어요!'}</h2>
      <p class="sub">이제 <b>${esc(award.stage)}</b>${isButterfly ? '가 되었어요.' : ' 단계예요.'} ${esc(award.stageBlurb || '')}</p>
      <button class="btn sage" style="width:100%" id="lu-ok">마음이 보러 가기</button>
      <button class="linkish mt" id="lu-close" style="display:block;margin:12px auto 0">닫기</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelector('#lu-ok').onclick = () => { close(); location.hash = '#/character'; };
  back.querySelector('#lu-close').onclick = close;
}

// ── 인증 UI (+ 마음이 칩) ─────────────────────────
function renderAuth() {
  if (state.me) {
    const p = state.me.points || 0;
    const em = state.me.stage?.emoji || '🥚';
    authEl.innerHTML = `
      <a class="charchip" href="#/character" title="마음이 보러 가기"><span class="cc-e">${em}</span> <b>${p}</b></a>
      <span class="who">${esc(state.me.nickname)} 님</span>
      <button class="btn ghost small" id="logout">로그아웃</button>`;
    document.getElementById('logout').onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      state.me = null; state.savedIds.clear();
      renderAuth(); route();
      toast('안녕히 가세요. 서재는 늘 여기 있어요.');
    };
  } else {
    authEl.innerHTML = `
      <button class="btn ghost small" id="demo">체험하기</button>
      <button class="btn small" id="login">시작하기</button>`;
    document.getElementById('demo').onclick = () => demoLogin();
    document.getElementById('login').onclick = () => openAuthModal();
  }
}

// 가입 없이 test 계정으로 바로 둘러보기
async function demoLogin(after) {
  try {
    const { user } = await api('/api/login', { method: 'POST', body: { username: 'test', password: 'test' } });
    state.me = user;
    await loadSaves();
    renderAuth();
    toast('체험 계정으로 둘러보는 중이에요 🌿');
    after ? after() : route();
  } catch (err) { toast(err.message || '체험 계정을 열 수 없어요.'); }
}

function openAuthModal(afterLogin) {
  let mode = 'login';
  const back = document.createElement('div');
  back.className = 'modal-back';
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (e.target === back) close(); };

  function draw() {
    const isLogin = mode === 'login';
    back.innerHTML = `
      <div class="modal">
        <h2>${isLogin ? '다시 오셨네요' : '무드리딩에 오신 걸 환영해요'}</h2>
        <p class="sub">${isLogin ? '마음이가 기다리고 있었어요.' : '감정을 기록하면 동반자 마음이가 함께 자랍니다.'}</p>
        <form id="af">
          <div class="field"><label>아이디</label><input type="text" name="username" autocomplete="username" required></div>
          ${isLogin ? '' : '<div class="field"><label>닉네임</label><input type="text" name="nickname" placeholder="서재에서 불릴 이름"></div>'}
          <div class="field"><label>비밀번호 <span class="hint">4자 이상</span></label><input type="password" name="password" autocomplete="current-password" required></div>
          <p class="err" id="aerr"></p>
          <button class="btn" style="width:100%" type="submit">${isLogin ? '들어가기' : '가입하고 시작하기'}</button>
        </form>
        <p class="center mt" style="font-size:13.5px;color:var(--ink-2)">
          ${isLogin ? '처음이신가요?' : '이미 계정이 있으신가요?'}
          <button class="linkish" id="swap">${isLogin ? '가입하기' : '로그인'}</button>
        </p>
        <div class="demo-divider"><span>또는</span></div>
        <button class="btn ghost" style="width:100%" id="demoBtn">🌿 체험 계정으로 바로 둘러보기</button>
        <p class="hint center" style="margin-top:6px">가입 없이 <b>test</b> 계정으로 로그인해요</p>
      </div>`;
    back.querySelector('#swap').onclick = () => { mode = isLogin ? 'register' : 'login'; draw(); };
    back.querySelector('#demoBtn').onclick = () => demoLogin(afterLogin ? (() => { close(); afterLogin(); }) : (() => close()));
    back.querySelector('#af').onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        const { user } = await api(isLogin ? '/api/login' : '/api/register', { method: 'POST', body: fd });
        state.me = user;
        await loadSaves();
        renderAuth(); close();
        toast(isLogin ? '어서 오세요 📖' : '마음이가 알에서 당신을 기다려요 🥚');
        afterLogin ? afterLogin() : route();
      } catch (err) {
        back.querySelector('#aerr').textContent = err.message;
      }
    };
    back.querySelector('input[name=username]').focus();
  }
  draw();
}

async function loadSaves() {
  if (!state.me) return;
  const { books } = await api('/api/saves');
  state.savedIds = new Set(books.map(b => b.id));
}

// ── 처방 카드 ────────────────────────────────────
function cardHTML(pick) {
  const b = pick.book;
  const saved = state.savedIds.has(b.id);
  return `
  <article class="card ${pick.key}">
    <div class="card-mode">${pick.icon} ${esc(pick.label)}</div>
    <h3>${esc(b.title)}</h3>
    <div class="author">${esc(b.author)}</div>
    <p class="why">${esc(b.why)}</p>
    <blockquote class="quote">${esc(b.curatorNote)}
      <small>무드리딩 큐레이터 노트 · 본문 인용이 아닙니다</small>
    </blockquote>
    <div class="meta-row">
      <span>오늘 읽을 분량 · <b>${esc(b.portion)}</b></span>
      <span>· 약 <b>${b.minutes}분</b></span>
    </div>
    <div class="ask">
      <strong>읽고 나서 생각할 질문</strong>
      ${esc(b.question)}
    </div>
    <div class="card-actions">
      <button class="btn small ${saved ? 'ghost' : 'sage'}" data-save="${b.id}">
        ${saved ? '✓ 서재에 있음' : '＋ 내 서재에 담기'}
      </button>
      <button class="btn small ghost" data-copy="${b.id}">✍️ 필사</button>
      <button class="btn small ghost" data-read="${b.id}">10분 읽기</button>
    </div>
    <div class="store-row">
      <span class="store-label">이 책 보러가기</span>
      <a class="store-btn kyobo" href="${b.links.kyobo}" target="_blank" rel="noopener">교보문고 <span class="ext">↗</span></a>
      <a class="store-btn aladin" href="${b.links.aladin}" target="_blank" rel="noopener">알라딘 <span class="ext">↗</span></a>
    </div>
  </article>`;
}

function wireCards(root) {
  root.querySelectorAll('[data-save]').forEach(btn => {
    btn.onclick = async () => {
      if (!state.me) return openAuthModal();
      const id = Number(btn.dataset.save);
      // 처방받아 담는 경우, 그때 고른 도착 마을을 함께 저장
      const destination = state.lastPrescription?.analysis?.destination?.key;
      const { saved, award } = await api(`/api/saves/${id}`, { method: 'POST', body: destination ? { destination } : undefined });
      saved ? state.savedIds.add(id) : state.savedIds.delete(id);
      btn.textContent = saved ? '✓ 서재에 있음' : '＋ 내 서재에 담기';
      btn.className = `btn small ${saved ? 'ghost' : 'sage'}`;
      if (saved) flashAward(award); else toast('서재에서 뺐어요.');
    };
  });
  root.querySelectorAll('[data-copy]').forEach(btn => {
    btn.onclick = () => { if (!state.me) return openAuthModal(); openCopyModal(Number(btn.dataset.copy)); };
  });
  root.querySelectorAll('[data-read]').forEach(btn => {
    btn.onclick = () => { location.hash = `#/routine?book=${btn.dataset.read}`; };
  });
}

// ── 화면: 감정 체크인 (메인) ─────────────────────
function viewCheckin() {
  view.innerHTML = `
    <section class="hero home-hero">
      <span class="kicker">감정으로 짓는 나만의 서재</span>
      <h1>지금 어떤 책이 인기인가보다,<br>지금 내 마음엔 어떤 책이 필요한가.</h1>
      <p>오늘의 마음을 하나 고르면, 그 감정에 어울리는 책과<br>짧은 독서 루틴을 처방해 드려요. 기록할 때마다 동반자 <b>마음이</b>가 함께 자랍니다.</p>
    </section>

    <div class="sec-head">
      <div>
        <h2 class="sec-title serif">지금, 마음은 어떤가요?</h2>
        <p class="sec-sub">무겁든 설레든, 지금 나와 가장 가까운 마음을 골라 주세요.</p>
      </div>
    </div>
    <div class="village" id="emos">
      ${state.meta.moods.map((e, i) => `
        <button class="vcard s${i % 8}" data-e="${esc(e.key)}" aria-pressed="${state.emotion === e.key}" style="--c:${e.color}">
          <span class="v-char-wrap">
            <img class="v-char" src="${e.char}" alt="" data-emoji="${e.icon}" loading="lazy" width="88" height="88">
          </span>
          <span class="v-key">${esc(e.key)}</span>
          <span class="v-hint">${esc(e.hint)}</span>
        </button>`).join('')}
    </div>

    <div class="note-form">
      <label>왜 이런 마음인가요? <span class="hint">(선택 · 한 문장이면 충분해요)</span></label>
      <textarea id="note" placeholder="예: 취업 준비가 길어지면서 남들과 자꾸 비교돼요."></textarea>
    </div>

    <div id="dest" class="dest-step" hidden></div>

    <div id="cta" class="cta-wrap" hidden>
      <button class="btn go-btn" id="go">책 처방받기${state.me ? '<span class="pilltag">+10</span>' : ''}</button>
      ${state.me ? '' : '<span class="hint">로그인 없이도 추천을 받아볼 수 있어요.</span>'}
    </div>
    <div id="result"></div>

    <section class="band" id="programs"></section>
    <section class="band" id="hashtags"></section>`;

  view.querySelectorAll('[data-e]').forEach(btn => {
    btn.onclick = () => selectEmotion(btn.dataset.e);
  });
  wireCharFallback(view);

  view.querySelector('#go').onclick = submitCheckin;

  // 이전 선택이 남아 있으면(뒤로 왔을 때) 목적지 단계 복원
  if (state.emotion) renderDest();

  renderPrograms(view.querySelector('#programs'));
  renderHashtags(view.querySelector('#hashtags'));
}

// 아직 그려지지 않은 감정 캐릭터(mood/*.svg)는 이모지로 대체
function wireCharFallback(root) {
  root.querySelectorAll('img.v-char[data-emoji]').forEach(img => {
    const swap = () => {
      if (!img.parentNode) return;
      const span = document.createElement('span');
      span.className = 'v-emoji';
      span.textContent = img.dataset.emoji;
      img.replaceWith(span);
    };
    img.onerror = swap;
    if (img.complete && img.naturalWidth === 0) swap();
  });
}

function selectEmotion(key) {
  const changed = state.emotion !== key;
  state.emotion = key;
  if (changed) { state.destination = null; state.customDest = ''; }
  view.querySelectorAll('[data-e]').forEach(b => b.setAttribute('aria-pressed', b.dataset.e === key));
  renderDest();
  view.querySelector('#dest')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 목적지(가고 싶은 마을) 단계 — 지금 마음에 따라 3곳 추천 + 전체 보기 + 직접 적기
function villageByKey(key) { return (state.meta.villages || []).find(v => v.key === key); }

function renderDest() {
  const dest = view.querySelector('#dest');
  const cta = view.querySelector('#cta');
  if (!dest || !state.emotion) return;
  const suggests = (state.meta.suggest && state.meta.suggest[state.emotion]) || [];

  const villageCard = (key, reason) => {
    const v = villageByKey(key);
    if (!v) return '';
    const on = state.destination === key && !state.customDest;
    return `
      <button class="dcard" data-dest="${esc(key)}" aria-pressed="${on}" style="--c:${v.color}">
        <img class="d-char" src="${v.char}" alt="" width="60" height="60">
        <div class="d-body">
          <div class="d-name">${esc(v.name)}</div>
          ${reason ? `<div class="d-reason">${esc(reason)}</div>` : `<div class="d-reason">${esc(v.vibe)}</div>`}
        </div>
      </button>`;
  };

  dest.hidden = false;
  dest.innerHTML = `
    <div class="sec-head">
      <div>
        <h2 class="sec-title serif">어느 마을로 가고 싶어요?</h2>
        <p class="sec-sub">지금 마음에서 향하고 싶은 곳을 골라 주세요. 그 마을로 데려다줄 책을 처방해 드려요.</p>
      </div>
    </div>
    <div class="dgrid">${suggests.map(s => villageCard(s.to, s.reason)).join('')}</div>
    <div class="dest-more">
      <button class="linkish" id="showAll">다른 마을도 둘러볼래요</button>
      <span class="dot">·</span>
      <button class="linkish" id="showCustom">가고 싶은 곳을 직접 적을래요</button>
    </div>
    <div id="allVillages" hidden></div>
    <div id="customWrap" hidden>
      <input type="text" id="customDest" maxlength="60" placeholder="예: 나를 조금 더 믿게 되는 곳"
        value="${esc(state.customDest || '')}">
    </div>`;

  dest.querySelectorAll('[data-dest]').forEach(btn => {
    btn.onclick = () => {
      state.destination = btn.dataset.dest; state.customDest = '';
      renderDest(); revealCta();
    };
  });

  dest.querySelector('#showAll').onclick = () => {
    const box = dest.querySelector('#allVillages');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    // 위에 이미 뜬 추천 3곳은 빼고 "나머지 마을"만 보여준다
    const shown = new Set(suggests.map(s => s.to));
    const rest = state.meta.villages.filter(v => !shown.has(v.key));
    box.innerHTML = `<div class="dgrid">${rest.map(v => villageCard(v.key, '')).join('')}</div>`;
    box.querySelectorAll('[data-dest]').forEach(btn => {
      btn.onclick = () => { state.destination = btn.dataset.dest; state.customDest = ''; renderDest(); revealCta(); };
    });
  };

  dest.querySelector('#showCustom').onclick = () => {
    const box = dest.querySelector('#customWrap');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const inp = box.querySelector('#customDest'); inp.focus();
      inp.oninput = () => { state.customDest = inp.value; if (inp.value.trim()) { state.destination = null; renderDestPressed(); } revealCta(); };
    }
  };

  revealCta();
}

// 커스텀 입력 시 마을 카드 선택 해제 반영(가벼운 갱신)
function renderDestPressed() {
  view.querySelectorAll('#dest [data-dest]').forEach(b => b.setAttribute('aria-pressed', 'false'));
}

function revealCta() {
  const cta = view.querySelector('#cta');
  if (cta && state.emotion) cta.hidden = false;
}

async function submitCheckin() {
  if (!state.emotion) return;
  const note = view.querySelector('#note')?.value || '';
  const result = view.querySelector('#result');
  result.innerHTML = `<div class="spinner">마음을 읽는 중…</div>`;
  const body = { emotion: state.emotion, note };
  if (state.customDest && state.customDest.trim()) body.customDestination = state.customDest.trim();
  else if (state.destination) body.destination = state.destination;
  try {
    const data = await api('/api/checkin', { method: 'POST', body });
    if (data.crisis) return renderCrisis(result, data);
    state.lastPrescription = data;
    renderPrescription(result, data);
    flashAward(data.award);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    result.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
}

// ── 수익화: 시그니처 경험 · 마스터 · 멤버십 ────────
function expCardHTML(p) {
  return `
    <article class="exp-card" data-prog="${p.id}">
      <div class="exp-top" style="--c:${p.id === 'tour' ? '#7FA86B' : '#C98A86'}">
        <span class="exp-badge">${esc(p.badge)}</span>
        <span class="exp-ic">${p.icon}</span>
      </div>
      <div class="exp-body">
        <div class="exp-kind">${esc(p.kind)}</div>
        <h3>${esc(p.title)}</h3>
        <p class="exp-tag">${esc(p.tagline)}</p>
        <p class="exp-desc">${esc(p.desc)}</p>
        <div class="exp-foot">
          <span class="exp-price">${esc(p.price)}</span>
          <button class="btn small sage" data-open="${p.id}">자세히 보기</button>
        </div>
      </div>
    </article>`;
}
function masterCardHTML(m) {
  return `
    <article class="master-card" style="--c:${m.color}">
      <div class="mc-avatar">${m.avatar ? `<img src="${m.avatar}" alt="" width="66" height="66">` : '🧑'}</div>
      <div class="mc-role">${esc(m.role)} · ${esc(m.field)}</div>
      <h3 class="mc-name serif">${esc(m.name)}</h3>
      <p class="mc-tag">${esc(m.tagline)}</p>
      <p class="mc-bio">${esc(m.bio)}</p>
      <div class="mc-leads">🤝 ${esc(m.leads)}</div>
    </article>`;
}
function tierHTML(m) {
  const featured = !!m.badge;
  return `
    <article class="tier ${featured ? 'featured' : ''}" style="--c:${m.accent}">
      ${m.badge ? `<div class="tier-badge">${esc(m.badge)}</div>` : ''}
      <div class="tier-name">${esc(m.name)}</div>
      <div class="tier-price">${esc(m.price)}<small>${esc(m.period || '')}</small></div>
      <div class="tier-tag">${esc(m.tagline)}</div>
      <ul class="tier-feats">${m.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      <button class="btn ${featured ? 'sage' : 'ghost'}" data-mem="${m.id}">${m.interested ? '✓ 신청됨' : esc(m.cta)}</button>
    </article>`;
}

async function renderPrograms(root) {
  if (!root) return;
  let programs = [], masters = [], memberships = [];
  try {
    const [a, b, c] = await Promise.all([api('/api/programs'), api('/api/masters'), api('/api/memberships')]);
    programs = a.programs; masters = b.masters; memberships = c.memberships;
  } catch { return; }

  root.innerHTML = `
    <div class="sec-head"><div>
      <h2 class="sec-title serif">무드리딩이 준비한 경험</h2>
      <p class="sec-sub">화면 밖에서도 이어지는 독서. 감정에서 출발하는 오프라인 경험.</p>
    </div></div>
    <div class="exp-grid">${programs.map(expCardHTML).join('')}</div>

    <div class="sec-head"><div>
      <h2 class="sec-title serif">마을을 이끄는 마스터</h2>
      <p class="sec-sub">각 감정 마을에는, 그 길을 먼저 걸어 본 안내자가 있어요.</p>
    </div></div>
    <div class="carousel">
      <button class="caro-arrow" data-caro="-1" aria-label="이전">‹</button>
      <div class="caro-track" id="masterTrack">${masters.map(masterCardHTML).join('')}</div>
      <button class="caro-arrow" data-caro="1" aria-label="다음">›</button>
    </div>

    <div class="sec-head"><div>
      <h2 class="sec-title serif">멤버십</h2>
      <p class="sec-sub">가볍게 시작하고, 필요할 때 더 깊이. 세 단계 중에 골라요.</p>
    </div></div>
    <div class="tier-grid">${memberships.map(tierHTML).join('')}</div>`;

  root.querySelectorAll('[data-open]').forEach(btn => {
    btn.onclick = () => openProgramModal(programs.find(p => p.id === btn.dataset.open));
  });
  const track = root.querySelector('#masterTrack');
  root.querySelectorAll('[data-caro]').forEach(b => b.onclick = () => {
    const card = track.querySelector('.master-card');
    const dx = (card ? card.offsetWidth + 14 : 280) * Number(b.dataset.caro);
    track.scrollBy({ left: dx, behavior: 'smooth' });
  });
  root.querySelectorAll('[data-mem]').forEach(btn => btn.onclick = () => onMembership(btn.dataset.mem));
}

async function onMembership(id) {
  if (!state.me) return openAuthModal();
  try {
    const { interested } = await api(`/api/interest/${id}`, { method: 'POST' });
    toast(interested ? '오픈 소식을 먼저 알려드릴게요 💌' : '신청을 취소했어요.');
    const home = view.querySelector('#programs'); if (home) renderPrograms(home);
  } catch (err) { toast(err.message); }
}

function openProgramModal(p) {
  if (!p) return;
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal wide">
      <div class="pm-head" style="--c:${p.id === 'tour' ? '#7FA86B' : p.id === 'therapy' ? '#C98A86' : '#C99A46'}">
        <span class="exp-ic">${p.icon}</span>
        <span class="exp-badge">${esc(p.badge)}</span>
      </div>
      <div class="exp-kind">${esc(p.kind)}</div>
      <h2>${esc(p.title)}</h2>
      <p class="sub">${esc(p.tagline)} · <b>${esc(p.price)}</b> · ${esc(p.duration)}</p>
      <p style="color:var(--ink-2);font-size:14.5px">${esc(p.desc)}</p>
      <div class="pm-includes">${p.includes.map(x => `<span class="inc">✓ ${esc(x)}</span>`).join('')}</div>
      <button class="btn ${p.interested ? 'ghost' : 'sage'}" style="width:100%;margin-top:6px" id="pmInterest">
        ${p.interested ? '✓ 오픈 알림 신청됨' : '오픈 소식 먼저 받기'}
      </button>
      <p class="fineprint center mt">아직 정식 오픈 전이에요. 신청하시면 가장 먼저 안내해 드릴게요.</p>
      <button class="linkish" id="pmClose" style="display:block;margin:12px auto 0">닫기</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelector('#pmClose').onclick = close;
  back.querySelector('#pmInterest').onclick = async () => {
    if (!state.me) { close(); return openAuthModal(); }
    try {
      const { interested } = await api(`/api/interest/${p.id}`, { method: 'POST' });
      p.interested = interested;
      const b = back.querySelector('#pmInterest');
      b.textContent = interested ? '✓ 오픈 알림 신청됨' : '오픈 소식 먼저 받기';
      b.className = `btn ${interested ? 'ghost' : 'sage'}`;
      b.style.width = '100%'; b.style.marginTop = '6px';
      toast(interested ? '오픈 소식을 가장 먼저 알려드릴게요 💌' : '알림 신청을 취소했어요.');
      const home = view.querySelector('#programs'); if (home) renderPrograms(home);
    } catch (err) { toast(err.message); }
  };
}

// ── 기록에서 자라는 해시태그 ──────────────────────
async function renderHashtags(root) {
  if (!root) return;
  let tags;
  try { ({ tags } = await api('/api/hashtags')); } catch { return; }
  const max = Math.max(1, ...tags.map(t => t.count));
  root.innerHTML = `
    <div class="sec-head">
      <div>
        <h2 class="sec-title serif">오늘의 기록 해시태그</h2>
        <p class="sec-sub">사람들의 기록에서 자라난 마음의 키워드. 감정 태그를 누르면 그 마을로 데려다 드려요.</p>
      </div>
    </div>
    <div class="tagcloud">
      ${tags.map(t => {
        const scale = 0.9 + (t.count / max) * 0.9;
        return `<button class="tag ${t.emotion ? 'link' : ''}" data-emotion="${t.emotion ? esc(t.emotion) : ''}"
          style="font-size:${scale.toFixed(2)}rem">${esc(t.tag)}<b>${t.count}</b></button>`;
      }).join('')}
    </div>`;
  root.querySelectorAll('.tag.link').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.emotion;
      if (!key) return;
      selectEmotion(key);
      view.querySelector('#emos')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });
}

function renderCrisis(root, data) {
  root.innerHTML = `
    <div class="crisis mt">
      <h2>잠깐만요, 책보다 먼저요.</h2>
      <p>${esc(data.message)}</p>
      <div class="helplines">
        ${data.helplines.map(h => `
          <div class="helpline">
            <div><div>${esc(h.name)}</div><div class="hours">${esc(h.hours)} 상담</div></div>
            <div class="num">${esc(h.number)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderPrescription(root, data) {
  const { analysis, picks, checkinId, guest } = data;
  const d = analysis.destination;
  const sit = analysis.situations.length
    ? analysis.situations.map(s => `<span class="chip">${esc(s)}</span>`).join('')
    : `<span class="chip">상황 정보 없음</span>`;
  root.innerHTML = `
    <div class="journey mt" ${d ? `style="--c:${d.color}"` : ''}>
      <div class="jn-from">
        <span class="jn-label">지금 마음</span>
        <b>${iconOf(analysis.emotion)} ${esc(analysis.emotion)}</b>
      </div>
      <div class="jn-arrow">→</div>
      ${d ? `
      <div class="jn-to">
        <img class="jn-char" src="${d.char}" alt="" width="52" height="52">
        <div>
          <span class="jn-label">향하는 마을</span>
          <b>${esc(d.villageName)}</b>
          <small>${esc(d.villageVibe)}</small>
        </div>
      </div>` : ''}
    </div>
    <div class="analysis">
      <div class="chips">
        <span class="section-title" style="margin:0 8px 0 0">읽어낸 마음</span>
        ${sit}
        <span class="chip">강도
          <span class="intensity">${[1, 2, 3].map(i => `<i class="${i <= analysis.intensity ? 'on' : ''}"></i>`).join('')}</span>
        </span>
      </div>
    </div>
    <h2 class="section-title">${d ? `${esc(d.villageName)}${particleRo(d.villageName)} 데려다줄 책 세 권` : '오늘의 책 처방전 · 세 갈래'}</h2>
    <div class="cards" id="cards">${picks.map(cardHTML).join('')}</div>
    <div class="feedback" id="fb">
      ${guest
      ? `<p>마음에 드셨다면, 저장하고 마음이를 키워 보세요.</p><div class="row"><button class="btn sage" id="signup">서재 만들기</button></div>`
      : `<p>이 추천이 도움이 되었나요?</p><div class="row">
           <button class="btn ghost" data-fb="1">네, 도움이 됐어요</button>
           <button class="btn ghost" data-fb="0">아니요, 잘 안 맞아요</button></div>`}
    </div>`;
  wireCards(root);
  const fb = root.querySelector('#fb');
  fb.querySelector('#signup')?.addEventListener('click', () => openAuthModal());
  fb.querySelectorAll('[data-fb]').forEach(btn => {
    btn.onclick = async () => {
      await api('/api/feedback', { method: 'POST', body: { checkinId, helpful: btn.dataset.fb === '1' } });
      fb.innerHTML = `<p>알려주셔서 고마워요. 다음 추천이 조금 더 정확해집니다.</p>`;
    };
  });
}

// ── 화면: 마음이 (동반자 성장 + 기록) ─────────────
async function viewCharacter() {
  if (!state.me) return needLogin('마음이');
  const [c, r] = await Promise.all([api('/api/character'), api('/api/report')]);
  const name = c.charName || c.stage.name;
  const pct = Math.round(c.ratio * 100);
  const toNext = c.next ? c.span - c.into : 0;
  const max = Math.max(1, ...Object.values(r.emotionCounts));

  view.innerHTML = `
    <h1>마음이의 방</h1>
    <p class="hint" style="margin-top:-6px">기록할수록 마음이가 자랍니다. 지금은 ${c.points} 포인트예요.</p>

    <div class="companion mt">
      <div class="comp-stage ${c.stage.aura}">
        <div class="comp-emoji ${c.stage.aura}" style="font-size:calc(76px * ${c.stage.scale || 1})">${c.stage.emoji}</div>
      </div>
      <div class="comp-info">
        <div class="comp-name" id="compName">
          <span class="serif" id="cnText">${esc(name)}</span>
          <button class="iconbtn" id="cnEdit" title="이름 짓기">✏️</button>
        </div>
        <div class="comp-sub">${esc(c.stage.name)} · ${esc(c.stage.blurb)}</div>
        <p class="comp-mood">“${esc(c.mood)}”</p>
        <div class="xp">
          <div class="xp-head">
            <span>${c.next ? `다음 단계 <b>${esc(c.next.name)}</b>` : '마지막 단계에 도달했어요'}</span>
            <span class="xp-num">${c.next ? `${toNext}p 남음` : `${c.points}p`}</span>
          </div>
          <div class="xp-bar"><span style="width:${c.next ? pct : 100}%"></span></div>
        </div>
      </div>
    </div>

    <h2 class="section-title mt">성장 여정</h2>
    <div class="track">
      ${c.stages.map((s, i) => `
        <div class="track-step ${i === c.stageIndex ? 'now' : i < c.stageIndex ? 'done' : 'locked'}">
          <div class="ts-emoji ${s.aura}">${s.emoji}</div>
          <div class="ts-name">${esc(s.name)}</div>
          <div class="ts-min">${s.min}p</div>
        </div>`).join('<div class="track-line"></div>')}
    </div>

    <div class="grid-2 mt">
      <div class="panel">
        <h3>포인트는 이렇게 쌓여요</h3>
        <div class="rules">
          ${c.pointRules.map(p => `
            <div class="rule"><span class="r-ic">${p.icon}</span>
              <span class="r-l">${esc(p.label)}<small>${esc(p.note)}</small></span>
              <span class="r-a">+${p.amount}</span></div>`).join('')}
        </div>
      </div>
      <div class="panel">
        <h3>최근 마음 포인트</h3>
        ${c.log.length ? `<div class="pointlog">${c.log.map(l => `
          <div class="pl-row"><span>${esc(l.reason)}</span><b>+${l.amount}</b><span class="pl-d">${fmtDate(l.at)}</span></div>`).join('')}</div>`
        : `<p class="hint">아직 기록이 없어요. 감정 체크인부터 시작해 보세요.</p>`}
      </div>
    </div>

    <h2 class="section-title mt">나의 기록 (최근 4주)</h2>
    <div class="stats">
      <div class="stat"><div class="v">${r.streak}<small>일</small></div><div class="k">연속 체크인</div></div>
      <div class="stat"><div class="v">${r.totalMinutes}<small>분</small></div><div class="k">누적 독서</div></div>
      <div class="stat"><div class="v">${r.improvedRatio}<small>%</small></div><div class="k">읽고 나아진 비율</div></div>
      <div class="stat"><div class="v">${c.counts.copies}<small>편</small></div><div class="k">필사한 문장</div></div>
      <div class="stat"><div class="v">${c.counts.saves}<small>권</small></div><div class="k">담아 둔 책</div></div>
      <div class="stat"><div class="v">${c.counts.quotes}<small>개</small></div><div class="k">저장한 문장</div></div>
    </div>

    <h2 class="section-title">가장 자주 찾아온 마음</h2>
    ${r.checkinCount ? `<div class="bars">
      ${state.meta.moods.map(e => {
        const n = r.emotionCounts[e.key] || 0;
        return `<div class="bar-row"><span>${e.icon} ${esc(e.key)}</span>
          <span class="bar"><span style="width:${(n / max) * 100}%"></span></span>
          <span class="n">${n}</span></div>`;
      }).join('')}
    </div>` : `<div class="empty"><span class="big">🌱</span>아직 기록이 없어요.</div>`}

    <div class="cta-row mt">
      <button class="btn sage" id="toCheckin">감정 체크인 하러 가기</button>
      <button class="btn ghost" id="toCopy">✍️ 오늘의 필사</button>
    </div>`;

  view.querySelector('#toCheckin').onclick = () => location.hash = '#/';
  view.querySelector('#toCopy').onclick = () => location.hash = '#/copy';

  // 이름 짓기 (인라인)
  view.querySelector('#cnEdit').onclick = () => {
    const box = view.querySelector('#compName');
    box.innerHTML = `
      <input type="text" id="cnInput" maxlength="12" value="${esc(c.charName || '')}" placeholder="${esc(c.stage.name)}" style="width:150px">
      <button class="btn small sage" id="cnSave">저장</button>`;
    const input = box.querySelector('#cnInput'); input.focus();
    box.querySelector('#cnSave').onclick = async () => {
      try {
        await api('/api/character/name', { method: 'POST', body: { name: input.value } });
        toast('마음이의 이름을 지었어요.');
        viewCharacter();
      } catch (err) { toast(err.message); }
    };
  };
}

// ── 필사 타이핑 엔진 (페이지·모달 공용) ──────────────
// 목표 문장을 한 글자씩 비춰 가며 옮겨 적는다. 자판마다 칼림바 펜타토닉 음이 흐른다.
function transcribeWidget(container, target, onDone) {
  const chars = Array.from(target.text);
  container.innerHTML = `
    <div class="copy-card">
      <div class="copy-head">
        <span class="copy-src">“${esc(target.source || '')}”</span>
        <button class="sound-toggle" title="소리 켜기/끄기">${kal.on ? '🔊' : '🔇'}</button>
      </div>
      <div class="manuscript">
        <p class="copy-target serif">${chars.map((c, k) => `<span class="ch" data-k="${k}">${c === ' ' ? ' ' : esc(c)}</span>`).join('')}</p>
      </div>
      <textarea class="type-input serif" placeholder="여기에 한 글자씩 따라 적어 보세요…" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="copy-stats">
        <span class="stat-pill">타수 <b class="cpm">0</b></span>
        <span class="stat-pill">정확도 <b class="acc">100</b>%</span>
        <span class="stat-pill prog"><b class="pct">0</b>% 옮김</span>
      </div>
      <div class="copy-foot">
        <div class="copy-meter"><div class="cm-bar"><span></span></div></div>
        <button class="btn sage" data-submit disabled>필사 완성 <span class="pilltag">+15</span></button>
      </div>
      <div class="copy-result" hidden></div>
    </div>`;

  const ta = container.querySelector('.type-input');
  const spans = [...container.querySelectorAll('.ch')];
  const barSpan = container.querySelector('.cm-bar > span');
  const cpmEl = container.querySelector('.cpm');
  const accEl = container.querySelector('.acc');
  const pctEl = container.querySelector('.pct');
  const submit = container.querySelector('[data-submit]');
  const resultBox = container.querySelector('.copy-result');
  const soundBtn = container.querySelector('.sound-toggle');
  let lastLen = 0, startTime = 0;

  function paint() {
    const v = ta.value;
    let correct = 0;
    spans.forEach((sp, k) => {
      sp.className = 'ch';
      if (k < v.length) {
        if (chars[k] === ' ' || v[k] === chars[k]) { sp.classList.add('hit'); correct++; }
        else sp.classList.add('miss');
      } else if (k === v.length) sp.classList.add('cursor');
    });
    const typed = v.length;
    const prog = Math.min(100, Math.round(typed / chars.length * 100));
    barSpan.style.width = prog + '%';
    barSpan.classList.toggle('ok', simJ(v, target.text) >= 0.9);
    pctEl.textContent = prog;
    accEl.textContent = typed ? Math.round(correct / typed * 100) : 100;
    const mins = startTime ? (Date.now() - startTime) / 60000 : 0;
    cpmEl.textContent = mins > 0.02 ? Math.round(typed / mins) : 0; // 타수(분당 글자수)
    submit.disabled = v.trim().length < 2;
  }

  ta.addEventListener('focus', kalInit);
  ta.addEventListener('input', () => {
    kalInit();
    const v = ta.value;
    if (!startTime && v.length) startTime = Date.now();
    if (v.length > lastLen) kalPluck(); // 키 입력마다 펜타토닉 무작위 음
    lastLen = v.length;
    paint();
  });
  soundBtn.onclick = () => { soundBtn.textContent = kalToggle() ? '🔊' : '🔇'; ta.focus(); };
  paint();
  setTimeout(() => ta.focus(), 60);

  submit.onclick = async () => {
    submit.disabled = true;
    try {
      const res = await api('/api/transcribe', { method: 'POST', body: { kind: target.kind, ref: target.ref, text: ta.value } });
      resultBox.hidden = false;
      if (res.passed) {
        kal.i = 0; kalSuccess();
        resultBox.className = 'copy-result pass';
        resultBox.innerHTML = `정확도 <b>${res.accuracy}%</b> · 한 문장을 마쳤어요. ${res.award?.amount ? `+${res.award.amount} 포인트` : '(이미 받은 문장이에요)'}`;
        flashAward(res.award);
        setTimeout(() => onDone && onDone(res), 1000);
      } else {
        resultBox.className = 'copy-result fail';
        resultBox.innerHTML = `정확도 <b>${res.accuracy}%</b> · 조금만 더요. 90%를 넘기면 완성돼요.`;
        submit.disabled = false;
      }
    } catch (err) { toast(err.message); submit.disabled = false; }
  };
}

function openCopyModal(bookId) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal wide"><h2>✍️ 필사</h2><p class="sub">문장을 눈이 아니라 손으로 한 번 더 읽어 보세요.</p><div id="cw"><div class="spinner">문장을 불러오는 중…</div></div><button class="linkish mt" id="cclose" style="display:block;margin:14px auto 0">닫기</button></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelector('#cclose').onclick = close;
  api(`/api/transcribe?kind=book&bookId=${bookId}`).then(({ target }) => {
    transcribeWidget(back.querySelector('#cw'), target, () => setTimeout(close, 800));
  }).catch(err => { back.querySelector('#cw').innerHTML = `<p class="err">${esc(err.message)}</p>`; });
}

// ── 화면: 필사 ───────────────────────────────────
const COPY_TABS = [
  { src: 'classic', label: '고전 명언' },
  { src: 'saved', label: '내가 담은 문장' },
  { src: 'book', label: '오늘의 책' }
];
async function viewCopy() {
  if (!state.me) return needLogin('필사');
  view.innerHTML = `
    <h1>필사</h1>
    <p class="lead">한 글자씩 손으로 옮기며 마음을 가라앉혀요. 자판을 칠 때마다 칼림바 소리가 함께 흐릅니다.</p>
    <div class="copy-tabs" id="ctabs">
      ${COPY_TABS.map(t => `<button data-src="${t.src}" class="${state.copySource === t.src ? 'on' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="cwrap"><div class="spinner">문장을 고르는 중…</div></div>
    <h2 class="section-title mt">내가 필사한 문장</h2>
    <div id="clist"></div>`;

  view.querySelectorAll('#ctabs [data-src]').forEach(b => {
    b.onclick = () => {
      state.copySource = b.dataset.src;
      view.querySelectorAll('#ctabs [data-src]').forEach(x => x.classList.toggle('on', x === b));
      loadNext();
    };
  });

  async function loadNext() {
    const wrap = view.querySelector('#cwrap');
    wrap.innerHTML = `<div class="spinner">문장을 고르는 중…</div>`;
    try {
      const data = await api(`/api/transcribe?kind=${state.copySource}`);
      if (data.empty) { wrap.innerHTML = `<div class="empty"><span class="big">✒️</span>${esc(data.message)}</div>`; return; }
      transcribeWidget(wrap, data.target, () => { loadList(); loadNext(); });
    } catch (err) { wrap.innerHTML = `<div class="empty"><span class="big">✍️</span>${esc(err.message)}</div>`; }
  }
  async function loadList() {
    const { copies } = await api('/api/copies');
    view.querySelector('#clist').innerHTML = copies.length
      ? `<div class="list">${copies.map(c => `
          <div class="row-item">
            <div><div class="quote" style="border:0;padding:0">${esc(c.text)}</div>
              <div class="s">${c.source ? esc(c.source) + ' · ' : ''}정확도 ${c.accuracy}% · ${fmtDate(c.createdAt)}</div></div>
          </div>`).join('')}</div>`
      : `<div class="empty"><span class="big">✒️</span>아직 필사한 문장이 없어요.</div>`;
  }
  loadNext(); loadList();
}

// ── 화면: 내 서재 ────────────────────────────────
const LIB_SORTS = [
  { key: 'recent', label: '최신순' },
  { key: 'oldest', label: '오래 담긴 순' },
  { key: 'read', label: '오래 읽은 순' },
  { key: 'emotion', label: '감정별보기' },
  { key: 'village', label: '마을별보기' }
];
let libBooks = [];
function bookCardHTML(b) {
  const c = tagColor(b.emotion);
  const vname = b.village ? b.village.name : '';
  return `
    <article class="book" style="--c:${c}">
      <div class="book-cover" data-detail="${b.id}" role="button" tabindex="0">
        <div class="book-band">${iconOf(b.emotion)} ${esc(b.emotion)}${vname ? ` <span class="to">→</span> ${esc(vname)}${b.viaCheckin ? ' <span class="via" title="체크인에서 직접 고른 마을">✓</span>' : ''}` : ''}</div>
        <h3 class="book-title serif">${esc(b.title)}</h3>
        <div class="book-author">${esc(b.author)}</div>
        <div class="book-meta">${b.readMinutes > 0 ? `📖 ${b.readMinutes}분 · ` : ''}${fmtDate(b.savedAt)} 담음</div>
        <div class="book-actions">
          <button class="bk-ic" data-copy="${b.id}" title="필사" aria-label="필사">✍️</button>
          <button class="bk-ic" data-read="${b.id}" title="읽기모드" aria-label="읽기모드">⏱️</button>
          <button class="bk-ic danger" data-unsave="${b.id}" title="빼기" aria-label="빼기">✕</button>
        </div>
      </div>
    </article>`;
}
async function viewLibrary() {
  if (!state.me) return needLogin('내 서재');
  const sort = state.librarySort || 'recent';
  const [{ books }, { quotes }] = await Promise.all([api('/api/saves'), api('/api/quotes')]);
  libBooks = books;

  const sorters = {
    recent: (a, b) => b.savedAt - a.savedAt,
    oldest: (a, b) => a.savedAt - b.savedAt,
    read: (a, b) => (b.readMinutes || 0) - (a.readMinutes || 0) || b.savedAt - a.savedAt
  };

  // ── 대시보드 계산 ──
  const totalRead = books.reduce((a, b) => a + (b.readMinutes || 0), 0);
  const mostRead = books.filter(b => b.readMinutes > 0).sort((a, b) => b.readMinutes - a.readMinutes)[0];
  const villageCount = {};
  for (const b of books) { const k = b.village?.name || '기타'; villageCount[k] = (villageCount[k] || 0) + 1; }
  const topVillage = Object.entries(villageCount).sort((a, b) => b[1] - a[1])[0];
  const dashHTML = books.length ? `
    <div class="lib-dash">
      <div class="ld-stat"><div class="ld-v">${books.length}<small>권</small></div><div class="ld-k">담은 책</div></div>
      <div class="ld-stat"><div class="ld-v">${totalRead}<small>분</small></div><div class="ld-k">누적 독서</div></div>
      <div class="ld-stat"><div class="ld-v">${quotes.length}<small>개</small></div><div class="ld-k">저장 문장</div></div>
      <div class="ld-stat"><div class="ld-v small">${topVillage ? esc(topVillage[0]) : '-'}</div><div class="ld-k">가장 많이 향한 마을</div></div>
    </div>` : '';

  let shelfHTML;
  if (!books.length) {
    shelfHTML = `<div class="empty"><span class="big">🗄️</span>아직 담아 둔 책이 없어요.<br>감정 체크인부터 시작해 보세요.</div>`;
  } else if (sort === 'emotion') {
    const groups = {};
    for (const b of books) (groups[b.emotion] ||= []).push(b);
    shelfHTML = Object.entries(groups).map(([emo, list]) => `
      <div class="shelf-group">
        <div class="shelf-label"><span class="dot" style="background:${tagColor(emo)}"></span>${iconOf(emo)} ${esc(emo)} <span class="cnt">${list.length}</span></div>
        <div class="booklist">${list.sort((a, b) => b.savedAt - a.savedAt).map(bookCardHTML).join('')}</div>
      </div>`).join('');
  } else if (sort === 'village') {
    const groups = {};
    for (const b of books) { const k = b.village?.name || '기타 마을'; (groups[k] ||= []).push(b); }
    shelfHTML = Object.entries(groups).map(([vname, list]) => {
      const v = list[0].village;
      return `
      <div class="shelf-group">
        <div class="shelf-label">${v ? `<img class="shelf-char" src="${v.char}" alt="" width="26" height="26">` : '🏘️'} ${esc(vname)} <span class="cnt">${list.length}</span></div>
        <div class="booklist">${list.sort((a, b) => b.savedAt - a.savedAt).map(bookCardHTML).join('')}</div>
      </div>`;
    }).join('');
  } else {
    shelfHTML = `<div class="booklist">${[...books].sort(sorters[sort]).map(bookCardHTML).join('')}</div>`;
  }

  view.innerHTML = `
    <h1>내 서재</h1>
    <p class="lead">담아 둔 책이 어떤 마을로 데려다주는지 한눈에. 책을 눌러 자세히 보세요.</p>
    ${dashHTML}
    <div class="copy-tabs" id="libsort">
      ${LIB_SORTS.map(s => `<button data-sort="${s.key}" class="${sort === s.key ? 'on' : ''}">${s.label}</button>`).join('')}
    </div>
    <div id="shelf">${shelfHTML}</div>

    <h2 class="section-title mt">저장한 문장 ${quotes.length}개</h2>
    <form id="qf" class="quote-form">
      <input type="text" name="text" placeholder="오늘 마음에 걸린 문장을 적어 두세요.">
      <button class="btn" type="submit">저장 <span class="pilltag">+5</span></button>
    </form>
    ${quotes.length ? `<div class="list">${quotes.map(q => `
      <div class="row-item">
        <div><div class="quote" style="border:0;padding:0">${esc(q.text)}</div>
          <div class="s">${q.title ? esc(q.title) + ' · ' : ''}${fmtDate(q.createdAt)}</div></div>
        <button class="btn small ghost" data-delq="${q.id}">지우기</button>
      </div>`).join('')}</div>`
      : `<div class="empty"><span class="big">✒️</span>문장을 모으면 나만의 문장집이 됩니다.</div>`}`;

  view.querySelectorAll('#libsort [data-sort]').forEach(btn => {
    btn.onclick = () => { state.librarySort = btn.dataset.sort; viewLibrary(); };
  });
  // 책 표지 클릭 → 상세
  view.querySelectorAll('[data-detail]').forEach(el => {
    const open = () => openBookDetail(libBooks.find(b => b.id === Number(el.dataset.detail)));
    el.onclick = e => { if (!e.target.closest('.bk-ic')) open(); };
    el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.bk-ic')) { e.preventDefault(); open(); } };
  });
  view.querySelectorAll('[data-unsave]').forEach(btn => {
    btn.onclick = async () => {
      await api(`/api/saves/${btn.dataset.unsave}`, { method: 'POST' });
      state.savedIds.delete(Number(btn.dataset.unsave));
      toast('서재에서 뺐어요.'); viewLibrary();
    };
  });
  view.querySelectorAll('[data-copy]').forEach(btn => { btn.onclick = () => openCopyModal(Number(btn.dataset.copy)); });
  view.querySelectorAll('[data-read]').forEach(btn => { btn.onclick = () => location.hash = `#/routine?book=${btn.dataset.read}`; });
  view.querySelectorAll('[data-delq]').forEach(btn => {
    btn.onclick = async () => { await api(`/api/quotes/${btn.dataset.delq}`, { method: 'DELETE' }); toast('문장을 지웠어요.'); viewLibrary(); };
  });
  view.querySelector('#qf').onsubmit = async e => {
    e.preventDefault();
    const text = new FormData(e.target).get('text');
    try {
      const { award } = await api('/api/quotes', { method: 'POST', body: { text } });
      flashAward(award); viewLibrary();
    } catch (err) { toast(err.message); }
  };
}

// 책 상세 모달 — 소개 + 필사 + 읽기모드 + 구입처
function openBookDetail(b) {
  if (!b) return;
  const c = tagColor(b.emotion);
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal wide book-detail" style="--c:${c}">
      <div class="bd-band">${iconOf(b.emotion)} ${esc(b.emotion)}${b.village ? ` <span class="to">→</span> ${esc(b.village.name)}` : ''}</div>
      <h2>${esc(b.title)}</h2>
      <p class="sub">${esc(b.author)}${b.minutes ? ` · 약 ${b.minutes}분` : ''}</p>
      ${b.why ? `<p class="bd-why">${esc(b.why)}</p>` : ''}
      ${b.curatorNote ? `<blockquote class="bd-quote serif">${esc(b.curatorNote)}<small>무드리딩 큐레이터 노트 · 본문 인용이 아닙니다</small></blockquote>` : ''}
      ${b.portion ? `<div class="bd-meta">오늘 읽을 분량 · <b>${esc(b.portion)}</b></div>` : ''}
      ${b.question ? `<div class="ask"><strong>읽고 나서 생각할 질문</strong>${esc(b.question)}</div>` : ''}
      <div class="bd-actions">
        <button class="btn sage" id="bd-copy">✍️ 필사하기</button>
        <button class="btn ghost" id="bd-read">⏱️ 읽기모드</button>
      </div>
      <div class="store-row">
        <span class="store-label">이 책 보러가기</span>
        <a class="store-btn kyobo" href="${b.links.kyobo}" target="_blank" rel="noopener">교보문고 <span class="ext">↗</span></a>
        <a class="store-btn aladin" href="${b.links.aladin}" target="_blank" rel="noopener">알라딘 <span class="ext">↗</span></a>
      </div>
      <button class="linkish" id="bd-close" style="display:block;margin:14px auto 0">닫기</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (e.target === back) close(); };
  back.querySelector('#bd-close').onclick = close;
  back.querySelector('#bd-copy').onclick = () => { close(); openCopyModal(b.id); };
  back.querySelector('#bd-read').onclick = () => { close(); location.hash = `#/routine?book=${b.id}`; };
}

// ── 화면: 10분 독서 루틴 ─────────────────────────
const MOODS = [
  { v: 1, e: '😞', l: '많이 무거움' }, { v: 2, e: '🙁', l: '조금 무거움' },
  { v: 3, e: '😐', l: '보통' }, { v: 4, e: '🙂', l: '조금 가벼움' }, { v: 5, e: '😊', l: '가벼움' }
];
let timerId = null;

async function viewRoutine(params) {
  if (!state.me) return needLogin('10분 독서 루틴');
  const bookId = Number(params.get('book')) || null;
  const { books } = await api('/api/saves');
  const target = books.find(b => b.id === bookId) || books[0] || null;
  let remaining = 10 * 60, moodBefore = 3, moodAfter = null, running = false;

  const scale = (name, cur) => `
    <div class="mood-scale" data-scale="${name}">
      ${MOODS.map(m => `<button type="button" data-v="${m.v}" aria-pressed="${cur === m.v}">${m.e}<span>${m.l}</span></button>`).join('')}
    </div>`;

  function draw() {
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    const done = remaining === 0;
    view.innerHTML = `
      <h1>10분 독서 루틴</h1>
      <p class="hint" style="margin-top:-6px">긴 독서가 어려운 날에도 10분은 넘길 수 있어요. 읽기 전과 후의 마음을 비교해 보세요.</p>
      ${target ? `
        <div class="panel mt">
          <h3>${esc(target.title)}</h3>
          <p class="sub">${esc(target.author)} · 오늘 읽을 분량: <b>${esc(target.portion)}</b></p>
          <div class="ask"><strong>읽고 나서 생각할 질문</strong>${esc(target.question)}</div>
        </div>` : `<div class="empty mt"><span class="big">📚</span>먼저 감정 체크인에서 책을 담아 주세요.</div>`}
      ${target ? `
      <h2 class="section-title mt">1 · 읽기 전, 지금 마음은?</h2>${scale('before', moodBefore)}
      <div class="timer-wrap mt">
        <div class="timer ${done ? 'done' : ''}">${mm}:${ss}</div>
        <div class="timer-sub">${done ? '10분을 채우셨어요. 잘하셨어요.' : running ? '읽는 중… 화면을 덮어 두셔도 좋아요.' : '준비되면 시작을 눌러 주세요.'}</div>
        <div class="timer-actions">
          <button class="btn ${running ? 'ghost' : ''}" id="toggle">${running ? '일시정지' : done ? '다시 10분' : '시작'}</button>
          <button class="btn ghost" id="reset">초기화</button>
        </div>
      </div>
      <h2 class="section-title">2 · 읽고 난 뒤, 마음이 달라졌나요?</h2>${scale('after', moodAfter)}
      <div class="field mt"><label>남기고 싶은 한 줄 <span class="hint">(선택)</span></label>
        <input type="text" id="note" placeholder="읽고 나서 든 생각을 짧게 적어 두세요."></div>
      <button class="btn sage" id="save" ${moodAfter ? '' : 'disabled'}>오늘의 독서 기록하기 <span class="pilltag">+20</span></button>
      ` : ''}`;
    if (!target) return;

    view.querySelectorAll('[data-scale]').forEach(group => {
      group.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const v = Number(btn.dataset.v);
          if (group.dataset.scale === 'before') moodBefore = v; else moodAfter = v;
          group.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === btn));
          const save = view.querySelector('#save'); if (save) save.disabled = !moodAfter;
        };
      });
    });

    view.querySelector('#toggle').onclick = () => {
      if (done) { remaining = 10 * 60; running = false; }
      running = !running; clearInterval(timerId);
      if (running) {
        timerId = setInterval(() => {
          remaining--;
          if (remaining <= 0) { remaining = 0; running = false; clearInterval(timerId); draw(); toast('10분을 채웠어요 🌿'); return; }
          const t = view.querySelector('.timer'); if (!t) return clearInterval(timerId);
          t.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
        }, 1000);
      }
      draw();
    };
    view.querySelector('#reset').onclick = () => { clearInterval(timerId); remaining = 10 * 60; running = false; draw(); };
    view.querySelector('#save').onclick = async () => {
      const note = view.querySelector('#note').value;
      const minutes = Math.max(1, Math.round((10 * 60 - remaining) / 60)) || 10;
      try {
        const { delta, award } = await api('/api/routines', { method: 'POST', body: { bookId: target.id, minutes, moodBefore, moodAfter, note } });
        clearInterval(timerId);
        flashAward(award);
        if (!award || !award.amount) toast(delta > 0 ? `읽고 나서 마음이 ${delta}칸 가벼워졌어요 🌤️` : '기록했어요. 오늘은 여기까지도 충분해요.');
        location.hash = '#/character';
      } catch (err) { toast(err.message); }
    };
  }
  draw();
}

// ── 화면: 감정 독서 모임 ─────────────────────────
async function viewChallenges() {
  const { challenges } = await api('/api/challenges');
  view.innerHTML = `
    <h1>감정 독서 모임</h1>
    <p class="hint" style="margin-top:-6px">같은 마음을 지나는 사람들과 짧게 읽습니다. 기록을 남기면 마음 포인트도 쌓여요.</p>
    <div class="grid-2 mt">
      ${challenges.map(c => `
        <div class="panel" data-c="${c.id}">
          <h3>${iconOf(c.emotion)} ${esc(c.title)}</h3>
          <p class="sub">${esc(c.desc)}</p>
          <div class="chips">
            <span class="chip">${c.days}일</span><span class="chip">${c.memberCount}명 참여</span><span class="chip">기록 ${c.postCount}개</span>
          </div>
          <div class="mt">
            <button class="btn small ${c.joined ? 'ghost' : 'sage'}" data-join="${c.id}">${c.joined ? '✓ 참여 중' : '참여하기'}</button>
            <button class="btn small ghost" data-open="${c.id}">기록 보기</button>
          </div>
          <div class="posts" id="posts-${c.id}"></div>
        </div>`).join('')}
    </div>`;

  view.querySelectorAll('[data-join]').forEach(btn => {
    btn.onclick = async () => {
      if (!state.me) return openAuthModal();
      await api(`/api/challenges/${btn.dataset.join}/join`, { method: 'POST' });
      viewChallenges();
    };
  });
  view.querySelectorAll('[data-open]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.open;
      const box = view.querySelector(`#posts-${id}`);
      if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
      const { posts } = await api(`/api/challenges/${id}/posts`);
      box.dataset.open = '1';
      box.innerHTML = `
        ${state.me ? `<form data-pf="${id}" style="display:flex;gap:6px;margin-bottom:6px">
          <input type="text" name="text" placeholder="오늘 읽은 10분을 남겨 주세요." style="flex:1">
          <button class="btn small" type="submit">남기기 <span class="pilltag">+10</span></button></form>`
        : `<p class="hint">로그인하면 기록을 남길 수 있어요.</p>`}
        ${posts.length ? posts.map(p => `<div class="post"><div class="who">${esc(p.nickname)} · ${fmtDate(p.createdAt)}</div>${esc(p.text)}</div>`).join('')
        : `<p class="hint">첫 기록의 주인공이 되어 보세요.</p>`}`;
      box.querySelector('[data-pf]')?.addEventListener('submit', async e => {
        e.preventDefault();
        const text = new FormData(e.target).get('text');
        try {
          const { award } = await api(`/api/challenges/${id}/posts`, { method: 'POST', body: { text } });
          flashAward(award);
          box.dataset.open = '0'; btn.click();
        } catch (err) { toast(err.message); }
      });
    };
  });
}

// ── 화면: 교실 ───────────────────────────────────
async function viewClassroom() {
  const { books } = await api('/api/classroom');
  view.innerHTML = `
    <h1>교실 모드</h1>
    <p class="hint" style="margin-top:-6px">아침활동 감정 체크인 후 함께 읽을 책과 활동지. 학급·학교 단위로 쓰도록 설계했습니다.</p>
    <div class="grid-2 mt">
      ${books.map(b => `
        <div class="panel">
          <div class="card-mode">${b.emotion === '전체' ? '🎨 감정 어휘' : iconOf(b.emotion) + ' ' + esc(b.emotion)}</div>
          <h3>${esc(b.title)}</h3>
          <p class="sub">${esc(b.author)}</p>
          <p class="why">${esc(b.why)}</p>
          <div class="ask"><strong>활동지</strong>
            <ol class="activity">${b.activity.map(a => `<li>${esc(a)}</li>`).join('')}</ol></div>
          <div class="store-row"><a class="store-btn kyobo" href="${b.links.kyobo}" target="_blank" rel="noopener">교보문고에서 보기 <span class="ext">↗</span></a></div>
        </div>`).join('')}
    </div>`;
}

// ── 공통 ─────────────────────────────────────────
function needLogin(what) {
  view.innerHTML = `
    <div class="empty" style="margin-top:60px">
      <span class="big">🔑</span>
      <p>${esc(what)}는 로그인 후 이용할 수 있어요.</p>
      <button class="btn sage mt" id="li">로그인 / 가입</button>
    </div>`;
  view.querySelector('#li').onclick = () => openAuthModal();
}

const ROUTES = {
  '/': viewCheckin,
  '/character': viewCharacter,
  '/copy': viewCopy,
  '/library': viewLibrary,
  '/routine': viewRoutine,
  '/challenges': viewChallenges,
  '/classroom': viewClassroom
};

async function route() {
  clearInterval(timerId);
  let raw = location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');
  if (path === '/report') { location.hash = '#/character'; return; } // 옛 링크 호환
  const params = new URLSearchParams(query || '');
  navEl.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${path}`));
  const fn = ROUTES[path] || viewCheckin;
  try { await fn(params); }
  catch (err) { view.innerHTML = `<div class="empty"><span class="big">🌫️</span>${esc(err.message)}</div>`; }
  window.scrollTo({ top: 0 });
}

(async function init() {
  state.meta = await api('/api/meta');
  const { user } = await api('/api/me');
  state.me = user;
  await loadSaves();
  renderAuth();
  window.addEventListener('hashchange', route);
  route();
})();
