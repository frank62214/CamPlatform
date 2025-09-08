import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import cron from "node-cron";
import dayjs from "dayjs";

const app = express();
// const PORT = 3000;
// const RTSP_URL = "rtsp://admin:admin@192.168.18.11:554/live/ch0";
const PORT = 3000;
const BASE_FOLDER = ".";
// 前端測試路由
app.get("/", (req, res) => {
  res.send(`<h1>HLS Streaming Server</h1>
    <video controls autoplay width="640">
      <source src="/hls/${PORT}/stream.m3u8" type="application/x-mpegURL">
    </video>
  `);
});

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

// API：列出指定資料夾下的所有資料夾與檔案
app.get("/api/:fordername/records", (req, res) => {
  const past7Days = getPast7Days();
  // 產生過去 7 天的合法日期字串
  // const validDates = new Set(
  //   Array.from({ length: 7 }, (_, i) => getDateStr(i))
  // );

  const dirPath = BASE_FOLDER +  req.path.replaceAll("/api", "");
  // 先讀 record 目錄底下的所有日期資料夾
  fs.readdir(dirPath, { withFileTypes: true }, (err, dirs) => {
    if (err) return res.status(200).send(err.message);

    const result = [];

    dirs.forEach(dir => {
      if (dir.isDirectory() && past7Days.includes(dir.name)) {
        const dateFolder = dir.name;
        const folderPath = path.join(dirPath, dateFolder);

        const files = fs.readdirSync(folderPath).map(file => file.replace(/\.mp4$/, '')); // 讀取該日期資料夾底下的檔案

        result.push({
          date: dateFolder,
          file: files
        });
      }
    });

    res.json(result);
  });
});

// API: 列出該日期所有錄影檔案
app.get("/api/:fordername/records/:date/:video", (req, res) => {
  // 從 query string 取得要查詢的路徑，例如 /folders?dir=./test
  const filepath = process.cwd() +  req.path.replaceAll("/api", "");
  console.log(filepath);

  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send("File not found");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});


