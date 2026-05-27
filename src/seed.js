import { db, now } from './db.js';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';

async function seed() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (existing.c >= 3) { console.log('이미 더미 데이터가 있습니다.'); return; }

  const users = [
    { name: '나비', email: 'nabi@test.com', pw: 'test1234' },
    { name: '루시아', email: 'lucia@test.com', pw: 'test1234' },
    { name: '검은늑대', email: 'wolf@test.com', pw: 'test1234' },
  ];

  const userIds = [];
  for (const u of users) {
    const id = nanoid();
    const hash = await bcrypt.hash(u.pw, 8);
    const role = userIds.length === 0 ? 'owner' : 'member';
    try {
      db.prepare('INSERT INTO users (id, email, password_hash, display_name, role, theme, created_at) VALUES (?,?,?,?,?,?,?)').run(id, u.email, hash, u.name, role, 'light', now());
      userIds.push(id);
      console.log(`✓ 계정 생성: ${u.name} (${u.email}) / 비밀번호: ${u.pw}`);
    } catch(e) { console.log(`⚠ ${u.name} 이미 존재`); }
  }

  if (userIds.length === 0) return;

  // 세계관 생성
  const worldId = nanoid();
  const slug = '테스트-' + nanoid(4);
  try {
    db.prepare('INSERT INTO worlds (id, owner_id, name, slug, description, banner_color, icon_emoji, announce_text, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(worldId, userIds[0], '테스트 세계관', slug, '교류 테스트용 세계관입니다.', '#534AB7', '🌙', '반갑습니다! 자유롭게 테스트해보세요.', now());
    userIds.forEach(uid => {
      try { db.prepare('INSERT INTO world_members (world_id, user_id) VALUES (?,?)').run(worldId, uid); } catch {}
    });
    console.log('\n✓ 세계관 생성: ' + slug);
  } catch(e) { console.log('세계관 생성 실패:', e.message); return; }

  // 캐릭터 생성
  const charData = [
    { uid: 0, name: '나비', handle: 'nabi', role: '마법 정령', bio: '꽃밭을 지키는 작은 정령.', color_bg: '#EEEDFE', color_fg: '#534AB7' },
    { uid: 1, name: '루시아', handle: 'lucia', role: '기사단장', bio: '왕국의 검은 기사단을 이끄는 전사.', color_bg: '#FAECE7', color_fg: '#993C1D' },
    { uid: 2, name: '그림자', handle: 'shadow', role: '암살자', bio: '어둠 속에서 움직이는 존재.', color_bg: '#252320', color_fg: '#a8a098' },
    { uid: 1, name: '빛의 성녀', handle: 'saintess', role: '치유사', bio: '빛의 신을 섬기는 성녀. 루시아의 또 다른 얼굴.', color_bg: '#FFF9E6', color_fg: '#8B6914' },
  ];

  const charIds = [];
  for (const c of charData) {
    const id = nanoid();
    try {
      db.prepare('INSERT INTO characters (id, user_id, world_id, name, handle, role, bio, color_bg, color_fg, is_npc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, userIds[c.uid], worldId, c.name, c.handle, c.role, c.bio, c.color_bg, c.color_fg, 0, now());
      charIds.push({ id, ...c });
      console.log('  ✓ 캐릭터: ' + c.name + ' (@' + c.handle + ')');
    } catch(e) { console.log('  ⚠ 캐릭터 생성 실패:', c.name, e.message); charIds.push(null); }
  }

  // 포스트 생성
  const posts = [
    { charIdx: 0, content: '*꽃밭 사이를 날아다니며 작은 날개를 파닥인다.* \n\n오늘도 좋은 날씨네요. @lucia 기사단장님, 순찰은 잘 끝났나요?' },
    { charIdx: 1, content: '*검을 칼집에 꽂으며 고개를 돌린다.*\n\n@nabi — 그래, 무사히 마쳤어. 북쪽 경계에 이상한 기운이 있긴 했지만.' },
    { charIdx: 2, content: '*어둠 속에서 낮게 중얼거린다.*\n\n...흥미롭군. #북쪽경계' },
    { charIdx: 3, content: '*빛의 오라를 두르며 나타난다.*\n\n루시아, 무리하지 마세요. 상처라도 있다면 치료해드릴게요.' },
    { charIdx: 0, content: '오늘 세계관에 새로 오신 분들 환영합니다! 🎉 편하게 말 걸어주세요. #세계관소개 #환영' },
  ];

  const postIds = [];
  for (const p of posts) {
    const char = charIds[p.charIdx];
    if (!char) continue;
    const id = nanoid();
    db.prepare('INSERT INTO posts (id, character_id, world_id, content, created_at) VALUES (?,?,?,?,?)').run(id, char.id, worldId, p.content, now());
    postIds.push(id);
  }
  console.log('\n✓ 포스트 ' + postIds.length + '개 생성');

  // 답글
  if (postIds[0] && charIds[1]) {
    const replyId = nanoid();
    db.prepare('INSERT INTO posts (id, character_id, world_id, content, reply_to_id, created_at) VALUES (?,?,?,?,?,?)').run(replyId, charIds[1].id, worldId, '*가볍게 고개를 끄덕인다.*\n\n고마워, 나비. 덕분에 기분이 좋아졌어.', postIds[0], now());
    console.log('✓ 답글 생성');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('더미 데이터 생성 완료!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('테스트 계정:');
  users.forEach(u => console.log(`  ${u.name}: ${u.email} / ${u.pw}`));
  console.log('세계관 슬러그:', slug);
}

seed().catch(console.error);
