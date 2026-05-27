import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,              // 최대 연결 수
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('DB pool error:', err.message);
});

// ? → $1,$2,... 변환 헬퍼
function q(sql) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return {
    async get(...p) { const { rows } = await pool.query(pgSql, p); return rows[0] ?? null; },
    async all(...p) { const { rows } = await pool.query(pgSql, p); return rows; },
    async run(...p) { await pool.query(pgSql, p); },
  };
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT DEFAULT 'member', theme TEXT DEFAULT 'light', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', banner_color TEXT DEFAULT '#185FA5', banner_height INTEGER DEFAULT 140, banner_image_url TEXT DEFAULT '', icon_emoji TEXT DEFAULT '', icon_image_url TEXT DEFAULT '', announce_text TEXT DEFAULT '', bg_image_url TEXT DEFAULT '', bg_overlay_opacity REAL DEFAULT 0.5, custom_font TEXT DEFAULT '', card_style TEXT DEFAULT 'default', banner_align TEXT DEFAULT 'left', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS world_members (world_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (world_id, user_id));
    CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, world_id TEXT NOT NULL, name TEXT NOT NULL, handle TEXT NOT NULL, role TEXT DEFAULT '', bio TEXT DEFAULT '', color_bg TEXT DEFAULT '#E6F1FB', color_fg TEXT DEFAULT '#185FA5', avatar_url TEXT DEFAULT '', header_url TEXT DEFAULT '', is_npc INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS char_sections (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT DEFAULT '', sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS char_links (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, label TEXT NOT NULL, url TEXT DEFAULT '', icon TEXT DEFAULT 'ti-link', link_type TEXT DEFAULT 'link', note_content TEXT DEFAULT '', sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, world_id TEXT NOT NULL, content TEXT NOT NULL, reply_to_id TEXT, is_pinned INTEGER DEFAULT 0, edited_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS post_media (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, url TEXT NOT NULL, media_type TEXT DEFAULT 'image', sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS reactions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, character_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(post_id, character_id));
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, recipient_user_id TEXT NOT NULL, type TEXT NOT NULL, actor_character_id TEXT, post_id TEXT, is_read INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS follows (id TEXT PRIMARY KEY, follower_character_id TEXT NOT NULL, following_character_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(follower_character_id, following_character_id));
    CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT DEFAULT '', author_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL, color TEXT DEFAULT '#5865F2', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, world_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dm_rooms (id TEXT PRIMARY KEY, name TEXT DEFAULT '', type TEXT DEFAULT 'dm', world_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dm_room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id TEXT, joined_at TEXT NOT NULL, PRIMARY KEY (room_id, user_id));
    CREATE TABLE IF NOT EXISTS dm_messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender_user_id TEXT NOT NULL, character_id TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dm_reads (user_id TEXT NOT NULL, room_id TEXT NOT NULL, last_read_at TEXT NOT NULL, PRIMARY KEY (user_id, room_id));
  `);
  console.log('✓ DB tables ready');
  // 마이그레이션: 기존 테이블에 새 컬럼 추가
  const migrations = [
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS custom_font TEXT DEFAULT ''`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS card_style TEXT DEFAULT 'default'`,
    `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS banner_align TEXT DEFAULT 'left'`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch {}
  }
}

export function now() { return new Date().toISOString(); }
function rndId() { return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2); }
export function getDb() { return pool; }
export function persist() {}

// ── User ──
export async function getUser(id) { return q('SELECT * FROM users WHERE id = ?').get(id); }
export async function getUserByEmail(e) { return q('SELECT * FROM users WHERE email = ?').get(e); }
export async function createUser(u) {
  await q('INSERT INTO users (id,email,password_hash,display_name,role,theme,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(u.id,u.email,u.password_hash,u.display_name,u.role||'member',u.theme||'light',u.created_at);
}
export async function updateUser(id, fields) {
  const keys = Object.keys(fields).filter(k=>['display_name','theme','role'].includes(k));
  if(!keys.length) return;
  const set = keys.map((k,i)=>`${k} = $${i+1}`).join(', ');
  await pool.query(`UPDATE users SET ${set} WHERE id = $${keys.length+1}`,[...keys.map(k=>fields[k]),id]);
}

// ── Session ──
export async function getSession(id) { return q('SELECT * FROM sessions WHERE id = ?').get(id); }
export async function createSession(s) { await q('INSERT INTO sessions (id,user_id,created_at) VALUES (?,?,?)').run(s.id,s.user_id,s.created_at); }
export async function deleteSession(id) { await q('DELETE FROM sessions WHERE id = ?').run(id); }

// ── World ──
export async function getWorldBySlug(slug) { return q('SELECT * FROM worlds WHERE slug = ?').get(slug); }
export async function getWorldById(id) { return q('SELECT * FROM worlds WHERE id = ?').get(id); }
export async function createWorld(w) {
  await pool.query(
    `INSERT INTO worlds (id,owner_id,name,slug,description,banner_color,banner_height,banner_image_url,icon_emoji,icon_image_url,announce_text,bg_image_url,bg_overlay_opacity,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [w.id,w.owner_id,w.name,w.slug,w.description||'',w.banner_color||'#185FA5',w.banner_height||140,w.banner_image_url||'',w.icon_emoji||'🌍',w.icon_image_url||'',w.announce_text||'',w.bg_image_url||'',w.bg_overlay_opacity??0.5,w.created_at]
  );
}
export async function updateWorld(id, fields) {
  const allowed = ['name','description','banner_color','banner_height','banner_image_url','icon_emoji','icon_image_url','announce_text','bg_image_url','bg_overlay_opacity','custom_font','card_style','banner_align'];
  const keys = Object.keys(fields).filter(k=>allowed.includes(k)&&fields[k]!==undefined);
  if(!keys.length) return getWorldById(id);
  const set = keys.map((k,i)=>`${k} = $${i+1}`).join(', ');
  await pool.query(`UPDATE worlds SET ${set} WHERE id = $${keys.length+1}`,[...keys.map(k=>fields[k]),id]);
  return getWorldById(id);
}
export async function getWorldsByUser(userId) {
  return pool.query(`SELECT DISTINCT w.* FROM worlds w LEFT JOIN world_members wm ON wm.world_id = w.id WHERE w.owner_id = $1 OR wm.user_id = $1 ORDER BY w.created_at DESC`,[userId]).then(r=>r.rows);
}
export async function addWorldMember(wid,uid) {
  await pool.query('INSERT INTO world_members (world_id,user_id,joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[wid,uid,now()]);
}
export async function getWorldMembers(wid) {
  return pool.query(`SELECT u.id,u.display_name FROM users u JOIN world_members wm ON wm.user_id=u.id WHERE wm.world_id=$1`,[wid]).then(r=>r.rows);
}

// ── Character ──
export async function getCharsByWorld(wid) {
  return pool.query(`SELECT c.*,u.display_name as player_name FROM characters c JOIN users u ON u.id=c.user_id WHERE c.world_id=$1 ORDER BY c.created_at ASC`,[wid]).then(r=>r.rows);
}
export async function getCharsByUser(uid,wid) {
  return pool.query('SELECT * FROM characters WHERE user_id=$1 AND world_id=$2',[uid,wid]).then(r=>r.rows);
}
export async function getCharById(id) {
  return pool.query(`SELECT c.*,u.display_name as player_name FROM characters c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,[id]).then(r=>r.rows[0]??null);
}
export async function getCharByHandle(wid,handle) { return q('SELECT * FROM characters WHERE world_id=? AND handle=?').get(wid,handle); }
export async function createChar(c) {
  await pool.query(`INSERT INTO characters (id,user_id,world_id,name,handle,role,bio,color_bg,color_fg,avatar_url,header_url,is_npc,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [c.id,c.user_id,c.world_id,c.name,c.handle,c.role||'',c.bio||'',c.color_bg||'#E6F1FB',c.color_fg||'#185FA5',c.avatar_url||'',c.header_url||'',c.is_npc?1:0,c.created_at]);
}
export async function updateChar(id,fields) {
  const allowed=['name','role','bio','color_bg','color_fg','avatar_url','header_url','is_npc','pinned_post_id'];
  const keys=Object.keys(fields).filter(k=>allowed.includes(k)&&fields[k]!==undefined);
  if(!keys.length) return getCharById(id);
  const set=keys.map((k,i)=>`${k} = $${i+1}`).join(', ');
  await pool.query(`UPDATE characters SET ${set} WHERE id = $${keys.length+1}`,[...keys.map(k=>fields[k]),id]);
  return getCharById(id);
}
export async function getCharSections(cid) { return pool.query('SELECT * FROM char_sections WHERE character_id=$1 ORDER BY sort_order',[cid]).then(r=>r.rows); }
export async function setCharSections(cid,sections) {
  await pool.query('DELETE FROM char_sections WHERE character_id=$1',[cid]);
  for(let i=0;i<sections.length;i++) await pool.query('INSERT INTO char_sections (id,character_id,title,content,sort_order) VALUES ($1,$2,$3,$4,$5)',[rndId(),cid,sections[i].title,sections[i].content||'',i]);
}
export async function getCharLinks(cid) { return pool.query('SELECT * FROM char_links WHERE character_id=$1 ORDER BY sort_order',[cid]).then(r=>r.rows); }
export async function setCharLinks(cid,links) {
  await pool.query('DELETE FROM char_links WHERE character_id=$1',[cid]);
  for(let i=0;i<links.length;i++){const l=links[i]; await pool.query('INSERT INTO char_links (id,character_id,label,url,icon,link_type,note_content,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[rndId(),cid,l.label,l.url||'',l.icon||'ti-link',l.link_type||'link',l.note_content||'',i]);}
}

// ── Post ──
// ── Post enrichment (단일 JOIN 쿼리로 최적화) ──
const POST_SELECT = `
  SELECT p.*,
    c.name as char_name, c.handle as char_handle,
    c.color_bg, c.color_fg, c.avatar_url, c.user_id,
    u.display_name as player_name,
    COUNT(DISTINCT r.id) as reactions,
    COUNT(DISTINCT rep.id) as replies
  FROM posts p
  LEFT JOIN characters c ON c.id = p.character_id
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN reactions r ON r.post_id = p.id
  LEFT JOIN posts rep ON rep.reply_to_id = p.id
`;

async function attachMedia(posts) {
  if (!posts.length) return posts;
  const ids = posts.map(p => p.id);
  const { rows } = await pool.query(
    `SELECT * FROM post_media WHERE post_id = ANY($1) ORDER BY sort_order`, [ids]
  );
  const mediaMap = {};
  for (const m of rows) {
    if (!mediaMap[m.post_id]) mediaMap[m.post_id] = [];
    mediaMap[m.post_id].push(m);
  }
  return posts.map(p => ({
    ...p,
    reactions: parseInt(p.reactions || 0),
    replies: parseInt(p.replies || 0),
    media: mediaMap[p.id] || []
  }));
}

async function enrichPost(p) {
  const { rows } = await pool.query(
    POST_SELECT + ` WHERE p.id = $1 GROUP BY p.id, c.name, c.handle, c.color_bg, c.color_fg, c.avatar_url, c.user_id, u.display_name`,
    [p.id || p]
  );
  const post = rows[0];
  if (!post) return null;
  return (await attachMedia([post]))[0];
}

export async function createPost(p) {
  await pool.query('INSERT INTO posts (id,character_id,world_id,content,reply_to_id,is_pinned,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[p.id,p.character_id,p.world_id,p.content,p.reply_to_id||null,0,p.created_at]);
}
export async function getPostById(id) {
  return enrichPost(id);
}
export async function getPostsByWorld(wid,limit=30,offset=0) {
  const { rows } = await pool.query(
    POST_SELECT + ` WHERE p.world_id = $1 AND p.reply_to_id IS NULL GROUP BY p.id, c.name, c.handle, c.color_bg, c.color_fg, c.avatar_url, c.user_id, u.display_name ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
    [wid, limit, offset]
  );
  return attachMedia(rows);
}
export async function getReplies(pid) {
  const { rows } = await pool.query(
    POST_SELECT + ` WHERE p.reply_to_id = $1 GROUP BY p.id, c.name, c.handle, c.color_bg, c.color_fg, c.avatar_url, c.user_id, u.display_name ORDER BY p.created_at ASC`,
    [pid]
  );
  return attachMedia(rows);
}
export async function deletePost(id) {
  const replies = await pool.query('SELECT id FROM posts WHERE reply_to_id=$1',[id]).then(r=>r.rows);
  for(const r of replies) await deletePost(r.id);
  await pool.query('DELETE FROM post_media WHERE post_id=$1',[id]);
  await pool.query('DELETE FROM reactions WHERE post_id=$1',[id]);
  await pool.query('DELETE FROM posts WHERE id=$1',[id]);
}
export async function getPostsByChar(cid,limit=30) {
  const { rows } = await pool.query(
    POST_SELECT + ` WHERE p.character_id = $1 AND p.reply_to_id IS NULL GROUP BY p.id, c.name, c.handle, c.color_bg, c.color_fg, c.avatar_url, c.user_id, u.display_name ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT $2`,
    [cid, limit]
  );
  return attachMedia(rows);
}
export async function addPostMedia(m) {
  await pool.query('INSERT INTO post_media (id,post_id,url,media_type,sort_order) VALUES ($1,$2,$3,$4,$5)',[m.id,m.post_id,m.url,m.media_type||'image',m.sort_order||0]);
}


// ── Reaction ──
export async function getReaction(pid,cid) { return q('SELECT * FROM reactions WHERE post_id=? AND character_id=?').get(pid,cid); }
export async function addReaction(r) { await pool.query('INSERT INTO reactions (id,post_id,character_id,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[r.id,r.post_id,r.character_id,r.created_at]); }
export async function removeReaction(pid,cid) { await q('DELETE FROM reactions WHERE post_id=? AND character_id=?').run(pid,cid); }
export async function getReactionCount(pid) { return parseInt((await q('SELECT COUNT(*) as cnt FROM reactions WHERE post_id=?').get(pid))?.cnt||0); }

// ── Notification ──
export async function createNotif(n) {
  await pool.query('INSERT INTO notifications (id,recipient_user_id,type,actor_character_id,post_id,is_read,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[n.id,n.recipient_user_id,n.type,n.actor_character_id||null,n.post_id||null,0,n.created_at]);
}
export async function getNotifs(uid,limit=30) {
  return pool.query(`SELECT n.*,c.name as actor_name,c.handle as actor_handle,c.avatar_url as actor_avatar,c.color_bg,c.color_fg,LEFT(p.content,80) as post_preview FROM notifications n LEFT JOIN characters c ON c.id=n.actor_character_id LEFT JOIN posts p ON p.id=n.post_id WHERE n.recipient_user_id=$1 ORDER BY n.created_at DESC LIMIT $2`,[uid,limit]).then(r=>r.rows);
}
export async function getUnreadCount(uid) { return parseInt((await q('SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id=? AND is_read=0').get(uid))?.cnt||0); }
export async function markAllRead(uid) { await q('UPDATE notifications SET is_read=1 WHERE recipient_user_id=?').run(uid); }

// ── Follow ──
export async function getFollowerCount(cid) { return parseInt((await q('SELECT COUNT(*) as cnt FROM follows WHERE following_character_id=?').get(cid))?.cnt||0); }
export async function getFollowingCount(cid) { return parseInt((await q('SELECT COUNT(*) as cnt FROM follows WHERE follower_character_id=?').get(cid))?.cnt||0); }

// ── Announcement ──
export async function getAnnouncements(wid) { return pool.query('SELECT * FROM announcements WHERE world_id=$1 ORDER BY created_at DESC',[wid]).then(r=>r.rows); }
export async function createAnnouncement(a) {
  await pool.query('INSERT INTO announcements (id,world_id,title,content,author_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[a.id,a.world_id,a.title,a.content||'',a.author_id||null,a.created_at]);
}
export async function deleteAnnouncement(id) { await q('DELETE FROM announcements WHERE id=?').run(id); }

// ── DM ──
export async function createRoom(r) {
  await pool.query('INSERT INTO dm_rooms (id,name,type,world_id,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[r.id,r.name||'',r.type||'dm',r.world_id||null,r.created_by,r.created_at]);
}
export async function getRoomsByUser(uid) {
  const rooms=await pool.query(`SELECT r.* FROM dm_rooms r JOIN dm_room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.created_at DESC`,[uid]).then(r=>r.rows);
  return Promise.all(rooms.map(async r=>{
    const [members,lastMsg]=await Promise.all([getRoomMembers(r.id),pool.query('SELECT * FROM dm_messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1',[r.id]).then(x=>x.rows[0]||null)]);
    return {...r,members,last_message:lastMsg};
  })).then(list=>list.sort((a,b)=>(b.last_message?.created_at||b.created_at).localeCompare(a.last_message?.created_at||a.created_at)));
}
export async function getRoomById(id) { return q('SELECT * FROM dm_rooms WHERE id=?').get(id); }
export async function addRoomMember(m) {
  await pool.query('INSERT INTO dm_room_members (room_id,user_id,character_id,joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[m.room_id,m.user_id,m.character_id||null,m.joined_at]);
}
export async function getRoomMembers(rid) {
  return pool.query(`SELECT m.*,u.display_name,c.name as char_name,c.color_bg as char_color_bg,c.color_fg as char_color_fg,c.avatar_url as char_avatar FROM dm_room_members m JOIN users u ON u.id=m.user_id LEFT JOIN characters c ON c.id=m.character_id WHERE m.room_id=$1`,[rid]).then(r=>r.rows);
}
export async function isRoomMember(rid,uid) { return !!(await q('SELECT 1 FROM dm_room_members WHERE room_id=? AND user_id=?').get(rid,uid)); }
export async function createDmMessage(msg) {
  await pool.query('INSERT INTO dm_messages (id,room_id,sender_user_id,character_id,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)',[msg.id,msg.room_id,msg.sender_user_id,msg.character_id||null,msg.content,msg.created_at]);
}
export async function getDmMessages(rid,limit=60) {
  return pool.query(`SELECT m.*,u.display_name,c.name as char_name,c.color_bg as char_color_bg,c.color_fg as char_color_fg,c.avatar_url as char_avatar,c.role as char_role FROM dm_messages m JOIN users u ON u.id=m.sender_user_id LEFT JOIN characters c ON c.id=m.character_id WHERE m.room_id=$1 ORDER BY m.created_at ASC`,[rid]).then(r=>r.rows.slice(-limit));
}
export async function getUnreadDmCount(uid) {
  const reads=await pool.query('SELECT room_id,last_read_at FROM dm_reads WHERE user_id=$1',[uid]).then(r=>r.rows);
  const readMap=Object.fromEntries(reads.map(r=>[r.room_id,r.last_read_at]));
  const rooms=await pool.query('SELECT room_id FROM dm_room_members WHERE user_id=$1',[uid]).then(r=>r.rows);
  let total=0;
  for(const {room_id} of rooms){
    const row=await pool.query('SELECT COUNT(*) as cnt FROM dm_messages WHERE room_id=$1 AND sender_user_id!=$2 AND created_at>$3',[room_id,uid,readMap[room_id]||'']).then(r=>r.rows[0]);
    total+=parseInt(row?.cnt||0);
  }
  return total;
}
export async function markDmRead(uid,rid) {
  await pool.query('INSERT INTO dm_reads (user_id,room_id,last_read_at) VALUES ($1,$2,$3) ON CONFLICT (user_id,room_id) DO UPDATE SET last_read_at=$3',[uid,rid,now()]);
}
export async function findDmRoom(uidA,uidB) {
  return pool.query(`SELECT r.* FROM dm_rooms r JOIN dm_room_members a ON a.room_id=r.id AND a.user_id=$1 JOIN dm_room_members b ON b.room_id=r.id AND b.user_id=$2 WHERE r.type='dm' AND (SELECT COUNT(*) FROM dm_room_members WHERE room_id=r.id)=2 LIMIT 1`,[uidA,uidB]).then(r=>r.rows[0]||null);
}
