// ─────────────────────────────────────────────────────────────
// db.js 의 1~28행(import ~ q 함수 끝)을 이걸로 교체하세요.
// 나머지 코드는 그대로 두시면 됩니다.
// ─────────────────────────────────────────────────────────────
import pg from 'pg';
import { nanoid } from 'nanoid';
const { Pool } = pg;

const CONN = process.env.DATABASE_URL;

// SSL: 문자열 매칭 대신 명시적 스위치 (로컬 Postgres 쓸 때만 PGSSL=off)
const useSsl = process.env.PGSSL === 'off'
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: CONN,
  ssl: useSsl,
  max: 10,
  idleTimeoutMillis: 10000,          // 30초 → 10초. 프록시가 끊기 전에 우리가 먼저 정리
  connectionTimeoutMillis: 10000,
  keepAlive: true,                   // TCP keepalive 로 유휴 커넥션 유지
  keepAliveInitialDelayMillis: 5000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  // 유휴 커넥션이 끊긴 경우. 풀이 알아서 제거하므로 로그만 남기고 넘어감
  console.error('[DB 유휴 커넥션 종료]', err.code || err.message);
});

// 재시도 대상: "커넥션이 죽어 있었다" 계열 에러만.
// 문법 오류·제약 위반 등은 재시도해도 똑같이 실패하므로 제외.
const RETRYABLE = new Set([
  'ECONNRESET',   // 소켓이 상대방에 의해 끊김  ← 지금 겪고 계신 것
  'EPIPE',        // 끊긴 소켓에 쓰기 시도
  'ETIMEDOUT',
  'ECONNREFUSED',
  '08000',        // connection_exception
  '08003',        // connection_does_not_exist
  '08006',        // connection_failure
  '57P01',        // admin_shutdown (DB가 커넥션을 종료시킴)
  '57P02',        // crash_shutdown
  '57P03',        // cannot_connect_now (재기동 중)
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 죽은 풀 커넥션을 자동으로 걸러내는 query 래퍼.
 *
 * 안전성: 유휴 중 끊긴 커넥션은 소켓을 꺼내 쓰는 "시점"에 바로 실패하므로,
 * SQL 문이 서버에 도달하기 전에 에러가 납니다. 따라서 재시도해도
 * INSERT 가 중복 실행되지 않습니다. 다만 쿼리 실행 도중 DB 가 재기동된
 * 드문 경우에는 이론상 중복이 가능하니, 금액 계산처럼 멱등하지 않은
 * 작업이 생기면 그때는 트랜잭션으로 감싸세요.
 */
async function query(sql, params, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    return await pool.query(sql, params);
  } catch (err) {
    const code = err.code || err.errno;
    const retryable = RETRYABLE.has(code) || code === -104; // -104 = ECONNRESET errno
    if (!retryable || attempt >= MAX_ATTEMPTS) throw err;

    const delay = attempt * 150;   // 150ms → 300ms
    console.warn(`[DB 재시도 ${attempt}/${MAX_ATTEMPTS - 1}] ${code} — ${delay}ms 후 재시도`);
    await sleep(delay);
    return query(sql, params, attempt + 1);
  }
}

// ? → $1,$2,... 변환 헬퍼 (이제 재시도가 적용된 query 를 사용)
function q(sql) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return {
    async get(...p) { const { rows } = await query(pgSql, p); return rows[0] ?? null; },
    async all(...p) { const { rows } = await query(pgSql, p); return rows; },
    async run(...p) { await query(pgSql, p); },
  };
}

// ─────────────────────────────────────────────────────────────
// 아래 두 줄은 파일 하단의 기존 export 를 대체/추가하는 부분입니다.
//
//   export function getDb() { return pool; }
//        ↓ 이렇게 바꾸면 server.js 에서 getDb().query(...) 를 쓰는
//          20여 곳도 전부 자동으로 재시도 혜택을 받습니다.
// ─────────────────────────────────────────────────────────────
export function getDb() {
  return { query, connect: (...a) => pool.connect(...a), end: () => pool.end() };
}

// 시작 시 연결을 한 번 확인하고 싶다면 initDb() 맨 위에 추가:
//
//   await query('SELECT 1');
//   console.log('✓ DB 연결 확인');
