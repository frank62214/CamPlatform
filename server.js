import express from "express";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRecordRouter } from "./server/records.js";

export function createApp({ videoRoot = process.env.VIDEO_ROOT || "/video" } = {}) {
  const app = express();
  app.get("/", (_req, res) => res.json({ status: "ok" }));

  for (const camera of ["cam1", "cam2"]) {
    app.use(`/${camera}/api/records`, createRecordRouter(videoRoot, camera));
    app.use(`/${camera}/hls`, express.static(path.join(videoRoot, camera, "hls"), {
      setHeaders(res, filePath) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (filePath.endsWith(".m3u8")) {
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Cache-Control", "no-store");
        } else if (filePath.endsWith(".ts")) {
          res.setHeader("Content-Type", "video/mp2t");
        }
      },
    }));
  }

  app.use((_req, res) => res.status(404).json({ error: "找不到指定的資源。" }));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || error.statusCode || 503;
    if (status >= 500) console.error("Recording storage error:", error.code || error.message);
    res.status(status).json({
      error: error.publicMessage || (status === 416
        ? "要求的播放範圍無效。"
        : status < 500 ? "找不到指定的錄影。" : "無法讀取錄影儲存空間，請稍後重試。"),
    });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Camera server listening on port ${port}`));
}
