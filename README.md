# Live Eyes

A voice-first web app that lets a blind or low-vision person point their phone at something and ask about it out loud. Gemini sees through the camera, hears the question, and answers by voice in real time.

The whole screen is one button. There is nothing to find or read: tap to start, talk, tap to stop. Sound cues and vibration tell the user what state the app is in.

## What it does

| Feature | How it works |
|---|---|
| Live conversation | The phone streams microphone audio and one camera frame per second to the Gemini Live API. Gemini answers with speech and can be interrupted. |
| "Read this" | Streamed frames are too soft for small print. Gemini calls the `read_text` tool, the app takes a sharp full-size photo, and a second Gemini model transcribes it and reports whether the photo was readable. |
| "Tell me when you see bus 42" / "tell me when I'm at the entrance" | Gemini calls the `watch_for` tool. The app checks a photo every 3 seconds in the background. It can alert as soon as the target is seen, or say when it comes into view and alert again when the user has reached it. Alerts are a chime, vibration and voice. A quiet pulse after each check tells the user the watcher is alive. |
| "Where am I?" / "Is there a pharmacy near here?" | Gemini calls the `where_am_i` tool. The app sends the phone's GPS position to the server, which asks Google Maps (Geocoding API and Places API) for the street address and the nearest places, and works out real distances in metres and compass directions. |
| Snapshot mode | Fallback at `/?mode=snapshot`: tap, one photo is described, the phone's own voice reads it out. Use it if the live connection misbehaves during the demo. |

## Files

```
server.py                 Flask server: token, photo analysis and location endpoints, static files
frontend/prompt.js        System prompt, voice and tool declarations. Tune this first.
frontend/app.js           Screen, camera, sound cues, tools, watcher, reconnects
frontend/live-client.js   WebSocket client for the Gemini Live API
frontend/index.html       The one-button screen
frontend/mediaUtils.js    Microphone capture and audio playback (Google's example, unchanged)
frontend/audio-processors Audio worklets (Google's example, unchanged)
Dockerfile                For Cloud Run
```

## Run it on your laptop (5 minutes)

1. Create an API key at https://aistudio.google.com/apikey. When asked for a project, pick the Google Cloud project that holds your hackathon credits.
2. In this folder:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then paste your key into .env
python server.py
```

3. Open http://localhost:8080 in Chrome, click anywhere, and allow the camera and microphone.

Camera access works on `localhost`, but a phone needs HTTPS. That is what the Cloud Run step gives you.

## Put it on a phone with Cloud Run

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy live-eyes \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY
```

The command prints an `https://...run.app` address. Open it on the phone (Chrome on Android, Safari on iPhone). Re-run the same command to deploy a change.

### Turn on "where am I" (Google Maps)

The location tool needs a Google Maps Platform key. In Cloud Shell, in the same project:

```bash
gcloud services enable geocoding-backend.googleapis.com places.googleapis.com apikeys.googleapis.com

MAPS_KEY=$(gcloud services api-keys create --display-name="live-eyes-maps" \
  --api-target=service=geocoding-backend.googleapis.com \
  --api-target=service=places.googleapis.com \
  --format="value(response.keyString)")
echo $MAPS_KEY

gcloud run services update live-eyes --region us-central1 --update-env-vars MAPS_API_KEY=$MAPS_KEY
```

`/api/health` should then show `"has_maps_key": true`. A new key can take a few minutes to start working. Without the key the rest of the app works and the assistant says the location lookup is not set up.

Anyone with the address can use your credits, so delete the service after the hackathon:
`gcloud run services delete live-eyes --region us-central1`

## If it does not connect

Do this check in the first hour. The app has been tested against a simulated Gemini connection, not the real one, so the first real run is the one that matters.

1. Open `https://YOUR-URL/api/health`. It should say `"has_api_key": true`.
2. Tap start. If the screen shows an error, the reason is printed in brackets under it and in the browser console.
3. Model not found: set a different model without changing code, for example `--set-env-vars GEMINI_API_KEY=...,LIVE_MODEL=gemini-3.1-flash-live-preview`. The current names are listed at https://ai.google.dev/gemini-api/docs/live-api/capabilities.
4. Still stuck after 20 minutes: demo with `/?mode=snapshot`, which only needs the ordinary Gemini API.

## Things to tune

| What | Where |
|---|---|
| How the assistant talks, what it refuses to do | `SYSTEM_PROMPT` in `frontend/prompt.js` |
| Voice | `VOICE_NAME` in `frontend/prompt.js` |
| How long it waits after you stop talking | comment in `_setupMessage()` in `frontend/live-client.js` |
| Watcher speed and time limit | constants at the top of `frontend/app.js` |
| Watcher model (use a lighter one if you hit rate limits) | `WATCH_MODEL` environment variable, e.g. `--update-env-vars WATCH_MODEL=gemini-3.5-flash-lite` |
| What the photo reader and watcher are told | the three prompts in `server.py` |

Test with your eyes closed and earbuds in. Write down every moment you were unsure what the app was doing: each one is a missing sound cue or a prompt fix.

## How it meets the track requirements

- **Gemini is central, not a chatbot.** Real-time audio and video understanding through the Live API, function calling to trigger app actions, and a second Gemini model returning structured JSON that the app acts on.
- **Clear social problem.** Independent access to visual information for blind and low-vision people: reading labels and letters, finding things, knowing when the right bus arrives.
- **Other Google tools.** Deployed on Cloud Run (built by Cloud Build, stored in Artifact Registry), Google Maps Platform (Geocoding and Places) for location, prototyped in Google AI Studio.
- **Cloud credits.** Cloud Run runs on the credits. The API key belongs to the same project, so Gemini usage is billed there too.
- **Working demo.** See below.

## Two-minute demo

1. Start with the phone face down. "A blind person cannot use an app they have to look at. So ours has one button: the whole screen."
2. Tap. Rising tones play and Gemini says it is ready.
3. Hold up a medicine box: "What is this, and when does it expire?" It takes a sharp photo (you hear the shutter) and reads the label.
4. "Tell me when you see a red mug." Pan the phone slowly across the table. Chime, vibration, then the voice says where the mug is.
5. Interrupt it mid-sentence to show it listens while it talks.
6. Close with the limits you chose on purpose: it will not tell anyone it is safe to cross a road, and it says so when it cannot read something.

Use earbuds with a microphone on stage. Venue noise and speaker echo are the most common reasons a voice demo fails. Record a backup video once it works.

## Known limits

- Distances are rough bands ("a few steps away"), never numbers: one camera cannot measure distance.
- The yellow chip at the top shows what the watcher is doing ("not in view, 7 checks" or the error it hit). Check it first when the watcher seems stuck.
- One frame per second and about a second of delay: fine for reading and finding, not for moving traffic. The prompt forbids safety calls on crossings.
- Location gives compass directions ("80 metres to the north-east"), not "on your left": the app does not know which way the user is facing. GPS is weak indoors.
- The GPS position stays on the phone until the user asks a location question; then it goes to our server and Google Maps for that one lookup and is not stored.
- A tap anywhere stops the session, which can happen by accident. A native app could use a hardware button instead.
- The token and photo endpoints have no login or rate limit. Fine for a demo, not for a public launch.
- Tested in desktop Chrome with a fake camera and microphone. Firefox is not supported by the audio capture code.

## Credits

`mediaUtils.js` and `audio-processors/` are copied unchanged from Google's official example, and `live-client.js` is adapted from the same example: https://github.com/google-gemini/gemini-live-api-examples.
