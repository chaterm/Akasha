import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderNodeReference } from './node-reference';

const target = resolve(
  __dirname,
  '../../../../../akasha-plugin/skills/akasha-pages/references/node-reference.md',
);

writeFileSync(target, renderNodeReference(), 'utf8');
process.stdout.write(`${target}\n`);
