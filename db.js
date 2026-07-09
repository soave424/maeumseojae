// 파일 기반 초경량 데이터베이스 (네이티브 컴파일 불필요)
// data.json 하나에 모든 컬렉션을 담고, 변경 시 임시파일 → rename 으로 안전하게 저장한다.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 배포 환경에서는 DATA_DIR 을 영구 디스크(마운트 볼륨)로 지정한다.
// 지정하지 않으면 프로젝트 폴더에 저장되는데, PaaS 기본 디스크는 재시작 시 초기화되므로
// 가입 사용자와 감정 기록이 사라진다.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const EMPTY = {
  users: [],
  books: [],          // 큐레이션 도서 카탈로그 (시드)
  challenges: [],     // 감정 주제별 독서 챌린지 (시드)
  checkins: [],       // { userId, emotion, note, situations[], intensity, bookIds[], createdAt }
  saves: [],          // { userId, bookId, createdAt }  = 내 서재에 담은 책
  quotes: [],         // { id, userId, bookId, text, createdAt } = 저장한 문장
  routines: [],       // { id, userId, bookId, minutes, moodBefore, moodAfter, note, createdAt }
  copies: [],         // { id, userId, bookId, text, accuracy, createdAt } = 필사 기록
  feedback: [],       // { checkinId, userId, helpful, comment, createdAt }
  joins: [],          // { userId, challengeId, joinedAt }
  posts: [],          // { id, challengeId, userId, text, createdAt }
  interests: [],      // { userId, programId, createdAt } = 상품 관심(리드)

  sessions: {},       // token -> userId
  seq: 1
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cache = { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    cache = JSON.parse(JSON.stringify(EMPTY));
  }
  return cache;
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// 잦은 쓰기를 모아서 저장 (디바운스) + 즉시 저장 옵션
let saveTimer = null;
function persist(immediate = false) {
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    save();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 200);
}

export const db = {
  get data() { return load(); },
  id() {
    const d = load();
    return d.seq++;
  },
  save: persist
};
