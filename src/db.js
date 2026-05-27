import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '../db');
const DB_PATH = join(DB_DIR, 'lorethread.db');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // 동시 읽기 성능 향상
db.pragma('foreign_keys = ON');

// ── 테이블 생성 ──
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  theme TEXT DEFAULT 'light',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  banner_color TEXT DEFAULT '#185FA5',
  banner_height INTEGER DEFAULT 140,
  banner_image_url TEXT DEFAULT '',
  icon_emoji TEXT DEFAULT '🌍',
  icon_image_url TEXT DEFAULT '',
  announce_text TEXT DEFAULT '',
  bg_image_url TEXT DEFAULT '',
  bg_overlay_opacity REAL DEFAULT 0.5,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS world_members (
  world_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (world_id, user_id)
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  role TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  color_bg TEXT DEFAULT '#E6F1FB',
  color_fg TEXT DEFAULT '#185FA5',
  avatar_url TEXT DEFAULT '',
  header_url TEXT DEFAULT '',
  is_npc INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS char_sections (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS char_links (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT DEFAULT '',
  icon TEXT DEFAULT 'ti-link',
  link_type TEXT DEFAULT 'link',
  note_content TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  is_pinned INTEGER DEFAULT 0,
  edited_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  url TEXT NOT NULL,
  media_type TEXT DEFAULT 'image',
  sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(post_id, character_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_character_id TEXT,
  post_id TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  follower_character_id TEXT NOT NULL,
  following_character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(follower_character_id, following_character_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  author_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  color TEXT DEFAULT '#5865F2',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_rooms (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  type TEXT DEFAULT 'dm',
  world_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_room_members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  character_id TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  character_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_reads (
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
`);

// ── 유틸 ──
export function now() { return new Date().toISOString(); }
function rndId() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

// getDb / persist — server.js 호환성 유지 (SQLite는 즉시 저장이라 persist는 no-op)
export function getDb() { return db; }
export function persist() {}

// ── User ──
export function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}
export function createUser(u) {
  db.prepare('INSERT INTO users (id,email,password_hash,display_name,role,theme,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(u.id, u.email, u.password_hash, u.display_name, u.role || 'member', u.theme || 'light', u.created_at);
}
export function updateUser(id, fields) {
  const allowed = ['display_name','theme','role'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}

// ── Session ──
export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}
export function createSession(s) {
  db.prepare('INSERT INTO sessions (id,user_id,created_at) VALUES (?,?,?)').run(s.id, s.user_id, s.created_at);
}
export function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── World ──
export function getWorldBySlug(slug) {
  return db.prepare('SELECT * FROM worlds WHERE slug = ?').get(slug) || null;
}
export function getWorldById(id) {
  return db.prepare('SELECT * FROM worlds WHERE id = ?').get(id) || null;
}
export function createWorld(w) {
  db.prepare(`INSERT INTO worlds (id,owner_id,name,slug,description,banner_color,banner_height,banner_image_url,icon_emoji,icon_image_url,announce_text,bg_image_url,bg_overlay_opacity,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(w.id, w.owner_id, w.name, w.slug, w.description||'', w.banner_color||'#185FA5',
        w.banner_height||140, w.banner_image_url||'', w.icon_emoji||'🌍', w.icon_image_url||'',
        w.announce_text||'', w.bg_image_url||'', w.bg_overlay_opacity??0.5, w.created_at);
}
export function updateWorld(id, fields) {
  const allowed = ['name','description','banner_color','banner_height','banner_image_url',
    'icon_emoji','icon_image_url','announce_text','bg_image_url','bg_overlay_opacity'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
  if (!keys.length) return getWorldById(id);
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE worlds SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
  return getWorldById(id);
}
export function getWorldsByUser(userId) {
  return db.prepare(`
    SELECT DISTINCT w.* FROM worlds w
    LEFT JOIN world_members wm ON wm.world_id = w.id
    WHERE w.owner_id = ? OR wm.user_id = ?
    ORDER BY w.created_at DESC
  `).all(userId, userId);
}
export function addWorldMember(worldId, userId) {
  db.prepare('INSERT OR IGNORE INTO world_members (world_id,user_id,joined_at) VALUES (?,?,?)').run(worldId, userId, now());
}
export function getWorldMembers(worldId) {
  return db.prepare(`
    SELECT u.id, u.display_name FROM users u
    JOIN world_members wm ON wm.user_id = u.id
    WHERE wm.world_id = ?
  `).all(worldId);
}

// ── Character ──
export function getCharsByWorld(worldId) {
  return db.prepare(`
    SELECT c.*, u.display_name as player_name FROM characters c
    JOIN users u ON u.id = c.user_id
    WHERE c.world_id = ?
    ORDER BY c.created_at ASC
  `).all(worldId);
}
export function getCharsByUser(userId, worldId) {
  return db.prepare('SELECT * FROM characters WHERE user_id = ? AND world_id = ?').all(userId, worldId);
}
export function getCharById(id) {
  const c = db.prepare(`
    SELECT c.*, u.display_name as player_name FROM characters c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(id);
  return c || null;
}
export function getCharByHandle(worldId, handle) {
  return db.prepare('SELECT * FROM characters WHERE world_id = ? AND handle = ?').get(worldId, handle) || null;
}
export function createChar(c) {
  db.prepare(`INSERT INTO characters (id,user_id,world_id,name,handle,role,bio,color_bg,color_fg,avatar_url,header_url,is_npc,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(c.id, c.user_id, c.world_id, c.name, c.handle, c.role||'', c.bio||'',
        c.color_bg||'#E6F1FB', c.color_fg||'#185FA5', c.avatar_url||'', c.header_url||'',
        c.is_npc?1:0, c.created_at);
}
export function updateChar(id, fields) {
  const allowed = ['name','role','bio','color_bg','color_fg','avatar_url','header_url','is_npc','pinned_post_id'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== undefined);
  if (!keys.length) return getCharById(id);
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE characters SET ${set} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
  return getCharById(id);
}
export function getCharSections(charId) {
  return db.prepare('SELECT * FROM char_sections WHERE character_id = ? ORDER BY sort_order').all(charId);
}
export function setCharSections(charId, sections) {
  db.prepare('DELETE FROM char_sections WHERE character_id = ?').run(charId);
  const ins = db.prepare('INSERT INTO char_sections (id,character_id,title,content,sort_order) VALUES (?,?,?,?,?)');
  sections.forEach((s, i) => ins.run(rndId(), charId, s.title, s.content||'', i));
}
export function getCharLinks(charId) {
  return db.prepare('SELECT * FROM char_links WHERE character_id = ? ORDER BY sort_order').all(charId);
}
export function setCharLinks(charId, links) {
  db.prepare('DELETE FROM char_links WHERE character_id = ?').run(charId);
  const ins = db.prepare('INSERT INTO char_links (id,character_id,label,url,icon,link_type,note_content,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  links.forEach((l, i) => ins.run(rndId(), charId, l.label, l.url||'', l.icon||'ti-link', l.link_type||'link', l.note_content||'', i));
}

// ── Post ──
function enrichPost(p) {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(p.character_id) || {};
  const u = c.user_id ? (db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id) || {}) : {};
  const media = db.prepare('SELECT * FROM post_media WHERE post_id = ? ORDER BY sort_order').all(p.id);
  const reactions = db.prepare('SELECT COUNT(*) as cnt FROM reactions WHERE post_id = ?').get(p.id)?.cnt || 0;
  const replies = db.prepare('SELECT COUNT(*) as cnt FROM posts WHERE reply_to_id = ?').get(p.id)?.cnt || 0;
  return { ...p, char_name: c.name||'', char_handle: c.handle||'', color_bg: c.color_bg||'#eee',
    color_fg: c.color_fg||'#333', avatar_url: c.avatar_url||'', player_name: u.display_name||'',
    user_id: c.user_id||'', media, reactions, replies };
}
export function createPost(p) {
  db.prepare('INSERT INTO posts (id,character_id,world_id,content,reply_to_id,is_pinned,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(p.id, p.character_id, p.world_id, p.content, p.reply_to_id||null, 0, p.created_at);
}
export function getPostById(id) {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  return p ? enrichPost(p) : null;
}
export function getPostsByWorld(worldId, limit=30, offset=0) {
  return db.prepare('SELECT * FROM posts WHERE world_id = ? AND reply_to_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(worldId, limit, offset).map(enrichPost);
}
export function getReplies(postId) {
  return db.prepare('SELECT * FROM posts WHERE reply_to_id = ? ORDER BY created_at ASC').all(postId).map(enrichPost);
}
export function deletePost(id) {
  // 재귀적으로 답글 삭제
  const replies = db.prepare('SELECT id FROM posts WHERE reply_to_id = ?').all(id);
  replies.forEach(r => deletePost(r.id));
  db.prepare('DELETE FROM post_media WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM reactions WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}
export function getPostsByChar(charId, limit=30) {
  return db.prepare('SELECT * FROM posts WHERE character_id = ? AND reply_to_id IS NULL ORDER BY is_pinned DESC, created_at DESC LIMIT ?')
    .all(charId, limit).map(enrichPost);
}

// ── Media ──
export function addPostMedia(m) {
  db.prepare('INSERT INTO post_media (id,post_id,url,media_type,sort_order) VALUES (?,?,?,?,?)')
    .run(m.id, m.post_id, m.url, m.media_type||'image', m.sort_order||0);
}

// ── Reaction ──
export function getReaction(postId, charId) {
  return db.prepare('SELECT * FROM reactions WHERE post_id = ? AND character_id = ?').get(postId, charId) || null;
}
export function addReaction(r) {
  db.prepare('INSERT OR IGNORE INTO reactions (id,post_id,character_id,created_at) VALUES (?,?,?,?)').run(r.id, r.post_id, r.character_id, r.created_at);
}
export function removeReaction(postId, charId) {
  db.prepare('DELETE FROM reactions WHERE post_id = ? AND character_id = ?').run(postId, charId);
}
export function getReactionCount(postId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM reactions WHERE post_id = ?').get(postId)?.cnt || 0;
}

// ── Notification ──
export function createNotif(n) {
  db.prepare('INSERT INTO notifications (id,recipient_user_id,type,actor_character_id,post_id,is_read,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(n.id, n.recipient_user_id, n.type, n.actor_character_id||null, n.post_id||null, 0, n.created_at);
}
export function getNotifs(userId, limit=30) {
  return db.prepare(`
    SELECT n.*, c.name as actor_name, c.handle as actor_handle, c.avatar_url as actor_avatar,
           c.color_bg, c.color_fg, SUBSTR(p.content,1,80) as post_preview
    FROM notifications n
    LEFT JOIN characters c ON c.id = n.actor_character_id
    LEFT JOIN posts p ON p.id = n.post_id
    WHERE n.recipient_user_id = ?
    ORDER BY n.created_at DESC LIMIT ?
  `).all(userId, limit);
}
export function getUnreadCount(userId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id = ? AND is_read = 0').get(userId)?.cnt || 0;
}
export function markAllRead(userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE recipient_user_id = ?').run(userId);
}

// ── Follow ──
export function getFollowerCount(charId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM follows WHERE following_character_id = ?').get(charId)?.cnt || 0;
}
export function getFollowingCount(charId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM follows WHERE follower_character_id = ?').get(charId)?.cnt || 0;
}

// ── Announcement ──
export function getAnnouncements(worldId) {
  return db.prepare('SELECT * FROM announcements WHERE world_id = ? ORDER BY created_at DESC').all(worldId);
}
export function createAnnouncement(a) {
  db.prepare('INSERT INTO announcements (id,world_id,title,content,author_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(a.id, a.world_id, a.title, a.content||'', a.author_id||null, a.created_at);
}
export function deleteAnnouncement(id) {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
}

// ── DM ──
export function createRoom(room) {
  db.prepare('INSERT INTO dm_rooms (id,name,type,world_id,created_by,created_at) VALUES (?,?,?,?,?,?)')
    .run(room.id, room.name||'', room.type||'dm', room.world_id||null, room.created_by, room.created_at);
}
export function getRoomsByUser(userId) {
  const rooms = db.prepare(`
    SELECT r.* FROM dm_rooms r
    JOIN dm_room_members m ON m.room_id = r.id
    WHERE m.user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId);
  return rooms.map(r => {
    const members = getRoomMembers(r.id);
    const lastMsg = db.prepare('SELECT * FROM dm_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 1').get(r.id) || null;
    return { ...r, members, last_message: lastMsg };
  }).sort((a,b) => {
    const at = a.last_message?.created_at || a.created_at;
    const bt = b.last_message?.created_at || b.created_at;
    return bt.localeCompare(at);
  });
}
export function getRoomById(id) {
  return db.prepare('SELECT * FROM dm_rooms WHERE id = ?').get(id) || null;
}
export function addRoomMember(m) {
  db.prepare('INSERT OR IGNORE INTO dm_room_members (room_id,user_id,character_id,joined_at) VALUES (?,?,?,?)')
    .run(m.room_id, m.user_id, m.character_id||null, m.joined_at);
}
export function getRoomMembers(roomId) {
  return db.prepare(`
    SELECT m.*, u.display_name, c.name as char_name,
           c.color_bg as char_color_bg, c.color_fg as char_color_fg, c.avatar_url as char_avatar
    FROM dm_room_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN characters c ON c.id = m.character_id
    WHERE m.room_id = ?
  `).all(roomId);
}
export function isRoomMember(roomId, userId) {
  return !!db.prepare('SELECT 1 FROM dm_room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
}
export function createDmMessage(msg) {
  db.prepare('INSERT INTO dm_messages (id,room_id,sender_user_id,character_id,content,created_at) VALUES (?,?,?,?,?,?)')
    .run(msg.id, msg.room_id, msg.sender_user_id, msg.character_id||null, msg.content, msg.created_at);
}
export function getDmMessages(roomId, limit=60) {
  return db.prepare(`
    SELECT m.*, u.display_name,
           c.name as char_name, c.color_bg as char_color_bg, c.color_fg as char_color_fg,
           c.avatar_url as char_avatar, c.role as char_role
    FROM dm_messages m
    JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN characters c ON c.id = m.character_id
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC
  `).all(roomId).slice(-limit);
}
export function getUnreadDmCount(userId) {
  const reads = db.prepare('SELECT room_id, last_read_at FROM dm_reads WHERE user_id = ?').all(userId);
  const readMap = Object.fromEntries(reads.map(r => [r.room_id, r.last_read_at]));
  const rooms = db.prepare('SELECT room_id FROM dm_room_members WHERE user_id = ?').all(userId);
  let total = 0;
  for (const { room_id } of rooms) {
    const lastRead = readMap[room_id] || '';
    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM dm_messages WHERE room_id = ? AND sender_user_id != ? AND created_at > ?')
      .get(room_id, userId, lastRead)?.cnt || 0;
    total += cnt;
  }
  return total;
}
export function markDmRead(userId, roomId) {
  db.prepare('INSERT OR REPLACE INTO dm_reads (user_id,room_id,last_read_at) VALUES (?,?,?)').run(userId, roomId, now());
}
export function findDmRoom(userIdA, userIdB) {
  return db.prepare(`
    SELECT r.* FROM dm_rooms r
    JOIN dm_room_members a ON a.room_id = r.id AND a.user_id = ?
    JOIN dm_room_members b ON b.room_id = r.id AND b.user_id = ?
    WHERE r.type = 'dm'
    AND (SELECT COUNT(*) FROM dm_room_members WHERE room_id = r.id) = 2
    LIMIT 1
  `).get(userIdA, userIdB) || null;
}
