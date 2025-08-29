import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
// const PORT = 3000;
// const RTSP_URL = "rtsp://admin:admin@192.168.18.11:554/live/ch0";

// 讀取命令列參數
const RTSP_URL = "rtsp://admin:admin@" + process.argv[2] + ":554/live/ch0";
const PORT = process.argv[3]==null? 3000 : process.argv[3] ;
if (!RTSP_URL) {
  console.error("❌ Please provide RTSP URL as argument");
  process.exit(1);
}
const HLS_FOLDER = path.resolve(`./hls/${PORT}`);

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
  console.log(`ffmpeg: ${data.toString()}`);
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

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
