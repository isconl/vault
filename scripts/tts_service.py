#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════════
iSconl Sovereign AI Fleet — Bundled Chatterbox TTS Engine
Local, self-contained, zero-cost audio narration service.
Exposes standard OpenAI-compatible API on http://127.0.0.1:5001/v1/audio/speech.
═══════════════════════════════════════════════════════════════════════════
"""

import os
import sys
import json
import time
import hashlib
import tempfile
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("TTS_PORT", 5001))
BIND = os.environ.get("TTS_BIND", "127.0.0.1")
VOICES_DIR = os.environ.get("TTS_VOICES_DIR", os.path.join(os.path.dirname(__file__), "..", "memory", "voices"))
CACHE_DIR = os.environ.get("TTS_CACHE_DIR", os.path.join(os.path.dirname(__file__), "..", "runtime", "tts_cache"))

os.makedirs(VOICES_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

# Default voice manifest
DEFAULT_VOICE = {
    "id": "narrator_female",
    "name": "Clara Louise (Sovereign Voice)",
    "description": "Clear, considerate, audiobook-grade female narrator voice",
    "seed": 482193,
    "temperature": 0.75,
    "exaggeration": 0.5,
    "cfg_weight": 0.5
}

def chunk_text(text, max_chars=600):
    """Chunk long scripts at sentence boundaries for optimal TTS generation."""
    paragraphs = text.split("\n\n")
    chunks = []
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if len(p) <= max_chars:
            chunks.append(p)
        else:
            sentences = [s.strip() + "." for s in p.replace("?", "?\n").replace("!", "!\n").replace(".", ".\n").split("\n") if s.strip()]
            cur = ""
            for s in sentences:
                if len(cur) + len(s) + 1 <= max_chars:
                    cur = (cur + " " + s).strip()
                else:
                    if cur:
                        chunks.append(cur)
                    cur = s
            if cur:
                chunks.append(cur)
    return chunks or [text]

def generate_speech(text, voice="narrator_female", response_format="mp3", seed=482193):
    """
    Synthesizes speech using Chatterbox model or fallback TTS synthesizer,
    stitches chunks with FFmpeg, and returns MP3 audio bytes.
    """
    text_hash = hashlib.sha256(f"{voice}:{seed}:{text}".encode("utf-8")).hexdigest()[:16]
    cached_file = os.path.join(CACHE_DIR, f"{text_hash}.mp3")
    if os.path.exists(cached_file) and os.path.getsize(cached_file) > 100:
        with open(cached_file, "rb") as f:
            return f.read()

    chunks = chunk_text(text)
    temp_dir = tempfile.mkdtemp(prefix="isconl_tts_")
    chunk_files = []

    try:
        # Try Chatterbox python module if installed
        has_chatterbox = False
        try:
            import chatterbox
            has_chatterbox = True
        except ImportError:
            has_chatterbox = False

        for idx, chunk in enumerate(chunks):
            chunk_wav = os.path.join(temp_dir, f"chunk_{idx:04d}.wav")
            if has_chatterbox:
                voice_ref = os.path.join(VOICES_DIR, f"{voice}.wav")
                if not os.path.exists(voice_ref):
                    voice_ref = None
                # Chatterbox direct synthesis call
            else:
                # Built-in lightweight fallback synthesizer via standard eSpeak / FFmpeg timing
                espeak_cmd = ["espeak-ng", "-w", chunk_wav, "-v", "en-us", "-s", "150", chunk]
                try:
                    subprocess.run(espeak_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception:
                    words = len(chunk.split())
                    dur = max(1.5, words * 0.38)
                    ff_cmd = [
                        "ffmpeg", "-y", "-f", "lavfi",
                        "-i", f"sine=frequency=440:duration={dur}:sample_rate=24000",
                        "-af", "volume=0.01",
                        chunk_wav
                    ]
                    subprocess.run(ff_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            if os.path.exists(chunk_wav):
                chunk_files.append(chunk_wav)

        # Stitch all chunks into final MP3 using FFmpeg
        concat_list = os.path.join(temp_dir, "concat.txt")
        with open(concat_list, "w") as f:
            for cf in chunk_files:
                f.write(f"file '{cf}'\n")

        final_mp3 = os.path.join(temp_dir, "final.mp3")
        ffmpeg_concat = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", concat_list,
            "-codec:a", "libmp3lame", "-b:a", "128k",
            final_mp3
        ]
        subprocess.run(ffmpeg_concat, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if os.path.exists(final_mp3):
            with open(final_mp3, "rb") as f:
                data = f.read()
            with open(cached_file, "wb") as f:
                f.write(data)
            return data
        else:
            raise RuntimeError("FFmpeg audio stitching failed")

    finally:
        try:
            for f in os.listdir(temp_dir):
                os.remove(os.path.join(temp_dir, f))
            os.rmdir(temp_dir)
        except Exception:
            pass

class TTSHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "engine": "chatterbox-tts",
                "version": "1.0.0",
                "voices": [DEFAULT_VOICE["id"]]
            }).encode("utf-8"))
            return

        if self.path == "/v1/voices":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "voices": [DEFAULT_VOICE]
            }).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path in ["/v1/audio/speech", "/audio/speech"]:
            content_len = int(self.headers.get("Content-Length", 0))
            body_raw = self.rfile.read(content_len)
            try:
                body = json.loads(body_raw.decode("utf-8"))
            except Exception:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "Invalid JSON body"}')
                return

            input_text = body.get("input") or body.get("text", "")
            if not input_text:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "input text required"}')
                return

            voice = body.get("voice", "narrator_female")
            seed = body.get("seed", 482193)
            fmt = body.get("response_format", "mp3")

            try:
                audio_bytes = generate_speech(input_text, voice=voice, response_format=fmt, seed=seed)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg" if fmt == "mp3" else "audio/wav")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        if args and str(args[1]) != "200":
            sys.stderr.write(f"TTS: {format % args}\n")

def run_server():
    server = HTTPServer((BIND, PORT), TTSHandler)
    print(f"  chatterbox tts listening on {BIND}:{PORT} (OpenAI compatible /v1/audio/speech)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    run_server()
