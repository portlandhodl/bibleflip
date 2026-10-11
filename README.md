# BibleFlip

Live sermon transcription in the browser, with spoken Bible references turned into
verses on screen. Speech is transcribed on the server's CPU with
[Moonshine Streaming](https://huggingface.co/moonshine-ai/moonshine-streaming-medium)
(MIT-licensed open weights). Talk into your desktop or iPad. Text appears while you
speak and settles into finished lines about half a second after you pause. When you
say "John 3:16", the verse appears at the top and joins a list on the left.

```
 browser / iPad Safari                         server (CPU)
┌──────────────────────┐   wss://…/ws   ┌──────────────────────────────┐
│ mic → AudioWorklet   │ ─ float32 PCM ▶│ FastAPI WebSocket            │
│  (100 ms chunks)     │                │  └ moonshine-voice Stream    │
│ live transcript  ◀───┼── JSON ────────│     partial / final lines    │
└──────────────────────┘                └──────────────────────────────┘
```

## Quick start

```bash
git clone https://github.com/portlandhodl/bibleflip.git && cd bibleflip
python3.11 -m venv .venv
./.venv/bin/pip install -r requirements.txt

./run.sh            # makes a self-signed cert on first run, downloads the model (~260 MB) once
```

The server prints the URLs it listens on, e.g. `https://192.0.2.10:8443/`.

- **This machine:** open `https://localhost:8443/`.
- **iPad / other devices:** open `https://<server-ip>:8443/` in Safari. Safari warns about
  the self-signed certificate. Tap **Show Details → visit this website**, then allow the
  microphone. To stop the warning permanently, AirDrop or email `certs/cert.pem` to the
  iPad, install the profile, then enable it under *Settings → General → About →
  Certificate Trust Settings*.

Browsers only allow microphone access on HTTPS pages or on `localhost`, which is why the
server uses TLS.

## Docker

```bash
docker compose up -d --build   # serves plain HTTP on 127.0.0.1:8094
```

The image bakes in the medium and small models, so it starts without downloading them.
Put a TLS-terminating reverse proxy in front, because browsers need HTTPS for the
microphone. `deploy/nginx.conf.example` proxies the page and the `/ws` WebSocket. Pass
different flags with `command:` in `compose.yaml`.

Link previews (Open Graph and Twitter cards) need absolute URLs, so the server builds them
from the `Host` and `X-Forwarded-Proto` headers the proxy sends. To pin them instead, set
`PUBLIC_URL=https://your.domain` in the container's environment. Don't add `cpus:` limits: the runtime starts one thread per physical core,
and a CPU quota throttles those threads. Measured on this server, the container matches
native lag (1 talker: ~0.8 s median; 4 talkers on medium: ~4-8 s median).

## Options

```
./run.sh --model small          # tiny | small | medium (default medium)
./run.sh --port 9443
./run.sh --update-interval 0.2  # more frequent live updates, more CPU
./run.sh --max-sessions 8       # concurrent talkers (default 4)
```

| Model  | Params | Avg WER* | Lag, 1 talker | Lag, 4 talkers |
|--------|-------:|---------:|--------------:|---------------:|
| tiny   | 34M    | 12.0%    | n/a           | n/a            |
| small  | 123M   | 7.8%     | ~0.5 s        | ~1.5 s         |
| medium | 245M   | 6.7%     | ~0.6 s        | ~5 s           |

\*Open ASR leaderboard averages from the model card. Lag is the median time from the
end of a spoken line to its final text arriving, measured on an 88-core Xeon server with
`test_client.py`.

## Bible verses

Say a reference such as "John 3:16", "John three sixteen", or "First Corinthians
chapter 13 verses 4 through 7". It is added to the **Verses** list on the left, and its
text appears at the top of the page with a link to the NKJV on BibleGateway. The text
shown is the public-domain King James Version (`data/kjv.json`), because NKJV text is
copyrighted and can't be redistributed. Detection runs on finished lines in
`static/verses.js`, which also joins lines split mid-reference ("…the book of Genesis." /
"Chapter 3 verse 15"). Run its tests with `node tests/verses.test.js`.

## Testing without a microphone

```bash
./.venv/bin/python test_client.py                 # streams a bundled sample in real time
./.venv/bin/python test_client.py my_recording.wav
```

## Files

- `server.py`: FastAPI app. One WebSocket per talker, each with its own Moonshine
  `Transcriber`/`Stream` on a dedicated thread.
- `static/`: web UI (`index.html`, `app.js`, `pcm-worklet.js`, `verses.js`). No build step.
- `data/kjv.json`: KJV text served by `/api/passage` (see `data/README.md`).
- `assets/`: SVG sources for the icons and the 1200×630 link-preview image. Run
  `assets/make-images.sh` after editing them (needs librsvg, ImageMagick, Noto Serif).
- `tests/verses.test.js`: reference-detection tests (`node tests/verses.test.js`).
- `Dockerfile`, `compose.yaml`, `deploy/nginx.conf.example`: container and reverse-proxy setup.
- `vendor/moonshine`: upstream [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)
  as a git submodule, for reference. The app uses the `moonshine-voice` pip package and runs
  without it. Fetch it with `git submodule update --init --depth 1`.
- `make-cert.sh`: self-signed cert covering localhost, the hostname, and all LAN IPs.
- `test_client.py`: streams a WAV file over the WebSocket protocol and reports lag.

## Notes

- English only. The streaming models are English, and other Moonshine languages use a
  non-commercial license.
- The native runtime pins its worker threads one per physical core and has no
  thread-count setting, so concurrent talkers compete for the same cores. Use
  `--model small` for groups.
- Like any seq2seq ASR model, it can hallucinate or repeat words on noise or very short
  clips.
- For fully offline use on an iPad, Moonshine ships a Swift package
  (`moonshine-ai/moonshine-swift`) and a WASM build that run the same models on-device.

## License

MIT, see `LICENSE`. Moonshine models and runtime are under their own licenses (see
`vendor/moonshine`). The KJV text is public domain.
