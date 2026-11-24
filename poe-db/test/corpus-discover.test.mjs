import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeedHtml, linkLine, discoverPoebuilds, discoverCommand } from '../scripts/corpus-discover.mjs';

// Shape of one poebuilds.cc feed card (/api/builds `html`), trimmed; text is synthetic.
const card = ({ id, title, version = '3.30 Covens', asc = 'Luminary', cls = 'Scion', author = 'Someone', links = [] }) =>
  `<div class="build-series"><div class="build-group-wrap build-series-head"><span class="build-card-tag--date build-card-date-slot">3h\nago</span>` +
  `<div class="build-card" data-class-slug="scion"><div class="build-card-portrait"><img src="/img/portraits/x.webp" alt="${asc}" width="130"></div>` +
  `<div class="build-card-body"><a href="https://www.youtube.com/watch?v=${id}" target="_blank" class="build-card-title" rel="noopener" title="${title}">${title}</a>` +
  `<div class="build-card-tags-line"><span class="build-card-tag build-card-tag--version build-card-tag--version-current">${version}</span><span class="build-card-tag build-card-tag--class" data-class-slug="scion">${cls}</span></div>` +
  `<div class="build-card-tags-line"><a href="/poe1/author/x" class="build-card-tag build-card-tag--author">${author}</a><a href="/poe1/build/${id}" class="build-card-tag build-card-tag--page">Details</a>` +
  links.map(l => `<a href="${l}" target="_blank" class="build-card-tag build-card-tag--ext">x</a>`).join('') + `</div></div></div></div></div>`;

const page1 = card({ id: 'aaa', title: 'Arc &amp; &quot;Spark&quot; Luminary', links: ['https://pobb.in/kYRu9o-ZWoGO'] })
  + card({ id: 'bbb', title: 'Ninja only', asc: 'Slayer', links: ['https://poe.ninja/poe1/pob/abc'] })
  + card({ id: 'ccc', title: 'Old', version: '3.29 Mercenaries', links: ['https://pobb.in/old'] })
  + card({ id: 'ddd', title: 'Both', asc: 'Chieftain', links: ['https://poe.ninja/poe1/pob/x', 'https://pob.codes/b/Q1'] })
  + card({ id: 'eee', title: 'No link' });

test('feed cards parse with version filter, decoded titles and PoB links', () => {
  const all = parseFeedHtml(page1);
  assert.equal(all.length, 5);
  const cur = parseFeedHtml(page1, { version: '3.30' });
  assert.deepEqual(cur.map(c => c.id), ['aaa', 'bbb', 'ddd', 'eee']);
  assert.equal(cur[0].title, 'Arc & "Spark" Luminary');
  assert.equal(cur[0].ascendancy, 'Luminary');
  assert.equal(cur[0].class, 'Scion');
  assert.equal(cur[0].author, 'Someone');
  assert.equal(cur[0].age, '3h ago');
  assert.equal(cur[0].page, 'https://www.poebuilds.cc/poe1/build/aaa');
  assert.deepEqual(cur[0].pob, ['https://pobb.in/kYRu9o-ZWoGO']);
  // poe.ninja links are never chosen; a card with only them yields no line.
  assert.equal(linkLine(cur[1]), null);
  assert.match(linkLine(cur[2]), /^https:\/\/pob\.codes\/b\/Q1\tChieftain \| Both \| Someone \| poebuilds\.cc 3\.30 Covens$/);
  assert.equal(linkLine(cur[3]), null);
});

test('discovery pages through the feed and stops on a page without cards of the version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-discover-'));
  const urls = [];
  const pages = [{ html: page1, hasMore: true, lastId: 'L1' }, { html: card({ id: 'fff', title: 'Second', links: ['https://pastebin.com/abc'] }) + card({ id: 'aaa', title: 'dup', links: ['https://pobb.in/zzz'] }), hasMore: true, lastId: 'L2' },
    { html: card({ id: 'ggg', title: 'Older', version: '3.29' }), hasMore: true, lastId: 'L3' }, { html: card({ id: 'hhh', title: 'never' }), hasMore: false }];
  const fetchSource = async url => { urls.push(url); return { bytes: Buffer.from(JSON.stringify(pages[urls.length - 1])) }; };
  try {
    const r = await discoverPoebuilds({ out: dir, fetchSource, delayMs: 0, maxPages: 10 });
    assert.equal(r.pages, 3);
    assert.equal(r.stop, 'no_cards_of_version');
    assert.equal(urls.length, 3);
    assert.match(urls[0], /^https:\/\/www\.poebuilds\.cc\/api\/builds\?view=latest&path=%2Fpoe1%3Fleague%3Dcovens$/);
    assert.match(urls[1], /&after=L1$/);
    assert.deepEqual({ cards: r.cards, links: r.links, ninja: r.skipped_poe_ninja_only, none: r.without_pob }, { cards: 5, links: 3, ninja: 1, none: 1 });
    const lines = fs.readFileSync(path.join(dir, 'links.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map(l => l.split('\t')[0]), ['https://pobb.in/kYRu9o-ZWoGO', 'https://pob.codes/b/Q1', 'https://pastebin.com/abc']);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.cards.length, 5);
    assert.equal(index.league, 'covens');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discover command validates its source and options', () => {
  assert.throws(() => discoverCommand(['discover']), /Use corpus discover poebuilds/);
  assert.throws(() => discoverCommand(['discover', 'maxroll']), /Use corpus discover poebuilds/);
  assert.throws(() => discoverCommand(['discover', 'poebuilds', '--max-pages', '0']), /positive integer/);
});
