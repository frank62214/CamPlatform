import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import cron from "node-cron";
import dayjs from "dayjs";

const app = express();
const PORT = 3000;
const BASE_FOLDER = ".";

// 前端測試路由
app.get("/", (req, res) => {
  res.send(`<h1>HLS Streaming Server</h1>
    <video controls autoplay width="640">
      <source src="/cam1/hls/stream.m3u8" type="application/x-mpegURL">
    </video>
  `);
});

// HLS 串流路由 - 從 /video/cam1/hls 提供串流影像
app.use("/cam1/hls", express.static(path.join(BASE_FOLDER, "video", "cam1", "hls"), {
  setHeaders: (res, filePath) => {
    // 設定 CORS 和正確的 Content-Type
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else if (filePath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
    }
  }
}));

// HLS 串流路由 - 從 /video/cam1/hls 提供串流影像
app.use("/cam1/hls", express.static(path.join(BASE_FOLDER, "video", "cam1", "hls"), {
  setHeaders: (res, filePath) => {
    // 設定 CORS 和正確的 Content-Type
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (filePath.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else if (filePath.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
    }
  }
}));

// 工具：取得今天往前推N天的日期（YYYYMMDD）
function getPast7Days() {
  const dates = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);

    const yyyy = d.getFullYear().toString();
    const mm = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');

    dates.push(`${yyyy}${mm}${dd}`);
  }

  return dates;
}

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


