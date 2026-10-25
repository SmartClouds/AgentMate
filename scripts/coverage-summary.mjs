#!/usr/bin/env node
// Prints one Markdown table for every package that has a coverage run, so CI can drop it into
// the job summary. Vitest and Jest both write the same `coverage-summary.json` shape, so this
// needs no dependencies and no knowledge of which runner produced it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PACKAGES = [
  'packages/core',
  'packages/protocol',
  'packages/studio',
  'apps/desktop',
  'apps/mobile',
];

const packages = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_PACKAGES;

function readTotals(packageDir) {
  try {
    const raw = readFileSync(join(packageDir, 'coverage', 'coverage-summary.json'), 'utf-8');
    const total = JSON.parse(raw).total;
    if (!total) return null;
    return total;
  } catch {
    // No coverage for this package in this run, which is normal.
    return null;
  }
}

function cell(metric) {
  if (!metric || typeof metric.pct !== 'number') return 'n/a';
  return `${metric.pct.toFixed(1)}% (${metric.covered}/${metric.total})`;
}

const rows = [];
for (const packageDir of packages) {
  const total = readTotals(packageDir);
  if (!total) continue;
  rows.push(
    `| \`${packageDir}\` | ${cell(total.lines)} | ${cell(total.statements)} | ${cell(total.functions)} | ${cell(total.branches)} |`,
  );
}

if (rows.length === 0) {
  console.log('No coverage reports found.');
  process.exit(0);
}

console.log('## Coverage\n');
console.log('| Package | Lines | Statements | Functions | Branches |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
