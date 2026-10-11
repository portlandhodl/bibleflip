"""Live English speech-to-text web server, running Moonshine Streaming on the CPU.

The browser captures microphone audio, sends it over a WebSocket as raw
float32 PCM, and receives partial (still changing) and final (completed line)
transcripts back as JSON.

Protocol (per WebSocket connection at /ws):
  client -> server  {"type": "start", "sampleRate": 48000}   (text, first message)
  client -> server  <binary float32 mono PCM chunks>
  client -> server  {"type": "stop"}                         (flush and finish)
  server -> client  {"type": "ready"}
  server -> client  {"type": "partial", "id": <line id>, "text": "..."}
  server -> client  {"type": "final",   "id": <line id>, "text": "...", "start": s, "duration": s}
  server -> client  {"type": "done"}                         (after stop, all text flushed)
  server -> client  {"type": "error", "message": "..."}
"""

import argparse
import asyncio
import html
import json
import logging
import mimetypes
import os
import queue
import re
import socket
import threading
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from moonshine_voice import ModelArch, get_model_for_language
from moonshine_voice.transcriber import (
    Error,
    LineCompleted,
    LineTextChanged,
    Transcriber,
)

log = logging.getLogger("moonshine-stt")

MODELS = {
    "tiny": ModelArch.TINY_STREAMING,  # 34M params, fastest, ~12% WER
    "small": ModelArch.SMALL_STREAMING,  # 123M params, ~7.8% WER
    "medium": ModelArch.MEDIUM_STREAMING,  # 245M params, ~6.7% WER
}

STATIC_DIR = Path(__file__).parent / "static"
# Public-domain King James Version: {"John": [[verse, ...] per chapter], ...}.
# NKJV text is copyrighted, so the UI links out to it instead of hosting it.
BIBLE = json.loads((Path(__file__).parent / "data" / "kjv.json").read_text(encoding="utf-8"))
INDEX_HTML = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
HOST_RE = re.compile(r"[A-Za-z0-9.\-]+(:\d+)?|\[[0-9A-Fa-f:]+\](:\d+)?")
STOP = object()  # sentinel placed on the audio queue to flush and end a session

mimetypes.add_type("application/manifest+json", ".webmanifest")

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Filled in by main() before the server starts.
config = {"model_path": None, "model_arch": None, "update_interval": 0.3}
session_slots: asyncio.Semaphore | None = None

# Each session loads its own Transcriber (~0.6s). On an 88-core box that beat one
# shared model taking turns (4 talkers on medium: ~5s median lag vs ~16s). The
# native runtime pins its worker threads one per physical core and has no
# thread-count setting, so sessions still compete for the same cores; for several
# simultaneous talkers use --model small (~1.5s median lag at 4 talkers).

@app.get("/")
async def index(request: Request):
    # og:image and friends need absolute URLs. PUBLIC_URL wins; otherwise use the
    # Host and X-Forwarded-Proto headers a reverse proxy passes through.
    base = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if not base:
        proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
        host = request.headers.get("host", "")
        if proto in ("http", "https") and HOST_RE.fullmatch(host):
            base = f"{proto}://{host}"
    return HTMLResponse(INDEX_HTML.replace("__BASE_URL__", html.escape(base)))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(STATIC_DIR / "favicon.ico")


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": config["model_arch"].name}


@app.get("/api/verse-counts")
async def verse_counts():
    """Verses per chapter for every book, so the client can reject impossible refs."""
    return {book: [len(ch) for ch in chapters] for book, chapters in BIBLE.items()}


@app.get("/api/passage")
async def passage(book: str, chapter: int, verse: int | None = None, end: int | None = None):
    """KJV text for a chapter, a verse, or a verse range."""
    chapters = BIBLE.get(book)
    if chapters is None or not 1 <= chapter <= len(chapters):
        raise HTTPException(404, "No such chapter")
    verses = chapters[chapter - 1]
    first = verse or 1
    last = min(end or verse or len(verses), len(verses))
    if not 1 <= first <= last:
        raise HTTPException(404, "No such verse")
    return {
        "translation": "KJV",
        "verses": [{"verse": n, "text": verses[n - 1]} for n in range(first, last + 1)],
    }


def run_transcriber(audio_q: queue.Queue, emit) -> None:
    """Owns one session's Transcriber + Stream; all native calls stay on this thread."""
    transcriber = Transcriber(
        model_path=config["model_path"], model_arch=config["model_arch"]
    )
    stream = transcriber.create_stream(update_interval=config["update_interval"])

    def on_event(event):
        if isinstance(event, Error):
            emit({"type": "error", "message": str(event.error)})
        elif isinstance(event, LineCompleted):
            text = event.line.text.strip()
            if text:
                emit(
                    {
                        "type": "final",
                        "id": event.line.line_id,
                        "text": text,
                        "start": round(event.line.start_time, 2),
                        "duration": round(event.line.duration, 2),
                    }
                )
        elif isinstance(event, LineTextChanged) and not event.line.is_complete:
            emit({"type": "partial", "id": event.line.line_id, "text": event.line.text})

    stream.add_listener(on_event)
    try:
        stream.start()
        emit({"type": "ready"})
        while True:
            item = audio_q.get()
            if item is STOP:
                stream.stop()  # transcribes any remaining audio and fires final events
                emit({"type": "done"})
                return
            # If transcription fell behind, hand over everything queued so far
            # in one call rather than one 100 ms chunk at a time.
            samples, sample_rate = item
            while not audio_q.empty() and audio_q.queue[0] is not STOP:
                samples = samples + audio_q.get_nowait()[0]
            stream.add_audio(samples, sample_rate)
    finally:
        stream.close()
        transcriber.close()


@app.websocket("/ws")
async def ws_transcribe(ws: WebSocket):
    await ws.accept()
    if session_slots.locked():
        await ws.send_json({"type": "error", "message": "Server busy, try again later."})
        await ws.close()
        return

    async with session_slots:
        loop = asyncio.get_running_loop()
        out_q: asyncio.Queue = asyncio.Queue()
        audio_q: queue.Queue = queue.Queue()

        def emit(msg):  # called from the transcriber thread
            loop.call_soon_threadsafe(out_q.put_nowait, msg)

        async def sender():
            while True:
                msg = await out_q.get()
                await ws.send_text(json.dumps(msg))
                if msg["type"] == "done":
                    return

        sample_rate = None
        worker = None
        stop_requested = False
        n_samples = 0  # audio received this session, for the "session ended" log line
        peak = 0.0
        sum_sq = 0.0
        send_task = asyncio.create_task(sender())
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    if worker is None:
                        continue  # audio before "start"; ignore
                    samples = np.frombuffer(message["bytes"], dtype=np.float32)
                    n_samples += samples.size
                    if samples.size:
                        peak = max(peak, float(np.abs(samples).max()))
                        sum_sq += float(np.dot(samples, samples))
                    audio_q.put((samples.tolist(), sample_rate))
                elif message.get("text") is not None:
                    cmd = json.loads(message["text"])
                    if cmd.get("type") == "start" and worker is None:
                        sample_rate = int(cmd.get("sampleRate", 16000))
                        log.info("session started (client rate %d Hz)", sample_rate)
                        worker = threading.Thread(
                            target=run_transcriber, args=(audio_q, emit), daemon=True
                        )
                        worker.start()
                    elif cmd.get("type") == "stop":
                        stop_requested = True
                        break
            if worker is not None and stop_requested:
                audio_q.put(STOP)
                # Wait for the flush so the last words reach the client.
                await asyncio.wait_for(send_task, timeout=30)
        except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
            pass
        finally:
            if worker is not None:
                audio_q.put(STOP)
                await asyncio.to_thread(worker.join, 30)
            send_task.cancel()
            rms = (sum_sq / n_samples) ** 0.5 if n_samples else 0.0
            log.info(
                "session ended: %.1fs audio received, peak %.3f, rms %.4f",
                n_samples / (sample_rate or 16000), peak, rms,
            )
            try:
                await ws.close()
            except (RuntimeError, WebSocketDisconnect):
                pass  # already closed by the client


def lan_addresses() -> list[str]:
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except socket.gaierror:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--model", choices=MODELS, default="medium")
    parser.add_argument(
        "--update-interval",
        type=float,
        default=0.3,
        help="seconds of audio between partial-transcript updates (lower = snappier, more CPU)",
    )
    parser.add_argument(
        "--max-sessions",
        type=int,
        default=4,
        help="concurrent talkers; lag grows with each (4 on medium ~5s, on small ~1.5s)",
    )
    parser.add_argument("--cert", default="certs/cert.pem")
    parser.add_argument("--key", default="certs/key.pem")
    parser.add_argument(
        "--no-tls", action="store_true", help="serve plain HTTP behind a TLS-terminating proxy"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    global session_slots
    session_slots = asyncio.Semaphore(args.max_sessions)

    # Downloads on first run (~260 MB for medium), then cached in ~/.cache/moonshine_voice.
    model_path, model_arch = get_model_for_language("en", MODELS[args.model])
    config.update(model_path=model_path, model_arch=model_arch, update_interval=args.update_interval)
    log.info("model: %s (%s)", args.model, model_path)

    ssl_kwargs = {}
    scheme = "http"
    if args.no_tls:
        log.info("TLS disabled: expecting a reverse proxy to terminate HTTPS")
    elif Path(args.cert).exists() and Path(args.key).exists():
        ssl_kwargs = {"ssl_certfile": args.cert, "ssl_keyfile": args.key}
        scheme = "https"
    else:
        log.warning(
            "No TLS cert found (%s). Serving plain HTTP: the microphone will only work "
            "at http://localhost. Run ./make-cert.sh to enable HTTPS for iPad/LAN use.",
            args.cert,
        )

    for addr in ["localhost", *lan_addresses()]:
        log.info("open %s://%s:%d/", scheme, addr, args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", **ssl_kwargs)


if __name__ == "__main__":
    main()
