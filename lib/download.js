// lib/download.js
import { createWriteStream } from "fs";
import axios from "axios";
import http from "http";
import https from "https";
import { pipeline } from "stream";
import { promisify } from "util";
import { dirname } from "path";
import { mkdir } from "fs/promises";

const streamPipeline = promisify(pipeline);

// Shared axios instance that reuses TCP connections (keepAlive)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const axiosInstance = axios.create({
  timeout: 60000,
  httpAgent,
  httpsAgent,
  headers: {
    // some origins treat unknown clients differently; mimic a common UA
    'User-Agent': 'curl/8.7.1',
    'Accept': '*/*',
  },
  // follow redirects by default
});

async function downloadFileToPath(url, destPath, options = {}) {
  const { headers = {}, retries = 2, retryDelay = 500 } = options;

  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const resp = await axiosInstance.get(url, { responseType: "stream", headers, validateStatus: null });

      // better diagnostics for non-2xx responses
      if (!resp || !resp.status || resp.status < 200 || resp.status >= 300) {
        const message = `Request failed with status code ${resp && resp.status} for ${url}`;
        const e = new Error(message);
        e.status = resp && resp.status;
        e.url = url;
        // Log and throw to trigger retry logic
        console.error(message);
        throw e;
      }

      // ensure destination directory exists (avoid ENOENT when writing)
      const destDir = dirname(destPath);
      await mkdir(destDir, { recursive: true });

      const writer = createWriteStream(destPath);
      // Use pipeline to properly propagate errors and backpressure
      await streamPipeline(resp.data, writer);
      return; // success
    } catch (err) {
      // Enrich error with URL/status for easier debugging
      // normalize status from axios response or from our thrown error
      const status = (err && err.response && err.response.status) || err.status;
      const message = status
        ? `Request failed with status code ${status} for ${url}`
        : `Request error for ${url}: ${err.message}`;

      // If we've exhausted retries or it's a 4xx that is unlikely to change, throw immediately for 403/401/400
      if (status && [400, 401, 403, 404].includes(status)) {
        const e = new Error(message);
        e.status = status;
        e.url = url;
        // log for server-side visibility
        console.error(e.message);
        throw e;
      }

      if (attempt > retries) {
        const e = new Error(message);
        e.status = status;
        e.url = url;
        console.error(`Download failed after ${attempt} attempts:`, e.message);
        throw e;
      }

      // small backoff before retrying
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
    }
  }
}

export { downloadFileToPath };
