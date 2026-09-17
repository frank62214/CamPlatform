import { Router } from "express";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

function httpError(status, publicMessage) {
  return Object.assign(new Error(publicMessage), { status, publicMessage });
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function validFile(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.mp4$/i.test(value);
}

async function cameraRoot(videoRoot, camera) {
  const root = path.resolve(videoRoot, camera);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw httpError(503, "錄影儲存空間尚未正確掛載。");
  return realpath(root);
}

// Dates and filenames are allowlisted, and symlinked directories/files are never served.
async function dateFolder(root, date) {
  const folder = path.join(root, date);
  try {
    const info = await lstat(folder);
    return info.isDirectory() && !info.isSymbolicLink() ? folder : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Read only top-level MP4 atom headers; seek past mdat, which can be several GB.
// FFmpeg's segment recorder writes moov on close. This also accepts faststart MP4.
async function isFinalizedMp4(file, fileSize) {
  const header = Buffer.alloc(16);
  let offset = 0;
  let hasMovie = false;
  let hasMedia = false;
  for (let count = 0; offset < fileSize && count < 4096; count++) {
    const { bytesRead } = await file.read(header, 0, 16, offset);
    if (bytesRead < 8) return false;
    const type = header.toString("ascii", 4, 8);
    let size = header.readUInt32BE(0);
    let headerSize = 8;
    if (size === 1) {
      if (bytesRead < 16) return false;
      const extendedSize = header.readBigUInt64BE(8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize || size > fileSize - offset) return false;
    if (type === "moov" && size > headerSize) hasMovie = true;
    if (type === "mdat" && size > headerSize) hasMedia = true;
    offset += size;
  }
  return offset === fileSize && hasMovie && hasMedia;
}

async function inspectRecord(folder, date, fileName, camera) {
  const filePath = path.join(folder, fileName);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const file = await open(filePath, "r");
  let ready;
  try {
    ready = await isFinalizedMp4(file, info.size);
  } finally {
    await file.close();
  }
  const timeMatch = fileName.replace(`${date}_`, "").match(/^(\d{2})(?:[-_]?(\d{2}))?(?:[-_]?(\d{2}))?\.mp4$/i);
  const time = timeMatch && Number(timeMatch[1]) < 24
    && Number(timeMatch[2] || 0) < 60 && Number(timeMatch[3] || 0) < 60
    ? `${timeMatch[1]}:${timeMatch[2] || "00"}:${timeMatch[3] || "00"}` : null;
  return {
    id: `${date}/${fileName}`,
    fileName,
    date,
    time,
    size: info.size,
    updatedAt: info.mtime.toISOString(),
    status: ready ? "ready" : Date.now() - info.mtimeMs < 120_000 ? "recording" : "unavailable",
    fileUrl: ready ? `/${camera}/api/records/${date}/${encodeURIComponent(fileName)}` : null,
  };
}

export function createRecordRouter(videoRoot, camera) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    const requestedDate = req.query.date;
    if (requestedDate !== undefined && !validDate(requestedDate)) {
      throw httpError(400, "日期格式必須為有效的 YYYY-MM-DD。");
    }
    const root = await cameraRoot(videoRoot, camera);
    const entries = await readdir(root, { withFileTypes: true });
    const dates = entries.filter(entry => entry.isDirectory() && validDate(entry.name))
      .map(entry => entry.name).sort().reverse();
    const date = requestedDate || dates[0] || null;
    const folder = date && await dateFolder(root, date);
    const records = [];
    if (folder) {
      const files = await readdir(folder, { withFileTypes: true });
      for (const entry of files) {
        if (!entry.isFile() || !validFile(entry.name)) continue;
        try {
          const record = await inspectRecord(folder, date, entry.name, camera);
          if (record) records.push(record);
        } catch (error) {
          // The retention job may remove files between directory scan and stat/open.
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    records.sort((a, b) => (b.time || b.fileName).localeCompare(a.time || a.fileName));
    res.json({ camera, date, dates, records });
  });

  router.get("/:date/:fileName", async (req, res, next) => {
    const { date, fileName } = req.params;
    if (!validDate(date) || !validFile(fileName)) throw httpError(404, "找不到指定的錄影。");
    const root = await cameraRoot(videoRoot, camera);
    const folder = await dateFolder(root, date);
    if (!folder) throw httpError(404, "錄影已不存在，請重新整理列表。");
    let record;
    try {
      record = await inspectRecord(folder, date, fileName, camera);
    } catch (error) {
      if (error.code === "ENOENT") throw httpError(404, "錄影已不存在，請重新整理列表。");
      throw error;
    }
    if (!record) throw httpError(404, "找不到指定的錄影。");
    if (record.status !== "ready") throw httpError(409, "錄影尚未完成或檔案不完整，暫時無法播放。");
    // Express supports HEAD and byte ranges, so seeking does not download the whole hour.
    res.setHeader("Content-Type", "video/mp4");
    res.sendFile(fileName, { root: folder, acceptRanges: true, cacheControl: false, dotfiles: "deny" }, error => {
      // Seeking and changing clips normally cancel the previous range request.
      if (error && error.code !== "ECONNABORTED" && error.code !== "ECONNRESET") next(error);
    });
  });
  return router;
}
