// lib/ffmpegHelpers.js
import ffmpeg from "fluent-ffmpeg";
import { dirname } from "path";
import { writeFileSync } from "fs";
import os from "os";

function createSegmentVideo({
  imagePath,
  outPath,
  resolution = "1280x720",
  duration = 3 /* seconds, required by payload now - default fallback */,
  threads = Math.max(1, os.cpus().length - 1),
  encoder = "libx264", // allow 'h264_nvenc' or others if desired
}) {
  return new Promise((resolve, reject) => {
    // build vf filter from resolution param (width x height)
    const [w, h] = resolution.split("x").map((s) => Number(s) || 0);
    const width = Number.isFinite(w) && w > 0 ? w : 1280;
    const height = Number.isFinite(h) && h > 0 ? h : 720;

    const vfFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    const codecOption = encoder === "libx264" ? "-c:v libx264" : `-c:v ${encoder}`;

    let timeout;
    const cmd = ffmpeg()
      .addInput(imagePath)
      .inputOptions(["-loop 1"])
      .outputOptions([
        codecOption,
        "-preset ultrafast",
        "-tune stillimage",
        "-pix_fmt yuv420p",
        "-movflags +faststart",
        `-vf ${vfFilter}`,
        "-r 24",
        `-threads ${threads}`,
      ])
      .output(outPath)
      .on("start", (cmdline) => {
        console.log('ffmpeg start:', cmdline);
        timeout = setTimeout(() => {
          console.error('FFmpeg process timed out after 60 seconds');
          try { cmd.kill('SIGKILL'); } catch (e) {}
          reject(new Error('FFmpeg process timed out'));
        }, 60000);
      })
      .on('stderr', (line) => {
        console.log('ffmpeg stderr:', line);
      })
      .on("end", () => {
        if (timeout) clearTimeout(timeout);
        resolve(outPath);
      })
      .on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        console.error('ffmpeg error (segment):', err && err.message);
        reject(err);
      });

    if (duration) {
      cmd.outputOptions(`-t ${duration}`);
    }
    cmd.run();
  });
}

function concatVideos(videoPaths, finalOutPath) {
  return new Promise((resolve, reject) => {
    const listFile = `${dirname(finalOutPath)}/filelist.txt`;
    const content = videoPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listFile, content);

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy", "-movflags +faststart"]) // use copy!
      .output(finalOutPath)
      .on("end", () => resolve(finalOutPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

export { createSegmentVideo, concatVideos };

/**
 * Create one video from multiple segments in a single ffmpeg run.
 * Each segment is an object: { imagePath, audioPath, duration }
 * This reduces process spawn and re-encoding overhead when building many short clips.
 */
async function createVideoFromSegments({ segments, outPath, resolution = "1280x720", threads = Math.max(1, os.cpus().length - 1), encoder = "libx264" }) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('segments array required');

  const [w, h] = resolution.split("x").map((s) => Number(s) || 0);
  const width = Number.isFinite(w) && w > 0 ? w : 1280;
  const height = Number.isFinite(h) && h > 0 ? h : 720;

  const cmd = ffmpeg();

  // Add only image inputs: image0, image1, ...
  segments.forEach((seg) => {
    // image input: loop and set framerate; add -t based on numeric duration (required in new payload)
    cmd.addInput(seg.imagePath);
    const imgInputOpts = [`-loop 1`, `-framerate 24`];
    if (seg && seg.duration != null && Number.isFinite(Number(seg.duration))) {
      imgInputOpts.push(`-t ${seg.duration}`);
    }
    cmd.inputOptions(imgInputOpts);
  });

  // Probe each image to compute an explicit numeric scale (width/height)
  const filters = [];
  const concatInputs = [];

  // helper to probe image dimensions
  const probeImage = (path) =>
    new Promise((resolve) => {
      ffmpeg.ffprobe(path, (err, metadata) => {
        if (err || !metadata || !Array.isArray(metadata.streams)) return resolve({ w: 0, h: 0 });
        const vs = metadata.streams.find((s) => s.width && s.height);
        if (!vs) return resolve({ w: 0, h: 0 });
        resolve({ w: vs.width || 0, h: vs.height || 0 });
      });
    });

  const dims = await Promise.all(segments.map((s) => probeImage(s.imagePath)));

  segments.forEach((_, i) => {
    const vIndex = i; // video input index (only images now)
    const { w: iw, h: ih } = dims[i] || { w: 0, h: 0 };

    // Build video filter chain
    let videoFilter;
    if (!iw || !ih) {
      videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    } else {
      const ratioW = width / iw;
      const ratioH = height / ih;
      const factor = Math.min(ratioW, ratioH, 1);
      const scaledW = Math.max(1, Math.floor(iw * factor));
      const scaledH = Math.max(1, Math.floor(ih * factor));
      videoFilter = `scale=${scaledW}:${scaledH},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    }

    filters.push(`[${vIndex}:v]${videoFilter}[sv${i}]`);
    concatInputs.push(`[sv${i}]`);
  });

  // concat filter: n=segments, each with v=1 a=0; inputs must be in order v0,v1,v2...
  filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=0[v]`);

  const filterComplex = filters.join(';');
  console.log('built filterComplex:', filterComplex);

  const codecOption = encoder === "libx264" ? "-c:v libx264" : `-c:v ${encoder}`;

  cmd.complexFilter(filterComplex)
    .on('start', (cmdline) => console.log('ffmpeg start:', cmdline))
    .on('stderr', (line) => console.log('ffmpeg stderr:', line))
    .outputOptions([
      codecOption,
      "-preset ultrafast",
      "-tune stillimage",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
      `-r 24`,
      `-threads ${threads}`,
    ])
    .outputOptions(["-map [v]"])
    .output(outPath);

  await new Promise((resolve, reject) => {
    cmd.on('end', () => resolve(outPath)).on('error', (err) => reject(err)).run();
  });

  return outPath;
}

// expose new helper
export { createVideoFromSegments };

