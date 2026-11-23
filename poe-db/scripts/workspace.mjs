import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const dbRoot = fileURLToPath(new URL('../', import.meta.url));
export const projectRoot = path.resolve(dbRoot, '..');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function safeId(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value ?? '') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) throw new Error('Use a lowercase identifier with letters, digits and hyphens (1–64 characters).');
  return value;
}
export function flags(args, allowed = [], switches = []) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (switches.includes(key)) { options[key] = true; continue; }
    if (!allowed.includes(key)) throw new Error(`Unknown option --${key}`);
    if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = args[++i];
  }
  return { positional, options };
}
