// Browser side: microphone -> AudioWorklet -> WebSocket -> live transcript.

const micButton = document.getElementById("mic");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const levelEl = document.getElementById("level");
const verseListEl = document.getElementById("verse-list");
const scriptureEl = document.getElementById("scripture");
const timerEl = document.getElementById("timer");
const jumpLiveEl = document.getElementById("jump-live");

let session = null; // { ws, ctx, media, source, node }
const lineEls = new Map(); // line id -> <p>
const verseEls = new Map(); // "John 3:16" -> <li>
const versePlaceholder = verseListEl.querySelector(".placeholder");
let shownRef = null; // reference currently in the scripture panel
let passageRequest = 0; // bumped per showPassage() so stale fetches are dropped
const verseTracker = new VerseTracker();
const passageCache = new Map(); // ref -> verses from /api/passage
let timer = null; // interval updating the elapsed-time display while recording
let wakeLock = null; // keeps phones from sleeping (and cutting the mic) mid-sermon

// Lets the detector reject verses that don't exist ("John 3:45").
fetch("/api/verse-counts").then((res) => res.json()).then(setVerseCounts).catch(() => {});

function setStatus(text) {
  statusEl.textContent = text;
}

function lineElement(id) {
  let el = lineEls.get(id);
  if (!el) {
    transcriptEl.querySelector(".placeholder")?.remove();
    el = document.createElement("p");
    transcriptEl.appendChild(el);
    lineEls.set(id, el);
  }
  return el;
}

// Follows the live text unless the reader has scrolled up to look at something;
// then a "Live" button offers the way back.
function nearBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;
}

function scrollToLive() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  jumpLiveEl.hidden = true;
}

function showLine(id, text, isFinal) {
  const follow = nearBottom();
  const el = lineElement(id);
  el.textContent = text;
  el.className = isFinal ? "final" : "partial";
  if (follow) scrollToLive();
  else jumpLiveEl.hidden = false;
}

transcriptEl.addEventListener("scroll", () => {
  if (nearBottom()) jumpLiveEl.hidden = true;
});
jumpLiveEl.addEventListener("click", scrollToLive);

function setRecording(on) {
  document.body.classList.toggle("recording", on);
  micButton.querySelector(".label").textContent = on ? "Stop" : "Start";
  micButton.setAttribute("aria-label", on ? "Stop recording" : "Start recording");
  clearInterval(timer);
  if (on) {
    const started = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      const h = Math.floor(s / 3600);
      const mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, "0");
      timerEl.textContent = (h ? h + ":" : "") + mm + ":" + String(s % 60).padStart(2, "0");
    };
    tick();
    timer = setInterval(tick, 1000);
    keepAwake();
  } else {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
}

async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported or refused (e.g. low battery); recording still works.
  }
}

// The browser drops the wake lock when the page is hidden; take it back on return.
document.addEventListener("visibilitychange", () => {
  if (session && document.visibilityState === "visible") keepAwake();
});

function handleMessage(msg) {
  switch (msg.type) {
    case "ready":
      setStatus("Listening…");
      break;
    case "partial": {
      showLine(msg.id, msg.text, false);
      // Show a reference while it's still being spoken; it's listed once the line ends.
      const spoken = verseTracker.peek(msg.text).at(-1);
      if (spoken && spoken.ref !== shownRef) showPassage(spoken);
      break;
    }
    case "final":
      showLine(msg.id, msg.text, true);
      verseTracker.addFinal(msg.text, msg.start, msg.duration).forEach(addVerse);
      break;
    case "done":
      // Drop partials that never completed (e.g. a cough that produced no text).
      for (const [id, el] of lineEls) {
        if (el.classList.contains("partial") && !el.textContent.trim()) {
          el.remove();
          lineEls.delete(id);
        }
      }
      session?.ws.close();
      break;
    case "error":
      setStatus("Error: " + msg.message);
      break;
  }
}

// Puts a spoken reference at the top of the sidebar (moving it up if it was
// mentioned before) and shows its text in the scripture panel.
// If the reference grew from a shorter one in the same breath ("Genesis 3" ->
// "Genesis 3:16"), the shorter entry is dropped unless it was also said elsewhere.
function addVerse(v) {
  versePlaceholder.remove();
  const shorter = v.replaces && verseEls.get(v.replaces);
  if (shorter && --shorter.dataset.count <= 0) {
    shorter.remove();
    verseEls.delete(v.replaces);
  }
  let li = verseEls.get(v.ref);
  if (!li) {
    li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "ref";
    button.append(v.ref, Object.assign(document.createElement("span"), { className: "time" }));
    button.addEventListener("click", () => showPassage(v));
    const link = Object.assign(document.createElement("a"), {
      className: "out", href: v.url, target: "_blank", rel: "noopener",
      title: "Read in NKJV", textContent: "\u2197",
    });
    li.append(button, link);
    li.dataset.count = 0;
    verseEls.set(v.ref, li);
  }
  li.dataset.count++;
  li.querySelector(".time").textContent =
    new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  li.classList.remove("fresh");
  void li.offsetWidth; // restart the highlight animation
  li.classList.add("fresh");
  verseListEl.prepend(li);
  verseListEl.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  showPassage(v);
}

async function showPassage(v) {
  const alreadyShown = shownRef === v.ref && passageCache.has(v.ref);
  shownRef = v.ref;
  for (const [ref, li] of verseEls) li.classList.toggle("current", ref === v.ref);
  scriptureEl.hidden = false;
  document.getElementById("scripture-ref").textContent = v.ref;
  document.getElementById("scripture-link").href = v.url;
  const textEl = document.getElementById("scripture-text");
  if (alreadyShown) return;
  textEl.textContent = "";
  const request = ++passageRequest;

  const params = new URLSearchParams({ book: v.book, chapter: v.chapter });
  if (v.verse !== null) params.set("verse", v.verse);
  if (v.verseEnd !== null) params.set("end", v.verseEnd);
  try {
    let verses = passageCache.get(v.ref);
    if (!verses) {
      const res = await fetch("/api/passage?" + params);
      if (!res.ok) throw new Error(res.status);
      ({ verses } = await res.json());
      passageCache.set(v.ref, verses);
    }
    if (request !== passageRequest) return; // superseded while loading
    for (const { verse, text } of verses) {
      textEl.append(Object.assign(document.createElement("sup"), { textContent: verse }), text + " ");
    }
  } catch {
    if (request !== passageRequest) return;
    textEl.innerHTML = '<span class="error">Verse text not found. Use the NKJV link instead.</span>';
  }
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Microphone blocked: open this page over HTTPS (or on localhost).");
    return;
  }
  micButton.disabled = true;
  setStatus("Requesting microphone…");
  verseTracker.reset(); // line times restart at 0 in each session

  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setStatus("Microphone permission denied: " + err.message);
    micButton.disabled = false;
    return;
  }

  // Created inside the click handler so iOS Safari allows audio to start.
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
  await ctx.resume();
  const source = ctx.createMediaStreamSource(media);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  const mute = ctx.createGain();
  mute.gain.value = 0; // keeps the graph pulling audio without playing it back
  source.connect(node).connect(mute).connect(ctx.destination);

  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  // Keep source referenced: Safari/Firefox can garbage-collect it and silently stop the audio.
  session = { ws, ctx, media, source, node };

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "start", sampleRate: ctx.sampleRate }));
    setStatus("Loading model…");
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    teardownAudio();
    session = null;
    setRecording(false);
    micButton.disabled = false;
    if (!statusEl.textContent.startsWith("Error")) setStatus("Idle");
  };
  ws.onerror = () => setStatus("Error: connection to server failed");

  node.port.onmessage = (e) => {
    const samples = e.data;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    levelEl.style.width = Math.min(100, Math.sqrt(sum / samples.length) * 400) + "%";
    if (ws.readyState === WebSocket.OPEN) ws.send(samples.buffer);
  };

  setRecording(true);
  micButton.disabled = false;
}

function teardownAudio() {
  if (!session) return;
  session.node.port.onmessage = null;
  session.media.getTracks().forEach((t) => t.stop());
  session.ctx.close();
  levelEl.style.width = "0";
}

function stop() {
  if (!session) return;
  teardownAudio();
  micButton.disabled = true;
  setStatus("Finishing…");
  // The server flushes the last words, replies "done", and then we close.
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "stop" }));
  } else {
    session.ws.close();
  }
}

micButton.addEventListener("click", () => (session ? stop() : start()));

document.getElementById("clear").addEventListener("click", () => {
  if (lineEls.size && !confirm("Clear the transcript?")) return;
  lineEls.clear();
  transcriptEl.innerHTML = "";
  jumpLiveEl.hidden = true;
});

document.getElementById("scripture-close").addEventListener("click", () => {
  scriptureEl.hidden = true;
  shownRef = null;
  for (const li of verseEls.values()) li.classList.remove("current");
});

document.getElementById("clear-verses").addEventListener("click", () => {
  verseEls.clear();
  verseListEl.replaceChildren(versePlaceholder);
  scriptureEl.hidden = true;
  shownRef = null;
  verseTracker.reset();
});

document.getElementById("copy").addEventListener("click", async () => {
  const text = [...transcriptEl.querySelectorAll("p.final")].map((p) => p.textContent).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied");
  } catch {
    setStatus("Copy failed");
  }
});
