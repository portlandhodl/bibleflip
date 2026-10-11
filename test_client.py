"""Streams a WAV file to the server in real time, like a browser mic would, and prints results.

Usage: .venv/bin/python test_client.py [file.wav] [--url wss://localhost:8443/ws] [--fast]
With no file, uses the sample clip bundled with moonshine-voice.
"""

import argparse
import asyncio
import json
import os
import ssl
import time

import numpy as np
import websockets
from moonshine_voice import get_assets_path, load_wav_file


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", nargs="?", default=os.path.join(get_assets_path(), "two_cities.wav"))
    parser.add_argument("--url", default="wss://localhost:8443/ws")
    parser.add_argument("--fast", action="store_true", help="send as fast as possible, not real time")
    args = parser.parse_args()

    audio, rate = load_wav_file(args.wav)
    audio = np.asarray(audio, dtype=np.float32)
    chunk = rate // 10  # 100 ms, same as the browser worklet

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # self-signed cert

    async with websockets.connect(args.url, ssl=ctx if args.url.startswith("wss") else None) as ws:
        await ws.send(json.dumps({"type": "start", "sampleRate": rate}))
        t0 = time.monotonic()
        sent_audio = 0.0

        async def send_audio():
            nonlocal sent_audio
            for i in range(0, len(audio), chunk):
                await ws.send(audio[i : i + chunk].tobytes())
                sent_audio = (i + chunk) / rate
                if not args.fast:
                    await asyncio.sleep(max(0, t0 + sent_audio - time.monotonic()))
            await ws.send(json.dumps({"type": "stop"}))

        sender = asyncio.create_task(send_audio())
        partials = 0
        lags = []
        async for raw in ws:
            msg = json.loads(raw)
            now = time.monotonic() - t0
            if msg["type"] == "partial":
                partials += 1
            elif msg["type"] == "final":
                # How long after the line's audio ended did the final text arrive?
                lag = now - (msg["start"] + msg["duration"])
                lags.append(lag)
                print(f"[{now:6.2f}s  lag {lag:5.2f}s] {msg['text']}")
            elif msg["type"] in ("ready", "error"):
                print(f"[{now:6.2f}s] {msg}")
            elif msg["type"] == "done":
                break
        await sender

    total = time.monotonic() - t0
    print(f"\naudio {len(audio) / rate:.1f}s, wall {total:.1f}s, {partials} partial updates")
    if lags and not args.fast:
        print(f"final-line lag after speech ends: median {np.median(lags):.2f}s, max {max(lags):.2f}s")


if __name__ == "__main__":
    asyncio.run(main())
