import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';

// 读取根 .env 的 APP_SECRET
const envPath = new URL('../../../.env', import.meta.url);
const env = readFileSync(envPath, 'utf8');
const secret = env.match(/^APP_SECRET=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!secret) {
  console.error('APP_SECRET not found');
  process.exit(1);
}

const [sub, email, workspaceId] = process.argv.slice(2);
const payload = { sub, email, workspaceId, type: 'access' }; // 无 sessionId → 跳过 session 校验
const token = jwt.sign(payload, secret, { expiresIn: '1h' });
console.log(token);
