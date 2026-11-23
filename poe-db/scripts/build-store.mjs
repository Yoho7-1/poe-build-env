import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, readJson, atomicJson, safeId } from './workspace.mjs';

const profileTypes = { trade_mode: 'string', platform: 'string', budget: 'object', preferred_content: 'array', buttons: 'string', experience: 'string',
  preferred_skills: 'array', disliked_mechanics: 'array', time_available: 'string', goals: 'array' };
export const stages = ['campaign', 'early-maps', 'atlas-progression', 'endgame', 'aspirational'];
export function validateBuild(value) {
  if (value.schema_version !== 1 || value.game !== 'poe1' || value.patch !== '3.30' || value.mode !== 'softcore') throw new Error('Build scope must be PoE 1 / 3.30 / Softcore; schema_version=1.');
  safeId(value.id);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('Invalid revision');
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Build name required');
  if (!['requirements','design','validation','progression','playtested'].includes(value.phase)) throw new Error('Unknown phase');
  if (!value.profile || typeof value.profile !== 'object' || Array.isArray(value.profile)) throw new Error('Invalid profile');
  for (const [key, next] of Object.entries(value.profile)) {
    const type = Object.hasOwn(profileTypes,key)?profileTypes[key]:null;
    if (!type || (next !== null && (type === 'array' ? !Array.isArray(next) || next.some(x => typeof x !== 'string') : typeof next !== type || (type === 'object' && Array.isArray(next))))) throw new Error(`Invalid profile.${key}`);
  }
  if (value.profile.trade_mode != null && !['trade','ssf'].includes(value.profile.trade_mode)) throw new Error('trade_mode must be trade, ssf or null');
  const b = value.profile.budget;
  if (b != null && (!Number.isFinite(b.amount) || b.amount < 0 || !['chaos','divine'].includes(b.currency))) throw new Error('Budget requires non-negative amount and chaos/divine currency');
  for (const key of ['decisions','open_questions','hypotheses','calculations']) if (!Array.isArray(value[key])) throw new Error(`Invalid ${key}`);
  if(value.open_questions.some(q=>typeof q!=='string'))throw new Error('Open questions must be strings');
  if(!value.design||typeof value.design!=='object'||Array.isArray(value.design))throw new Error('Design object required');
  for(const key of Object.keys(value.design))if(!['main_skill','ascendancy','bloodline','damage_scaling','defenses','resource_plan'].includes(key))throw new Error(`Unknown design.${key}`);
  for(const key of ['main_skill','ascendancy','bloodline','resource_plan'])if(value.design[key]!=null&&typeof value.design[key]!=='string')throw new Error(`Invalid design.${key}`);
  for(const key of ['damage_scaling','defenses'])if(!Array.isArray(value.design[key])||value.design[key].some(x=>typeof x!=='string'))throw new Error(`Invalid design.${key}`);
  if (!value.progression || stages.some(s => !value.progression[s])) throw new Error('All progression stages required');
  for (const [key,stage] of Object.entries(value.progression)) {
    if(!stages.includes(key)||!stage||!['not_designed','draft','calculated','playtested'].includes(stage.status))throw new Error('Invalid stage status');
    if(stage.pob!=null&&typeof stage.pob!=='string')throw new Error('Invalid stage PoB path');
    for(const list of ['mandatory_items','transition_requirements','unresolved'])if(!Array.isArray(stage[list])||stage[list].some(x=>typeof x!=='string'))throw new Error(`Invalid progression.${key}.${list}`);
  }
  return value;
}

export function createBuild(id, name, directory = path.join(projectRoot, 'builds')) {
  safeId(id);
  const folder = path.join(directory, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(folder); // Exclusive: never overwrite another build.
  const now = new Date().toISOString();
  const value = { schema_version: 1, id, name, game: 'poe1', patch: '3.30', mode: 'softcore', revision: 1, created_at: now, updated_at: now, phase: 'requirements',
    profile: Object.fromEntries(Object.keys(profileTypes).map(key => [key, null])),
    design: { main_skill: null, ascendancy: null, bloodline: null, damage_scaling: [], defenses: [], resource_plan: null },
    progression: Object.fromEntries(stages.map(stage => [stage, { status: 'not_designed', pob: null, mandatory_items: [], transition_requirements: [], unresolved: [] }])),
    decisions: [], hypotheses: [], calculations: [],
    open_questions: ['Trade или SSF?', 'Платформа, бюджет и опыт?', 'Предпочтительный контент, навыки и комфортное число кнопок?'] };
  atomicJson(path.join(folder, 'build.json'), validateBuild(value));
  fs.mkdirSync(path.join(folder, 'history'));
  atomicJson(path.join(folder, 'history', 'revision-1.json'), value);
  return value;
}
export function loadBuild(id = 'main', directory = path.join(projectRoot, 'builds')) {
  return validateBuild(readJson(path.join(directory, safeId(id), 'build.json')));
}
export function updateBuild(id, expectedRevision, patch, directory = path.join(projectRoot, 'builds')) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Patch must be an object');
  const folder = path.join(directory, safeId(id));
  const lock = path.join(folder, '.write-lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    const current = loadBuild(id, directory);
    if (current.revision !== expectedRevision) throw new Error(`Revision conflict: expected ${expectedRevision}, current ${current.revision}. Reload before changing.`);
    const allowed = ['name','phase','profile','design','progression','open_questions','hypotheses'];
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`Cannot patch ${key}; use the dedicated operation for decisions/calculations.`);
    const next = { ...current, ...patch, profile: { ...current.profile, ...patch.profile }, design: { ...current.design, ...patch.design },
      progression: { ...current.progression, ...patch.progression }, revision: current.revision + 1, updated_at: new Date().toISOString() };
    validateBuild(next);
    atomicJson(path.join(folder, 'history', `revision-${next.revision}-${randomUUID()}.json`), next);
    atomicJson(path.join(folder, 'build.json'), next);
    return next;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function appendBuildEvent(id, expectedRevision, kind, event, directory = path.join(projectRoot, 'builds')) {
  if (!['decisions','calculations'].includes(kind)) throw new Error('Invalid event kind');
  if (kind === 'decisions' && (!event.statement || !event.reason || !Array.isArray(event.evidence) || !['accepted','rejected','deferred'].includes(event.status))) throw new Error('Decision requires statement, reason, evidence[] and accepted/rejected/deferred status');
  if(kind==='decisions'&&(typeof event.statement!=='string'||typeof event.reason!=='string'||event.evidence.some(x=>typeof x!=='string')||event.status!=='deferred'&&!event.evidence.length))throw new Error('Accepted/rejected decisions require at least one evidence reference; evidence entries must be strings');
  if (kind === 'calculations' && (!event.result_file || !event.input_sha256 || !event.scenario)) throw new Error('Calculation requires result_file, input_sha256 and scenario');
  const folder = path.join(directory, safeId(id)), lock = path.join(folder, '.write-lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    const current = loadBuild(id, directory);
    if (current.revision !== expectedRevision) throw new Error('Revision conflict; reload before appending.');
    const next = { ...current, revision: current.revision + 1, updated_at: new Date().toISOString(), [kind]: [...current[kind], { ...event, id: randomUUID(), at: new Date().toISOString() }] };
    validateBuild(next);
    atomicJson(path.join(folder, 'history', `revision-${next.revision}-${randomUUID()}.json`), next);
    atomicJson(path.join(folder, 'build.json'), next);
    return next;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function briefBuild(value) {
  return { id: value.id, revision: value.revision, game: value.game, patch: value.patch, mode: value.mode, phase: value.phase,
    profile: value.profile, design: value.design, progression: Object.fromEntries(Object.entries(value.progression).map(([key, stage]) => [key, { status: stage.status, pob: stage.pob, unresolved: stage.unresolved }])),
    decisions: value.decisions.slice(-5), decisions_total: value.decisions.length, open_questions: value.open_questions,
    hypotheses: value.hypotheses, calculations: value.calculations.slice(-2), calculations_total: value.calculations.length };
}
