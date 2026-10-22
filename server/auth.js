'use strict';
// 登录鉴权：首次访问自设密码（scrypt 哈希存 auth.json），会话 token 持久化 30 天。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

class Auth {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { passwordHash: null, sessions: {} };
    this.failures = { count: 0, lockedUntil: 0 };
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw === 'object') this.state = { passwordHash: raw.passwordHash || null, sessions: raw.sessions || {} };
    } catch { /* 未设置 */ }
  }
  _persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* ignore */ }
  }
  isSetup() { return !!this.state.passwordHash; }
  _hash(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  }
  _verifyHash(password, stored) {
    try {
      const [, saltHex, hashHex] = stored.split(':');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
      return crypto.timingSafeEqual(expected, actual);
    } catch { return false; }
  }
  setup(password) {
    if (this.isSetup()) throw new Error('密码已设置');
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new Error('密码长度需为 6–128 位');
    this.state.passwordHash = this._hash(password);
    this._persist();
    return this._createSession();
  }
  login(password) {
    const now = Date.now();
    if (now < this.failures.lockedUntil) throw new Error('尝试次数过多，请 5 分钟后再试');
    if (!this.isSetup()) throw new Error('尚未设置密码');
    if (!this._verifyHash(String(password || ''), this.state.passwordHash)) {
      this.failures.count += 1;
      if (this.failures.count >= 5) { this.failures.lockedUntil = now + 5 * 60 * 1000; this.failures.count = 0; }
      throw new Error('密码不正确');
    }
    this.failures.count = 0;
    return this._createSession();
  }
  _createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.state.sessions[token] = { createdAt: now, expiresAt: now + SESSION_TTL_MS };
    // 清过期会话
    for (const [t, s] of Object.entries(this.state.sessions)) if (s.expiresAt < now) delete this.state.sessions[t];
    this._persist();
    return token;
  }
  check(token) {
    if (!token) return false;
    const s = this.state.sessions[token];
    return !!s && s.expiresAt > Date.now();
  }
  logout(token) {
    if (token && this.state.sessions[token]) { delete this.state.sessions[token]; this._persist(); }
  }
}
module.exports = { Auth };
