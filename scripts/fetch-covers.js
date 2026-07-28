// 알라딘 Open API로 책 표지·ISBN을 받아 covers.json 을 만든다.
// 실행: TTB_KEY=ttbXXXX node scripts/fetch-covers.js
// 표지 이미지는 알라딘 URL을 그대로 저장(핫링크). 재실행하면 갱신된다.
import { writeFile, readFile } from 'node:fs/promises';
import { BOOKS, CLASSROOM } from '../seed.js';

const TTB = process.env.TTB_KEY || 'ttbsoave4240955001';
const OUT = new URL('../covers.json', import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 저자 문자열에서 이름 토큰만 뽑아 매칭에 쓴다. '에밀 아자르(로맹 가리)' → ['에밀','아자르','로맹','가리']
function nameTokens(author) {
  return (author || '')
    .replace(/[()·,]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// 알라딘 검색 결과 중 우리 책과 가장 잘 맞는 항목을 고른다.
function pickBest(items, book) {
  if (!items || !items.length) return null;
  const toks = nameTokens(book.author);
  // 1) 저자 이름 토큰이 알라딘 author에 겹치는 첫 항목
  const byAuthor = items.find(it => {
    const a = it.author || '';
    return toks.some(t => a.includes(t));
  });
  // 2) 없으면 판매지수 높은 첫 결과(알라딘이 이미 관련도순 정렬)
  return byAuthor || items[0];
}

// coversum(85px)보다 큰 cover200 으로 올려서 저장 → 카드에서 선명하게.
function upsize(url) {
  return (url || '').replace('/coversum/', '/cover200/');
}

async function search(book) {
  const q = encodeURIComponent(book.title);
  const url = `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey=${TTB}`
    + `&Query=${q}&QueryType=Title&MaxResults=10&start=1&SearchTarget=Book`
    + `&Sort=SalesPoint&output=js&Version=20131101`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`JSON 파싱 실패: ${text.slice(0, 120)}`); }
  if (data.errorCode) throw new Error(`알라딘 오류 ${data.errorCode}: ${data.errorMessage}`);
  return pickBest(data.item, book);
}

async function main() {
  const all = [...BOOKS, ...CLASSROOM].filter(b => b.title && b.author);
  // 이전 결과를 이어받아, 실패한 것만 다시 시도할 수 있게 한다.
  let covers = {};
  try { covers = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

  let ok = 0, miss = 0;
  for (const book of all) {
    try {
      const it = await search(book);
      if (!it) { console.log(`  ✗ 없음   ${book.title}`); miss++; await sleep(120); continue; }
      covers[book.title] = {
        author: book.author,
        matched: it.author,
        isbn13: it.isbn13 || '',
        itemId: it.itemId || null,
        cover: upsize(it.cover || ''),
        link: it.link ? it.link.replace(/&amp;/g, '&') : ''
      };
      console.log(`  ✓ ${book.title}  ←  ${it.title}  (${it.author})`);
      ok++;
    } catch (e) {
      console.log(`  ! 오류   ${book.title}: ${e.message}`);
      miss++;
    }
    await sleep(150); // 예의상 호출 간격
  }

  await writeFile(OUT, JSON.stringify(covers, null, 2) + '\n', 'utf8');
  console.log(`\n완료: ${ok}권 표지 확보, ${miss}권 실패. → covers.json (${Object.keys(covers).length}개)`);
}

main().catch(e => { console.error(e); process.exit(1); });
