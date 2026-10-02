#!/usr/bin/env python3
"""Live Eyes server.

Three jobs:
  1. Serve the web app in ./frontend
  2. POST /api/token  -> short-lived token so the browser can open a Gemini
     Live API session directly, without ever seeing the real API key
  3. POST /api/look   -> one high-resolution photo analysed by a (non-live)
     Gemini model with structured output. Used by the "read text" and
     "watch for" tools and by snapshot mode.
  4. POST /api/where  -> street address and nearby places for a GPS position,
     from Google Maps Platform. Used by the "where am I" tool.

Run locally:   python server.py     (then open http://localhost:8080)
Run on Cloud Run: see README.md
"""

import base64
import binascii
import datetime
import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from google import genai
from google.genai import types

load_dotenv()

PORT = int(os.environ.get("PORT", "8080"))
LIVE_MODEL = os.environ.get("LIVE_MODEL", "gemini-3.8-live")
VISION_MODEL = os.environ.get("VISION_MODEL", "gemini-3.8-flash")
# The watcher makes a request every few seconds. Point it at a lighter model
# (e.g. a flash-lite one) if you hit rate limits.
WATCH_MODEL = os.environ.get("WATCH_MODEL", VISION_MODEL)

# Google Maps Platform key for the "where am I" tool (Geocoding API + Places API).
MAPS_API_KEY = os.environ.get("MAPS_API_KEY", "")
GEOCODE_URL = os.environ.get("GEOCODE_URL", "https://maps.googleapis.com/maps/api/geocode/json")
PLACES_URL = os.environ.get("PLACES_URL", "https://places.googleapis.com/v1")
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # photos are ~0.5 MB; cap at 8 MB

_client = None


def gemini():
    """Create the Gemini client on first use, so the server still boots (and
    explains the problem) when the key is missing."""
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Put it in a .env file or pass it "
                "with --set-env-vars when deploying."
            )
        _client = genai.Client(api_key=key)
    return _client


# ---------------------------------------------------------------- live token --

@app.post("/api/token")
def create_token():
    """One-use token for one Live API session. The browser asks for a fresh
    one every time it connects or reconnects."""
    try:
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        token = gemini().auth_tokens.create(
            config={
                "uses": 1,
                "expire_time": now + datetime.timedelta(minutes=30),
                "new_session_expire_time": now + datetime.timedelta(minutes=1),
                "http_options": {"api_version": "v1beta"},
            }
        )
        return jsonify({"token": token.name, "model": LIVE_MODEL})
    except Exception as e:  # noqa: BLE001 - show the real reason during the hackathon
        app.logger.exception("token error")
        return jsonify({"error": str(e)}), 500


# ------------------------------------------------------------------ one look --

READ_PROMPT = """You are the reading eye for a blind person. This photo was just taken with their phone.

Transcribe every piece of readable text in the photo, exactly as written, in natural reading order. Do not summarise, translate, or correct it. Put the most prominent text first (titles, names, large numbers).
{focus}
Set "readable" to false if there is no text, or it is too blurry, dark, or small to read with confidence. Never guess at letters or digits.
In "advice", say in one short sentence how to move the phone to get a better photo (for example: text is cut off on the right, move the phone right; move further away; hold steady; more light). Leave "advice" empty if the photo is fine."""

READ_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "text": {"type": "STRING"},
        "readable": {"type": "BOOLEAN"},
        "advice": {"type": "STRING"},
    },
    "required": ["text", "readable", "advice"],
}

WATCH_PROMPT = """A blind person is walking and holding their phone with the camera pointing ahead. They asked to be alerted about this: "{target}"

Look at the photo, which was taken just now, and answer three things.

"visible": true if the target can be seen anywhere in the photo. Be practical, not strict: if something in the photo is reasonably likely to be the target, answer true. The one exception is a target that includes a specific number or words (a bus number, a name, a sign): then you must be able to actually read them in the photo.

"close": true only if the target is visible AND the person has essentially reached it: it is right in front of the camera, within about three steps, and takes up a large part of the photo. If it is further away than that, answer false.

"detail": one short sentence saying where the target is, as a clock direction from the camera's point of view (12 o'clock is straight ahead) and one of these rough distances: within arm's reach, a few steps away, across the street, far away. Never give a number of steps or metres. Leave "detail" empty if the target is not visible."""

WATCH_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "visible": {"type": "BOOLEAN"},
        "close": {"type": "BOOLEAN"},
        "detail": {"type": "STRING"},
    },
    "required": ["visible", "close", "detail"],
}

DESCRIBE_PROMPT = """Describe this photo for a blind person in at most three short sentences. It will be read aloud.
Start with anything that could be a hazard right in front of them. Then say the main thing in view. Read out any important text exactly.
Give positions as clock directions from the camera's point of view (12 o'clock is straight ahead). For distance use only rough bands (within arm's reach, a few steps away, across the room, far away), never a number of steps or metres. If the photo is too dark or blurry, say so and say how to move the phone.
Answer in this language: {lang}."""


@app.post("/api/look")
def look():
    """Analyse one photo. Body: {"task": "read" | "watch" | "describe",
    "image": "<base64 JPEG>", "target": "...", "focus": "...", "lang": "..."}"""
    body = request.get_json(silent=True) or {}
    task = body.get("task")
    model = VISION_MODEL

    try:
        image = base64.b64decode(body.get("image", ""), validate=True)
    except (binascii.Error, ValueError):
        image = b""
    if not image:
        return jsonify({"error": "image must be a base64-encoded JPEG"}), 400

    if task == "read":
        focus = str(body.get("focus") or "").strip()[:200]
        prompt = READ_PROMPT.format(
            focus=f'The person especially wants: "{focus}". Put that first.' if focus else ""
        )
        schema = READ_SCHEMA
    elif task == "watch":
        target = str(body.get("target") or "").strip()[:200]
        if not target:
            return jsonify({"error": "target is required for task=watch"}), 400
        prompt = WATCH_PROMPT.format(target=target)
        schema = WATCH_SCHEMA
        model = WATCH_MODEL
    elif task == "describe":
        prompt = DESCRIBE_PROMPT.format(lang=str(body.get("lang") or "en")[:20])
        schema = None
    else:
        return jsonify({"error": "task must be read, watch or describe"}), 400

    config = None
    if schema:
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
        )

    try:
        response = gemini().models.generate_content(
            model=model,
            contents=[
                types.Part.from_bytes(data=image, mime_type="image/jpeg"),
                prompt,
            ],
            config=config,
        )
        text = (response.text or "").strip()
        if schema:
            return jsonify(json.loads(text))
        return jsonify({"text": text})
    except Exception as e:  # noqa: BLE001
        app.logger.exception("look error")
        # Pass rate-limit errors through as 429 so the app can slow down.
        status = 429 if getattr(e, "code", None) == 429 else 502
        return jsonify({"error": str(e)}), status


# ---------------------------------------------------------------- where am I --

COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
PLACE_FIELDS = "places.displayName,places.primaryTypeDisplayName,places.shortFormattedAddress,places.location"


def _fetch_json(url, body=None, headers=None):
    """GET (or POST when body is given) and parse the JSON reply."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        # Google explains what is wrong (API not enabled, bad key) in the body.
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"Google Maps returned {e.code}: {detail}") from e


def _distance_and_direction(lat1, lng1, lat2, lng2):
    """Metres and compass direction from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlng = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    metres = 2 * 6371000 * math.asin(math.sqrt(a))
    bearing = math.degrees(
        math.atan2(math.sin(dlng) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlng))
    )
    return metres, COMPASS[round((bearing % 360) / 45) % 8]


def _reverse_geocode(lat, lng, lang):
    query = urllib.parse.urlencode({"latlng": f"{lat},{lng}", "language": lang, "key": MAPS_API_KEY})
    data = _fetch_json(f"{GEOCODE_URL}?{query}")
    if data.get("status") != "OK" or not data.get("results"):
        raise RuntimeError(f"Geocoding failed: {data.get('status')} {data.get('error_message', '')}".strip())
    best = data["results"][0]
    parts = {}
    for component in best.get("address_components", []):
        for kind in component.get("types", []):
            parts.setdefault(kind, component.get("long_name"))
    return {
        "address": best.get("formatted_address", ""),
        "street": parts.get("route", ""),
        "area": parts.get("neighborhood") or parts.get("sublocality") or parts.get("locality") or "",
    }


def _nearby_places(lat, lng, lang, looking_for):
    headers = {"X-Goog-Api-Key": MAPS_API_KEY, "X-Goog-FieldMask": PLACE_FIELDS}
    centre = {"latitude": lat, "longitude": lng}
    if looking_for:
        # A specific kind of place: the closest matches within about 1 km.
        data = _fetch_json(
            f"{PLACES_URL}/places:searchText",
            body={
                "textQuery": looking_for,
                "locationBias": {"circle": {"center": centre, "radius": 1000.0}},
                "rankPreference": "DISTANCE",
                "pageSize": 5,
                "languageCode": lang,
            },
            headers=headers,
        )
    else:
        # General "what is around me": whatever is closest, within 150 m.
        data = _fetch_json(
            f"{PLACES_URL}/places:searchNearby",
            body={
                "locationRestriction": {"circle": {"center": centre, "radius": 150.0}},
                "rankPreference": "DISTANCE",
                "maxResultCount": 8,
                "languageCode": lang,
            },
            headers=headers,
        )

    places = []
    for place in data.get("places", []):
        location = place.get("location") or {}
        if "latitude" not in location:
            continue
        metres, direction = _distance_and_direction(lat, lng, location["latitude"], location["longitude"])
        places.append(
            {
                "name": (place.get("displayName") or {}).get("text", ""),
                "type": (place.get("primaryTypeDisplayName") or {}).get("text", ""),
                "distance_m": int(round(metres, -1)) if metres >= 20 else int(round(metres)),
                "direction": direction,
                "address": place.get("shortFormattedAddress", ""),
            }
        )
    places.sort(key=lambda item: item["distance_m"])
    return places


@app.post("/api/where")
def where():
    """Street address and nearby places for a GPS position.
    Body: {"lat": 37.42, "lng": -122.08, "accuracy": 12, "looking_for": "pharmacy", "lang": "en"}"""
    if not MAPS_API_KEY:
        return jsonify({"error": "Location lookup is not set up on the server (MAPS_API_KEY is missing)."}), 503

    body = request.get_json(silent=True) or {}
    try:
        lat, lng = float(body.get("lat")), float(body.get("lng"))
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng must be valid coordinates"}), 400

    lang = str(body.get("lang") or "en")[:2]
    looking_for = str(body.get("looking_for") or "").strip()[:100]
    result = {"looking_for": looking_for, "places": []}
    try:
        result["accuracy_m"] = int(round(float(body.get("accuracy"))))
    except (TypeError, ValueError):
        pass

    # The two lookups are independent: return whichever worked.
    errors = []
    try:
        result.update(_reverse_geocode(lat, lng, lang))
    except Exception as e:  # noqa: BLE001
        app.logger.exception("geocode error")
        errors.append(str(e))
    try:
        result["places"] = _nearby_places(lat, lng, lang, looking_for)
    except Exception as e:  # noqa: BLE001
        app.logger.exception("places error")
        errors.append(str(e))

    if len(errors) == 2:
        return jsonify({"error": " | ".join(errors)}), 502
    if errors:
        result["partial_error"] = errors[0]
    return jsonify(result)


# -------------------------------------------------------------- static files --

# Cloud Run reserves /healthz for itself, so the public check lives at /api/health.
@app.get("/api/health")
@app.get("/healthz")
def healthz():
    return jsonify(
        {
            "ok": True,
            "live_model": LIVE_MODEL,
            "vision_model": VISION_MODEL,
            "watch_model": WATCH_MODEL,
            "has_api_key": bool(os.environ.get("GEMINI_API_KEY")),
            "has_maps_key": bool(MAPS_API_KEY),
        }
    )


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


@app.after_request
def no_cache(response):
    # Phones cache JavaScript aggressively. During a hackathon you want every
    # reload to pick up your latest change.
    response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    print(f"Live Eyes: http://localhost:{PORT}  (live={LIVE_MODEL}, vision={VISION_MODEL})")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
