/**
 * Live Eyes - app logic.
 *
 * The whole screen is one button. Tap to start, talk, tap to stop.
 * Everything the user needs to know is delivered by sound: Gemini's voice,
 * short audio cues for each state change, and vibration where the phone
 * supports it.
 *
 * Files:
 *   prompt.js       system prompt, voice, tool declarations (tune these)
 *   live-client.js  WebSocket client for the Gemini Live API
 *   mediaUtils.js   microphone capture and audio playback (from Google's example)
 *   app.js          this file: screen, camera, sound cues, tools, reconnects
 */

// ---- settings you may want to tune -------------------------------------------

const FRAME_INTERVAL_MS = 1000; // Live API reads at most 1 frame per second
const FRAME_MAX_SIDE = 768; //     size of the streamed frames (docs recommend 768)
const PHOTO_MAX_SIDE = 2048; //    size of the sharp photo used by read_text
const WATCH_INTERVAL_MS = 3000; // pause between background watcher checks
const WATCH_MAX_INTERVAL_MS = 12000; // slowest it gets when the API rate-limits us
const WATCH_TIMEOUT_MS = 5 * 60 * 1000;
const WATCH_MAX_FAILURES = 4; //   failed checks in a row before the watcher gives up
const MAX_RECONNECT_TRIES = 3;

// ---- state -------------------------------------------------------------------

const el = {
  body: document.body,
  main: document.getElementById("main"),
  label: document.getElementById("label"),
  sub: document.getElementById("sub"),
  status: document.getElementById("status"),
  captions: document.getElementById("captions"),
  watching: document.getElementById("watching"),
  preview: document.getElementById("preview"),
  modeLink: document.getElementById("modeLink"),
};

const SNAPSHOT_MODE = new URLSearchParams(location.search).get("mode") === "snapshot";

const S = {
  phase: "idle", //        idle | connecting | live
  client: null,
  mic: null,
  player: null,
  frameTimer: null,
  tickTimer: null,
  watch: null, //          the running watcher, see startWatch()
  reconnecting: false,
  wakeLock: null,
  geoWatch: null, //       id of the GPS watcher
  position: null, //       latest GPS fix: { lat, lng, accuracy, at }
  positionError: null,
  busy: false, //          snapshot mode: a description is in progress
};

// ---- camera ------------------------------------------------------------------

class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.canvas = document.createElement("canvas");
  }

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" }, // rear camera
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /** Current frame as base64 JPEG, scaled so the longer side is at most maxSide. */
  frame(maxSide, quality = 0.8) {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!this.stream || !w || !h) return null;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.canvas.getContext("2d").drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL("image/jpeg", quality).split(",")[1];
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

const camera = new Camera(el.preview);

// ---- feedback the user can hear and feel -------------------------------------

// Each cue is a list of [frequency in Hz, length in seconds].
const CUES = {
  start: [[440, 0.09], [660, 0.12]], //               rising: working on it
  ready: [[523, 0.09], [659, 0.09], [784, 0.18]], //  three rising notes: go ahead
  stop: [[660, 0.09], [440, 0.16]], //                falling: stopped
  shutter: [[1200, 0.03], [900, 0.05]], //            photo taken
  tick: [[880, 0.035]], //                            still working
  pulse: [[520, 0.03]], //                            watcher checked, nothing yet
  seen: [[784, 0.08], [988, 0.12]], //                watcher: target came into view
  found: [[988, 0.1], [1319, 0.1], [988, 0.1], [1319, 0.2]], // watcher alert
  error: [[220, 0.18], [165, 0.32]], //               low: something went wrong
};

function cue(name) {
  const ctx = S.player && S.player.audioContext;
  if (!ctx) return;
  const volume = name === "tick" || name === "pulse" ? 0.06 : 0.22;
  let t = ctx.currentTime + 0.01;
  for (const [freq, length] of CUES[name]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + length + 0.02);
    t += length + 0.03;
  }
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern); // Android only; iOS ignores it
}

function startTicks() {
  stopTicks();
  S.tickTimer = setInterval(() => cue("tick"), 700);
}

function stopTicks() {
  clearInterval(S.tickTimer);
  S.tickTimer = null;
}

/** Speak with the phone's own voice. Used when Gemini's voice is not available. */
function speak(text) {
  try {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || "en-US";
    speechSynthesis.speak(utterance);
  } catch (_) {
    /* no speech synthesis on this browser */
  }
}

// ---- screen ------------------------------------------------------------------

const IDLE_HINT = SNAPSHOT_MODE
  ? "Tap anywhere, then tap again each time you want a description."
  : "Tap anywhere to start. Then just ask what you want to know.";

function setPhase(phase, errorText) {
  S.phase = phase;
  el.body.dataset.phase = phase;
  if (errorText) el.body.dataset.error = "1";
  else delete el.body.dataset.error;

  if (phase === "idle") {
    el.label.textContent = SNAPSHOT_MODE ? "Describe" : "Start";
    el.sub.textContent = errorText || IDLE_HINT;
  } else if (phase === "connecting") {
    el.label.textContent = "Connecting";
    el.sub.textContent = "Tap anywhere to cancel.";
  } else {
    setActivity("listening");
  }
}

function setActivity(activity) {
  if (S.phase !== "live") return;
  el.body.dataset.activity = activity;
  if (SNAPSHOT_MODE) {
    el.label.textContent = activity === "thinking" ? "Looking" : "Describe";
    el.sub.textContent = "Tap anywhere for a description.";
    return;
  }
  el.label.textContent = { listening: "Listening", speaking: "Speaking", thinking: "Looking" }[activity];
  el.sub.textContent = "Tap anywhere to stop.";
}

/** Message for screen readers (and nothing else). */
function announce(text) {
  el.status.textContent = "";
  setTimeout(() => (el.status.textContent = text), 50);
}

function caption(who, text) {
  const last = el.captions.lastElementChild;
  if (last && last.className === who) {
    last.textContent += text;
  } else {
    const p = document.createElement("p");
    p.className = who;
    p.textContent = text;
    el.captions.appendChild(p);
  }
  while (el.captions.children.length > 4) el.captions.firstElementChild.remove();
}

function showWatching(target, note) {
  el.watching.hidden = !target;
  el.watching.textContent = target ? `Watching for: ${target}${note ? ` · ${note}` : ""}` : "";
}

// ---- server calls ------------------------------------------------------------

async function fetchToken() {
  const res = await fetch("/api/token", { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Token request failed (${res.status})`);
  return data; // { token, model }
}

/** POST JSON to our server and return the JSON reply. Throws with the server's error text. */
async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Server error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Send one photo to /api/look. task is "read", "watch" or "describe". */
const look = (body) => fetchJson("/api/look", body);

// ---- tools Gemini can call ---------------------------------------------------

const TOOLS = {
  // Streamed frames are small and soft. For small print we take one sharp,
  // full-size photo and have a second Gemini model transcribe it.
  async read_text({ focus }) {
    const image = camera.frame(PHOTO_MAX_SIDE, 0.9);
    if (!image) throw new Error("The camera is not ready yet");
    cue("shutter");
    vibrate(30);
    return look({ task: "read", image, focus }); // { text, readable, advice }
  },

  async watch_for({ target, alert_when }) {
    const mode = alert_when === "close" ? "close" : "visible";
    startWatch(target, mode);
    return { status: "watching", target, alert_when: mode };
  },

  async stop_watching() {
    const wasWatching = !!S.watch;
    stopWatch();
    return { status: wasWatching ? "stopped" : "nothing was being watched" };
  },

  // GPS position -> street address and nearby places from Google Maps.
  async where_am_i({ looking_for }) {
    const position = await currentPosition();
    return fetchJson("/api/where", {
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracy,
      looking_for,
      lang: navigator.language || "en",
    }); // { address, street, area, accuracy_m, places: [{ name, type, distance_m, direction }] }
  },
};

// ---- location ----------------------------------------------------------------
// We start following the GPS when the session starts. That way the permission
// question appears together with camera and microphone (not silently in the
// middle of a conversation), and a fresh position is ready when Gemini asks.
// The position stays on the phone until the user asks a location question.

function startLocation() {
  if (!navigator.geolocation || S.geoWatch !== null) return;
  S.positionError = null;
  S.geoWatch = navigator.geolocation.watchPosition(
    (pos) => {
      S.position = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Date.now(),
      };
      S.positionError = null;
    },
    (err) => {
      S.positionError = err;
      console.warn("Location error", err.message);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function stopLocation() {
  if (S.geoWatch !== null) navigator.geolocation.clearWatch(S.geoWatch);
  S.geoWatch = null;
  S.position = null;
}

/** The latest GPS fix, waiting up to 8 seconds for one if we have none yet. */
async function currentPosition() {
  if (!navigator.geolocation) throw new Error("This phone or browser does not provide location.");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (S.position && Date.now() - S.position.at < 30000) return S.position;
    if (S.positionError && S.positionError.code === 1) break; // permission denied
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (S.positionError && S.positionError.code === 1) {
    throw new Error("Location permission is turned off for this site. The user has to allow location in the browser settings.");
  }
  if (S.position) return S.position; // older than 30 s, but better than nothing
  throw new Error("Could not get a GPS position. It works best outdoors or near a window.");
}

async function handleToolCalls(functionCalls) {
  setActivity("thinking");
  startTicks();
  const client = S.client;
  const functionResponses = await Promise.all(
    functionCalls.map(async (call) => {
      try {
        const tool = TOOLS[call.name];
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        return { id: call.id, name: call.name, response: { result: await tool(call.args || {}) } };
      } catch (err) {
        console.warn("Tool failed", call.name, err);
        return { id: call.id, name: call.name, response: { error: String(err.message || err) } };
      }
    })
  );
  stopTicks();
  if (S.client === client && S.phase === "live") {
    client.sendToolResponse(functionResponses);
    setActivity("listening");
  }
}

// ---- background watcher ("tell me when you see bus 42") ----------------------

// mode "visible": alert as soon as the target can be seen.
// mode "close":   say once when it comes into view, alert when the user reaches it.
function startWatch(target, mode = "visible") {
  stopWatch();
  const watch = {
    target,
    mode,
    startedAt: Date.now(),
    timer: null,
    interval: WATCH_INTERVAL_MS,
    checks: 0,
    failures: 0, //       failed checks in a row
    announcedSeen: false,
  };
  S.watch = watch;
  showWatching(target, "starting");

  const tell = (text) => S.client && S.client.sendText(text);

  const check = async () => {
    if (S.watch !== watch) return; // stopped or replaced

    if (Date.now() - watch.startedAt > WATCH_TIMEOUT_MS) {
      stopWatch();
      tell(`[App] The watcher stopped after five minutes without finding "${target}". Tell the user and ask if they want to keep watching.`);
      return;
    }

    try {
      const image = camera.frame(1024, 0.8);
      if (image) {
        const result = await look({ task: "watch", image, target }); // { visible, close, detail }
        if (S.watch !== watch) return;
        watch.checks += 1;
        watch.failures = 0;

        const reached = mode === "close" ? result.visible && result.close : result.visible;
        if (reached) {
          stopWatch();
          cue("found"); // the alert does not wait for the voice
          vibrate([200, 100, 200]);
          tell(
            mode === "close"
              ? `[App] The watcher says the user has reached "${target}". ${result.detail} Tell the user right now in one short sentence.`
              : `[App] The watcher just found "${target}". ${result.detail} Tell the user right now in one short sentence.`
          );
          return;
        }

        if (mode === "close" && result.visible && !watch.announcedSeen) {
          watch.announcedSeen = true;
          cue("seen");
          vibrate(80);
          tell(`[App] The watcher can now see "${target}" but the user has not reached it yet. ${result.detail} Tell the user in one short sentence where it is, and that you will say when they reach it.`);
        } else {
          cue("pulse"); // quiet heartbeat: the watcher is alive
        }
        showWatching(target, `${result.visible ? "in view" : "not in view"}, ${watch.checks} checks`);
      }
    } catch (err) {
      if (S.watch !== watch) return;
      console.warn("Watcher check failed", err);
      watch.failures += 1;
      showWatching(target, `error: ${err.message}`.slice(0, 80));

      if (err.status === 429) {
        // Rate limited: keep going, but check less often.
        watch.interval = Math.min(watch.interval * 2, WATCH_MAX_INTERVAL_MS);
      }
      if (watch.failures >= WATCH_MAX_FAILURES) {
        stopWatch();
        cue("error");
        tell(
          err.status === 429
            ? `[App] The watcher had to stop because the service is rate limiting requests. Tell the user it stopped and that they can ask again in a minute.`
            : `[App] The watcher stopped because of a technical error. Tell the user it stopped and that they can ask you to start it again.`
        );
        return;
      }
    }
    watch.timer = setTimeout(check, watch.interval);
  };

  check();
}

function stopWatch() {
  if (S.watch) clearTimeout(S.watch.timer);
  S.watch = null;
  showWatching(null);
}

// ---- live session ------------------------------------------------------------

async function start() {
  setPhase("connecting");
  announce("Connecting");

  const client = new LiveClient({
    model: "", // filled in below: the server decides which model we use
    systemInstruction: SYSTEM_PROMPT,
    tools: TOOL_DECLARATIONS,
    voice: VOICE_NAME,
  });
  S.client = client;
  // True if the user tapped stop while we were still setting up.
  const cancelled = () => S.client !== client;

  try {
    // Create the audio output first, while we are still inside the tap.
    // Browsers only allow sound to start from a user gesture.
    if (!S.player) S.player = new AudioPlayer();
    await S.player.init();
    cue("start");

    client.onAudio = (base64) => {
      setActivity("speaking");
      S.player.play(base64);
    };
    client.onInterrupted = () => S.player.interrupt(); // user spoke over Gemini
    client.onTurnComplete = () => setActivity("listening");
    client.onInputTranscript = (text) => caption("you", text);
    client.onOutputTranscript = (text) => caption("eyes", text);
    client.onToolCall = handleToolCalls;
    client.onGoAway = () => reconnect(); // server is about to close this connection
    client.onClose = () => reconnect(); //  connection dropped

    // Ask for microphone and camera. The mic only sends once
    // client.connected becomes true.
    const mic = new AudioStreamer(client);
    S.mic = mic;
    await mic.start();
    if (cancelled()) return mic.stop();
    await camera.start();
    if (cancelled()) return camera.stop();

    const { token, model } = await fetchToken();
    if (cancelled()) return;
    client.model = model;
    await client.connect(token);
    if (cancelled()) return;

    setPhase("live");
    announce("Connected. Listening.");
    cue("ready");
    vibrate(60);
    keepScreenOn();
    startLocation();

    S.frameTimer = setInterval(() => {
      const frame = camera.frame(FRAME_MAX_SIDE, 0.7);
      if (frame) client.sendImageMessage(frame);
    }, FRAME_INTERVAL_MS);

    client.sendText(GREETING_PROMPT);
  } catch (err) {
    if (!cancelled()) fail(err);
  }
}

/** Open a fresh connection and continue the same conversation. */
async function reconnect() {
  if (S.reconnecting || S.phase !== "live") return;
  S.reconnecting = true;
  const client = S.client;

  for (let attempt = 1; attempt <= MAX_RECONNECT_TRIES; attempt++) {
    try {
      const { token } = await fetchToken();
      if (S.client !== client) break;
      await client.connect(token); // uses client.resumeHandle if we have one
      S.reconnecting = false;
      return;
    } catch (err) {
      console.warn(`Reconnect attempt ${attempt} failed`, err);
      client.resumeHandle = null; // the handle may have expired: start a clean session
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
    if (S.client !== client) break;
  }

  S.reconnecting = false;
  if (S.client === client) fail(new Error("Connection lost"));
}

function stop({ silent = false } = {}) {
  clearInterval(S.frameTimer);
  S.frameTimer = null;
  stopTicks();
  stopWatch();
  if (S.client) S.client.close();
  S.client = null;
  if (S.mic) S.mic.stop();
  S.mic = null;
  camera.stop();
  if (S.player) S.player.interrupt();
  stopLocation();
  if (S.wakeLock) S.wakeLock.release().catch(() => {});
  S.wakeLock = null;

  const wasRunning = S.phase !== "idle";
  setPhase("idle");
  if (wasRunning && !silent) {
    cue("stop");
    announce("Stopped");
  }
}

function fail(err) {
  console.error(err);
  let message = "Something went wrong. Tap anywhere to try again.";
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    message = "Live Eyes needs the camera and microphone. Allow them in your browser, then tap to try again.";
  } else if (err && err.name === "NotFoundError") {
    message = "No camera or microphone was found on this device.";
  } else if (err && err.message === "Connection lost") {
    message = "Connection lost. Tap anywhere to start again.";
  }
  stop({ silent: true });
  cue("error");
  vibrate([80, 60, 80, 60, 80]);
  speak(message);
  setPhase("idle", `${message}${err && err.message ? ` (${err.message})` : ""}`);
}

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator) S.wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {
    /* not supported or not allowed: the phone may dim, the session keeps running */
  }
}

// ---- snapshot mode (fallback when live streaming is not available) ------------
// Tap, one photo goes to /api/look, the answer is read out by the phone's voice.

async function snapshot() {
  if (S.busy) return;
  S.busy = true;
  try {
    if (!S.player) S.player = new AudioPlayer();
    await S.player.init();

    if (!camera.active) {
      await camera.start();
      setPhase("live");
      cue("ready");
      speak("Snapshot mode. Point the phone and tap to hear what is in front of you.");
      return;
    }

    const image = camera.frame(PHOTO_MAX_SIDE, 0.9);
    if (!image) throw new Error("The camera is not ready yet");
    cue("shutter");
    vibrate(30);
    setActivity("thinking");
    startTicks();
    const result = await look({ task: "describe", image, lang: navigator.language || "en" });
    stopTicks();
    el.captions.replaceChildren();
    caption("eyes", result.text);
    speak(result.text);
    setActivity("listening");
  } catch (err) {
    fail(err);
  } finally {
    stopTicks();
    S.busy = false;
  }
}

// ---- wiring ------------------------------------------------------------------

el.main.addEventListener("click", () => {
  if (SNAPSHOT_MODE) snapshot();
  else if (S.phase === "idle") start();
  else stop();
});

// Release the camera and microphone when the phone locks or the tab is hidden.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && S.phase !== "idle") stop({ silent: true });
});

if (SNAPSHOT_MODE) {
  el.modeLink.textContent = "Live mode";
  el.modeLink.href = location.pathname;
}
setPhase("idle");
