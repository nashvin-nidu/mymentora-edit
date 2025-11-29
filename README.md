# Slide-FFmpeg

Brief: A small Express-based service that generates short videos from image segments using FFmpeg and uploads finished videos to Supabase storage.

Why there are two startup scripts
- `server.js`: The main Express application. This file defines the HTTP API (including `/generate-video`), handles requests, performs downloads, calls FFmpeg helpers, and uploads results to Supabase. Run this directly for local development or debugging.
- `start.js`: A lightweight production launcher that performs pre-flight checks (FFmpeg availability, `temp/` directory presence, and required environment variables) and then starts `server.js` as a child process with `NODE_ENV=production`. It also adds nicer startup logs and graceful-shutdown handling.

When to use each
- Use `node server.js` for development, debugging, or when you want the process to run in the current terminal and see stack traces and verbose error output.
- Use `node start.js` (or the provided Dockerfile entrypoint) in production to ensure the environment is validated before launching and to get a more controlled, production-friendly startup.

Requirements
- Node.js 16+ (ESM support and `fs/promises`) - test with `node -v`.
- FFmpeg installed and on `PATH` (required by the app). Test with `ffmpeg -version`.
- A `temp/` directory at project root (the app will create `temp/` automatically when `server.js` starts, but `start.js` expects it).
- Environment variables (typically via a `.env` file):
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - Optional: `PORT`

Quick start (development)
1. Install dependencies:
```bash
npm install
```
2. Start the server directly:
```bash
node server.js
```

Quick start (production-like)
1. Ensure FFmpeg is installed and available on `PATH`.
2. Ensure `.env` contains `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Start with the launcher:
```bash
node start.js
```

Docker
- The repository includes a `dockerfile` (lowercase). Build and run containers in environments where FFmpeg is available in the image. You may need to create an image with FFmpeg and Node.js together; adjust the Dockerfile accordingly.

API example
- Health check:
```bash
curl http://localhost:3000/health
```

- Generate video (example payload):
```bash
curl -X POST http://localhost:3000/generate-video \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "job-123",
    "resolution": "1280x720",
    "segments": [
      { "imageUrl": "https://example.com/image1.jpg", "duration": 3, "subtitleText": "Hello" },
      { "imageUrl": "https://example.com/image2.jpg", "duration": 4 }
    ]
  }'
```

Notes and troubleshooting
- If `start.js` exits with "FFmpeg not found", install FFmpeg and ensure the binary is on your `PATH` before starting.
- If uploads to Supabase fail, verify your `SUPABASE_URL` and `SUPABASE_ANON_KEY`, and confirm network connectivity to the Supabase instance.
- During development set `NODE_ENV` to anything other than `production` to preserve session files for debugging; in production the server will remove temp files after a job completes or on failure.

Contact
- If you need changes to behavior (for example, different cleanup semantics, concurrency limits, or added logging), open an issue or edit `server.js` / `start.js` accordingly.
# mymentora-edit
