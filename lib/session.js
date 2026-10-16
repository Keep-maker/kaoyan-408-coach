// ============================================================
//  会话层：为每个访客分配独立数据空间（零依赖，用内置 crypto）
//  - HttpOnly Cookie 携带 sid，服务端 sessions 表映射到 user_id
//  - 不引入账号密码，访客打开即有自己的空间
// ============================================================
const crypto = require('node:crypto');
const { q } = require('./db');

const COOKIE = 'ky_sid';
const MAX_AGE = 180 * 24 * 3600; // 180 天（秒）

// 解析请求头里的 Cookie
function parseCookies(req) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (_) { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}

const newSid = () => crypto.randomBytes(24).toString('base64url');

// sid -> userId（无效或过期返回 null）
function userIdFor(sid) {
  if (!sid) return null;
  const row = q.get('SELECT user_id FROM sessions WHERE sid=?', sid);
  if (!row) return null;
  return row.user_id;
}

function bind(sid, userId) {
  q.run(`INSERT INTO sessions (sid,user_id,last_seen) VALUES (?,?,datetime('now','localtime'))
         ON CONFLICT(sid) DO UPDATE SET last_seen=excluded.last_seen`, sid, userId);
}

function touch(sid) {
  try { q.run(`UPDATE sessions SET last_seen=datetime('now','localtime') WHERE sid=?`, sid); } catch (_) {}
}

// 清理长期不活跃的会话（保留数据，仅回收会话行）
function cleanup(days = 180) {
  try { return q.run(`DELETE FROM sessions WHERE last_seen IS NOT NULL AND last_seen < datetime('now','localtime',?)`, '-' + days + ' days').changes; }
  catch (_) { return 0; }
}

function cookieHeader(sid) {
  return COOKIE + '=' + sid + '; Path=/; Max-Age=' + MAX_AGE + '; HttpOnly; SameSite=Lax';
}

module.exports = { COOKIE, parseCookies, newSid, userIdFor, bind, touch, cleanup, cookieHeader };
