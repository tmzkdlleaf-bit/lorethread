import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '../db');
const DB_PATH = join(DB_DIR, 'data.json');

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

const EMPTY = {
  users: [], sessions: [], worlds: [], world_members: [], announcements: [],
  characters: [], char_sections: [], char_links: [],
  posts: [], post_media: [], reactions: [], notifications: [], follows: []
};

let _db = null;

function load() {
  if (_db) return _db;
  if (existsSync(DB_PATH)) {
    try { _db = JSON.parse(readFileSync(DB_PATH, 'utf8')); }
    catch { _db = { ...EMPTY }; }
    // ensure all tables exist
    for (const k of Object.keys(EMPTY)) if (!_db[k]) _db[k] = [];
  } else {
    _db = { ...EMPTY };
  }
  return _db;
}

function save() {
  writeFileSync(DB_PATH, JSON.stringify(_db, null, 2), 'utf8');
}

export function getDb() { return load(); }
export function persist() { save(); }

// ── User helpers ──
export function getUser(id) { return load().users.find(u => u.id === id) || null; }
export function getUserByEmail(e) { return load().users.find(u => u.email === e) || null; }
export function createUser(u) { load().users.push(u); save(); }
export function updateUser(id, fields) {
  const db = load(); const i = db.users.findIndex(u => u.id === id);
  if (i >= 0) { db.users[i] = { ...db.users[i], ...fields }; save(); }
}

// ── Session helpers ──
export function getSession(id) { return load().sessions.find(s => s.id === id) || null; }
export function createSession(s) { load().sessions.push(s); save(); }
export function deleteSession(id) { const db=load(); db.sessions=db.sessions.filter(s=>s.id!==id); save(); }

// ── World helpers ──
export function getWorldBySlug(slug) { return load().worlds.find(w => w.slug === slug) || null; }
export function getWorldById(id) { return load().worlds.find(w => w.id === id) || null; }
export function createWorld(w) { load().worlds.push(w); save(); }
export function updateWorld(id, fields) {
  const db = load(); const i = db.worlds.findIndex(w => w.id === id);
  if (i >= 0) { db.worlds[i] = { ...db.worlds[i], ...fields }; save(); return db.worlds[i]; }
  return null;
}
export function getWorldsByUser(userId) {
  const db = load();
  const memberWorldIds = db.world_members.filter(m => m.user_id === userId).map(m => m.world_id);
  return db.worlds.filter(w => w.owner_id === userId || memberWorldIds.includes(w.id))
    .sort((a, b) => a.created_at > b.created_at ? -1 : 1);
}
export function addWorldMember(worldId, userId) {
  const db = load();
  if (!db.world_members.find(m => m.world_id === worldId && m.user_id === userId)) {
    db.world_members.push({ world_id: worldId, user_id: userId, joined_at: now() });
    save();
  }
}
export function getWorldMembers(worldId) {
  const db = load();
  return db.world_members.filter(m => m.world_id === worldId)
    .map(m => db.users.find(u => u.id === m.user_id))
    .filter(Boolean)
    .map(u => ({ id: u.id, display_name: u.display_name }));
}

// ── Character helpers ──
export function getCharsByWorld(worldId) {
  const db = load();
  return db.characters.filter(c => c.world_id === worldId)
    .map(c => {
      const u = db.users.find(u => u.id === c.user_id);
      return { ...c, player_name: u?.display_name || '' };
    });
}
export function getCharsByUser(userId, worldId) {
  return load().characters.filter(c => c.user_id === userId && c.world_id === worldId);
}
export function getCharById(id) {
  const db = load(); const c = db.characters.find(c => c.id === id);
  if (!c) return null;
  const u = db.users.find(u => u.id === c.user_id);
  return { ...c, player_name: u?.display_name || '' };
}
export function getCharByHandle(worldId, handle) {
  return load().characters.find(c => c.world_id === worldId && c.handle === handle) || null;
}
export function createChar(c) { load().characters.push(c); save(); }
export function updateChar(id, fields) {
  const db = load(); const i = db.characters.findIndex(c => c.id === id);
  if (i >= 0) { db.characters[i] = { ...db.characters[i], ...fields }; save(); return db.characters[i]; }
  return null;
}
export function getCharSections(charId) {
  return load().char_sections.filter(s => s.character_id === charId).sort((a,b)=>a.sort_order-b.sort_order);
}
export function setCharSections(charId, sections) {
  const db = load();
  db.char_sections = db.char_sections.filter(s => s.character_id !== charId);
  sections.forEach((s, i) => db.char_sections.push({ id: rndId(), character_id: charId, title: s.title, content: s.content, sort_order: i }));
  save();
}
export function getCharLinks(charId) {
  return load().char_links.filter(l => l.character_id === charId).sort((a,b)=>a.sort_order-b.sort_order);
}
export function setCharLinks(charId, links) {
  const db = load();
  db.char_links = db.char_links.filter(l => l.character_id !== charId);
  links.forEach((l, i) => db.char_links.push({ id: rndId(), character_id: charId, ...l, sort_order: i }));
  save();
}

// ── Post helpers ──
export function createPost(p) { load().posts.push(p); save(); }
export function getPostById(id) {
  const db = load(); const p = db.posts.find(p => p.id === id);
  if (!p) return null;
  return enrichPost(db, p);
}
export function getPostsByWorld(worldId, limit=30, offset=0) {
  const db = load();
  return db.posts.filter(p => p.world_id === worldId && !p.reply_to_id)
    .sort((a,b) => b.created_at.localeCompare(a.created_at))
    .slice(offset, offset+limit)
    .map(p => enrichPost(db, p));
}
export function getReplies(postId) {
  const db = load();
  return db.posts.filter(p => p.reply_to_id === postId)
    .sort((a,b) => a.created_at.localeCompare(b.created_at))
    .map(p => enrichPost(db, p));
}
export function deletePost(id) {
  const db = load();
  db.posts = db.posts.filter(p => p.id !== id && p.reply_to_id !== id);
  save();
}
export function getPostsByChar(charId, limit=30) {
  const db = load();
  return db.posts.filter(p => p.character_id === charId && !p.reply_to_id)
    .sort((a,b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return b.created_at.localeCompare(a.created_at);
    })
    .slice(0, limit)
    .map(p => enrichPost(db, p));
}
function enrichPost(db, p) {
  const c = db.characters.find(c => c.id === p.character_id) || {};
  const u = db.users.find(u => u.id === c.user_id) || {};
  const media = db.post_media.filter(m => m.post_id === p.id).sort((a,b)=>a.sort_order-b.sort_order);
  const reactions = db.reactions.filter(r => r.post_id === p.id).length;
  const replies = db.posts.filter(r => r.reply_to_id === p.id).length;
  return { ...p, char_name: c.name||'', char_handle: c.handle||'', color_bg: c.color_bg||'#eee',
    color_fg: c.color_fg||'#333', avatar_url: c.avatar_url||'', player_name: u.display_name||'',
    user_id: c.user_id||'', media, reactions, replies };
}

// ── Media ──
export function addPostMedia(m) { load().post_media.push(m); save(); }

// ── Reactions ──
export function getReaction(postId, charId) {
  return load().reactions.find(r => r.post_id === postId && r.character_id === charId) || null;
}
export function addReaction(r) { load().reactions.push(r); save(); }
export function removeReaction(postId, charId) {
  const db = load(); db.reactions = db.reactions.filter(r => !(r.post_id===postId && r.character_id===charId)); save();
}
export function getReactionCount(postId) { return load().reactions.filter(r => r.post_id === postId).length; }

// ── Notifications ──
export function createNotif(n) { load().notifications.push(n); save(); }
export function getNotifs(userId, limit=30) {
  const db = load();
  return db.notifications.filter(n => n.recipient_user_id === userId)
    .sort((a,b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(n => {
      const c = db.characters.find(c => c.id === n.actor_character_id);
      const p = db.posts.find(p => p.id === n.post_id);
      return { ...n, actor_name: c?.name||'', actor_handle: c?.handle||'',
        actor_avatar: c?.avatar_url||'', color_bg: c?.color_bg||'', color_fg: c?.color_fg||'',
        post_preview: p?.content?.slice(0,80)||'' };
    });
}
export function getUnreadCount(userId) {
  return load().notifications.filter(n => n.recipient_user_id === userId && !n.is_read).length;
}
export function markAllRead(userId) {
  const db = load();
  db.notifications.filter(n => n.recipient_user_id === userId).forEach(n => n.is_read = true);
  save();
}

// ── Follows ──
export function getFollowerCount(charId) { return load().follows.filter(f => f.following_character_id === charId).length; }
export function getFollowingCount(charId) { return load().follows.filter(f => f.follower_character_id === charId).length; }

// ── Utils ──
export function now() { return new Date().toISOString(); }
function rndId() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

// ══════════════════════════════════════
//  DM (다이렉트 메시지 + 그룹 채팅방)
// ══════════════════════════════════════

export function createRoom(room) {
  // room: {id, name, type('dm'|'group'), world_id, created_by, created_at}
  const db = load();
  if (!db.dm_rooms) db.dm_rooms = [];
  db.dm_rooms.push(room);
  save();
}

export function getRoomsByUser(userId) {
  const db = load();
  if (!db.dm_rooms) return [];
  const memberRoomIds = (db.dm_room_members || [])
    .filter(m => m.user_id === userId)
    .map(m => m.room_id);
  return db.dm_rooms.filter(r => memberRoomIds.includes(r.id))
    .map(r => {
      const members = (db.dm_room_members || [])
        .filter(m => m.room_id === r.id)
        .map(m => {
          const u = db.users.find(u => u.id === m.user_id);
          const char = m.character_id ? db.characters.find(c => c.id === m.character_id) : null;
          return { user_id: m.user_id, display_name: u?.display_name || '', character_id: m.character_id, char_name: char?.name || '', char_color_bg: char?.color_bg || '', char_color_fg: char?.color_fg || '', char_avatar: char?.avatar_url || '' };
        });
      const lastMsg = (db.dm_messages || [])
        .filter(m => m.room_id === r.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return { ...r, members, last_message: lastMsg || null };
    })
    .sort((a, b) => {
      const at = a.last_message?.created_at || a.created_at;
      const bt = b.last_message?.created_at || b.created_at;
      return bt.localeCompare(at);
    });
}

export function getRoomById(id) {
  const db = load();
  return (db.dm_rooms || []).find(r => r.id === id) || null;
}

export function addRoomMember(member) {
  // member: {room_id, user_id, character_id, joined_at}
  const db = load();
  if (!db.dm_room_members) db.dm_room_members = [];
  const exists = db.dm_room_members.find(m => m.room_id === member.room_id && m.user_id === member.user_id);
  if (!exists) { db.dm_room_members.push(member); save(); }
}

export function getRoomMembers(roomId) {
  const db = load();
  return (db.dm_room_members || []).filter(m => m.room_id === roomId).map(m => {
    const u = db.users.find(u => u.id === m.user_id);
    const char = m.character_id ? db.characters.find(c => c.id === m.character_id) : null;
    return { ...m, display_name: u?.display_name || '', char_name: char?.name || '', char_color_bg: char?.color_bg || '', char_color_fg: char?.color_fg || '', char_avatar: char?.avatar_url || '' };
  });
}

export function isRoomMember(roomId, userId) {
  const db = load();
  return !!(db.dm_room_members || []).find(m => m.room_id === roomId && m.user_id === userId);
}

export function createDmMessage(msg) {
  // msg: {id, room_id, sender_user_id, character_id, content, created_at}
  const db = load();
  if (!db.dm_messages) db.dm_messages = [];
  db.dm_messages.push(msg);
  save();
}

export function getDmMessages(roomId, limit = 60) {
  const db = load();
  return (db.dm_messages || [])
    .filter(m => m.room_id === roomId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-limit)
    .map(m => {
      const u = db.users.find(u => u.id === m.sender_user_id);
      const char = m.character_id ? db.characters.find(c => c.id === m.character_id) : null;
      return { ...m, display_name: u?.display_name || '', char_name: char?.name || char?.handle || '', char_color_bg: char?.color_bg || '#E6F1FB', char_color_fg: char?.color_fg || '#185FA5', char_avatar: char?.avatar_url || '', char_role: char?.role || '' };
    });
}

export function getUnreadDmCount(userId) {
  const db = load();
  // 간단히: 마지막 읽은 메시지 이후 새 메시지 수
  const reads = db.dm_reads || {};
  let total = 0;
  const roomIds = (db.dm_room_members || []).filter(m => m.user_id === userId).map(m => m.room_id);
  for (const rid of roomIds) {
    const lastRead = reads[`${userId}:${rid}`] || '';
    const unread = (db.dm_messages || []).filter(m => m.room_id === rid && m.sender_user_id !== userId && m.created_at > lastRead).length;
    total += unread;
  }
  return total;
}

export function markDmRead(userId, roomId) {
  const db = load();
  if (!db.dm_reads) db.dm_reads = {};
  db.dm_reads[`${userId}:${roomId}`] = new Date().toISOString();
  save();
}

export function findDmRoom(userIdA, userIdB) {
  const db = load();
  if (!db.dm_rooms) return null;
  const dmRooms = db.dm_rooms.filter(r => r.type === 'dm');
  for (const room of dmRooms) {
    const members = (db.dm_room_members || []).filter(m => m.room_id === room.id).map(m => m.user_id);
    if (members.includes(userIdA) && members.includes(userIdB) && members.length === 2) return room;
  }
  return null;
}

// ── Announcements ──
export function getAnnouncements(worldId) {
  const d = load();
  if (!d.announcements) d.announcements = [];
  return d.announcements
    .filter(a => a.world_id === worldId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export function createAnnouncement(a) {
  const d = load();
  if (!d.announcements) d.announcements = [];
  d.announcements.push(a);
  save();
}
export function deleteAnnouncement(id) {
  const d = load();
  d.announcements = (d.announcements || []).filter(a => a.id !== id);
  save();
}
