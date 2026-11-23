export function decodeEntities(value = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−', bull: '•', times: '×', hellip: '…' };
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
    }
    return entities[entity] ?? whole;
  });
}

export function plainText(value) {
  let text = decodeEntities(value);
  text = text.replace(/<span\b[^>]*class="[^"]*item-stat-separator[^>]*>\s*<\/span>/gi, '\n');
  text = text.replace(/<br\s*\/?\s*>|<hr\b[^>]*>|<\/(?:p|div|tr|table)>/gi, '\n');
  text = text.replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*?)?\s*\/?>/gi, '');
  text = text.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, target, label) => label ?? target);
  text = text.replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (_, url, label) => label ?? url);
  text = text.replace(/'{2,5}/g, '');
  return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function splitOptions(value) {
  const text = decodeEntities(value);
  const choices = [];
  const fixed = text.replace(/<table\b[^>]*class="[^"]*random-modifier-stats[^"]*"[^>]*>[\s\S]*?<\/table>/gi, block => {
    choices.push(plainText(block));
    return '\n';
  });
  return { fixed: plainText(fixed), choices };
}

export function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = versionTuple(left), b = versionTuple(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

export function classifyAvailability(item) {
  if (item.is_in_game !== '1') return { include: false, reason: 'not_marked_in_game' };
  if (item.removal_version && compareVersions(item.removal_version, '3.30.0') <= 0) return { include: false, reason: 'removed_by_target_patch' };
  if (item.release_version && compareVersions(item.release_version, '3.30.0') > 0) return { include: false, reason: 'released_after_target_patch' };
  if (['Idol', 'Watchstone'].includes(item.class)) return { include: false, reason: 'outside_standard_covens_scope' };
  if (item.drop_enabled !== '1') return { include: false, reason: 'acquisition_not_confirmed_by_source' };
  return { include: true, reason: 'wiki_current_acquisition_flag', confidence: 'source_asserted' };
}

export function numeric(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid numeric source value: ${value}`);
  return result;
}

export const wikiUrl = page => `https://www.poewiki.net/wiki/${encodeURIComponent(decodeEntities(page).replaceAll(' ', '_'))}`;

export function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}
