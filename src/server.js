import 'dotenv/config';
import http from 'http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseCookie } from 'cookie';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { v2 as cloudinary } from 'cloudinary';
import {
  initDb, now, getDb,
  getUser, getUserByEmail, createUser, updateUser,
  getSession, createSession, deleteSession,
  getWorldBySlug, getWorldById, createWorld, updateWorld, getWorldsByUser, addWorldMember, getWorldMembers,
  getCharsByWorld, getCharsByUser, getCharById, getCharByHandle, createChar, updateChar,
  getCharSections, setCharSections, getCharLinks, setCharLinks,
  createPost, getPostById, getPostsByWorld, getPostsByFollowing, getReplies, deletePost, getPostsByChar,
  addPostMedia, getReaction, addReaction, removeReaction, getReactionCount,
  createNotif, getNotifs, getUnreadCount, markAllRead,
  getAnnouncements, createAnnouncement, deleteAnnouncement,
  getFollowerCount, getFollowingCount,
  createRoom, getRoomsByUser, getRoomById, addRoomMember, getRoomMembers,
  isRoomMember, createDmMessage, getDmMessages, getUnreadDmCount, markDmRead, findDmRoom
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm']);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
const UPLOADS_DIR = join(__dirname, '../tmp_uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// ── SSE ──
const sseClients = new Map();
function broadcast(userId, data) {
  sseClients.get(userId)?.forEach(r => { try { r.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} });
}

function readBody(req) {
  return new Promise(resolve => {
    const ch = [];
    req.on('data', c => ch.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch { resolve({}); } });
  });
}

async function readMultipart(req) {
  return new Promise((resolve) => {
    const ch = [];
    req.on('data', c => ch.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(ch);
        const ct = req.headers['content-type'] || '';
        const bm = ct.match(/boundary=(.+)/);
        if (!bm) return resolve({ files: [] });
        const boundary = '--' + bm[1].trim();
        const bb = Buffer.from(boundary);
        const pos = [];
        for (let i = 0; i <= buf.length - bb.length; i++) {
          if (buf.slice(i, i + bb.length).equals(bb)) pos.push(i);
        }
        const uploads = [];
        for (let pi = 0; pi < pos.length - 1; pi++) {
          const ps = pos[pi] + bb.length + 2;
          const pe = pos[pi + 1] - 2;
          if (ps >= pe) continue;
          const part = buf.slice(ps, pe);
          const he = part.indexOf('\r\n\r\n');
          if (he === -1) continue;
          const hdr = part.slice(0, he).toString();
          const data = part.slice(he + 4);
          const fn = hdr.match(/filename="([^"]+)"/)?.[1];
          if (fn) {
            const ext = extname(fn).toLowerCase() || '.bin';
            if (!ALLOWED_UPLOAD_EXTS.has(ext)) continue;
            if (data.length > MAX_UPLOAD_BYTES) continue;
            const tmpPath = join(UPLOADS_DIR, nanoid() + ext);
            writeFileSync(tmpPath, data);
            try {
              const result = await cloudinary.uploader.upload(tmpPath, {
                folder: 'lorethread',
                resource_type: 'auto',
                transformation: [
                  { width: 1920, crop: 'limit' },  // 최대 1920px로 축소
                  { quality: 'auto:good' },          // 화질 자동 최적화
                  { fetch_format: 'auto' },           // WebP 등 최적 포맷 자동 선택
                ],
              });
              uploads.push({ url: result.secure_url });
            } finally {
              try { unlinkSync(tmpPath); } catch {}
            }
          }
        }
        resolve({ files: uploads });
      } catch (e) { console.error('Upload error:', e); resolve({ files: [] }); }
    });
    req.on('error', () => resolve({ files: [] }));
  });
}

async function getSessionUser(req) {
  try {
    const cookies = parseCookie(req.headers.cookie || '');
    const sid = cookies.session;
    if (!sid) return null;
    const sess = await getSession(sid);
    if (!sess) return null;
    return await getUser(sess.user_id);
  } catch { return null; }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function serveFile(res, fp) {
  try {
    const content = readFileSync(fp);
    const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': mime[extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}
function makeSlug(name) {
  return name.trim().replace(/\s+/g, '-').replace(/[^\w\-가-힣]/g, '').toLowerCase().slice(0, 40) + '-' + nanoid(4);
}

const server = http.createServer(async (req, res) => {
  try {
    const rawPath = req.url.split('?')[0];
    const path = decodeURIComponent(rawPath);
    const m = req.method;

    const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (rawPath.startsWith('/static/')) return serveFile(res, join(__dirname, '../public', rawPath));

    const user = await getSessionUser(req);

    // ── SSE ──
    if (path === '/api/events') {
      if (!user) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('data: {"type":"connected"}\n\n');
      if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
      sseClients.get(user.id).add(res);
      req.on('close', () => sseClients.get(user.id)?.delete(res));
      return;
    }

    // ── Auth ──
    if (path === '/api/auth/register' && m === 'POST') {
      const b = await readBody(req);
      if (!b.email || !b.password || !b.display_name) return json(res, { error: '모든 항목을 입력해주세요.' }, 400);
      if (await getUserByEmail(b.email)) return json(res, { error: '이미 사용 중인 이메일입니다.' }, 400);
      const pool = getDb();
      const cnt = await pool.query('SELECT COUNT(*) as cnt FROM users').then(r => parseInt(r.rows[0].cnt));
      const role = cnt === 0 ? 'owner' : 'member';
      const hash = await bcrypt.hash(b.password, 10);
      const id = nanoid();
      await createUser({ id, email: b.email, password_hash: hash, display_name: b.display_name, role, theme: 'light', created_at: now() });
      const sid = nanoid(32);
      await createSession({ id: sid, user_id: id, created_at: now() });
      res.setHeader('Set-Cookie', `session=${sid}; Path=/; HttpOnly; Max-Age=2592000; SameSite=None; Secure`);
      return json(res, { ok: true, user: { id, email: b.email, display_name: b.display_name, role } });
    }

    if (path === '/api/auth/login' && m === 'POST') {
      const b = await readBody(req);
      const u = await getUserByEmail(b.email);
      if (!u || !(await bcrypt.compare(b.password, u.password_hash))) return json(res, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
      const sid = nanoid(32);
      await createSession({ id: sid, user_id: u.id, created_at: now() });
      res.setHeader('Set-Cookie', `session=${sid}; Path=/; HttpOnly; Max-Age=2592000; SameSite=None; Secure`);
      return json(res, { ok: true, user: { id: u.id, email: u.email, display_name: u.display_name, role: u.role } });
    }

    if (path === '/api/auth/logout' && m === 'POST') {
      const cookies = parseCookie(req.headers.cookie || '');
      if (cookies.session) await deleteSession(cookies.session);
      res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0; SameSite=None; Secure');
      return json(res, { ok: true });
    }

    if (path === '/api/auth/me') {
      if (!user) return json(res, { user: null });
      return json(res, { user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, theme: user.theme }, worlds: await getWorldsByUser(user.id) });
    }

    if (path === '/api/user/theme' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      await updateUser(user.id, { theme: b.theme });
      return json(res, { ok: true });
    }

    if (path === '/api/upload' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const { files } = await readMultipart(req);
      return json(res, { ok: true, urls: files.map(f => f.url) });
    }

    // Cloudinary 직접 업로드용 서명 발급
    if (path === '/api/upload/sign' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const timestamp = Math.round(Date.now() / 1000);
      const params = { folder: 'lorethread', timestamp, transformation: 'w_1280,c_limit,q_auto:good,f_auto' };
      const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
      return json(res, {
        signature, timestamp,
        api_key: process.env.CLOUDINARY_API_KEY,
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        folder: 'lorethread',
        transformation: params.transformation,
      });
    }

    if (path === '/api/notifications' && m === 'GET') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      return json(res, { notifications: await getNotifs(user.id), unread: await getUnreadCount(user.id) });
    }
    if (path === '/api/notifications/read' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      await markAllRead(user.id);
      return json(res, { ok: true });
    }

    // ── 계정 전환 ──
    if (path === '/api/accounts' && m === 'GET') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const pool = getDb();
      const sessions = await pool.query('SELECT DISTINCT user_id FROM sessions').then(r => r.rows);
      const seen = new Set();
      const accounts = (await Promise.all(sessions.map(s => await getUser(s.user_id)))).filter(u => {
        if (!u || seen.has(u.id)) return false;
        seen.add(u.id); return true;
      }).map(u => ({ user_id: u.id, display_name: u.display_name, email: u.email, role: u.role }));
      return json(res, { accounts });
    }
    if (path === '/api/accounts/switch' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      const target = await getUser(b.user_id);
      if (!target) return json(res, { error: '계정을 찾을 수 없습니다.' }, 404);
      const pool = getDb();
      let sess = await pool.query('SELECT * FROM sessions WHERE user_id=$1 LIMIT 1', [target.id]).then(r => r.rows[0]);
      if (!sess) {
        const sid = nanoid(32);
        await createSession({ id: sid, user_id: target.id, created_at: now() });
        sess = { id: sid };
      }
      res.setHeader('Set-Cookie', `session=${sess.id}; Path=/; HttpOnly; Max-Age=2592000; SameSite=None; Secure`);
      return json(res, { ok: true, user: { id: target.id, email: target.email, display_name: target.display_name, role: target.role } });
    }

    // ── 초대 코드 ──
    if (path === '/api/invite/use' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      if (!b.code) return json(res, { error: '코드를 입력해주세요.' }, 400);
      const pool = getDb();
      const invite = await pool.query('SELECT * FROM invites WHERE code=$1', [b.code]).then(r => r.rows[0]);
      if (!invite) return json(res, { error: '유효하지 않은 초대 코드입니다.' }, 404);
      const targetWorld = await getWorldById(invite.world_id);
      if (!targetWorld) return json(res, { error: '세계관을 찾을 수 없습니다.' }, 404);
      await addWorldMember(targetWorld.id, user.id);
      return json(res, { ok: true, world: targetWorld });
    }

    // ── Worlds ──
    if (path === '/api/worlds' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      if (!b.name) return json(res, { error: '세계관 이름을 입력해주세요.' }, 400);
      const slug = makeSlug(b.name);
      const id = nanoid();
      await createWorld({ id, owner_id: user.id, name: b.name, slug, description: b.description||'', banner_color: b.banner_color||'#185FA5', icon_emoji: b.icon_emoji||'🌍', announce_text: b.announce_text||'', created_at: now() });
      await addWorldMember(id, user.id);
      return json(res, { ok: true, world: await getWorldBySlug(slug) });
    }

    if (path.startsWith('/api/worlds/')) {
      const parts = path.slice('/api/worlds/'.length).split('/');
      const slug = parts[0];
      const sub = parts[1] || '';
      const world = await getWorldBySlug(slug);

      if (!sub && m === 'DELETE') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (!user || world.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const pool = getDb();
        const charIds = await pool.query('SELECT id FROM characters WHERE world_id=$1', [world.id]).then(r => r.rows.map(c => c.id));
        for (const cid of charIds) {
          await pool.query('DELETE FROM char_sections WHERE character_id=$1', [cid]);
          await pool.query('DELETE FROM char_links WHERE character_id=$1', [cid]);
        }
        const postIds = await pool.query('SELECT id FROM posts WHERE world_id=$1', [world.id]).then(r => r.rows.map(p => p.id));
        for (const pid of postIds) {
          await pool.query('DELETE FROM post_media WHERE post_id=$1', [pid]);
          await pool.query('DELETE FROM reactions WHERE post_id=$1', [pid]);
        }
        await pool.query('DELETE FROM posts WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM characters WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM world_members WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM announcements WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM events WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM invites WHERE world_id=$1', [world.id]);
        await pool.query('DELETE FROM worlds WHERE id=$1', [world.id]);
        // 알림 고아 레코드 정리
        await pool.query('DELETE FROM notifications WHERE post_id IN (SELECT id FROM posts WHERE world_id=$1)', [world.id]);
        return json(res, { ok: true });
      }

      if (!sub) {
        if (m === 'GET') {
          if (!world) return json(res, { error: 'Not found' }, 404);
          return json(res, { world, members: await getWorldMembers(world.id) });
        }
        if (m === 'PATCH') {
          if (!world || world.owner_id !== user?.id) return json(res, { error: 'Forbidden' }, 403);
          const b = await readBody(req);
          const updated = await updateWorld(world.id, b);
          return json(res, { ok: true, world: updated || world });
        }
      }

      if (sub === 'join' && m === 'POST') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        if (!world) return json(res, { error: 'Not found' }, 404);
        await addWorldMember(world.id, user.id);
        return json(res, { ok: true });
      }

      if (sub === 'invite' && m === 'POST') {
        if (!user || world?.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const pool = getDb();
        const existing = await pool.query('SELECT * FROM invites WHERE world_id=$1', [world.id]).then(r => r.rows[0]);
        if (existing) return json(res, { ok: true, code: existing.code });
        const code = nanoid(10);
        await pool.query('INSERT INTO invites (code,world_id,created_by,created_at) VALUES ($1,$2,$3,$4)', [code, world.id, user.id, now()]);
        return json(res, { ok: true, code });
      }

      if (sub === 'announcements') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (m === 'GET') return json(res, { announcements: await getAnnouncements(world.id) });
        if (m === 'POST') {
          if (!user || world.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
          const b = await readBody(req);
          if (!b.title) return json(res, { error: '제목을 입력해주세요.' }, 400);
          await createAnnouncement({ id: nanoid(), world_id: world.id, title: b.title, content: b.content||'', author_id: user.id, created_at: now() });
          return json(res, { ok: true });
        }
      }

      if (parts[1] === 'announcements' && parts[2] && m === 'DELETE') {
        if (!user || world?.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        await deleteAnnouncement(parts[2]);
        return json(res, { ok: true });
      }

      if (sub === 'events') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (m === 'GET') {
          const pool = getDb();
          const events = await pool.query('SELECT * FROM events WHERE world_id=$1 ORDER BY start_date ASC', [world.id]).then(r => r.rows);
          return json(res, { events });
        }
        if (m === 'POST') {
          if (!user || world.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
          const b = await readBody(req);
          if (!b.title || !b.start_date || !b.end_date) return json(res, { error: '제목과 기간을 입력해주세요.' }, 400);
          const pool = getDb();
          await pool.query('INSERT INTO events (id,world_id,title,content,start_date,end_date,color,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [nanoid(), world.id, b.title, b.content||'', b.start_date, b.end_date, b.color||'#5865F2', now()]);
          return json(res, { ok: true });
        }
      }

      if (parts[1] === 'events' && parts[2] && m === 'DELETE') {
        if (!world || !user || world.owner_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        await getDb().query('DELETE FROM events WHERE id=$1', [parts[2]]);
        return json(res, { ok: true });
      }

      if (parts[1] === 'posts' && parts[2] === 'following' && m === 'GET') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (!user) return json(res, { posts: [] });
        const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const offset = parseInt(qs.get('offset') || '0');
        const myChars = await getCharsByUser(user.id, world.id);
        const myCharIds = myChars.map(c => c.id);
        if (!myCharIds.length) return json(res, { posts: [] });
        const pool = getDb();
        const followingIds = await pool.query(
          `SELECT following_character_id FROM follows WHERE follower_character_id = ANY($1)`, [myCharIds]
        ).then(r => r.rows.map(f => f.following_character_id));
        if (!followingIds.length) return json(res, { posts: [] });
        // DB에서 직접 팔로잉 포스트만 페이지네이션해서 가져옴
        const posts = await getPostsByFollowing(world.id, followingIds, 30, offset);
        const enriched = await Promise.all(
          posts.map(async p => ({ ...p, userReacted: (await Promise.all(myCharIds.map(cid => getReaction(p.id, cid)))).some(Boolean) }))
        );
        return json(res, { posts: enriched });
      }

      if (sub === 'characters') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (m === 'GET') return json(res, { characters: await getCharsByWorld(world.id) });
        if (m === 'POST') {
          if (!user) return json(res, { error: 'Unauthorized' }, 401);
          const b = await readBody(req);
          if (!b.name || !b.handle) return json(res, { error: '이름과 핸들을 입력해주세요.' }, 400);
          const handle = b.handle.toLowerCase().trim().replace(/[^a-z0-9_가-힣]/gi, '').slice(0, 20);
          if (await getCharByHandle(world.id, handle)) return json(res, { error: '이미 사용 중인 핸들입니다.' }, 400);
          const id = nanoid();
          await createChar({ id, user_id: user.id, world_id: world.id, name: b.name, handle, role: b.role||'', bio: b.bio||'', color_bg: b.color_bg||'#E6F1FB', color_fg: b.color_fg||'#185FA5', avatar_url: b.avatar_url||'', header_url: b.header_url||'', is_npc: b.is_npc?1:0, created_at: now() });
          if (b.sections?.length) await setCharSections(id, b.sections);
          if (b.links?.length) await setCharLinks(id, b.links);
          return json(res, { ok: true, character: await getCharById(id) });
        }
      }

      if (sub === 'posts') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (m === 'GET') {
          const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
          const offset = parseInt(qs.get('offset') || '0');
          const tag = qs.get('tag') || '';
          const myChars = user ? await getCharsByUser(user.id, world.id) : [];
          const myCharIds = myChars.map(c => c.id);
          let posts = await getPostsByWorld(world.id, 30, offset, tag);
          posts = await Promise.all(posts.map(async p => ({ ...p, userReacted: (await Promise.all(myCharIds.map(cid => getReaction(p.id, cid)))).some(Boolean) })));
          return json(res, { posts });
        }
        if (m === 'POST') {
          if (!user) return json(res, { error: 'Unauthorized' }, 401);
          const b = await readBody(req);
          if (!b.content && !b.media_urls?.length) return json(res, { error: '내용을 입력해주세요.' }, 400);
          if (!b.character_id) return json(res, { error: '캐릭터를 선택해주세요.' }, 400);
          const myChars = await getCharsByUser(user.id, world.id);
          const char = myChars.find(c => c.id === b.character_id);
          if (!char) return json(res, { error: '본인 캐릭터가 아닙니다.' }, 403);
          const id = nanoid();
          await createPost({ id, character_id: b.character_id, world_id: world.id, content: b.content||'', reply_to_id: b.reply_to_id||null, created_at: now() });
          if (b.media_urls?.length) {
            for (let i = 0; i < Math.min(b.media_urls.length, 4); i++) {
              await addPostMedia({ id: nanoid(), post_id: id, url: b.media_urls[i], media_type: /\.(mp4|webm)$/i.test(b.media_urls[i]) ? 'video' : 'image', sort_order: i });
            }
          }
          if (b.reply_to_id) {
            const parent = await getPostById(b.reply_to_id);
            if (parent?.user_id && parent.user_id !== user.id) {
              await createNotif({ id: nanoid(), recipient_user_id: parent.user_id, type: 'reply', actor_character_id: b.character_id, post_id: id, created_at: now() });
              broadcast(parent.user_id, { type: 'reply', actor: char.name, postId: id });
            }
          }
          for (const [, handle] of (b.content||'').matchAll(/@([a-z0-9_가-힣]+)/gi)) {
            const mc = await getCharByHandle(world.id, handle);
            if (mc && mc.user_id !== user.id) {
              await createNotif({ id: nanoid(), recipient_user_id: mc.user_id, type: 'mention', actor_character_id: b.character_id, post_id: id, created_at: now() });
              broadcast(mc.user_id, { type: 'mention', actor: char.name, handle, postId: id });
            }
          }
          // 같은 세계관 멤버 전체에게 새 글 알림 broadcast
          const worldMembers = await getWorldMembers(world.id);
          for (const mem of worldMembers) {
            if (mem.id !== user.id) broadcast(mem.id, { type: 'new_post', postId: id, worldId: world.id });
          }
          return json(res, { ok: true, post: { ...await getPostById(id), userReacted: false } });
        }
      }

      return json(res, { error: 'Not found' }, 404);
    }

    // ── Characters ──
    if (path.startsWith('/api/characters/')) {
      const parts = path.slice('/api/characters/'.length).split('/');
      const charId = parts[0];
      const sub = parts[1] || '';

      if (sub === 'is-following' && m === 'GET') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const myCharId = qs.get('character_id');
        const myChar = await getCharById(myCharId);
        if (!myChar || myChar.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const pool = getDb();
        const following = await pool.query('SELECT 1 FROM follows WHERE follower_character_id=$1 AND following_character_id=$2', [myCharId, charId]).then(r => r.rows.length > 0);
        return json(res, { following });
      }

      if (sub === 'follow' && m === 'POST') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const b = await readBody(req);
        const myChar = await getCharById(b.character_id);
        if (!myChar || myChar.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const pool = getDb();
        const existing = await pool.query('SELECT 1 FROM follows WHERE follower_character_id=$1 AND following_character_id=$2', [b.character_id, charId]).then(r => r.rows.length > 0);
        if (existing) {
          await pool.query('DELETE FROM follows WHERE follower_character_id=$1 AND following_character_id=$2', [b.character_id, charId]);
        } else {
          await pool.query('INSERT INTO follows (id,follower_character_id,following_character_id,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [nanoid(), b.character_id, charId, now()]);
        }
        return json(res, { ok: true, followed: !existing, followerCount: await getFollowerCount(charId) });
      }

      if (!sub && m === 'GET') {
        const c = await getCharById(charId);
        if (!c) return json(res, { error: 'Not found' }, 404);
        c.sections = await getCharSections(charId);
        c.links = await getCharLinks(charId);
        return json(res, { character: c, posts: await getPostsByChar(charId, 20), followerCount: await getFollowerCount(charId), followingCount: await getFollowingCount(charId) });
      }

      if (!sub && m === 'PATCH') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const c = await getCharById(charId);
        if (!c || c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const b = await readBody(req);
        await updateChar(charId, b);
        if (b.sections) await setCharSections(charId, b.sections);
        if (b.links) await setCharLinks(charId, b.links);
        const updated = await getCharById(charId);
        updated.sections = await getCharSections(charId);
        updated.links = await getCharLinks(charId);
        return json(res, { ok: true, character: updated });
      }

      if (!sub && m === 'DELETE') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const c = await getCharById(charId);
        if (!c) return json(res, { error: 'Not found' }, 404);
        if (c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const pool = getDb();
        await pool.query('DELETE FROM char_sections WHERE character_id=$1', [charId]);
        await pool.query('DELETE FROM char_links WHERE character_id=$1', [charId]);
        const postIds = await pool.query('SELECT id FROM posts WHERE character_id=$1', [charId]).then(r => r.rows.map(p => p.id));
        for (const pid of postIds) {
          await pool.query('DELETE FROM post_media WHERE post_id=$1', [pid]);
          await pool.query('DELETE FROM reactions WHERE post_id=$1', [pid]);
        }
        await pool.query('DELETE FROM posts WHERE character_id=$1', [charId]);
        await pool.query('DELETE FROM characters WHERE id=$1', [charId]);
        return json(res, { ok: true });
      }
    }

    // ── Posts ──
    if (path.startsWith('/api/posts/')) {
      const parts = path.slice('/api/posts/'.length).split('/');
      const postId = parts[0];
      const sub = parts[1] || '';

      if (!sub && m === 'GET') {
        const post = await getPostById(postId);
        if (!post) return json(res, { error: 'Not found' }, 404);
        return json(res, { post });
      }

      if (sub === 'replies' && m === 'GET') return json(res, { replies: await getReplies(postId) });

      if (sub === 'thread' && m === 'GET') {
        const post = await getPostById(postId);
        if (!post) return json(res, { error: 'Not found' }, 404);
        const ancestors = [];
        let cur = post.reply_to_id ? await getPostById(post.reply_to_id) : null;
        while (cur) { ancestors.unshift(cur); cur = cur.reply_to_id ? await getPostById(cur.reply_to_id) : null; }
        const myChars = user ? await getCharsByUser(user.id, post.world_id) : [];
        const myCharIds = myChars.map(c => c.id);
        const enrich = async p => ({ ...p, userReacted: (await Promise.all(myCharIds.map(cid => getReaction(p.id, cid)))).some(Boolean) });
        return json(res, { ancestors: await Promise.all(ancestors.map(enrich)), post: await enrich(post), replies: await Promise.all((await getReplies(postId)).map(enrich)) });
      }

      if (!sub && m === 'PATCH') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const post = await getPostById(postId);
        if (!post) return json(res, { error: 'Not found' }, 404);
        const c = await getCharById(post.character_id);
        if (!c || c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const b = await readBody(req);
        const pool = getDb();
        const updates = []; const vals = [];
        if (b.content !== undefined) { updates.push(`content = $${updates.length+1}`); vals.push(b.content); }
        if (b.is_pinned !== undefined) { updates.push(`is_pinned = $${updates.length+1}`); vals.push(b.is_pinned ? 1 : 0); }
        updates.push(`edited_at = $${updates.length+1}`); vals.push(now());
        await pool.query(`UPDATE posts SET ${updates.join(', ')} WHERE id = $${vals.length+1}`, [...vals, postId]);
        return json(res, { ok: true, post: await getPostById(postId) });
      }

      if (sub === 'react' && m === 'POST') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const b = await readBody(req);
        const c = await getCharById(b.character_id);
        if (!c || c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const existing = await getReaction(postId, b.character_id);
        if (existing) { await removeReaction(postId, b.character_id); }
        else {
          await addReaction({ id: nanoid(), post_id: postId, character_id: b.character_id, created_at: now() });
          const post = await getPostById(postId);
          if (post?.user_id && post.user_id !== user.id) {
            await createNotif({ id: nanoid(), recipient_user_id: post.user_id, type: 'react', actor_character_id: b.character_id, post_id: postId, created_at: now() });
            broadcast(post.user_id, { type: 'react', actor: c.name, postId });
          }
        }
        return json(res, { ok: true, count: await getReactionCount(postId), reacted: !existing });
      }

      if (!sub && m === 'DELETE') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const post = await getPostById(postId);
        if (!post) return json(res, { error: 'Not found' }, 404);
        const c = await getCharById(post.character_id);
        if (!c || c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        await deletePost(postId);
        return json(res, { ok: true });
      }
    }

    // ── DM ──
    if (path === '/api/dm/rooms' && m === 'GET') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      return json(res, { rooms: await getRoomsByUser(user.id) });
    }
    if (path === '/api/dm/rooms' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      const { type, name, members, character_id, world_id } = b;
      if (!members?.length) return json(res, { error: 'members required' }, 400);
      if (type === 'dm' && members.length === 1) {
        const existing = await findDmRoom(user.id, members[0]);
        if (existing) return json(res, { ok: true, room: { ...await getRoomById(existing.id), members: await getRoomMembers(existing.id) } });
      }
      const id = nanoid();
      await createRoom({ id, name: type === 'dm' ? '' : (name||'새 그룹'), type: type||'dm', world_id: world_id||null, created_by: user.id, created_at: now() });
      await addRoomMember({ room_id: id, user_id: user.id, character_id: character_id||null, joined_at: now() });
      for (const uid of members) if (uid !== user.id) await addRoomMember({ room_id: id, user_id: uid, character_id: null, joined_at: now() });
      return json(res, { ok: true, room: { ...await getRoomById(id), members: await getRoomMembers(id) } });
    }
    if (path.startsWith('/api/dm/rooms/')) {
      const parts = path.slice('/api/dm/rooms/'.length).split('/');
      const roomId = parts[0]; const sub = parts[1] || '';
      if (!sub && m === 'GET') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const room = await getRoomById(roomId);
        if (!room || !(await isRoomMember(roomId, user.id))) return json(res, { error: 'Forbidden' }, 403);
        await markDmRead(user.id, roomId);
        return json(res, { room, messages: await getDmMessages(roomId), members: await getRoomMembers(roomId) });
      }
      if (sub === 'messages' && m === 'POST') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        if (!(await isRoomMember(roomId, user.id))) return json(res, { error: 'Forbidden' }, 403);
        const b = await readBody(req);
        if (!b.content) return json(res, { error: 'content required' }, 400);
        await createDmMessage({ id: nanoid(), room_id: roomId, sender_user_id: user.id, character_id: b.character_id||null, content: b.content, created_at: now() });
        await markDmRead(user.id, roomId);
        const members = await getRoomMembers(roomId);
        for (const mem of members) if (mem.user_id !== user.id) broadcast(mem.user_id, { type: 'dm', roomId, senderId: user.id, content: b.content.slice(0, 60) });
        return json(res, { ok: true, messages: await getDmMessages(roomId) });
      }
    }
    if (path === '/api/dm/unread' && m === 'GET') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      return json(res, { count: await getUnreadDmCount(user.id) });
    }

    serveFile(res, join(__dirname, '../public/index.html'));
  } catch (err) {
    console.error('[서버 오류]', err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '서버 오류가 발생했습니다.' })); }
  }
});

process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));

// DB 초기화 후 서버 시작
initDb().then(() => {
  server.listen(PORT, () => {
    console.log('\n🌟 Lorethread 서버 시작!');
    console.log(`👉 http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});
