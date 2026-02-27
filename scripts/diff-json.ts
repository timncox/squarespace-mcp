/**
 * Deep diff two JSON files.
 * Usage: npx tsx scripts/diff-json.ts <before.json> <after.json>
 */
import { readFileSync } from 'fs';

function deepDiff(path: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    console.log(`${path}: ${JSON.stringify(a)?.substring(0, 300)} → ${JSON.stringify(b)?.substring(0, 300)}`);
    return;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const k of keys) {
    deepDiff(`${path}.${k}`, aObj[k], bObj[k]);
  }
}

const beforeFile = process.argv[2];
const afterFile = process.argv[3];

if (!beforeFile || !afterFile) {
  console.error('Usage: npx tsx scripts/diff-json.ts <before.json> <after.json>');
  process.exit(1);
}

const before = JSON.parse(readFileSync(beforeFile, 'utf-8'));
const after = JSON.parse(readFileSync(afterFile, 'utf-8'));

deepDiff('root', before, after);
