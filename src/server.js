import 'dotenv/config';
import http from 'http';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname, extname, resolve, sep } from 'path';
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
  addPostMedia, getReaction, addReaction, removeReaction, getReactionCount, getReactedPostIds,
  createNotif, getNotifs, getUnreadCount, markAllRead,
  getAnnouncements, createAnnouncement, deleteAnnouncement,
  getWorldAdmins, setWorldAdmin, deleteUserAccount,
  getFollowerCount, getFollowingCount,
  createRoom, getRoomsByUser, getRoomById, addRoomMember, getRoomMembers,
  isRoomMember, createDmMessage, getDmMessages, getUnreadDmCount, markDmRead, findDmRoom,
  cleanupSessions, deleteWorldCascade, SESSION_TTL_DAYS,
  getInvites, createInvite, revokeInvite, consumeInvite, setPostSensitive
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_UPLOAD_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB — 핸들러 쪽 제한과 일치시킴
const ALLOWED_UPLOAD_TYPES = new Set(['image/jpeg','image/jpg','image/png','image/gif','image/webp','video/mp4','video/webm']);
const UPLOADS_DIR = join(__dirname, '../tmp_uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

// ── 보안/검증 유틸 ──
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
// 로컬 http 개발 시 Secure 쿠키는 Safari/Firefox에서 거부된다.
const COOKIE_ATTRS = IS_PROD
  ? 'Path=/; HttpOnly; SameSite=None; Secure'
  : 'Path=/; HttpOnly; SameSite=Lax';
const SESSION_MAX_AGE = SESSION_TTL_DAYS * 86400;

/** 신뢰할 수 있는 클라이언트 IP. x-forwarded-for는 위조 가능하므로
 *  Railway 등 프록시 1홉 뒤라는 전제에서 '마지막' 값을 쓴다. */
/** 세계관 모더레이터인지. owner + world_admins + 전역 admin. */
async function isModerator(user, worldId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const w = await getWorldById(worldId);
  if (w?.owner_id === user.id) return true;
  const admins = await getWorldAdmins(worldId);
  return admins.some(a => a.user_id === user.id);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function sessionCookie(sid) { return `session=${sid}; ${COOKIE_ATTRS}; Max-Age=${SESSION_MAX_AGE}`; }

// 이 브라우저가 실제로 로그인한 세션 ID 목록. 계정 전환은 이 안에서만 허용된다.
function readAccountSids(req) {
  try {
    const raw = parseCookie(req.headers.cookie || '').accounts || '';
    const cur = parseCookie(req.headers.cookie || '').session;
    const list = raw.split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9_-]{16,64}$/.test(x));
    if (cur && !list.includes(cur)) list.unshift(cur);
    return list.slice(0, 10);
  } catch { return []; }
}
function accountsCookie(sids) {
  return `accounts=${sids.slice(0, 10).join(',')}; ${COOKIE_ATTRS}; Max-Age=${SESSION_MAX_AGE}`;
}

// 허용 오리진: 쉼표로 여러 개, 끝 슬래시는 무시
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);

/** 이미지/영상 URL 화이트리스트. 저장형 XSS(javascript:, onerror= 등) 차단. */
const SAFE_URL_HOSTS = ['res.cloudinary.com'];
function safeUrl(v) {
  if (v === undefined || v === null || v === '') return '';
  const str = String(v).trim();
  if (!str) return '';
  try {
    const u = new URL(str);
    if (u.protocol !== 'https:') return '';
    if (!SAFE_URL_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return '';
    return u.toString();
  } catch { return ''; }
}
/** #RRGGBB 형식만 허용. */
function safeColor(v, fallback = '') {
  const str = String(v ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(str) ? str : fallback;
}
/** 자유 텍스트에서 제어문자 제거 + 길이 제한. */
function safeText(v, max = 200) {
  return String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
}
/** 캐릭터/세계관 입력에서 위험 필드를 정규화한다. */
function sanitizeCharFields(b) {
  const out = { ...b };
  for (const k of ['avatar_url', 'header_url']) if (k in out) out[k] = safeUrl(out[k]);
  if ('color_bg' in out) out.color_bg = safeColor(out.color_bg, '#E6F1FB');
  if ('color_fg' in out) out.color_fg = safeColor(out.color_fg, '#185FA5');
  if ('role' in out) out.role = safeText(out.role, 40);
  if ('name' in out) out.name = safeText(out.name, 60);
  if ('bio'  in out) out.bio  = safeText(out.bio, 2000);
  return out;
}
function sanitizeWorldFields(b) {
  const out = { ...b };
  for (const k of ['banner_image_url', 'icon_image_url', 'bg_image_url']) if (k in out) out[k] = safeUrl(out[k]);
  if ('banner_color' in out) out.banner_color = safeColor(out.banner_color, '#185FA5');
  if ('custom_font' in out) out.custom_font = safeText(out.custom_font, 60).replace(/[^\w\s\-,'"가-힣]/g, '');
  if ('name' in out) out.name = safeText(out.name, 60);
  if ('description' in out) out.description = safeText(out.description, 2000);
  if ('announce_text' in out) out.announce_text = safeText(out.announce_text, 2000);
  return out;
}
/** LIMIT/OFFSET용 정수 파싱. NaN이 그대로 넘어가면 PG가 500을 낸다. */
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ── SSE ──
const sseClients = new Map();
function broadcast(userId, data) {
  sseClients.get(userId)?.forEach(r => { try { r.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} });
}

function readBody(req) {
  return new Promise(resolve => {
    const ch = [];
    req.on('data', c => ch.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(ch).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { console.error('[본문 파싱 실패]', req.method, req.url, raw.slice(0, 200)); resolve({}); }
    });
  });
}

async function readMultipart(req) {
  let rejected = null;
  return new Promise((resolve) => {
    const ch = [];
    req.on('data', c => ch.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(ch);
        const ct = req.headers['content-type'] || '';
        const bm = ct.match(/boundary=(.+)/);
        if (!bm) return resolve({ files: [], rejected: null });
        const boundary = '--' + bm[1].trim();
        const bb = Buffer.from(boundary);
        // 바이트 단위 루프는 10MB에서 수천만 번 비교하며 이벤트 루프를 막는다.
        // Buffer.indexOf는 네이티브 구현이라 비교가 안 되게 빠르다.
        const pos = [];
        for (let i = buf.indexOf(bb, 0); i !== -1; i = buf.indexOf(bb, i + bb.length)) pos.push(i);
        const uploads = [];
        // 거절 사유를 호출자에게 알려준다.
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
            // 파트 헤더의 Content-Type. 기존 코드는 요청 전체의 content-type을
            // 넣어 두어 핸들러의 허용 타입 검사가 100% 실패했다.
            const partType = (hdr.match(/Content-Type:\s*([^\r\n;]+)/i)?.[1] || '').trim().toLowerCase();
            if (!ALLOWED_UPLOAD_EXTS.has(ext)) { rejected = '지원하지 않는 파일 형식입니다.'; continue; }
            if (partType && !ALLOWED_UPLOAD_TYPES.has(partType)) { rejected = '지원하지 않는 파일 형식입니다.'; continue; }
            if (data.length > MAX_UPLOAD_BYTES) { rejected = '파일 크기는 10MB를 초과할 수 없습니다.'; continue; }
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
              uploads.push({ url: result.secure_url, size: data.length, type: partType, ext });
            } finally {
              try { unlinkSync(tmpPath); } catch {}
            }
          }
        }
        resolve({ files: uploads, rejected });
      } catch (e) { console.error('Upload error:', e); resolve({ files: [], rejected: '업로드 처리 중 오류가 발생했습니다.' }); }
    });
    req.on('error', () => resolve({ files: [], rejected: null }));
  });
}

async function getSessionUser(req) {
  try {
    const cookies = parseCookie(req.headers.cookie || '');
    const sid = cookies.session;
    if (!sid) return null;
    const sess = await getSession(sid);
    if (!sess) return null;
    return getUser(sess.user_id);
  } catch { return null; }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function serveFile(res, fp, req) {
  try {
    const content = readFileSync(fp);
    const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm', '.svg':'image/svg+xml' };
    const ext = extname(fp).toLowerCase();
    // 279KB짜리 index.html을 매 요청 재전송하지 않도록 ETag/캐시 헤더를 붙인다.
    const etag = 'W/"' + content.length.toString(16) + '-' + createHash('sha1').update(content).digest('hex').slice(0, 16) + '"';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
    if (req && req.headers['if-none-match'] === etag) { res.writeHead(304, { 'ETag': etag, 'Cache-Control': cache }); return res.end(); }
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'ETag': etag,
      'Cache-Control': cache,
    });
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

    const reqOrigin = (req.headers.origin || '').replace(/\/$/, '');
    if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (reqOrigin) {
      // 차단될 때 원인이 로그에 남는다 (기존에는 조용히 실패했다)
      console.warn('[CORS 차단]', reqOrigin, '— 허용 목록:', ALLOWED_ORIGINS.join(', '));
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (rawPath.startsWith('/static/')) {
      // join()이 '..'를 정규화하므로 /static/../../.env 로 소스와 .env가 새어나갔다.
      // resolve 후 public/ 밖이면 거부한다.
      const PUBLIC_DIR = resolve(__dirname, '../public');
      const target = resolve(PUBLIC_DIR, '.' + rawPath.slice('/static'.length));
      if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403); return res.end('Forbidden');
      }
      return serveFile(res, target, req);
    }

    const user = await getSessionUser(req);

    
    // ── SSE ──
    if (path === '/api/events') {
      if (!user) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('data: {"type":"connected"}\n\n');
      if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
      sseClients.get(user.id).add(res);

      // 하트비트가 없으면 Railway 프록시가 유휴 연결을 끊어 실시간 알림이 조용히 죽는다.
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 25000);
      const cleanup = () => {
        clearInterval(hb);
        const set = sseClients.get(user.id);
        if (set) { set.delete(res); if (!set.size) sseClients.delete(user.id); } // 빈 Set 누수 방지
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // ── Auth ──
    if (path === '/api/auth/register' && m === 'POST') {
      const ip = clientIp(req);
      if (rateLimit(ip, 'register', 5, 3600000)) return json(res, { error: '가입 요청이 너무 많습니다. 1시간 후 다시 시도해주세요.' }, 429);
      const b = await readBody(req);
      if (typeof b.email !== 'string' || typeof b.password !== 'string' || typeof b.display_name !== 'string'
          || !b.email.trim() || !b.password || !b.display_name.trim()) {
        return json(res, { error: '모든 항목을 입력해주세요.' }, 400);
      }
      if (b.password.length < 8) return json(res, { error: '비밀번호는 8자 이상이어야 합니다.' }, 400);
      if (b.password.length > 200) return json(res, { error: '비밀번호가 너무 깁니다.' }, 400);
      b.email = b.email.trim();
      b.display_name = safeText(b.display_name, 40);
      if (await getUserByEmail(b.email)) return json(res, { error: '이미 사용 중인 이메일입니다.' }, 400);
      const pool = getDb();
      const cnt = await pool.query('SELECT COUNT(*) as cnt FROM users').then(r => parseInt(r.rows[0].cnt));
      const role = cnt === 0 ? 'owner' : 'member';
      const hash = await bcrypt.hash(b.password, 10);
      const id = nanoid();
      await createUser({ id, email: b.email, password_hash: hash, display_name: b.display_name, role, theme: 'light', created_at: now() });
      const sid = nanoid(32);
      await createSession({ id: sid, user_id: id, created_at: now() });
      res.setHeader('Set-Cookie', [sessionCookie(sid), accountsCookie([sid, ...readAccountSids(req)])]);
      return json(res, { ok: true, user: { id, email: b.email, display_name: b.display_name, role } });
    }

    if (path === '/api/auth/login' && m === 'POST') {
      const ip = clientIp(req);
      if (rateLimit(ip, 'login', 10, 60000)) return json(res, { error: '잠시 후 다시 시도해주세요.' }, 429);
      const b = await readBody(req);
      // 입력이 조금만 이상해도 bcrypt.compare가 예외를 던져 500이 났다.
      if (typeof b.email !== 'string' || typeof b.password !== 'string' || !b.email || !b.password) {
        return json(res, { error: '이메일과 비밀번호를 입력해주세요.' }, 400);
      }
      const u = await getUserByEmail(b.email.trim());
      // password_hash가 비어 있는 계정(이관 사고 등)도 500 대신 401로 떨어뜨린다.
      if (!u || typeof u.password_hash !== 'string' || !u.password_hash.startsWith('$2')) {
        if (u) console.error('[로그인] password_hash 손상:', u.id);
        return json(res, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
      }
      if (!(await bcrypt.compare(b.password, u.password_hash))) {
        return json(res, { error: '이메일 또는 비밀번호가 올바르지 않습니다.' }, 401);
      }
      const sid = nanoid(32);
      await createSession({ id: sid, user_id: u.id, created_at: now() });
      res.setHeader('Set-Cookie', [sessionCookie(sid), accountsCookie([sid, ...readAccountSids(req)])]);
      return json(res, { ok: true, user: { id: u.id, email: u.email, display_name: u.display_name, role: u.role } });
    }

    if (path === '/api/auth/logout' && m === 'POST') {
      const cookies = parseCookie(req.headers.cookie || '');
      const cur = cookies.session;
      if (cur) await deleteSession(cur);
      const rest = readAccountSids(req).filter(x => x !== cur);
      res.setHeader('Set-Cookie', [
        `session=; ${COOKIE_ATTRS}; Max-Age=0`,
        rest.length ? accountsCookie(rest) : `accounts=; ${COOKIE_ATTRS}; Max-Age=0`,
      ]);
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
      // 업로드는 Cloudinary 요금과 직결되므로 레이트 리밋을 건다.
      if (rateLimit(clientIp(req), 'upload', 30, 60000)) {
        return json(res, { error: '업로드 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }, 429);
      }
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > 10 * 1024 * 1024) {
        return json(res, { error: '파일 크기는 10MB를 초과할 수 없습니다.' }, 413);
      }
      // 크기/타입 검증은 readMultipart 내부에서 Cloudinary 업로드 '전에' 수행된다.
      // 예전에는 업로드가 끝난 뒤 검사해서, 거절해도 요금은 이미 나갔다.
      // 또 f.type에 요청 전체의 content-type이 들어가 있어 항상 415가 떨어졌다.
      const { files, rejected } = await readMultipart(req);
      if (!files.length) {
        return json(res, { error: rejected || '업로드할 파일이 없습니다.' }, rejected ? 415 : 400);
      }
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
      // 예전에는 sessions 테이블 전체를 훑어 모든 유저의 이메일을 반환했다.
      // 이제는 이 브라우저가 실제로 로그인한 세션들만 본다.
      const sids = readAccountSids(req);
      const seen = new Set();
      const accounts = [];
      for (const sid of sids) {
        const sess = await getSession(sid);
        if (!sess) continue;
        if (seen.has(sess.user_id)) continue;
        const u = await getUser(sess.user_id);
        if (!u) continue;
        seen.add(u.id);
        accounts.push({ user_id: u.id, display_name: u.display_name, email: u.email, role: u.role });
      }
      return json(res, { accounts });
    }
    if (path === '/api/accounts/switch' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      const b = await readBody(req);
      if (!b.user_id) return json(res, { error: '계정을 지정해주세요.' }, 400);

      // 핵심: 이 브라우저가 보유한 세션 중에서만 전환을 허용한다.
      // 예전에는 아무 user_id나 넣으면 비밀번호 없이 그 계정이 되었다.
      const sids = readAccountSids(req);
      let targetSid = null;
      for (const sid of sids) {
        const sess = await getSession(sid);
        if (sess && sess.user_id === b.user_id) { targetSid = sid; break; }
      }
      if (!targetSid) {
        console.warn('[계정 전환 거부] user', user.id, '→', b.user_id);
        return json(res, { error: '해당 계정으로 먼저 로그인해주세요.' }, 403);
      }
      const target = await getUser(b.user_id);
      if (!target) return json(res, { error: '계정을 찾을 수 없습니다.' }, 404);

      res.setHeader('Set-Cookie', [sessionCookie(targetSid), accountsCookie(sids)]);
      return json(res, { ok: true, user: { id: target.id, email: target.email, display_name: target.display_name, role: target.role } });
    }

    // ── 초대 코드 ──
    if (path === '/api/invite/use' && m === 'POST') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      if (rateLimit(clientIp(req), 'invite', 20, 3600000)) {
        return json(res, { error: '초대 코드 시도가 너무 많습니다.' }, 429);
      }
      const b = await readBody(req);
      if (!b.code) return json(res, { error: '코드를 입력해주세요.' }, 400);

      // 만료·사용횟수·폐기를 원자적으로 검사하고 카운트를 올린다.
      const r = await consumeInvite(String(b.code).trim());
      if (!r.ok) {
        const msg = {
          not_found: '유효하지 않은 초대 코드입니다.',
          expired:   '만료된 초대 코드입니다.',
          exhausted: '사용 횟수를 모두 소진한 코드입니다.',
          revoked:   '사용이 중지된 코드입니다.',
        }[r.reason] || '사용할 수 없는 코드입니다.';
        return json(res, { error: msg, reason: r.reason }, r.reason === 'not_found' ? 404 : 410);
      }
      const targetWorld = await getWorldById(r.invite.world_id);
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
        // 삭제 순서가 뒤바뀌어 알림 고아 레코드가 영구히 남았고,
        // 트랜잭션이 없어 중간 실패 시 데이터가 반쯤 지워졌다.
        await deleteWorldCascade(world.id);
        return json(res, { ok: true });
      }

      if (!sub) {
        if (m === 'GET') {
          if (!world) return json(res, { error: 'Not found' }, 404);
          return json(res, { world, members: await getWorldMembers(world.id) });
        }
        if (m === 'PATCH') {
          if (!world || !user) return json(res, { error: 'Forbidden' }, 403);
          // world_admins 테이블이 있는데 여태 owner만 검사했다. 관리자도 허용한다.
          const wAdmins = await getWorldAdmins(world.id);
          const canEdit = world.owner_id === user.id || user.role === 'admin'
            || wAdmins.some(a => a.user_id === user.id);
          if (!canEdit) return json(res, { error: 'Forbidden' }, 403);
          const b = sanitizeWorldFields(await readBody(req));
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

      if (sub === 'invite') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (!(await isModerator(user, world.id))) return json(res, { error: 'Forbidden' }, 403);

        // 목록 — 만료/소진 상태까지 함께
        if (m === 'GET') return json(res, { invites: await getInvites(world.id) });

        // 발급 — 예전에는 세계관당 영구 코드 1개뿐이라 유출되면 회수 불가였다
        if (m === 'POST') {
          const b = await readBody(req);
          const days = clampInt(b.expires_in_days, 0, 0, 365);      // 0 = 무기한
          const maxUses = clampInt(b.max_uses, 0, 0, 1000);          // 0 = 무제한
          const code = nanoid(10);
          const inv = await createInvite({
            code, world_id: world.id, created_by: user.id, created_at: now(),
            expires_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
            max_uses: maxUses || null,
          });
          return json(res, { ok: true, code, invite: inv });
        }

        // 폐기
        if (m === 'DELETE') {
          const b = await readBody(req);
          if (!b.code) return json(res, { error: '코드를 지정해주세요.' }, 400);
          const done = await revokeInvite(String(b.code).trim(), world.id);
          return done ? json(res, { ok: true }) : json(res, { error: '코드를 찾을 수 없습니다.' }, 404);
        }
      }

    if (sub === 'admins') {
      if (m === 'GET') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        return json(res, { admins: await getWorldAdmins(world.id) });
      }
      if (m === 'POST') {
        if (!world || world.owner_id !== user?.id) return json(res, { error: 'Forbidden' }, 403);
        const b = await readBody(req);
        await setWorldAdmin(world.id, b.user_id, b.is_admin);
        return json(res, { ok: true });
      }
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
        const offset = clampInt(qs.get('offset'), 0, 0, 1000000);
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
        // 예전: 포스트 30개 × 내 캐릭터 N개 = 최대 수십 번의 개별 쿼리.
        // 지금: 한 번의 쿼리로 반응한 post_id 집합을 받아온다.
        const reacted = await getReactedPostIds(posts.map(p => p.id), myCharIds);
        return json(res, { posts: posts.map(p => ({ ...p, userReacted: reacted.has(p.id) })) });
      }

      if (sub === 'characters') {
        if (!world) return json(res, { error: 'Not found' }, 404);
        if (m === 'GET') return json(res, { characters: await getCharsByWorld(world.id) });
        if (m === 'POST') {
          if (!user) return json(res, { error: 'Unauthorized' }, 401);
          // 예전에는 슬러그만 알면 누구나 남의 세계관에 캐릭터를 만들 수 있었다.
          const members = await getWorldMembers(world.id);
          // getWorldMembers는 users를 조인해 user_id가 아니라 id로 돌려준다
          const isMember = world.owner_id === user.id || members.some(mm => (mm.id || mm.user_id) === user.id);
          if (!isMember) return json(res, { error: '이 세계관의 멤버가 아닙니다. 초대 코드로 먼저 참여해주세요.' }, 403);
          const b = sanitizeCharFields(await readBody(req));
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
          const offset = clampInt(qs.get('offset'), 0, 0, 1000000);
          const tag = qs.get('tag') || '';
          const myChars = user ? await getCharsByUser(user.id, world.id) : [];
          const myCharIds = myChars.map(c => c.id);
          let posts = await getPostsByWorld(world.id, 30, offset, tag);
          const reacted = await getReactedPostIds(posts.map(p => p.id), myCharIds);
          posts = posts.map(p => ({ ...p, userReacted: reacted.has(p.id) }));
          return json(res, { posts });
        }
        if (m === 'POST') {
          if (!user) return json(res, { error: 'Unauthorized' }, 401);
          if (rateLimit(clientIp(req), 'post', 20, 60000)) return json(res, { error: '글 작성이 너무 잦습니다. 잠시 후 다시 시도해주세요.' }, 429);
          const b = await readBody(req);
          if (!b.content && !b.media_urls?.length) return json(res, { error: '내용을 입력해주세요.' }, 400);
          if (!b.character_id) return json(res, { error: '캐릭터를 선택해주세요.' }, 400);
          const myChars = await getCharsByUser(user.id, world.id);
          const char = myChars.find(c => c.id === b.character_id);
          if (!char) return json(res, { error: '본인 캐릭터가 아닙니다.' }, 403);
          const id = nanoid();
          await createPost({ id, character_id: b.character_id, world_id: world.id, content: b.content||'', reply_to_id: b.reply_to_id||null, is_sensitive: b.is_sensitive, created_at: now() });
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
        // 포스트용 force_sensitive 블록이 여기 잘못 복사돼 있었다.
        // post/b/pool이 정의되기 전에 참조해 캐릭터 수정이 100% 500이었다.
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        const c = await getCharById(charId);
        if (!c) return json(res, { error: 'Not found' }, 404);
        const isAdminDel = user.role === 'admin';
        const delWorld = await getWorldById(c.world_id);
        const delWorldAdmins = await getWorldAdmins(c.world_id);
        const isWorldAdminDel = delWorld?.owner_id === user.id || delWorldAdmins.some(a => a.user_id === user.id);
        if (!isAdminDel && !isWorldAdminDel && c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const b = sanitizeCharFields(await readBody(req));
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
        const replies = await getReplies(postId);
        const all = [...ancestors, post, ...replies];
        const reacted = await getReactedPostIds(all.map(p => p.id), myCharIds);
        const enrich = p => ({ ...p, userReacted: reacted.has(p.id) });
        return json(res, { ancestors: ancestors.map(enrich), post: enrich(post), replies: replies.map(enrich) });
      }

      if (!sub && m === 'PATCH') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        // b/post/pool을 참조보다 먼저 선언한다. 예전에는 TDZ로 매번 500이었다.
        const b = await readBody(req);
        const post = await getPostById(postId);
        if (!post) return json(res, { error: 'Not found' }, 404);
        const pool = getDb();

        // 관리자 강제 블러 / 해제
        if (b?.force_sensitive !== undefined) {
          if (!(await isModerator(user, post.world_id))) return json(res, { error: 'Forbidden' }, 403);
          const updated = await setPostSensitive(postId, !!b.force_sensitive, user.id);
          console.log('[모더레이션]', user.id, b.force_sensitive ? '블러' : '해제', postId);
          return json(res, { ok: true, post: updated });
        }

        const c = await getCharById(post.character_id);
        if (!c || c.user_id !== user.id) return json(res, { error: 'Forbidden' }, 403);
        const updates = []; const vals = [];
        if (b.content !== undefined) { updates.push(`content = $${updates.length+1}`); vals.push(String(b.content).slice(0, 10000)); }
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
        // 본인 글이거나 세계관 모더레이터면 삭제 가능.
        // 예전에는 작성자만 가능해서 관리자가 문제 글을 못 지웠다.
        const isOwner = c && c.user_id === user.id;
        if (!isOwner && !(await isModerator(user, post.world_id))) return json(res, { error: 'Forbidden' }, 403);
        if (!isOwner) console.log('[모더레이션] 관리자 삭제', user.id, postId);
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


    // ── 헬스체크 ──
    if (path === '/health' || path === '/ping') {
      // DB를 실제로 찔러본다. 이게 없어서 DB가 사라진 걸 몇 주간 몰랐다.
      try {
        await getDb().query('SELECT 1');
        return json(res, { status: 'ok', db: 'up', timestamp: new Date().toISOString() });
      } catch (e) {
        console.error('[헬스체크 실패] DB 응답 없음:', e.code || e.message);
        return json(res, { status: 'degraded', db: 'down', error: e.code || 'unknown' }, 503);
      }
    }

    // ── 계정 탈퇴 ──
    if (path === '/api/auth/account' && m === 'DELETE') {
      if (!user) return json(res, { error: 'Unauthorized' }, 401);
      await deleteUserAccount(user.id);
      const sid = parseCookie(req.headers.cookie || '').session;
      if (sid) await deleteSession(sid);
      res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
      return json(res, { ok: true });
    }

    // ── DM 읽음 처리 ──
    if (path.startsWith('/api/dm/rooms/') && m === 'POST') {
      const parts = path.slice('/api/dm/rooms/'.length).split('/');
      const roomId = parts[0];
      const sub = parts[1] || '';
      if (sub === 'read') {
        if (!user) return json(res, { error: 'Unauthorized' }, 401);
        await markDmRead(user.id, roomId);
        return json(res, { ok: true });
      }
    }

    serveFile(res, join(__dirname, '../public/index.html'), req);
  } catch (err) {
    console.error('[서버 오류]', err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '서버 오류가 발생했습니다.' })); }
  }
});

process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));


// ── Rate Limiting ──
const rateLimitMap = new Map();
function rateLimit(ip, action, maxReq = 10, windowMs = 60000) {
  const key = `${ip}:${action}`;
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
  record.count++;
  rateLimitMap.set(key, record);
  return record.count > maxReq;
}
// 만료 세션 정리 — 예전에는 sessions 테이블이 무한히 쌓였다
setInterval(() => {
  cleanupSessions()
    .then(n => { if (n) console.log(`[세션 정리] 만료 세션 ${n}건 삭제`); })
    .catch(e => console.error('[세션 정리 실패]', e.code || e.message));
}, 6 * 3600 * 1000).unref?.();

// 1시간마다 캐시 정리
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) if (now > v.resetAt) rateLimitMap.delete(k);
}, 3600000);

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
