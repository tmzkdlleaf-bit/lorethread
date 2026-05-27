import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import {
  initDb, now,
  getUserByEmail, createUser,
  createWorld, addWorldMember,
  createChar, createPost
} from './db.js';

async function seed() {
  await initDb();

  const users = [
    { name: '나비', email: 'nabi@test.com', pw: 'test1234', role: 'owner' },
    { name: '루시아', email: 'lucia@test.com', pw: 'test1234', role: 'member' },
    { name: '검은늑대', email: 'wolf@test.com', pw: 'test1234', role: 'member' },
  ];

  const userIds = [];
  for (const u of users) {
    const existing = await getUserByEmail(u.email);
    if (existing) { console.log(`⚠ ${u.name} 이미 존재`); userIds.push(existing.id); continue; }
    const id = nanoid();
    const hash = await bcrypt.hash(u.pw, 8);
    await createUser({ id, email: u.email, password_hash: hash, display_name: u.name, role: u.role, created_at: now() });
    userIds.push(id);
    console.log(`✓ 계정: ${u.name} (${u.email} / ${u.pw})`);
  }

  const worldId = nanoid();
  const slug = 'test-' + nanoid(4);
  await createWorld({ id: worldId, owner_id: userIds[0], name: '테스트 세계관', slug, description: '교류 테스트용', banner_color: '#534AB7', icon_emoji: '🌙', announce_text: '반갑습니다!', created_at: now() });
  for (const uid of userIds) await addWorldMember(worldId, uid);
  console.log('✓ 세계관:', slug);

  const chars = [
    { uid:0, name:'나비', handle:'nabi', role:'마법 정령', bio:'꽃밭을 지키는 작은 정령.', color_bg:'#EEEDFE', color_fg:'#534AB7' },
    { uid:1, name:'루시아', handle:'lucia', role:'기사단장', bio:'왕국의 검은 기사단을 이끄는 전사.', color_bg:'#FAECE7', color_fg:'#993C1D' },
    { uid:2, name:'그림자', handle:'shadow', role:'암살자', bio:'어둠 속에서 움직이는 존재.', color_bg:'#252320', color_fg:'#a8a098' },
    { uid:1, name:'빛의 성녀', handle:'saintess', role:'치유사', bio:'빛의 신을 섬기는 성녀.', color_bg:'#FFF9E6', color_fg:'#8B6914' },
  ];
  const charIds = [];
  for (const c of chars) {
    const id = nanoid();
    await createChar({ id, user_id: userIds[c.uid], world_id: worldId, name: c.name, handle: c.handle, role: c.role, bio: c.bio, color_bg: c.color_bg, color_fg: c.color_fg, created_at: now() });
    charIds.push(id);
    console.log(`  ✓ 캐릭터: ${c.name} (@${c.handle})`);
  }

  const posts = [
    { ci:0, content:'*꽃밭 사이를 날아다니며 작은 날개를 파닥인다.*\n\n오늘도 좋은 날씨네요. @lucia 기사단장님, 순찰은 잘 끝났나요?' },
    { ci:1, content:'*검을 칼집에 꽂으며 고개를 돌린다.*\n\n@nabi — 그래, 무사히 마쳤어. #북쪽경계에 이상한 기운이 있긴 했지만.' },
    { ci:2, content:'*어둠 속에서 낮게 중얼거린다.*\n\n...흥미롭군.' },
    { ci:3, content:'루시아, 무리하지 마세요. 상처라도 있다면 치료해드릴게요.' },
  ];
  for (const p of posts) {
    await createPost({ id: nanoid(), character_id: charIds[p.ci], world_id: worldId, content: p.content, created_at: now() });
  }
  console.log(`✓ 포스트 ${posts.length}개 생성`);
  console.log('\n세계관 슬러그:', slug);
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });
