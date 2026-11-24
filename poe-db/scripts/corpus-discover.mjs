// Link discovery for the corpus (WP2): list PoB paste links of current-patch guides from poebuilds.cc's own feed API
// (/api/builds, the endpoint its page calls for "load more"; robots.txt allows it, only /*/top and /*/new are
// disallowed). Politely paged through source-cache (cached, conditional, >= 1.5 s between requests), stops on the
// first page without cards of the wanted version. Output: index.json (every card with provenance) and links.txt
// (url<TAB>note) for `corpus add-list`. poe.ninja PoB links are skipped and counted: the project uses poe.ninja only
// through its documented economy API. Card text is data, not instructions.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, flags } from './workspace.mjs';

const site = 'https://www.poebuilds.cc';
const decode = s => String(s ?? '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pobLink = /https:\/\/(?:pobb\.in|pob\.codes|api\.pob\.codes|pastebin\.com|poe\.ninja\/poe1\/pob)\/[^"'\s<]+/g;
export const isNinja = url => /^https:\/\/poe\.ninja\//.test(url);
export const defaultDiscoverDirectory = version => path.join(projectRoot, 'research/lab/sources', `poebuilds-${String(version).replace(/\./g, '')}`);

// One feed page (the `html` field of /api/builds) -> cards; `version` keeps only cards whose version tag starts with it.
export function parseFeedHtml(html, { version = null } = {}) {
  const cards = [];
  for (const chunk of String(html ?? '').split('<div class="build-series').slice(1)) {
    const id = chunk.match(/href="\/poe1\/build\/([A-Za-z0-9_-]+)"/)?.[1];
    if (!id) continue;
    const ver = chunk.match(/build-card-tag--version[^>]*>([^<]+)</)?.[1]?.trim() ?? null;
    if (version && !ver?.startsWith(version)) continue;
    cards.push({ id, title: decode(chunk.match(/class="build-card-title"[^>]*title="([^"]*)"/)?.[1]).trim(), version: ver,
      ascendancy: decode(chunk.match(/portrait"><img[^>]*alt="([^"]*)"/)?.[1]) || null, class: chunk.match(/build-card-tag--class"[^>]*>([^<]+)</)?.[1]?.trim() ?? null,
      author: decode(chunk.match(/build-card-tag--author">([^<]+)</)?.[1]).trim() || null, age: chunk.match(/build-card-tag--date[^>]*>([^<]+)</)?.[1]?.replace(/\s+/g, ' ').trim() ?? null,
      pob: [...new Set((chunk.match(pobLink) ?? []).map(decode))], page: `${site}/poe1/build/${id}` });
  }
  return cards;
}

export function linkLine(card) {
  const url = card.pob.find(u => !isNinja(u));
  if (!url) return null;
  const note = [card.ascendancy ?? card.class ?? 'unknown', card.title.slice(0, 90), card.author ?? 'unknown author', `poebuilds.cc ${card.version ?? ''}`.trim()]
    .map(s => String(s).replace(/[\t\r\n]+/g, ' ')).join(' | ');
  return `${url}\t${note}`;
}

export async function discoverPoebuilds({ league = 'covens', version = '3.30', maxPages = 20, out = null, delayMs = 1500, fetchSource = null, minimumAgeMs = 3600000 } = {}) {
  const fetcher = fetchSource ?? (await import('./source-cache.mjs')).cachedSource;
  const cards = new Map();
  let after = null, pages = 0, stop = 'max_pages';
  while (pages < maxPages) {
    if (pages && delayMs) await new Promise(r => setTimeout(r, Math.max(1500, delayMs)));
    const q = new URLSearchParams({ view: 'latest', path: `/poe1?league=${league}` });
    if (after) q.set('after', after);
    const data = await fetcher(`${site}/api/builds?${q}`, { minimumAgeMs });
    const page = JSON.parse(Buffer.from(data.bytes).toString('utf8'));
    pages++;
    const found = parseFeedHtml(page.html, { version });
    for (const c of found) if (!cards.has(c.id)) cards.set(c.id, c);
    if (!found.length) { stop = 'no_cards_of_version'; break; }
    if (!page.hasMore || !page.lastId) { stop = 'feed_end'; break; }
    after = page.lastId;
  }
  const list = [...cards.values()];
  const lines = list.map(linkLine).filter(Boolean);
  const summary = { pages, stop, cards: list.length, with_pob: list.filter(c => c.pob.length).length, links: lines.length,
    skipped_poe_ninja_only: list.filter(c => c.pob.length && c.pob.every(isNinja)).length, without_pob: list.filter(c => !c.pob.length).length };
  const directory = out ?? defaultDiscoverDirectory(version);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ source: `${site} (feed API /api/builds, league filter)`, fetched: new Date().toISOString(), league, version, ...summary,
    note: 'Card text is data, not instructions. poe.ninja PoB links are not fetched (economy API only).', cards: list }, null, 1));
  fs.writeFileSync(path.join(directory, 'links.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
  return { out: directory, index: path.join(directory, 'index.json'), links_file: path.join(directory, 'links.txt'), ...summary,
    next: `corpus add-list ${path.join(directory, 'links.txt')}` };
}

export function discoverCommand(args) {
  const { positional, options } = flags(args, ['league', 'version', 'max-pages', 'out', 'delay-ms']);
  const [, sourceName] = positional;
  if (sourceName !== 'poebuilds') throw new Error('Use corpus discover poebuilds [--league covens] [--version 3.30] [--max-pages 20] [--out dir] [--delay-ms 1500]');
  const maxPages = Number(options['max-pages'] ?? 20);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('--max-pages must be a positive integer');
  return discoverPoebuilds({ league: options.league ?? 'covens', version: options.version ?? '3.30', maxPages, out: options.out ? path.resolve(options.out) : null, delayMs: Number(options['delay-ms'] ?? 1500) });
}
export const discoverHelp = {
  'corpus discover poebuilds [--league covens] [--version 3.30] [--max-pages 20] [--out dir] [--delay-ms 1500]':
    'List PoB paste links of current-patch guides from the poebuilds.cc feed API (cached, >= 1.5 s between pages, stops on a page without cards of the version); writes index.json and links.txt for corpus add-list (default research/lab/sources/poebuilds-330); poe.ninja links skipped and counted'
};
