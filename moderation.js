// 안전 모듈
//  1) 커뮤니티 악플 방지: 금칙어 필터 + 도배(레이트리밋) 방지
//  2) 위기 표현 감지: 감정 기록에서 자·타해 신호가 보이면 책 추천 대신 전문기관 안내를 우선한다.
//
// 주의: 이 모듈은 의료적 판단을 하지 않는다. 위기 표현이 감지되면 서비스는 "진단"이나
// "치료적 조언"을 제공하지 않고, 공식 상담 창구를 안내하는 역할만 한다. (사업계획서 §2, §13)

const BANNED = [
  '바보', '멍청', '병신', '꺼져', '못생', '한심', '쓰레기',
  '재수없', '닥쳐', '개새', '미친놈', '미친년', '씨발', '시발', '개소리',
  '븅신', 'ㅂㅅ', 'ㅄ', '지랄', 'fuck', 'shit', 'stupid', 'idiot', 'ugly', 'loser'
];

// 자·타해 위기 신호. 오탐보다 미탐이 위험하므로 넓게 잡되, 안내는 부드럽게 한다.
const CRISIS = [
  '자살', '죽고싶', '죽고 싶', '죽고싶다', '살기싫', '살기 싫', '살고싶지않', '살고 싶지 않',
  '사라지고싶', '사라지고 싶', '없어지고싶', '없어지고 싶', '자해', '극단적선택', '극단적 선택',
  '목숨을', '뛰어내리', '유서', '죽어버리', '끝내고싶', '끝내고 싶'
];

// 감정의 강도를 짐작하게 하는 표현
const INTENSIFIERS = ['너무', '진짜', '정말', '매일', '계속', '항상', '견딜 수 없', '견딜수없', '미치겠', '숨이 막', '하나도'];

// 상황 분류 사전: 키워드 → 상황 태그
const SITUATION_RULES = [
  { tag: '관계',    words: ['친구', '사람', '관계', '연인', '이별', '가족', '동료', '상사', '헤어', '눈치', '오해'] },
  { tag: '진로·취업', words: ['취업', '진로', '면접', '이직', '자소서', '합격', '불합격', '졸업', '취준', '스펙'] },
  { tag: '학업',     words: ['공부', '시험', '성적', '학교', '과제', '수업', '학점', '입시'] },
  { tag: '일·번아웃', words: ['회사', '업무', '야근', '직장', '프로젝트', '번아웃', '퇴근', '출근', '일이'] },
  { tag: '비교',     words: ['비교', '남들', 'sns', '인스타', '부럽', '뒤처', '뒤쳐', '나만'] },
  { tag: '상실',     words: ['잃었', '떠나', '사별', '실패', '놓쳤', '끝났'] },
  { tag: '몸·수면',   words: ['잠', '불면', '피곤', '지쳐', '지친', '아프', '기운'] },
  { tag: '미래',     words: ['막막', '앞날', '앞으로', '불확실', '모르겠'] }
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s._\-*~!@#$%^&()+=]/g, '');
}

export function findBadWords(text) {
  const norm = normalize(text);
  const raw = String(text || '').toLowerCase();
  const hits = [];
  for (const w of BANNED) {
    if (norm.includes(normalize(w)) || raw.includes(w.toLowerCase())) hits.push(w);
  }
  return hits;
}

export function isClean(text) {
  return findBadWords(text).length === 0;
}

// 위기 표현이 감지되면 true. 감정 기록에만 적용한다.
export function detectCrisis(text) {
  const norm = normalize(text);
  return CRISIS.some(w => norm.includes(normalize(w)));
}

// 국내 공식 상담 창구 (2024년 자살예방상담전화가 109로 통합됨)
export const HELPLINES = [
  { name: '자살예방상담전화', number: '109', hours: '24시간' },
  { name: '정신건강 위기상담전화', number: '1577-0199', hours: '24시간' },
  { name: '청소년전화', number: '1388', hours: '24시간' },
  { name: '생명의전화', number: '1588-9191', hours: '24시간' }
];

// 문장에서 상황 태그를 뽑는다. 최대 3개.
export function classifySituations(text) {
  const norm = normalize(text);
  const tags = [];
  for (const rule of SITUATION_RULES) {
    if (rule.words.some(w => norm.includes(normalize(w)))) tags.push(rule.tag);
  }
  return tags.slice(0, 3);
}

// 강도: 1(잔잔함) ~ 3(강함)
export function measureIntensity(text) {
  const norm = normalize(text);
  const hits = INTENSIFIERS.filter(w => norm.includes(normalize(w))).length;
  if (hits >= 2) return 3;
  if (hits === 1) return 2;
  return 1;
}

// 사용자별 최근 작성 시각 기록 → 도배 방지
const lastAction = new Map();
export function rateLimit(userId, key = 'default', minGapMs = 3000) {
  const k = `${userId}:${key}`;
  const now = Date.now();
  const prev = lastAction.get(k) || 0;
  if (now - prev < minGapMs) return false;
  lastAction.set(k, now);
  return true;
}
