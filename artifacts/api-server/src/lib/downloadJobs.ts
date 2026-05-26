import { v4 as uuidv4 } from "uuid";

export interface DownloadJob {
  jobId: string;
  status: "pending" | "downloading" | "complete" | "error";
  progress: number;
  downloadUrl: string | null;
  filename: string | null;
  error: string | null;
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  thumbnail: string | null;
  platform: string;
  label: string;
  filename: string | null;
  createdAt: string;
}

const jobs = new Map<string, DownloadJob>();
let history: HistoryItem[] = [];

export function createJob(): DownloadJob {
  const job: DownloadJob = {
    jobId: uuidv4(),
    status: "pending",
    progress: 0,
    downloadUrl: null,
    filename: null,
    error: null,
  };
  jobs.set(job.jobId, job);
  return job;
}

export function getJob(jobId: string): DownloadJob | undefined {
  return jobs.get(jobId);
}

export function updateJob(jobId: string, updates: Partial<DownloadJob>): void {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
  }
}

export function addHistory(item: Omit<HistoryItem, "id" | "createdAt">): HistoryItem {
  const entry: HistoryItem = {
    ...item,
    id: uuidv4(),
    createdAt: new Date().toISOString(),
  };
  history.unshift(entry);
  if (history.length > 50) history = history.slice(0, 50);
  return entry;
}

export function getHistory(): HistoryItem[] {
  return history;
}

export function clearHistory(): void {
  history = [];
}

export function deleteHistoryItem(id: string): boolean {
  const idx = history.findIndex((h) => h.id === id);
  if (idx === -1) return false;
  history.splice(idx, 1);
  return true;
}
