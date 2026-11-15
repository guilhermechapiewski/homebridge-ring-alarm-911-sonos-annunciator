"""Renders clips with Piper (https://github.com/OHF-Voice/piper1-gpl).

Called by scripts/make-clips.js, which passes the model path and reads the
jobs from stdin as JSON: [{"out": "/abs/file.wav", "text": "..."}, ...].
Needs Python with `pip install piper-tts`. Development tool only; nothing
from Piper ships with the plugin.

Each clip gets a short lead-in of silence (speakers often swallow the first
moment while their amplifier wakes up) and is peak-normalized, so every
clip is equally loud.
"""
import array
import io
import json
import os
import sys
import wave

import piper
from piper import PiperVoice

LEAD_IN_SECONDS = 0.4
PEAK = 0.89  # -1 dBFS


def main() -> None:
    model = os.path.abspath(sys.argv[1])
    jobs = json.load(sys.stdin)
    # espeak-ng truncates long data paths, so give it a short relative one.
    os.chdir(os.path.dirname(piper.__file__))
    voice = PiperVoice.load(model, espeak_data_dir='espeak-ng-data')
    for job in jobs:
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as raw:
            voice.synthesize_wav(job['text'], raw)
        buffer.seek(0)
        with wave.open(buffer, 'rb') as raw:
            rate, width, channels = raw.getframerate(), raw.getsampwidth(), raw.getnchannels()
            samples = array.array('h', raw.readframes(raw.getnframes()))
        if width != 2 or channels != 1:
            raise SystemExit(f'expected 16-bit mono from the voice, got {width * 8}-bit x{channels}')
        peak = max(1, max(abs(s) for s in samples))
        gain = PEAK * 32767 / peak
        samples = array.array('h', (max(-32768, min(32767, round(s * gain))) for s in samples))
        silence = array.array('h', [0] * int(rate * LEAD_IN_SECONDS))
        with wave.open(job['out'], 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(rate)
            out.writeframes((silence + samples).tobytes())


if __name__ == '__main__':
    main()
