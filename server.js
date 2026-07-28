import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';
import {
  isClean, findBadWords, rateLimit,
  detectCrisis, classifySituations, measureIntensity, HELPLINES
} from './moderation.js';
import { seedIfEmpty, MOODS, VILLAGES, MODES, STAGES, BUTTERFLIES, POINT_RULES, PROGRAMS, MASTERS, MEMBERSHIPS, HASHTAGS, SUGGEST, CLASSIC_QUOTES } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 책 표지·ISBN (알라딘 Open API로 미리 받아 둔 매핑). 없으면 표지 없이 동작.
// 갱신: TTB_KEY=... node scripts/fetch-covers.js
let COVERS = {};
try {
  const { createRequire } = await import('module');
  COVERS = createRequire(import.meta.url)('./covers.json');
} catch { COVERS = {}; }

// 알라딘 Open API 키 (책 검색용). 배포 시 TTB_KEY 로 덮어쓸 수 있다.
const TTB_KEY = process.env.TTB_KEY || 'ttbsoave4240955001';

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

// PaaS는 HTTPS 종단 프록시 뒤에 앱을 둔다. 이 설정이 없으면 secure 쿠키가 나가지 않는다.
if (PROD) app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// HTML·CSS·JS는 항상 서버에 재검증(no-cache) → 옛 화면 캐시 방지. 이미지는 ETag 캐시.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (/\.(html|css|js)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

seedIfEmpty();

// 로그인 없이 둘러볼 수 있는 체험 계정 (test / test). 없으면 만들어 둔다.
function ensureDemoUser() {
  const d = db.data;
  if (d.users.some(u => u.username === 'test')) return;
  const uid = d.seq++;
  const now = Date.now();
  d.users.push({
    id: uid, username: 'test', nickname: '체험이', plan: 'free',
    points: 60, charName: '토리',
    pointLog: [
      { amount: 15, reason: '필사 완성', at: now - 3600e3 },
      { amount: 20, reason: '10분 독서', at: now - 7200e3 },
      { amount: 10, reason: '감정 체크인', at: now - 86400e3 }
    ],
    rewardedKeys: [],
    passwordHash: bcrypt.hashSync('test', 10), createdAt: now - 3 * 86400e3
  });
  // 데모용 초기 데이터: 책 3권을 서로 다른 마을로 담아두기
  const adult = d.books.filter(b => b.audience === 'adult');
  const pick = emo => adult.find(b => b.emotion === emo);
  [['불안', '고요'], ['위로', '위로'], ['도전', '용기']].forEach(([emo, vil], i) => {
    const b = pick(emo);
    if (b) d.saves.push({ userId: uid, bookId: b.id, destinationVillage: vil, createdAt: now - i * 86400e3 });
  });
  d.checkins.push({ id: d.seq++, userId: uid, emotion: '불안', note: '', situations: [], intensity: 1, destination: '고요', customDestination: null, bookIds: [], createdAt: now - 86400e3 });
  d.checkins.push({ id: d.seq++, userId: uid, emotion: '설렘', note: '', situations: [], intensity: 1, destination: '설렘', customDestination: null, bookIds: [], createdAt: now });
  db.save(true);
}
ensureDemoUser();

// 세션 쿠키 — 배포(HTTPS)에서는 secure 를 켠다.
const COOKIE = { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 24 * 60 * 60 * 1000 };

// 헬스 체크 (PaaS가 살아있는지 확인하는 엔드포인트)
app.get('/healthz', (req, res) => res.json({ ok: true, books: db.data.books.length }));

const D = () => db.data;
const DAY = 24 * 60 * 60 * 1000;

// ---------- 유틸 ----------
function publicUser(u) {
  if (!u) return null;
  ensureGame(u);
  const st = stageView(u, stageOf(u.points));
  return {
    id: u.id, username: u.username, nickname: u.nickname, plan: u.plan,
    points: u.points, charName: u.charName, stage: { name: st.name, emoji: st.emoji, img: st.img, aura: st.aura }
  };
}

// ---------- 게이미피케이션: 마음 포인트 & 동반자 "마음이" ----------
// 오래된 계정에도 게임 필드가 없을 수 있으므로 접근 시점에 초기화한다.
function ensureGame(u) {
  if (typeof u.points !== 'number') u.points = 0;
  if (!Array.isArray(u.pointLog)) u.pointLog = [];
  if (!Array.isArray(u.rewardedKeys)) u.rewardedKeys = [];
  if (!('charName' in u)) u.charName = null;
}

function stageOf(points) {
  let s = STAGES[0];
  for (const st of STAGES) if (points >= st.min) s = st;
  return s;
}

// 마지막 나비 단계는 사용자마다 나비 종류를 안정적으로 배정한다.
function butterflyOf(u) {
  return BUTTERFLIES[hashOf(String(u.id)) % BUTTERFLIES.length];
}
// 표시용 단계: 나비 단계면 name 을 사용자의 나비 종류로 바꿔 준다.
function stageView(u, st) {
  return { emoji: st.emoji, img: st.img || null, name: st.butterfly ? butterflyOf(u) : st.name, aura: st.aura, scale: st.scale, min: st.min, blurb: st.blurb };
}

// 다음 단계까지의 진행도
function progressOf(points) {
  const cur = stageOf(points);
  const idx = STAGES.indexOf(cur);
  const next = STAGES[idx + 1] || null;
  const into = points - cur.min;
  const span = next ? next.min - cur.min : 0;
  return { cur, next, into, span, ratio: next ? Math.min(1, into / span) : 1, idx };
}

// 반복 지급
function award(u, amount, reason) {
  ensureGame(u);
  const before = stageOf(u.points);
  u.points += amount;
  u.pointLog.unshift({ amount, reason, at: Date.now() });
  u.pointLog = u.pointLog.slice(0, 30);
  const after = stageOf(u.points);
  const view = stageView(u, after);
  return {
    amount, points: u.points, levelUp: after.name !== before.name,
    stage: view.name, stageEmoji: view.emoji, stageImg: view.img, stageAura: view.aura, stageBlurb: view.blurb
  };
}

// 1회성 지급 (같은 key 는 두 번 주지 않는다 → 어뷰징 방지)
function awardOnce(u, key, amount, reason) {
  ensureGame(u);
  if (u.rewardedKeys.includes(key)) return { amount: 0, points: u.points, levelUp: false };
  u.rewardedKeys.push(key);
  return award(u, amount, reason);
}

// 하루 cap 회까지만 지급
function dailyAward(u, prefix, cap, amount, reason) {
  ensureGame(u);
  const day = new Date().toDateString();
  for (let i = 1; i <= cap; i++) {
    const key = `${prefix}:${day}:${i}`;
    if (!u.rewardedKeys.includes(key)) return awardOnce(u, key, amount, reason);
  }
  return { amount: 0, points: u.points, levelUp: false };
}

// 필사 정확도 (레벤슈타인 거리 기반). 공백은 하나로 정규화.
function normText(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[n];
}
function similarity(input, target) {
  const a = normText(input), b = normText(target);
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

function currentUser(req) {
  const token = req.cookies?.ms_token;
  if (!token) return null;
  const uid = D().sessions[token];
  if (!uid) return null;
  return D().users.find(u => u.id === uid) || null;
}

function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = u;
  next();
}

// 문자열을 안정적인 정수로 — 같은 문장에는 같은 추천을, 다른 문장에는 다른 추천을 준다.
function hashOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 책의 emotion 태그 → 이 책이 데려다주는 대표 마을
function villageForEmotion(emo) {
  return VILLAGES.find(v => v.targets[0] === emo) || VILLAGES.find(v => (v.targets || []).includes(emo)) || null;
}

function bookCard(b) {
  const q = encodeURIComponent(b.title);
  const v = villageForEmotion(b.emotion);
  const cv = COVERS[b.title] || null;
  // 커스텀(검색으로 담은) 책은 책 레코드에 표지·isbn·itemId 를 직접 들고 있다.
  const cover = b.cover || cv?.cover || null;
  const isbn13 = b.isbn13 || cv?.isbn13 || null;
  const productLink = b.itemId
    ? `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${b.itemId}`
    : (cv?.link ? cv.link.replace(/&?partner=openAPI/g, '').replace(/&?start=api/g, '') : null);
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    mode: b.mode,
    emotion: b.emotion,
    custom: !!b.custom,
    village: v ? { key: v.key, name: v.name, color: v.color, char: v.char, vibe: v.vibe } : null,
    minutes: b.minutes,
    portion: b.portion,
    why: b.why,
    curatorNote: b.curatorNote,
    question: b.question,
    situations: b.situations || [],
    cover,
    isbn13,
    links: {
      kyobo: `https://search.kyobobook.co.kr/search?keyword=${q}`,
      aladin: productLink || `https://www.aladin.co.kr/search/wsearchresult.aspx?SearchWord=${q}`
    }
  };
}

// ---------- 추천 엔진 (§5-3) ----------
// 책은 "지금 감정(mood)"이 아니라 "가고 싶은 마을(village)"을 향해 고른다.
//   지금 감정 = 출발점(맥락), 도착 마을 = 책이 데려다줄 목적지.
//   village.targets = 이 마을로 데려다주는 책의 emotion 태그.
function recommend(village, note, mood, exclude = []) {
  const situations = classifySituations(note);
  const intensity = measureIntensity(note);
  const targets = village.targets;
  const ex = new Set((exclude || []).map(Number));
  const salt = hashOf(`${village.key}|${mood}|${note}|${ex.size}`);

  const scored = D().books
    .filter(b => b.audience === 'adult')
    .map(b => {
      // rel = 마을과의 '진짜' 관련도(흔들림 제외). rel>0 인 책만 후보로 둔다.
      let rel = 0;
      if (targets.includes(b.emotion)) rel += 10;                         // 도착 마을을 향하는 책
      if ((b.alsoFor || []).some(a => targets.includes(a))) rel += 5;
      if (mood && b.emotion === mood) rel += 2;                           // 지금 감정도 살짝 반영
      const overlap = (b.situations || []).filter(s => situations.includes(s)).length;
      rel += overlap * 3;
      let score = rel;
      if (intensity >= 3 && b.mode === 'light') score += 2;
      if (intensity >= 3 && b.minutes <= 10) score += 1;
      score += ((salt + b.id) % 3) * 0.1;                                 // 동점 순서만 흔든다
      return { book: b, rel, score };
    })
    .filter(x => x.rel > 0)
    .sort((a, b) => b.score - a.score);

  // 세 갈래에서 각각 한 권씩. 마을 테마(scored) 안에서만 고르고, 이미 본 책은 건너뛴다.
  // 마을 책을 다 보면 반복 허용 → 프런트가 "처음부터"로 순환.
  let fresh = 0;
  const picks = [];
  for (const mode of MODES) {
    let hit = scored.find(x => x.book.mode === mode.key && !ex.has(x.book.id));   // 안 본 마을 책
    if (hit) fresh++;
    else hit = scored.find(x => x.book.mode === mode.key);                        // 소진 → 마을 안에서 반복
    if (hit) picks.push({ ...mode, book: bookCard(hit.book) });
  }
  return { situations, intensity, picks, fresh }; // fresh: 이번에 새로 나온 권수
}

// ---------- 메타 ----------
app.get('/api/meta', (req, res) => {
  res.json({ moods: MOODS, villages: VILLAGES, modes: MODES, helplines: HELPLINES, stages: STAGES, pointRules: POINT_RULES, suggest: SUGGEST });
});

// ---------- 인증 ----------
app.post('/api/register', async (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  if (String(password).length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  if (D().users.some(u => u.username === username)) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  const nick = (nickname || username).trim();
  if (!isClean(nick)) return res.status(400).json({ error: '닉네임에 부적절한 표현이 있어요.' });

  const user = {
    id: db.id(),
    username,
    nickname: nick,
    plan: 'free',
    passwordHash: await bcrypt.hash(password, 10),
    points: 0,
    pointLog: [],
    rewardedKeys: [],
    charName: null,
    createdAt: Date.now()
  };
  D().users.push(user);
  const token = crypto.randomBytes(24).toString('hex');
  D().sessions[token] = user.id;
  db.save(true);
  res.cookie('ms_token', token, COOKIE);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = D().users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  D().sessions[token] = user.id;
  db.save(true);
  res.cookie('ms_token', token, COOKIE);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.ms_token;
  if (token) { delete D().sessions[token]; db.save(true); }
  res.clearCookie('ms_token', COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(currentUser(req)) }));

// ---------- 감정 체크인 → 책 처방 (§5-1 ~ §5-4) ----------
app.post('/api/checkin', (req, res) => {
  const emotion = String(req.body?.emotion || '').trim();          // 지금 감정(출발)
  const note = String(req.body?.note || '').trim().slice(0, 300);
  const destKey = String(req.body?.destination || '').trim();       // 가고 싶은 마을(도착) key
  const customDest = String(req.body?.customDestination || '').trim().slice(0, 60);
  const moodItem = MOODS.find(m => m.key === emotion);
  if (!moodItem) {
    return res.status(400).json({ error: '지금 감정을 하나 골라 주세요.' });
  }

  // 위기 표현이 감지되면 책을 권하기 전에 전문기관부터 안내한다. (§5-2, §13)
  // 이 서비스는 의료·상담 서비스가 아니다.
  if (detectCrisis(note) || (customDest && detectCrisis(customDest))) {
    return res.json({
      crisis: true,
      helplines: HELPLINES,
      message: '지금 많이 힘드신 것 같아요. 무드리딩은 상담이나 의료 서비스가 아니어서, 지금 이 순간에 필요한 도움을 드리기 어렵습니다. 아래 창구에서 바로 이야기 나누실 수 있어요.'
    });
  }

  // 도착 마을 결정: 유효한 마을이면 그곳으로, 직접 적었으면 키워드로 가장 가까운 마을 추정,
  // 둘 다 없으면 지금 감정에 추천되는 첫 번째 마을로.
  const chosen = VILLAGES.find(v => v.key === destKey);
  const fallback = () => VILLAGES.find(v => v.key === (SUGGEST[emotion]?.[0]?.to)) || VILLAGES[0];
  let village = fallback(), customLabel = null;
  if (chosen) {
    village = chosen;
  } else if (customDest) {
    village = VILLAGES.find(v => customDest.includes(v.key) || customDest.includes(v.charName) || customDest.includes(v.name.replace(' 마을', ''))) || fallback();
    customLabel = customDest;
  }

  const { situations, intensity, picks } = recommend(village, note, emotion);

  const destination = {
    key: village.key,
    villageName: customLabel || village.name,
    villageVibe: customLabel ? '내가 직접 그린 마을' : village.vibe,
    char: village.char, charName: village.charName, color: village.color,
    custom: !!customLabel
  };

  const me = currentUser(req);
  let checkinId = null, awardRes = null;
  if (me) {
    checkinId = db.id();
    D().checkins.push({
      id: checkinId,
      userId: me.id,
      emotion, note, situations, intensity,
      destination: village.key, customDestination: customLabel || null,
      bookIds: picks.map(p => p.book.id),
      createdAt: Date.now()
    });
    // 하루 첫 체크인에만 포인트 (스팸 방지)
    awardRes = awardOnce(me, `checkin:${new Date().toDateString()}`, 10, '감정 체크인');
    db.save(true);
  }

  res.json({
    crisis: false,
    checkinId,
    analysis: { emotion, situations, intensity, destination },
    picks,
    guest: !me,
    award: awardRes
  });
});

// ---------- 다른 책 추천받기 (리롤) — 포인트/기록 없이 같은 마을의 다른 책만 ----------
app.post('/api/recommend', (req, res) => {
  const emotion = String(req.body?.emotion || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 300);
  const destKey = String(req.body?.destination || '').trim();
  const customDest = String(req.body?.customDestination || '').trim().slice(0, 60);
  const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude : [];
  if (!MOODS.find(m => m.key === emotion)) return res.status(400).json({ error: '지금 감정을 하나 골라 주세요.' });

  const chosen = VILLAGES.find(v => v.key === destKey);
  const fallback = () => VILLAGES.find(v => v.key === (SUGGEST[emotion]?.[0]?.to)) || VILLAGES[0];
  let village = fallback(), customLabel = null;
  if (chosen) village = chosen;
  else if (customDest) {
    village = VILLAGES.find(v => customDest.includes(v.key) || customDest.includes(v.charName) || customDest.includes(v.name.replace(' 마을', ''))) || fallback();
    customLabel = customDest;
  }
  const { situations, intensity, picks, fresh } = recommend(village, note, emotion, exclude);
  const destination = {
    key: village.key,
    villageName: customLabel || village.name,
    villageVibe: customLabel ? '내가 직접 그린 마을' : village.vibe,
    char: village.char, charName: village.charName, color: village.color,
    custom: !!customLabel
  };
  res.json({ analysis: { emotion, situations, intensity, destination }, picks, fresh });
});

// ---------- 내 서재: 책 저장 (§10 저장 기능) ----------
app.get('/api/saves', requireAuth, (req, res) => {
  const uid = req.user.id;
  const list = D().saves
    .filter(s => s.userId === uid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(s => {
      const b = D().books.find(x => x.id === s.bookId);
      if (!b) return null;
      // 이 책으로 읽은 누적 10분 독서 시간 (오래 읽은 순 정렬용)
      const readMinutes = D().routines.filter(r => r.userId === uid && r.bookId === b.id).reduce((a, r) => a + r.minutes, 0);
      const card = bookCard(b);
      // 처방받아 담았다면 그때 실제로 고른 마을을 우선 사용, 없으면 책 성격에서 유도한 마을
      const chosen = s.destinationVillage ? VILLAGES.find(v => v.key === s.destinationVillage) : null;
      const village = chosen
        ? { key: chosen.key, name: chosen.name, color: chosen.color, char: chosen.char, vibe: chosen.vibe }
        : card.village;
      return { ...card, village, viaCheckin: !!chosen, savedAt: s.createdAt, readMinutes };
    })
    .filter(Boolean);
  res.json({ books: list });
});

app.post('/api/saves/:bookId', requireAuth, (req, res) => {
  const bookId = Number(req.params.bookId);
  if (!D().books.some(b => b.id === bookId)) return res.status(404).json({ error: '책을 찾을 수 없습니다.' });
  // 처방 화면에서 담을 때 그때 고른 도착 마을을 함께 저장
  const destKey = String(req.body?.destination || '').trim();
  const dest = VILLAGES.find(v => v.key === destKey) ? destKey : null;
  const existing = D().saves.find(s => s.userId === req.user.id && s.bookId === bookId);
  let awardRes = null;
  if (existing) {
    D().saves = D().saves.filter(s => !(s.userId === req.user.id && s.bookId === bookId));
  } else {
    D().saves.push({ userId: req.user.id, bookId, destinationVillage: dest, createdAt: Date.now() });
    awardRes = awardOnce(req.user, `save:${bookId}`, 5, '책 담기'); // 책마다 처음 담을 때만
  }
  db.save(true);
  res.json({ saved: !existing, award: awardRes });
});

// ---------- 알라딘 책 검색 (10분 루틴에서 직접 책 넣기) ----------
function upsizeCover(url) {
  return (url || '').replace('/coversum/', '/cover200/');
}
app.get('/api/books/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  if (!rateLimit(req.user.id, 'search', 600)) {
    return res.status(429).json({ error: '검색이 너무 잦아요. 잠시 후 다시 시도해 주세요.' });
  }
  try {
    const url = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey=${TTB_KEY}`
      + `&Query=${encodeURIComponent(q)}&QueryType=Keyword&MaxResults=10&start=1`
      + `&SearchTarget=Book&Sort=SalesPoint&output=js&Version=20131101`;
    const data = JSON.parse(await (await fetch(url)).text());
    if (data.errorCode) return res.status(502).json({ error: '검색 서비스를 불러오지 못했어요.' });
    const results = (data.item || []).map(it => ({
      title: String(it.title || '').replace(/\s*-\s*.*$/, '').trim() || it.title,
      fullTitle: it.title,
      author: (it.author || '').replace(/\s*\(지은이\).*$/, '').trim() || it.author,
      cover: upsizeCover(it.cover),
      isbn13: it.isbn13 || '',
      itemId: it.itemId || null
    })).filter(r => r.title);
    res.json({ results });
  } catch {
    res.status(502).json({ error: '검색 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
  }
});

// 검색 결과로 고른 책을 카탈로그에 없으면 새로 만들어(커스텀) id 를 돌려준다.
app.post('/api/books/custom', requireAuth, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200);
  const author = String(req.body?.author || '').trim().slice(0, 200);
  const isbn13 = String(req.body?.isbn13 || '').trim().slice(0, 20);
  const cover = String(req.body?.cover || '').trim().slice(0, 400);
  const itemId = Number(req.body?.itemId) || null;
  if (title.length < 1) return res.status(400).json({ error: '책 제목이 필요해요.' });
  if (!isClean(title) || (author && !isClean(author))) {
    return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });
  }
  // 이미 있는 책이면(카탈로그·커스텀 불문) 재사용 — isbn 우선, 없으면 제목+저자
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  let book = D().books.find(b =>
    (isbn13 && b.isbn13 === isbn13) ||
    (norm(b.title) === norm(title) && norm(b.author) === norm(author)));
  if (!book) {
    book = {
      id: db.id(), audience: 'adult', custom: true,
      title, author, mode: 'light', emotion: null, alsoFor: [], situations: [],
      minutes: 10, portion: '오늘 읽고 싶은 만큼',
      why: '', curatorNote: '', question: '',
      cover: cover || null, isbn13: isbn13 || null, itemId
    };
    D().books.push(book);
    db.save(true);
  }
  res.json({ book: bookCard(book) });
});

// ---------- 서재 메모(기록하기) ----------
app.get('/api/notes', requireAuth, (req, res) => {
  const list = D().notes
    .filter(n => n.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(n => {
      const b = D().books.find(x => x.id === n.bookId);
      return { id: n.id, bookId: n.bookId, text: n.text, createdAt: n.createdAt, title: b?.title || '', author: b?.author || '' };
    });
  res.json({ notes: list });
});

app.post('/api/notes', requireAuth, (req, res) => {
  const bookId = Number(req.body?.bookId) || null;
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!bookId || !D().books.some(b => b.id === bookId)) return res.status(404).json({ error: '책을 찾을 수 없습니다.' });
  if (text.length < 1) return res.status(400).json({ error: '메모를 입력해 주세요.' });
  if (!isClean(text)) return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });
  const n = { id: db.id(), userId: req.user.id, bookId, text, createdAt: Date.now() };
  D().notes.push(n);
  const awardRes = awardOnce(req.user, `note:${n.id}`, 5, '독서 메모');
  db.save(true);
  res.json({ ok: true, note: { id: n.id, bookId, text: n.text, createdAt: n.createdAt }, award: awardRes });
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const n = D().notes.find(x => x.id === id);
  if (!n) return res.status(404).json({ error: '메모를 찾을 수 없습니다.' });
  if (n.userId !== req.user.id) return res.status(403).json({ error: '본인 메모만 지울 수 있어요.' });
  D().notes = D().notes.filter(x => x.id !== id);
  db.save(true);
  res.json({ ok: true });
});

// ---------- 문장 저장 ----------
app.get('/api/quotes', requireAuth, (req, res) => {
  const list = D().quotes
    .filter(q => q.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(q => {
      const b = D().books.find(x => x.id === q.bookId);
      return { id: q.id, text: q.text, createdAt: q.createdAt, title: b?.title || '', author: b?.author || '' };
    });
  res.json({ quotes: list });
});

app.post('/api/quotes', requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  const bookId = Number(req.body?.bookId) || null;
  if (text.length < 2) return res.status(400).json({ error: '문장을 입력해 주세요.' });
  if (!isClean(text)) return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });
  const q = { id: db.id(), userId: req.user.id, bookId, text, createdAt: Date.now() };
  D().quotes.push(q);
  const awardRes = awardOnce(req.user, `quote:${q.id}`, 5, '문장 저장');
  db.save(true);
  res.json({ ok: true, id: q.id, award: awardRes });
});

app.delete('/api/quotes/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const q = D().quotes.find(x => x.id === id);
  if (!q) return res.status(404).json({ error: '문장을 찾을 수 없습니다.' });
  if (q.userId !== req.user.id) return res.status(403).json({ error: '본인 문장만 지울 수 있어요.' });
  D().quotes = D().quotes.filter(x => x.id !== id);
  db.save(true);
  res.json({ ok: true });
});

// ---------- 10분 독서 루틴 + 감정 변화 기록 (§5-5, §5-6) ----------
app.post('/api/routines', requireAuth, (req, res) => {
  const bookId = Number(req.body?.bookId) || null;
  const minutes = Math.min(120, Math.max(1, Number(req.body?.minutes) || 10));
  const moodBefore = Math.min(5, Math.max(1, Number(req.body?.moodBefore) || 3));
  const moodAfter = Math.min(5, Math.max(1, Number(req.body?.moodAfter) || 3));
  const note = String(req.body?.note || '').trim().slice(0, 300);
  if (note && !isClean(note)) return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });

  const r = { id: db.id(), userId: req.user.id, bookId, minutes, moodBefore, moodAfter, note, createdAt: Date.now() };
  D().routines.push(r);

  // 10분 읽은 책은 내 서재에 자동으로 담긴다 (아직 없을 때만).
  let autoSaved = false;
  if (bookId && D().books.some(b => b.id === bookId)
      && !D().saves.some(s => s.userId === req.user.id && s.bookId === bookId)) {
    D().saves.push({ userId: req.user.id, bookId, destinationVillage: null, createdAt: Date.now() });
    awardOnce(req.user, `save:${bookId}`, 5, '책 담기');
    autoSaved = true;
  }

  // 하루 3번까지 기본 20점, 읽고 나서 마음이 나아졌으면 보너스 10점
  let awardRes = dailyAward(req.user, 'routine', 3, 20, '10분 독서');
  if (moodAfter > moodBefore) {
    const bonus = award(req.user, 10, '마음이 나아짐');
    awardRes = { amount: awardRes.amount + 10, points: bonus.points, levelUp: awardRes.levelUp || bonus.levelUp, stage: bonus.stage, stageEmoji: bonus.stageEmoji };
  }
  db.save(true);
  res.json({ ok: true, delta: moodAfter - moodBefore, award: awardRes, autoSaved });
});

// ---------- 주간 리포트 (§4 고객 관계, §12 성공 지표) ----------
app.get('/api/report', requireAuth, (req, res) => {
  const uid = req.user.id;
  const since = Date.now() - 28 * DAY;
  const checkins = D().checkins.filter(c => c.userId === uid && c.createdAt >= since);
  const routines = D().routines.filter(r => r.userId === uid && r.createdAt >= since);

  const emotionCounts = {};
  for (const m of MOODS) emotionCounts[m.key] = 0;
  for (const c of checkins) emotionCounts[c.emotion] = (emotionCounts[c.emotion] || 0) + 1;

  const deltas = routines.map(r => r.moodAfter - r.moodBefore);
  const avgDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

  // 연속 체크인 일수
  const days = new Set(checkins.map(c => new Date(c.createdAt).toDateString()));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(Date.now() - i * DAY).toDateString();
    if (days.has(d)) streak++;
    else if (i > 0) break;
    else break;
  }

  res.json({
    nickname: req.user.nickname,
    checkinCount: checkins.length,
    routineCount: routines.length,
    totalMinutes: routines.reduce((a, r) => a + r.minutes, 0),
    savedBooks: D().saves.filter(s => s.userId === uid).length,
    savedQuotes: D().quotes.filter(q => q.userId === uid).length,
    emotionCounts,
    avgDelta: Math.round(avgDelta * 100) / 100,
    improvedRatio: deltas.length ? Math.round((deltas.filter(d => d > 0).length / deltas.length) * 100) : 0,
    streak,
    recent: checkins.slice(-14).map(c => ({ emotion: c.emotion, intensity: c.intensity, createdAt: c.createdAt }))
  });
});

// ---------- 추천 피드백 (§10 피드백, §13 알고리즘 개선) ----------
app.post('/api/feedback', requireAuth, (req, res) => {
  const checkinId = Number(req.body?.checkinId);
  const helpful = !!req.body?.helpful;
  const comment = String(req.body?.comment || '').trim().slice(0, 300);
  const c = D().checkins.find(x => x.id === checkinId && x.userId === req.user.id);
  if (!c) return res.status(404).json({ error: '해당 추천 기록을 찾을 수 없습니다.' });
  if (comment && !isClean(comment)) return res.status(400).json({ error: '부적절한 표현이 포함되어 있어요.' });
  D().feedback = D().feedback.filter(f => f.checkinId !== checkinId);
  D().feedback.push({ checkinId, userId: req.user.id, helpful, comment, createdAt: Date.now() });
  db.save(true);
  res.json({ ok: true });
});

// ---------- 감정 독서 챌린지 (§5-7) ----------
app.get('/api/challenges', (req, res) => {
  const me = currentUser(req);
  const list = D().challenges.map(c => ({
    ...c,
    memberCount: D().joins.filter(j => j.challengeId === c.id).length,
    postCount: D().posts.filter(p => p.challengeId === c.id).length,
    joined: me ? D().joins.some(j => j.challengeId === c.id && j.userId === me.id) : false
  }));
  res.json({ challenges: list });
});

app.post('/api/challenges/:id/join', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!D().challenges.some(c => c.id === id)) return res.status(404).json({ error: '챌린지를 찾을 수 없습니다.' });
  const existing = D().joins.find(j => j.challengeId === id && j.userId === req.user.id);
  if (existing) {
    D().joins = D().joins.filter(j => !(j.challengeId === id && j.userId === req.user.id));
  } else {
    D().joins.push({ challengeId: id, userId: req.user.id, joinedAt: Date.now() });
  }
  db.save(true);
  res.json({ joined: !existing });
});

app.get('/api/challenges/:id/posts', (req, res) => {
  const id = Number(req.params.id);
  const list = D().posts
    .filter(p => p.challengeId === id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(p => {
      const u = D().users.find(u => u.id === p.userId);
      return { id: p.id, nickname: u?.nickname || '익명', text: p.text, createdAt: p.createdAt };
    });
  res.json({ posts: list });
});

app.post('/api/challenges/:id/posts', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!D().challenges.some(c => c.id === id)) return res.status(404).json({ error: '챌린지를 찾을 수 없습니다.' });
  const text = String(req.body?.text || '').trim().slice(0, 400);
  if (text.length < 2) return res.status(400).json({ error: '기록할 내용을 적어 주세요.' });
  if (findBadWords(text).length) return res.status(400).json({ error: '부적절한 표현이 감지되었어요. 따뜻한 말로 남겨주세요. 💛' });
  if (!rateLimit(req.user.id, 'post', 3000)) return res.status(429).json({ error: '너무 빠르게 올리고 있어요. 잠시 후 다시 시도하세요.' });
  const p = { id: db.id(), challengeId: id, userId: req.user.id, text, createdAt: Date.now() };
  D().posts.push(p);
  const awardRes = awardOnce(req.user, `post:${id}:${new Date().toDateString()}`, 10, '독서 모임 기록');
  db.save(true);
  res.json({ post: { id: p.id, nickname: req.user.nickname, text: p.text, createdAt: p.createdAt }, award: awardRes });
});

// ---------- 교실 모드 (§9 학교형) ----------
app.get('/api/classroom', (req, res) => {
  const books = D().books.filter(b => b.audience === 'youth').map(b => ({
    id: b.id, title: b.title, author: b.author, emotion: b.emotion, why: b.why, activity: b.activity,
    links: { kyobo: `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(b.title)}` }
  }));
  res.json({ books });
});

// ---------- 동반자 "마음이" 성장 화면 ----------
app.get('/api/character', requireAuth, (req, res) => {
  const u = req.user;
  ensureGame(u);
  const uid = u.id;
  const prog = progressOf(u.points);

  // 오늘 활동 여부 → 표정
  const today = new Date().toDateString();
  const activeToday = D().checkins.some(c => c.userId === uid && new Date(c.createdAt).toDateString() === today)
    || D().routines.some(r => r.userId === uid && new Date(r.createdAt).toDateString() === today);

  const days = new Set(D().checkins.filter(c => c.userId === uid).map(c => new Date(c.createdAt).toDateString()));
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(Date.now() - i * DAY).toDateString();
    if (days.has(d)) streak++; else if (i > 0) break; else break;
  }

  let mood;
  if (!activeToday) mood = '오늘은 아직 책을 만나지 못했어요. 감정 하나만 들려주실래요?';
  else if (streak >= 3) mood = `${streak}일째 곁을 지켜 주셔서, 마음이가 포동포동해졌어요.`;
  else mood = '오늘도 함께 읽어 주셔서 고마워요.';

  res.json({
    charName: u.charName,
    points: u.points,
    stage: stageView(u, prog.cur),
    next: prog.next ? stageView(u, prog.next) : null,
    into: prog.into,
    span: prog.span,
    ratio: prog.ratio,
    stageIndex: prog.idx,
    stages: STAGES.map(s => stageView(u, s)),
    pointRules: POINT_RULES,
    mood,
    streak,
    activeToday,
    counts: {
      checkins: D().checkins.filter(c => c.userId === uid).length,
      routines: D().routines.filter(r => r.userId === uid).length,
      copies: D().copies.filter(c => c.userId === uid).length,
      saves: D().saves.filter(s => s.userId === uid).length,
      quotes: D().quotes.filter(q => q.userId === uid).length
    },
    log: u.pointLog.slice(0, 12)
  });
});

app.post('/api/character/name', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 12);
  if (name && !isClean(name)) return res.status(400).json({ error: '이름에 부적절한 표현이 있어요.' });
  req.user.charName = name || null;
  db.save(true);
  res.json({ ok: true, charName: req.user.charName });
});

// ---------- 필사 (§ 게이미피케이션) ----------
// 세 갈래 출처: 고전 명언(classic) · 내가 담은 문장(saved) · 책 큐레이터 노트(book).
// 저작권상 책 "본문"은 쓰지 않는다(큐레이터 노트/공개저작 고전/사용자 저장 문장만).

// kind+ref 로 정답 문장을 찾아 반환. { text, source } | null
function copyTargetText(u, kind, ref) {
  if (kind === 'book') {
    const b = D().books.find(x => x.id === Number(ref) && x.curatorNote);
    return b ? { text: b.curatorNote, source: `${b.title} · ${b.author}` } : null;
  }
  if (kind === 'saved') {
    const q = D().quotes.find(x => x.id === Number(ref) && x.userId === u.id);
    if (!q) return null;
    const b = D().books.find(x => x.id === q.bookId);
    return { text: q.text, source: b ? `${b.title} · ${b.author}` : '내가 담은 문장' };
  }
  const q = CLASSIC_QUOTES[Number(ref)];
  return q ? { text: q.text, source: q.author + (q.work ? ` · 《${q.work}》` : '') } : null;
}

// 필사할 문장 하나를 고른다. 아직 안 한 것 우선.
app.get('/api/transcribe', requireAuth, (req, res) => {
  const u = req.user;
  ensureGame(u);
  const isDone = key => u.rewardedKeys.includes(key);
  const kind = String(req.query.kind || (req.query.bookId ? 'book' : 'classic'));

  if (kind === 'book') {
    let b;
    if (req.query.bookId) b = D().books.find(x => x.id === Number(req.query.bookId) && x.curatorNote);
    else {
      const pool = D().books.filter(x => x.audience === 'adult' && x.curatorNote);
      const savedIds = new Set(D().saves.filter(s => s.userId === u.id).map(s => s.bookId));
      const undone = pool.filter(x => !isDone(`copy:book:${x.id}`));
      b = undone.find(x => savedIds.has(x.id)) || undone[0] || pool[0];
    }
    if (!b) return res.status(404).json({ error: '필사할 문장을 찾지 못했어요.' });
    return res.json({ target: { kind: 'book', ref: b.id, text: b.curatorNote, source: `${b.title} · ${b.author}` }, alreadyDone: isDone(`copy:book:${b.id}`) });
  }

  if (kind === 'saved') {
    const mine = D().quotes.filter(q => q.userId === u.id);
    if (!mine.length) return res.json({ empty: true, message: '아직 담아 둔 문장이 없어요. 내 서재에서 마음에 드는 문장을 저장해 보세요.' });
    const q = mine.find(x => !isDone(`copy:saved:${x.id}`)) || mine[0];
    const b = D().books.find(x => x.id === q.bookId);
    return res.json({ target: { kind: 'saved', ref: q.id, text: q.text, source: b ? `${b.title} · ${b.author}` : '내가 담은 문장' }, alreadyDone: isDone(`copy:saved:${q.id}`) });
  }

  // classic
  const idxs = CLASSIC_QUOTES.map((_, i) => i);
  const undone = idxs.filter(i => !isDone(`copy:classic:${i}`));
  const idx = undone.length ? undone[0] : (hashOf(String(u.id) + u.rewardedKeys.length) % CLASSIC_QUOTES.length);
  const q = CLASSIC_QUOTES[idx];
  res.json({ target: { kind: 'classic', ref: idx, text: q.text, source: q.author + (q.work ? ` · 《${q.work}》` : '') }, alreadyDone: isDone(`copy:classic:${idx}`), remaining: undone.length });
});

app.post('/api/transcribe', requireAuth, (req, res) => {
  const kind = String(req.body?.kind || 'classic');
  const ref = req.body?.ref;
  const input = String(req.body?.text || '').slice(0, 600);
  const t = copyTargetText(req.user, kind, ref);
  if (!t) return res.status(404).json({ error: '필사할 문장을 찾지 못했어요.' });

  const accuracy = Math.round(similarity(input, t.text) * 100);
  const passed = accuracy >= 90;
  let awardRes = null;
  if (passed) {
    D().copies.push({ id: db.id(), userId: req.user.id, kind, ref: String(ref), source: t.source, text: normText(input), accuracy, createdAt: Date.now() });
    awardRes = awardOnce(req.user, `copy:${kind}:${ref}`, 15, '필사 완성'); // 문장마다 처음 완성할 때만
    db.save(true);
  }
  res.json({ accuracy, passed, award: awardRes, target: t.text });
});

app.get('/api/copies', requireAuth, (req, res) => {
  const list = D().copies
    .filter(c => c.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(c => {
      let source = c.source;
      if (!source && c.bookId) { const b = D().books.find(x => x.id === c.bookId); source = b ? `${b.title} · ${b.author}` : ''; }
      return { id: c.id, text: c.text, accuracy: c.accuracy, createdAt: c.createdAt, source: source || '' };
    });
  res.json({ copies: list });
});

// ---------- 수익화: 시그니처 경험 · 마스터 · 멤버십 (§8 수익원) ----------
const withInterest = (list, me) => list.map(p => ({
  ...p,
  interested: me ? D().interests.some(i => i.userId === me.id && i.programId === p.id) : false,
  interestCount: D().interests.filter(i => i.programId === p.id).length
}));

app.get('/api/programs', (req, res) => {
  res.json({ programs: withInterest(PROGRAMS, currentUser(req)) });
});

app.get('/api/masters', (req, res) => {
  // 마을 마스코트를 아바타로 붙여 준다
  const list = MASTERS.map(m => {
    const v = VILLAGES.find(v => v.key === m.village);
    return { ...m, avatar: v?.char || null, color: v?.color || '#9A8F7E', villageName: v?.name || '' };
  });
  res.json({ masters: list });
});

app.get('/api/memberships', (req, res) => {
  res.json({ memberships: withInterest(MEMBERSHIPS, currentUser(req)) });
});

// 관심 등록(리드) — 프로그램·멤버십 공용. 결제 연동 전 단계.
const INTEREST_IDS = new Set([...PROGRAMS.map(p => p.id), ...MEMBERSHIPS.map(m => m.id)]);
app.post('/api/interest/:id', requireAuth, (req, res) => {
  const id = String(req.params.id);
  if (!INTEREST_IDS.has(id)) return res.status(404).json({ error: '해당 상품을 찾을 수 없습니다.' });
  const existing = D().interests.find(i => i.userId === req.user.id && i.programId === id);
  if (existing) {
    D().interests = D().interests.filter(i => !(i.userId === req.user.id && i.programId === id));
  } else {
    D().interests.push({ userId: req.user.id, programId: id, createdAt: Date.now() });
  }
  db.save(true);
  res.json({ interested: !existing });
});

// ---------- 기록에서 자라는 해시태그 ----------
app.get('/api/hashtags', (req, res) => {
  const total = {
    checkins: D().checkins.length,
    routines: D().routines.length,
    copies: D().copies.length,
    saves: D().saves.length
  };
  const byEmotion = {};
  for (const c of D().checkins) byEmotion[c.emotion] = (byEmotion[c.emotion] || 0) + 1;

  const tags = HASHTAGS.map(h => ({
    tag: h.tag,
    emotion: h.emotion || null,
    count: h.from ? (total[h.from] || 0) : (byEmotion[h.emotion] || 0)
  })).sort((a, b) => b.count - a.count);
  res.json({ tags });
});

// SPA fallback
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  📖 무드리딩이 http://localhost:${PORT} 에서 문을 열었어요.\n`);
});
