import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import {exec}from"child_process";
import cron from "node-cron";
import dayjs from "dayjs";

const app = express();

const camNum = process.argv[2];

// 讀取 JSON
const rawData = fs.readFileSync('ipCamConfig.json', 'utf-8');
const data = camNum==null ? 3000 : JSON.parse(rawData)[camNum]; // 轉成 JS 物件

// 設定參數
const PORT = data.serverPort;
const IP = data.ip;
const cameraTitle = data.title;
const baseFolderName = data.folderName;

// 建立歷史紀錄與串流的資料夾
const HLS_FOLDER = path.join(process.cwd(), `/${baseFolderName}/hls/`);
if (!fs.existsSync(HLS_FOLDER)) {
  fs.mkdirSync(HLS_FOLDER, { recursive: true });
}

// 讀取錄影命令列參數
// 錄製時間間隔 (分鐘) - 測試時改成 10，正式可以 1440 (一天)
const RTSP_URL = "rtsp://admin:admin@" + IP + ":554/live/ch0";
if (!RTSP_URL) {
  console.error("❌ Please provide RTSP URL as argument");
  process.exit(1);
}

// 提供 HLS 靜態檔案
app.use("/hls", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 允許所有來源
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}, express.static(HLS_FOLDER));

// 啟動 ffmpeg 產生 HLS
const ffmpeg = spawn("ffmpeg", [
  "-rtsp_transport", "tcp",              // 用 TCP 取流，避免 UDP 丟包
  "-analyzeduration", "10000000",        // 增加分析時間
  "-probesize", "10000000",              // 增加探測大小
  "-i", RTSP_URL,                        // RTSP 來源
  "-c:v", "copy",                        // 視訊直接複用，不重編碼
  "-c:a", "aac",                         // 音訊轉成 AAC
  "-ar", "44100",                        // 取樣率（攝影機常見 8k，要輸出 HLS 建議轉成 44.1k）
  "-b:a", "128k",
  "-f", "hls",                           // 輸出格式 HLS
  "-hls_time", "2",                      // 每片 TS 長度 2 秒
  "-hls_list_size", "3",                 // m3u8 保留 3 個片段
  "-hls_flags", "delete_segments+omit_endlist", // 刪舊檔案，不加結尾
  path.join(HLS_FOLDER, "stream.m3u8"),  // 輸出目錄
]);

ffmpeg.stderr.on("data", (data) => {
  // console.log(`ffmpeg: ${data.toString()}`);
});

// 監聽錯誤輸出 (stderr) - ffmpeg 大部分訊息都在這裡
ffmpeg.stderr.on("data", (data) => {
  // console.error(`stderr: ${data}`);
});

// 監聽錯誤事件 (spawn 問題)
ffmpeg.on("error", (err) => {
  // console.error("Failed to start ffmpeg:", err);
});

ffmpeg.on("close", (code) => {
  // console.log(`ffmpeg exited with code ${code}`);
});

// 前端測試路由
app.get("/", (req, res) => {
  res.send(`<h1>HLS Streaming Server</h1>
    <video controls autoplay width="640">
      <source src="/${baseFolderName}/hls/stream.m3u8" type="application/x-mpegURL">
    </video>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
