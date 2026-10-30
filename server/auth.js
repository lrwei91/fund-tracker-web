'use strict';
// 登录鉴权（多用户版）：以用户名进入系统，无密码。
// auth.json: { users: { <用户名>: { createdAt } }, sessions: { <token>: { username, createdAt, expiresAt } } }
// 用户名白名单制：只有已开通的用户名可登录；首个用户 lrwei91 在迁移/首启时自动开通。
// 旧版单密码 auth.json（passwordHash）首次加载时自动迁移：开通 lrwei91、旧会话全部失效。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const DEFAULT_USER = 'lrwei91';

function validUsername(name) { return typeof name === 'string' && USERNAME_RE.test(name); }

class Auth {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { users: {}, sessions: {} };
    let migrated = false;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.users && typeof raw.users === 'object') {
          this.state.users = raw.users;
          this.state.sessions = (raw.sessions && typeof raw.sessions === 'object') ? raw.sessions : {};
          // 旧会话无 username 字段的一律失效
          for (const [t, s] of Object.entries(this.state.sessions)) {
            if (!s || !validUsername(s.username) || !this.state.users[s.username]) delete this.state.sessions[t];
          }
        } else if (raw.passwordHash) {
          migrated = true; // 旧单密码格式 → 迁移为用户名制
        }
      }
    } catch { /* 未开通任何用户 */ }
    if (!Object.keys(this.state.users).length) {
      this.state.users[DEFAULT_USER] = { createdAt: new Date().toISOString() };
      migrated = true;
    }
    if (migrated) this._persist();
  }
  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* ignore */ }
  }
  isSetup() { return Object.keys(this.state.users).length > 0; }
  hasUser(username) { return !!this.state.users[username]; }
  usernames() { return Object.keys(this.state.users); }
  addUser(username) {
    const name = String(username || '').trim();
    if (!validUsername(name)) throw new Error('用户名仅允许字母、数字、下划线、短横线和点，1–32 位');
    if (this.state.users[name]) return name;
    this.state.users[name] = { createdAt: new Date().toISOString() };
    this._persist();
    return name;
  }
  login(username) {
    const name = String(username || '').trim();
    if (!validUsername(name)) throw new Error('用户名格式不正确');
    if (!this.state.users[name]) throw new Error('该用户名尚未开通，请确认输入');
    return this._createSession(name);
  }
  _createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.state.sessions[token] = { username, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    for (const [t, s] of Object.entries(this.state.sessions)) if (!s || s.expiresAt < now) delete this.state.sessions[t];
    this._persist();
    return token;
  }
  // 返回会话对应的用户名，未登录/过期返回 null
  sessionUser(token) {
    if (!token) return null;
    const s = this.state.sessions[token];
    if (!s || s.expiresAt <= Date.now() || !this.state.users[s.username]) return null;
    return s.username;
  }
  check(token) { return this.sessionUser(token) !== null; }
  logout(token) {
    if (token && this.state.sessions[token]) { delete this.state.sessions[token]; this._persist(); }
  }
}
module.exports = { Auth, validUsername, DEFAULT_USER };
