#!/usr/bin/env node
'use strict';
/**
 * Renders the announcement clips (CLIP_TEXT in src/alarm.ts) into
 * audio/<style>/<clip>.wav with Piper and the en_US-ljspeech-high voice
 * (public domain; see NOTICE). Needs a build first (npm run build).
 *
 *   python3 -m venv /tmp/piper && /tmp/piper/bin/pip install piper-tts
 *   /tmp/piper/bin/python -m piper.download_voices en_US-ljspeech-high   # in some folder
 *   node scripts/make-clips.js --python /tmp/piper/bin/python --model <folder>/en_US-ljspeech-high.onnx \
 *     [--style standard,urgent] [--only burglar,test]
 *
 * Use a voice whose license allows redistribution (check its MODEL_CARD, and
 * what it was fine-tuned from), and update NOTICE if it changes.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

let alarm;
try {
  alarm = require('../dist/alarm');
} catch {
  console.error('Run "npm run build" first.');
  process.exit(1);
}
const { ANNOUNCEMENT_STYLES, CLIP_NAMES, CLIP_TEXT } = alarm;

const python = arg('python') || 'python3';
const model = arg('model');
if (!model || !fs.existsSync(model)) {
  console.error('Usage: node scripts/make-clips.js --python <python with piper-tts> --model <voice.onnx> [--style ...] [--only ...]');
  process.exit(2);
}
const styles = arg('style') ? arg('style').split(',') : ANNOUNCEMENT_STYLES;
const clips = arg('only') ? arg('only').split(',') : CLIP_NAMES;
for (const style of styles) {
  if (!ANNOUNCEMENT_STYLES.includes(style)) {
    console.error(`Unknown style "${style}"`);
    process.exit(2);
  }
}
for (const clip of clips) {
  if (!CLIP_NAMES.includes(clip)) {
    console.error(`Unknown clip "${clip}"`);
    process.exit(2);
  }
}

const jobs = [];
for (const style of styles) {
  const dir = path.join(__dirname, '..', 'audio', style);
  fs.mkdirSync(dir, { recursive: true });
  for (const clip of clips) {
    jobs.push({ out: path.join(dir, `${clip}.wav`), text: CLIP_TEXT[style][clip], label: `${style}/${clip}` });
  }
}

execFileSync(python, [path.join(__dirname, 'piper-render.py'), path.resolve(model)], {
  input: JSON.stringify(jobs.map(({ out, text }) => ({ out, text }))),
  stdio: ['pipe', 'inherit', 'inherit'],
});
for (const job of jobs) {
  console.log(`${job.label}: ${fs.statSync(job.out).size} bytes  "${job.text}"`);
}
