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
const data = JSON.parse(rawData)[camNum]; // 轉成 JS 物件

// 設定參數
const recordPORT = data.recordPort;
const PORT = data.serverPort;
const IP = data.ip;
const cameraTitle = data.title;
const baseFolderName = data.folderName;

// 讀取錄影命令列參數
// 錄製時間間隔 (分鐘) - 測試時改成 10，正式可以 1440 (一天)
const RECORD_INTERVAL_MINUTES = 60;
const RTSP_URL = "rtsp://admin:admin@" + IP + ":554/live/ch0";
if (!RTSP_URL) {
  console.error("❌ Please provide RTSP URL as argument");
  process.exit(1);
}

function getTimeStamp(){
  return dayjs().format('YYYY-MM-DD HH:mm:ss');
}

let isRecording = false;
let isPending = true;

// 執行錄製
// 建立 cron 表達式 (每 X 分鐘執行一次)
const cronExp = '* * * * *';
cron.schedule(cronExp, () => {

  if (isRecording) {
    isPending = true;
    console.log(`[${getTimeStamp()}]⚠️ Still recording, skip this run...`);
    return;
  }
  startRecording();
});

function startRecording(){
  isRecording = true;
  isPending = false;
  const min = dayjs().format('mm');
  const duration = (RECORD_INTERVAL_MINUTES-min) * 60; // 秒
  const date = dayjs().format('YYYY-MM-DD');
  // 建立歷史紀錄的資料夾
  const RECORD_FOLDER = path.join(process.cwd(), `/${baseFolderName}/${date}`);
  if (!fs.existsSync(RECORD_FOLDER)) {
    fs.mkdirSync(RECORD_FOLDER, { recursive: true });
  }
  const timestamp = dayjs().format('HH');
  const filepath = `${RECORD_FOLDER}/${timestamp}.mp4`;

  console.log(`[${getTimeStamp()}]▶️ Start recording: ${filepath} (${duration/60} min)`);

  const ffmpeg = spawn("ffmpeg", [
    "-rtsp_transport", "tcp",                 // 用 TCP 避免 UDP 丟包
    "-analyzeduration", "10000000",          // 增加分析串流時間（10 秒）
    "-probesize", "5000000",                  // 增加分析資料大小
    "-i", RTSP_URL,                           // RTSP 串流來源
    "-t", String(duration),                   // 錄影時長
    "-c:v", "copy",                           // 視訊直接複製
    "-c:a", "aac",                            // 音訊轉 AAC
    "-movflags", "+faststart",                // mp4 開頭 metadata
    "-y", filepath
  ]);

  ffmpeg.stdout.on("data", (data) => {
    // console.log(`ffmpeg: ${data}`);
  });

  ffmpeg.stderr.on("data", (data) => {
    // console.error(`ffmpeg err: ${data}`);
  });

  ffmpeg.on("close", (code) => {
    isRecording = false;
    console.log(`[${getTimeStamp()}] ⏹ Recording finished with code ${code}`);
    if (isPending) {
      startRecording(); // 立即補錄
    }
  });

}

app.listen(recordPORT, () => {
  console.log(`✅ Server running on http://localhost:${recordPORT}`);
});
