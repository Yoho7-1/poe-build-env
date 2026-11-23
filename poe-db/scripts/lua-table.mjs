// Minimal parser for data-only Lua table literals (PoB TreeData/*.lua): no code execution.
export function parseLuaTable(text) {
  let i = 0;
  const n = text.length;
  const fail = msg => { throw new Error(`Lua parse error at ${i}: ${msg}`); };
  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('--', i)) {
        const long = text.slice(i + 2).match(/^\[(=*)\[/);
        if (long) { const end = text.indexOf(`]${long[1]}]`, i); i = end < 0 ? n : end + long[1].length + 2; }
        else { while (i < n && text[i] !== '\n') i++; }
        continue;
      }
      return;
    }
  }
  function string() {
    const quote = text[i++];
    let out = '';
    while (i < n && text[i] !== quote) {
      let c = text[i++];
      if (c === '\\') {
        c = text[i++];
        if (c === 'n') out += '\n'; else if (c === 't') out += '\t'; else if (c === 'r') out += '\r';
        else if (/\d/.test(c)) { let d = c; while (d.length < 3 && /\d/.test(text[i])) d += text[i++]; out += String.fromCharCode(Number(d)); }
        else out += c;
      } else out += c;
    }
    if (text[i++] !== quote) fail('unterminated string');
    return out;
  }
  function longString() {
    const m = text.slice(i).match(/^\[(=*)\[/);
    const close = `]${m[1]}]`;
    const start = i + m[0].length;
    const end = text.indexOf(close, start);
    if (end < 0) fail('unterminated long string');
    i = end + close.length;
    return text.slice(start, end).replace(/^\r?\n/, '');
  }
  function value() {
    skip();
    const c = text[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return string();
    if (c === '[' && /^\[=*\[/.test(text.slice(i, i + 10))) return longString();
    const m = text.slice(i, i + 40).match(/^(-?(?:0x[0-9a-f]+|\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|true|false|nil)/i);
    if (!m) fail(`unexpected ${JSON.stringify(text.slice(i, i + 20))}`);
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    if (m[0] === 'nil') return null;
    return Number(m[0]);
  }
  function table() {
    i++;
    const arr = [], obj = {};
    let keyed = false;
    for (;;) {
      skip();
      if (text[i] === '}') { i++; break; }
      let key = null;
      if (text[i] === '[' && !/^\[=*\[/.test(text.slice(i, i + 10))) {
        i++; key = value(); skip(); if (text[i++] !== ']') fail('expected ]'); skip(); if (text[i++] !== '=') fail('expected =');
      } else {
        const m = text.slice(i, i + 80).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/);
        if (m) { key = m[1]; i += m[0].length; }
      }
      const v = value();
      if (key === null) arr.push(v); else { keyed = true; obj[key] = v; }
      skip();
      if (text[i] === ',' || text[i] === ';') i++;
    }
    if (!keyed) return arr;
    arr.forEach((v, idx) => { obj[idx + 1] = v; });
    return obj;
  }
  skip();
  if (text.startsWith('return', i)) i += 6;
  return value();
}
