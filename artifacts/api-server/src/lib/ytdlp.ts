import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { updateJob } from "./downloadJobs.js";
import { logger } from "./logger.js";

// Use the standalone yt-dlp binary. Path is configurable via YT_DLP_BIN env var
// so it works on Render (where the binary is downloaded during build) as well as locally.
const YT_DLP_BIN = process.env["YT_DLP_BIN"] ?? "/home/runner/workspace/bin/yt-dlp";

export type Platform = "youtube" | "unknown";

export interface QualityOption {
  label: string;
  format: string;
  formatId: string | null;
  filesize: number | null;
  isAudio: boolean;
}

export interface MediaInfo {
  url: string;
  platform: Platform;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  viewCount: number | null;
  qualities: QualityOption[];
}

export function detectPlatform(url: string): Platform {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return "unknown";
}

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      }
    });
    proc.on("error", (err) => reject(err));
  });
}

function runYtDlpWithProgress(
  args: string[],
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YT_DLP_BIN, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      const line = d.toString();
      const match = line.match(/(\d+(?:\.\d+)?)%/);
      if (match) onProgress(Math.min(parseFloat(match[1]), 95));
    });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

async function fetchRawInfo(url: string): Promise<string> {
  const baseArgs = [
    "--dump-single-json",
    "--no-check-certificates",
    "--no-warnings",
  ];

  try {
    return await runYtDlp([...baseArgs, url]);
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);

    // YouTube Shorts / restricted content — retry with Android client
    if (
      msg.includes("not available on this app") ||
      msg.includes("Requested format is not available")
    ) {
      return await runYtDlp([
        ...baseArgs,
        "--extractor-args", "youtube:player_client=android",
        url,
      ]);
    }

    throw firstErr;
  }
}

export async function fetchMediaInfo(url: string): Promise<MediaInfo> {
  const platform = detectPlatform(url);

  if (platform !== "youtube") {
    throw new Error("Only YouTube URLs are supported. Paste a youtube.com or youtu.be link.");
  }

  const json = await fetchRawInfo(url);

  const info = JSON.parse(json) as Record<string, unknown>;
  const formats = (info.formats as Record<string, unknown>[] | undefined) ?? [];

  const seenFormatIds = new Set<string>();
  const qualities: QualityOption[] = [];

  const resolutionTiers = [
    { label: "1080p", height: 1080, min: 900 },
    { label: "720p",  height: 720,  min: 600 },
    { label: "480p",  height: 480,  min: 400 },
    { label: "360p",  height: 360,  min: 240 },
  ];

  for (const tier of resolutionTiers) {
    const match = formats
      .filter(
        (f) =>
          typeof f.height === "number" &&
          (f.height as number) >= tier.min &&
          (f.height as number) <= tier.height &&
          f.vcodec !== "none" &&
          f.ext !== "webm",
      )
      .sort((a, b) => ((b.height as number) ?? 0) - ((a.height as number) ?? 0))[0];

    if (match) {
      const fid = (match.format_id as string) ?? "";
      if (!seenFormatIds.has(fid)) {
        seenFormatIds.add(fid);
        qualities.push({
          label: tier.label,
          format: (match.ext as string) ?? "mp4",
          formatId: fid || null,
          filesize:
            (match.filesize as number) ??
            (match.filesize_approx as number) ??
            null,
          isAudio: false,
        });
      }
    }
  }

  // Fallback: if no distinct per-tier format found (e.g. Shorts with one combined stream),
  // show the actual available resolutions without duplicates
  if (qualities.length === 0) {
    const videoFormats = formats
      .filter(
        (f) =>
          typeof f.height === "number" &&
          (f.height as number) > 0 &&
          f.vcodec !== "none",
      )
      .sort((a, b) => ((b.height as number) ?? 0) - ((a.height as number) ?? 0));

    for (const f of videoFormats) {
      const fid = (f.format_id as string) ?? "";
      if (seenFormatIds.has(fid)) continue;
      seenFormatIds.add(fid);
      const h = f.height as number;
      const label =
        h >= 1080 ? "1080p" : h >= 720 ? "720p" : h >= 480 ? "480p" : "360p";
      if (qualities.some((q) => q.label === label)) continue;
      qualities.push({
        label,
        format: (f.ext as string) ?? "mp4",
        formatId: fid || null,
        filesize:
          (f.filesize as number) ?? (f.filesize_approx as number) ?? null,
        isAudio: false,
      });
    }
  }

  const audioFmt = formats
    .filter(
      (f) =>
        f.vcodec === "none" &&
        (f.acodec as string) !== "none" &&
        f.ext !== "webm",
    )
    .sort((a, b) => ((b.abr as number) ?? 0) - ((a.abr as number) ?? 0))[0];

  qualities.push({
    label: "MP3",
    format: "mp3",
    formatId: audioFmt ? (audioFmt.format_id as string) : null,
    filesize: audioFmt
      ? ((audioFmt.filesize as number) ??
          (audioFmt.filesize_approx as number) ??
          null)
      : null,
    isAudio: true,
  });

  return {
    url,
    platform,
    title: (info.title as string) ?? "Unknown title",
    thumbnail:
      (info.thumbnail as string) ??
      (
        (info.thumbnails as Record<string, unknown>[] | undefined)?.slice(
          -1,
        )[0]?.url as string
      ) ??
      null,
    duration: typeof info.duration === "number" ? info.duration : null,
    uploader:
      (info.uploader as string) ??
      (info.channel as string) ??
      (info.creator as string) ??
      null,
    viewCount:
      typeof info.view_count === "number" ? info.view_count : null,
    qualities,
  };
}

export async function runDownload(
  jobId: string,
  url: string,
  formatId: string,
  label: string,
  isAudio: boolean,
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexdrop-"));
  const outTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

  updateJob(jobId, { status: "downloading", progress: 5 });

  const baseFlags: string[] = [
    "--no-check-certificates",
    "--no-warnings",
    "--newline",
  ];

  const args: string[] = [...baseFlags, "-o", outTemplate];

  if (isAudio) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    // Use height-based selectors so quality is guaranteed — not just a raw format ID
    const heightMatch = label.match(/^(\d+)p$/);
    if (heightMatch) {
      const h = heightMatch[1];
      args.push(
        "-f",
        `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        "--merge-output-format", "mp4",
      );
    } else {
      args.push(
        "-f",
        `${formatId}+bestaudio[ext=m4a]/${formatId}/best`,
        "--merge-output-format", "mp4",
      );
    }
  }

  args.push(url);

  try {
    await runYtDlpWithProgress(args, (pct) => {
      updateJob(jobId, { progress: 5 + pct * 0.88 });
    });
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);

    // YouTube Shorts fallback — retry with Android client and best available
    if (
      msg.includes("not available on this app") ||
      msg.includes("Requested format is not available")
    ) {
      const androidArgs = [
        ...baseFlags,
        "--extractor-args", "youtube:player_client=android",
        "-f", "best",
        "-o", outTemplate,
        url,
      ];
      await runYtDlpWithProgress(androidArgs, (pct) => {
        updateJob(jobId, { progress: 5 + pct * 0.88 });
      });
    } else {
      throw firstErr;
    }
  }

  updateJob(jobId, { progress: 95 });

  const files = fs.readdirSync(tmpDir);
  if (files.length === 0) {
    throw new Error("Download produced no output file");
  }

  const filePath = path.join(tmpDir, files[0]);
  logger.info({ jobId, filePath }, "Download complete");
  return filePath;
}
