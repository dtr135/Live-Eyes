/**
 * LiveClient - a small WebSocket client for the Gemini Live API.
 *
 * Adapted from geminilive.js in Google's official example
 * (github.com/google-gemini/gemini-live-api-examples). What we added:
 *   - context window compression, so camera sessions are not cut off after 2 minutes
 *   - session resumption, so we can reconnect without losing the conversation
 *   - GoAway handling (the server warns us before it closes a connection)
 *   - connect() returns a promise, which makes reconnect logic simple
 *
 * The browser talks to Gemini directly. Our server only hands out a
 * short-lived token (see server.py).
 */

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

class LiveClient {
  constructor({ model, systemInstruction, tools = [], voice = "Kore" }) {
    this.model = model;
    this.systemInstruction = systemInstruction;
    this.tools = tools;
    this.voice = voice;

    this.ws = null;
    this._abortConnect = null; // rejects a connect() that is still in progress
    this.connected = false; // true only once Gemini has accepted our setup
    this.resumeHandle = null; // lets a new connection continue the same session

    // The app overrides these.
    this.onAudio = (base64Pcm) => {};
    this.onInputTranscript = (text) => {};
    this.onOutputTranscript = (text) => {};
    this.onInterrupted = () => {};
    this.onTurnComplete = () => {};
    this.onToolCall = (functionCalls) => {};
    this.onGoAway = (timeLeft) => {};
    this.onClose = (event) => {}; // only fires for unexpected closes
  }

  /**
   * Open a connection. Resolves when Gemini has accepted the setup message,
   * rejects if the socket closes or nothing happens within 12 seconds.
   * Calling it again replaces the current connection (used for reconnects).
   */
  connect(token) {
    this._dropSocket();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_ENDPOINT}?access_token=${token}`);
      this.ws = ws;
      let settled = false;

      const giveUp = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(reason));
      };
      const timer = setTimeout(() => {
        giveUp("Timed out connecting to Gemini");
        if (this.ws === ws) this._dropSocket();
      }, 12000);
      this._abortConnect = () => giveUp("Connection cancelled");

      ws.onopen = () => ws.send(JSON.stringify(this._setupMessage()));

      ws.onmessage = async (event) => {
        if (this.ws !== ws) return; // message from a connection we already replaced
        let data;
        try {
          data = JSON.parse(await this._readText(event.data));
        } catch (err) {
          console.warn("Could not parse message from Gemini", err);
          return;
        }
        if (data.setupComplete && !settled) {
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          resolve();
          return;
        }
        this._handle(data);
      };

      ws.onerror = (event) => console.warn("WebSocket error", event);

      ws.onclose = (event) => {
        if (this.ws !== ws) return; // we closed this one on purpose
        this.ws = null;
        this.connected = false;
        console.warn("Gemini closed the connection", event.code, event.reason);
        if (!settled) giveUp(event.reason || `Connection closed (code ${event.code})`);
        else this.onClose(event);
      };
    });
  }

  /** Close on purpose. Does not fire onClose. */
  close() {
    this._dropSocket();
    this.resumeHandle = null;
  }

  // ---- sending -------------------------------------------------------------

  /** Called by AudioStreamer (mediaUtils.js) with 16 kHz PCM chunks. */
  sendAudioMessage(base64Pcm) {
    this._send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64Pcm } } });
  }

  /** One camera frame. */
  sendImageMessage(base64Jpeg, mimeType = "image/jpeg") {
    this._send({ realtimeInput: { video: { mimeType, data: base64Jpeg } } });
  }

  /** Text into the conversation. Gemini answers it out loud. */
  sendText(text) {
    this._send({ realtimeInput: { text } });
  }

  /** Results for the function calls Gemini asked for. */
  sendToolResponse(functionResponses) {
    this._send({ toolResponse: { functionResponses } });
  }

  // ---- internals -----------------------------------------------------------

  _setupMessage() {
    const setup = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
        },
      },
      systemInstruction: { parts: [{ text: this.systemInstruction }] },
      // Captions for the screen (for judges, low-vision users and braille displays).
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Without this, a session with video ends after about 2 minutes.
      contextWindowCompression: { slidingWindow: {} },
      // Ask the server for handles we can use to continue after a reconnect.
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
    if (this.tools.length) {
      setup.tools = [{ functionDeclarations: this.tools }];
    }
    // realtimeInputConfig is left out on purpose: we use the model's default
    // voice activity detection and turn coverage. To make it wait longer
    // before answering, add for example:
    //   setup.realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: 1000 } };
    return { setup };
  }

  _handle(data) {
    if (data.toolCall?.functionCalls?.length) {
      this.onToolCall(data.toolCall.functionCalls);
    }

    if (data.sessionResumptionUpdate) {
      const { resumable, newHandle } = data.sessionResumptionUpdate;
      if (resumable && newHandle) this.resumeHandle = newHandle;
    }

    if (data.goAway) {
      this.onGoAway(data.goAway.timeLeft);
    }

    const content = data.serverContent;
    if (!content) return;

    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data) this.onAudio(part.inlineData.data);
    }
    if (content.inputTranscription?.text) this.onInputTranscript(content.inputTranscription.text);
    if (content.outputTranscription?.text) this.onOutputTranscript(content.outputTranscription.text);
    if (content.interrupted) this.onInterrupted();
    if (content.turnComplete) this.onTurnComplete();
  }

  _send(message) {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  _dropSocket() {
    const ws = this.ws;
    this.ws = null; // handlers check this, so the old socket goes quiet
    this.connected = false;
    if (this._abortConnect) this._abortConnect();
    this._abortConnect = null;
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* already closed */
      }
    }
  }

  async _readText(payload) {
    if (typeof payload === "string") return payload;
    if (payload instanceof Blob) return payload.text();
    return new TextDecoder().decode(payload);
  }
}
