// CLI glue for build creation and share codes; registered from agent.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './workspace.mjs';
import { newPob, exportCode, importCode } from './pob.mjs';

export const pobHelp = {
  'pob new --class <Class> [--ascendancy <Name>] [--bloodline <Name>] [--level N] [--changes file.json] --save-xml <new.xml>':'Empty valid 3_30 build through PoB newBuild; --changes may allocate nodes, add groups and sets in the same step',
  'pob export-code <file.xml> [--save-code code.txt] [--raw]':'Local PoB share code from PoB SaveDB output; verifies byte and engine round-trip (--raw: bytes only)',
  'pob import-code <code.txt> | --code <string> --save-xml <new.xml>':'Decode a local share code, save PoB-normalized XML and verify it recomputes identically'
};

export function pobBuildCommand(operation, file, options) {
  const changes = options.changes ? readJson(path.resolve(options.changes)) : {};
  if (operation === 'new') {
    if (!options['save-xml']) throw new Error('pob new requires --save-xml <new-file.xml>');
    if (options.level != null && !/^\d+$/.test(options.level)) throw new Error('--level must be an integer');
    return newPob({ className: options.class, ascendancy: options.ascendancy ?? null, bloodline: options.bloodline ?? null,
      level: options.level == null ? 1 : Number(options.level), changes, saveXml: path.resolve(options['save-xml']), full: !!options.full, scenario: options.scenario ?? 'imported' });
  }
  if (operation === 'export-code') {
    if (!file) throw new Error('Local XML file required');
    const result = exportCode(fs.readFileSync(path.resolve(file)), { raw: !!options.raw, scenario: options.scenario ?? 'imported' });
    if (options['save-code']) {
      fs.writeFileSync(path.resolve(options['save-code']), result.code + '\n', { flag: 'wx' });
      return { ...result, code: undefined, saved_code: path.resolve(options['save-code']) };
    }
    return result;
  }
  if (operation === 'import-code') {
    if (!!file === !!options.code) throw new Error('Give exactly one of <code-file> or --code <string>');
    const input = options.code ?? fs.readFileSync(path.resolve(file), 'utf8');
    return importCode(input, { saveXml: options['save-xml'] ? path.resolve(options['save-xml']) : null, scenario: options.scenario ?? 'imported', full: !!options.full });
  }
  throw new Error(`Unknown pob operation: ${operation}`);
}
