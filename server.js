import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import {exec   }from"child_process";
import cron from "node-cron";
import dayjs from "dayjs";

const app = express();
// const PORT = 3000;
// const RTSP_URL = "rtsp://admin:admin@192.168.18.11:554/live/ch0";

const RECORD_FOLDER = path.join(process.cwd(), "records");
if (!fs.existsSync(RECORD_FOLDER)) {
  fs.mkdirSync(RECORD_FOLDER);
}

// 讀取命令列參數
// 錄製時間間隔 (分鐘) - 測試時改成 10，正式可以 1440 (一天)
const RECORD_INTERVAL_MINUTES = 10;
const RTSP_URL = "rtsp://admin:admin@" + process.argv[2] + ":554/live/ch0";
const PORT = process.argv[3]==null? 3000 : process.argv[3] ;
if (!RTSP_URL) {
  console.error("❌ Please provide RTSP URL as argument");
  process.exit(1);
}
const HLS_FOLDER = path.resolve(`./hls/${PORT}`);

// 執行錄製
// 建立 cron 表達式 (每 X 分鐘執行一次)
const cronExp = `*/${RECORD_INTERVAL_MINUTES} * * * *`;
cron.schedule(cronExp, () => {
//   const date = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const date  =  dayjs().format('YYYY-MM-DD HH:mm:ss');
  const filename = `record_${date}.mp4`;
  const filepath = path.join(RECORD_FOLDER, filename);

  const cmd = `ffmpeg -i ${RTSP_URL} -t ${RECORD_INTERVAL_MINUTES * 60} -c:v copy -c:a aac -movflags +faststart -y ${filepath}`;
  console.log("開始錄製:", filename);

  exec(cmd, (err) => {
    if (err) console.error("FFmpeg 錄製失敗:", err);
    else console.log("錄製完成:", filename);
  });
});

// 建立 HLS 資料夾
if (!fs.existsSync(HLS_FOLDER)) fs.mkdirSync(HLS_FOLDER);

// 提供 HLS 靜態檔案
app.use("/hls", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 允許所有來源
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}, express.static(HLS_FOLDER));

// 啟動 ffmpeg 產生 HLS
const ffmpeg = spawn("ffmpeg", [
  "-i", RTSP_URL,
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-g", "50",
  "-sc_threshold", "0",
  "-f", "hls",
  "-hls_time", "2",
  "-hls_list_size", "3",
  "-hls_flags", "delete_segments+omit_endlist",
  path.join(HLS_FOLDER, "stream.m3u8")
]);

ffmpeg.stderr.on("data", (data) => {
//   console.log(`ffmpeg: ${data.toString()}`);
});

ffmpeg.on("close", (code) => {
  console.log(`ffmpeg exited with code ${code}`);
});

// 前端測試路由
app.get("/", (req, res) => {
  res.send(`<h1>HLS Streaming Server</h1>
    <video controls autoplay width="640">
      <source src="/hls/${PORT}/stream.m3u8" type="application/x-mpegURL">
    </video>
  `);
});

// API: 列出所有錄影檔案
app.get("/api/records", (req, res) => {
  const files = fs.readdirSync(RECORD_FOLDER).filter(f => f.endsWith(".mp4"));
  res.json(files);
});

// API: 提供檔案播放
app.get("/api/records/:filename", (req, res) => {
  const filepath = path.join(RECORD_FOLDER, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send("File not found");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
