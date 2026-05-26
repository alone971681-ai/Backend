import { Router, type IRouter } from "express";
import path from "path";
import fs from "fs";
import {
  fetchMediaInfo as fetchInfo,
  runDownload,
  detectPlatform,
} from "../lib/ytdlp.js";
import {
  createJob,
  getJob,
  updateJob,
  addHistory,
  getHistory,
  clearHistory,
  deleteHistoryItem,
} from "../lib/downloadJobs.js";

const router: IRouter = Router();

router.post("/media/info", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  try {
    const info = await fetchInfo(trimmed);
    res.json(info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.warn({ url: trimmed, err: msg }, "Failed to fetch media info");

    if (
      msg.includes("Private") ||
      msg.includes("private") ||
      msg.includes("unavailable") ||
      msg.includes("age") ||
      msg.includes("login")
    ) {
      res.status(422).json({ error: "This media is private or unavailable." });
      return;
    }
    res.status(400).json({ error: "Could not fetch media info. Check the URL and try again." });
  }
});

router.post("/media/download", async (req, res): Promise<void> => {
  const { url, formatId, label, title, thumbnail, platform } = req.body as {
    url?: string;
    formatId?: string;
    label?: string;
    title?: string;
    thumbnail?: string | null;
    platform?: string | null;
  };

  if (!url || !formatId || !label) {
    res.status(400).json({ error: "url, formatId, and label are required" });
    return;
  }

  const job = createJob();
  res.json(job);

  const isAudio = label === "MP3" || formatId === "mp3";

  (async () => {
    try {
      const filePath = await runDownload(job.jobId, url, formatId, label, isAudio);
      const filename = path.basename(filePath);

      const downloadUrl = `/api/media/file/${job.jobId}/${encodeURIComponent(filename)}`;

      updateJob(job.jobId, {
        status: "complete",
        progress: 100,
        downloadUrl,
        filename,
      });

      addHistory({
        url,
        title: title ?? filename,
        thumbnail: thumbnail ?? null,
        platform: platform ?? detectPlatform(url),
        label,
        filename,
      });

      (job as { _filePath?: string })._filePath = filePath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateJob(job.jobId, { status: "error", error: msg });
    }
  })();
});

router.get("/media/download/:jobId", async (req, res): Promise<void> => {
  const jobId = Array.isArray(req.params.jobId)
    ? req.params.jobId[0]
    : req.params.jobId;

  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

router.get(
  "/media/file/:jobId/:filename",
  async (req, res): Promise<void> => {
    const jobId = Array.isArray(req.params.jobId)
      ? req.params.jobId[0]
      : req.params.jobId;
    const filename = Array.isArray(req.params.filename)
      ? req.params.filename[0]
      : req.params.filename;

    const job = getJob(jobId) as (ReturnType<typeof getJob> & { _filePath?: string }) | undefined;
    if (!job || !job._filePath) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const filePath = job._filePath;
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File no longer exists" });
      return;
    }

    res.download(filePath, filename, (err) => {
      if (err) {
        req.log.error({ err }, "Error sending file");
      }
    });
  },
);

router.get("/media/history", async (_req, res): Promise<void> => {
  res.json(getHistory());
});

router.delete("/media/history", async (_req, res): Promise<void> => {
  clearHistory();
  res.sendStatus(204);
});

router.delete("/media/history/:id", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const deleted = deleteHistoryItem(id);
  if (!deleted) {
    res.status(404).json({ error: "History item not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
