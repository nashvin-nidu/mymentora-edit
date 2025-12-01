// server.js
import 'dotenv/config';
import express, { json } from "express";
import cors from "cors";
import { join, extname, dirname } from "path";
import { mkdir, rm } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { downloadFileToPath } from "./lib/download.js";
import { createSegmentVideo, concatVideos, createVideoFromSegments } from "./lib/ffmpegHelpers.js";
// import { createSubtitleFile, getSubtitleStylePresets } from "./lib/subtitleHelpers.js";
import { uploadVideoToSupabase } from "./lib/supabaseHelpers.js";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_ROOT = join(__dirname, "temp");
if (!existsSync(TEMP_ROOT)) mkdirSync(TEMP_ROOT);

const app = express();
app.use(morgan("dev"));

// CORS: allow configured origins and handle preflight early
const allowedOrigins = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length
  ? {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: process.env.CORS_CREDENTIALS === "true",
    }
  : {
      origin: true, // reflect request origin (use with care; set CORS_ORIGINS in prod)
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    };

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
// capture raw body for better JSON error reporting
app.use(json({
  limit: "50mb",
            verify: (req, res, buf, encoding) => {
              try {
                req.rawBody = buf.toString(encoding || 'utf8');
              } catch (e) {
                req.rawBody = '<unavailable>';
              }
            }
          }));

          // JSON parse error handler: provide raw body snippet to logs to help debug malformed JSON
app.use((err, req, res, next) => {
  if (err && err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('INVALID JSON in request body:', err.message);
            let snippet = '<unavailable>';
            if (req && req.rawBody) {
              // log a reasonable snippet (first 2k chars)
              snippet = req.rawBody.length > 2000 ? req.rawBody.slice(0, 2000) + '...[truncated]' : req.rawBody;
              console.error('Raw body snippet:\n', snippet);
            }
            // Expose snippet only in non-production to avoid leaking sensitive data
            if (process.env.NODE_ENV !== 'production') {
              return res.status(400).json({ error: 'Invalid JSON', message: err.message, rawBodySnippet: snippet });
    }
    return res.status(400).json({ error: 'Invalid JSON', message: err.message });
  }
  next(err);
});

// simple p-limit implementation to bound concurrency
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  const next = () => {
              if (queue.length === 0 || active >= concurrency) return;
              active++;
              const { fn, resolve, reject } = queue.shift();
              Promise.resolve(fn()).then((val) => {
                active--;
                resolve(val);
                next();
              }, (err) => {
                active--;
                reject(err);
                next();
              });
            };
            return (fn) => new Promise((resolve, reject) => {
              queue.push({ fn, resolve, reject });
              next();
            });
          }

          const MAX_CONCURRENCY = Math.max(1, os.cpus().length - 1);
          const limit = pLimit(MAX_CONCURRENCY);

          app.post("/generate-video", async (req, res) => {
            // normalize body: accept either { segments: [...] } or [ { segments: [...] } ]
            let body = req.body;
            try {
              console.log('Incoming /generate-video request');
              console.log('Request body keys:', Object.keys(req.body));
            } catch (e) {}

            if (Array.isArray(body) && body.length === 1 && body[0] && typeof body[0] === 'object') {
    body = body[0];
  }

  const { jobId, segments: rawSegments, resolution = "1280x720", subtitleStyle, subtitlePreset } = body || {};

  // Require jobId in payload
  if (!jobId || typeof jobId !== 'string' || jobId.trim() === '') {
    return res.status(400).json({ error: "jobId required in request body" });
  }

  // Use provided jobId (caller must provide unique id to avoid overwrites)
  const videoJobId = jobId;
  
  // Handle subtitle styling
  let globalSubtitleStyle = null;
  if (subtitlePreset) {
    const presets = getSubtitleStylePresets();
    globalSubtitleStyle = presets[subtitlePreset.toLowerCase()] || presets['default'];
    console.log(`Using subtitle preset: ${subtitlePreset}`);
  } else if (subtitleStyle) {
    globalSubtitleStyle = subtitleStyle;
    console.log(`Using custom subtitle style: ${subtitleStyle}`);
  }

  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return res.status(400).json({ error: "segments array required" });
  }

  // normalize each segment to expected keys (imageUrl, duration)
  const segments = rawSegments.map((s) => ({
    id: s && (s.id ?? s.ID ?? s.index),
    imageUrl: s && (s.imageUrl || s.image_Url || s.image_url || s.image),
    duration: s && (s.duration ?? s.length ?? s.time),
    // keep other optional metadata if present
    image_prompt: s && (s.image_prompt || s.imagePrompt),
    subtitleText: s && (s.subtitleText || s.subtitle_text || s.subtitle),
    word_duration: s && (s.word_duration || s.wordDuration || s.words),
  }));

  console.log(`Received ${segments.length} segments`);
  segments.forEach((s, i) => console.log(`segment[${i}] imageUrl=${s.imageUrl} duration=${s.duration}`));



  const sessionId = uuidv4();
  const sessionDir = join(TEMP_ROOT, sessionId);
  // ensure temp root and session dir exist
  await mkdir(sessionDir, { recursive: true });

  try {
  // 1) download all images in parallel but bounded
    // helper: extract extension safely from a URL string
    const safeExt = (urlStr, fallback) => {
      try {
        const p = new URL(urlStr).pathname; // throws if not a valid URL
        const e = extname(p).split("?")[0];
        return e || fallback;
      } catch (e) {
        return fallback;
      }
    };

    const downloadTasks = segments.map((seg, i) =>
      limit(async () => {
        const imgExt = safeExt(seg.imageUrl, ".png");
        const imgPath = join(sessionDir, `img_${i}${imgExt}`);

        // download image (log failures per URL)
        await downloadFileToPath(seg.imageUrl, imgPath).catch((err) => {
          console.error(`Failed to download image for segment ${i}:`, err.message || err);
          throw err;
        });

        return { 
          imagePath: imgPath, 
          duration: seg.duration,
          subtitleText: seg.subtitleText,
          word_duration: seg.word_duration
        };
      })
    );

    const downloaded = await Promise.all(downloadTasks);

    console.log(`Successfully downloaded ${downloaded.length} segments`);

    // 2) Generate subtitle files for segments that have subtitle data
    // Also update segment durations if calculated from word timing
    const subtitleResults = downloaded.map((seg, i) => {
      if (seg.subtitleText || seg.word_duration) {
        return createSubtitleFile(seg, sessionDir, i, seg.duration, globalSubtitleStyle);
      }
      return { srtPath: null, calculatedDuration: null, subtitleStyle: null };
    });
    
    const subtitlePaths = subtitleResults.map(result => result.srtPath);
    const subtitleStyles = subtitleResults.map(result => result.subtitleStyle);
    
    // Update segment durations with calculated values from word timing
    downloaded.forEach((seg, i) => {
      if (subtitleResults[i].calculatedDuration) {
        seg.duration = subtitleResults[i].calculatedDuration;
        console.log(`Updated segment ${i} duration to ${seg.duration}s from word timing`);
      }
    });

    // Validate that each segment has a numeric duration (new payload requirement)
    const missingDuration = downloaded.findIndex((s) => s.duration == null || !Number.isFinite(Number(s.duration)));
    if (missingDuration !== -1) {
      throw new Error(`Payload validation failed: each segment must include a numeric 'duration' in seconds (missing or invalid at index ${missingDuration})`);
    }

    // 3) try single-run concat (fast). If it fails, fall back to per-segment
    // encode + concat which is slower but more robust.
    const finalPath = join(sessionDir, "final.mp4");
    try {
      await createVideoFromSegments({ 
        segments: downloaded, 
        outPath: finalPath, 
        resolution,
        subtitlePaths,
        subtitleStyles
      });
    } catch (singleErr) {
      console.error('Single-run createVideoFromSegments failed, falling back to per-segment encode:', singleErr && singleErr.message);
      // create per-segment mp4 files
      const segVideoPaths = [];
      for (let i = 0; i < downloaded.length; i++) {
        const seg = downloaded[i];
        const segOut = join(sessionDir, `seg_${i}.mp4`);
        console.log('Encoding segment (fallback):', seg.imagePath, '->', segOut);
        await createSegmentVideo({ 
          imagePath: seg.imagePath, 
          outPath: segOut, 
          duration: seg.duration, 
          resolution,
        });
        segVideoPaths.push(segOut);
      }
      console.log('Concatenating', segVideoPaths.length, 'segment files');
      await concatVideos(segVideoPaths, finalPath);
    }

    // 3) Upload to Supabase and return URL
    console.log('Uploading video to Supabase...');
    const uploadResult = await uploadVideoToSupabase(finalPath, videoJobId);
    
    console.log('Video uploaded successfully:', uploadResult.url);
    
    // Return JSON response with jobId and URL
    res.json({
      jobId: videoJobId,
      url: uploadResult.url
    });
    
    // Cleanup session directory after successful upload
    rm(sessionDir, { recursive: true, force: true }).catch(console.error);
  } catch (err) {
    console.error("Video generation failed:", err);
    
    // Clean up session directory on error (production)
    if (process.env.NODE_ENV === 'production') {
      rm(sessionDir, { recursive: true, force: true }).catch(console.error);
    } else {
      console.error(`Session files available for debugging at: ${sessionDir}`);
    }
    
    res
      .status(500)
      .json({ 
        error: "Video generation failed", 
        details: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message || err 
      });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on http://0.0.0.0:${PORT}`));
