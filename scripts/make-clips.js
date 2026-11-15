#!/usr/bin/env node
// Renders the announcement clips (CLIP_TEXT in src/alarm.ts) into audio/<clip>.wav
// with macOS's `say`. Needs a build first (npm run build).
//
//   node scripts/make-clips.js [--voice Samantha] [--rate 170] [--only burglar,test]
//
// NOTE: check the license of the voice before publishing clips made this way
// (see AGENTS.md, "Open decisions").

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

let CLIP_TEXT;
try {
  ({ CLIP_TEXT } = require('../dist/alarm'));
} catch {
  console.error('Run "npm run build" first.');
  process.exit(1);
}

const voice = arg('voice');
const rate = arg('rate') ?? '170';
const only = arg('only') ? arg('only').split(',') : Object.keys(CLIP_TEXT);
const outDir = path.join(__dirname, '..', 'audio');
fs.mkdirSync(outDir, { recursive: true });

for (const clip of only) {
  const text = CLIP_TEXT[clip];
  if (!text) {
    console.error(`Unknown clip "${clip}"`);
    process.exit(1);
  }
  const file = path.join(outDir, `${clip}.wav`);
  const args = ['-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', '-r', rate];
  if (voice) {
    args.push('-v', voice);
  }
  execFileSync('say', [...args, text], { stdio: 'inherit' });
  console.log(`${clip}: ${file} (${fs.statSync(file).size} bytes) "${text}"`);
}
