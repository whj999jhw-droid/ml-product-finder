import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db.js';

// 扩展 session 类型，携带当前用户
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    email?: string;
  }
}

const router = Router();

// 密码哈希：scrypt + 随机 salt（Node 内置 crypto，无额外依赖）
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 注册
router.post('/register', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: '邮箱和密码（至少6位）必填' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const userId = uuidv4();
    db.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(userId, email, passwordHash, salt);
    req.session.userId = userId;
    req.session.email = email;
    return res.json({ success: true, user: { id: userId, email } });
  } catch (err: any) {
    console.error('[Auth Register]', err);
    return res.status(500).json({ error: '注册失败' });
  }
});

// 登录
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码必填' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    return res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (err: any) {
    console.error('[Auth Login]', err);
    return res.status(500).json({ error: '登录失败' });
  }
});

// 登出
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: '登出失败' });
    res.clearCookie('mlf_session');
    return res.json({ success: true });
  });
});

// 当前登录用户
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }
  return res.json({ user: { id: req.session.userId, email: req.session.email } });
});

// 登录守卫（供其他路由使用）
export function requireAuth(req: any, res: any, next: any) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

export default router;
