import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cards } from '../mechanics/catalog.mjs';
import { queryMechanics } from '../scripts/mechanics.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const coverageIds = ['projectile-behaviour','impale','stun','charges','rage','aura-herald-effect','warcry-exert',
  'brand-channelling','low-life-ci-hybrid','enemy-debuffs','pantheon-map-context'];

test('stage 5 coverage cards are built with resolved sources, caveats and relations', () => {
  const ids = new Set(cards.map(c => c.id));
  for (const id of coverageIds) {
    assert.ok(ids.has(id), id);
    const card = queryMechanics('get', id, { related: true }).results[0];
    assert.ok(card, `missing in database: ${id}`);
    assert.equal(card.patch, '3.30');
    assert.ok(card.rules.length >= 3 && card.conditions.length && card.pitfalls.length, id);
    assert.ok(card.sources.length && card.sources.every(s => s.sha256?.length === 64), id);
    assert.ok(card.related.length, id);
  }
  for (const [text, id] of [['Impale', 'impale'], ['Pierce', 'projectile-behaviour'], ['Pantheon', 'pantheon-map-context'], ['Wither', 'enemy-debuffs']])
    assert.equal(queryMechanics('search', text).results[0].id, id);
});

test('config variables cited by coverage cards exist in pinned ConfigOptions', () => {
  const config = path.join(root, 'vendor/pob/src/Modules/ConfigOptions.lua');
  if (!fs.existsSync(config)) return;
  const text = fs.readFileSync(config, 'utf8');
  const body = cards.filter(c => coverageIds.includes(c.id)).flatMap(c => [...c.rules, ...c.conditions, ...c.pitfalls]).join('\n');
  const cited = ['skillPierceCount','skillChainCount','skillForkCount','projectileDistance','ShrapnelBallistaProjectileOverlap',
    'toxicRainPodOverlap','tornadoShotSecondaryHitChance','multiplierImpalesOnEnemy','conditionEnemyStunned','conditionHitsAlwaysStun',
    'enemyDamageType','usePowerCharges','overridePowerCharges','useFrenzyCharges','useEnduranceCharges','multiplierRage','sacrificedRageCount',
    'conditionCritWithHeraldSkillRecently','enemyIsBoss','multiplierWarcryPower','warcryMode','conditionUsedWarcryRecently',
    'multiplierWarcryUsedRecently','BrandsAttachedToEnemy','ActiveBrands','BrandsInLastQuarter','BrandsInLastHalf','targetBrandedEnemy',
    'multiplierChannelling','conditionLowLife','conditionEnemyIntimidated','conditionEnemyUnnerved','conditionEnemyMaimed',
    'conditionEnemyHindered','conditionEnemyBlinded','overrideBuffBlinded','multiplierWitheredStackCount','pantheonMajorGod',
    'pantheonMinorGod','MapPrefix1','MapSuffix1','multiplierMapModTier','multiplierMapModEffect'];
  for (const name of cited) {
    assert.ok(body.includes(name), `not cited: ${name}`);
    assert.ok(text.includes(`var = "${name}"`), `unknown config variable: ${name}`);
  }
});
