# 持續人物偵測驗收

日期：2026-10-04。功能與限制以 [SPEC.md](./SPEC.md) 為準。本文件區分可重現的自動測試、實際模型容器驗證與正式環境核對，避免把建置成功視為功能已上線。

## 自動化檢查

```sh
npm ci
npm test
npm run build
npm run model:prepare
RUN_DETECTION_MODEL_SMOKE=1 node --test tests/detection-runtime.test.js
docker build -f Dockerfile.server -t camplatform-server:verify .
```

Windows 的環境變數寫法為 `$env:RUN_DETECTION_MODEL_SMOKE='1'`。一般 `npm test` 不強制下載模型；可選的真實模型測試需先準備權重。Windows 缺少建立檔案 symlink 權限時可略過該測項，Linux 必須執行。

本次完整測試在 Windows 為 116 通過、2 個上述環境／模型前置條件略過、0 失敗；Linux server image 內執行完整測試（含真實模型與 symlink）全部通過。Vue 型別檢查、正式 build、server Docker build 與 Helm lint 均通過。

| 測試組 | 驗證事項 |
| --- | --- |
| `detection-runtime.test.js` | PDT／取樣時間、來源格式與路徑、檔案容量、過期／未來影格、去重、序列化、取消、逾時、重試、設定 revision 競態、離線本機模型 |
| `detection-store.test.js` | 原子保存、寫入失敗不發布、重試、重啟還原、筆數／天數、時區日期、損壞檔案不覆寫、實際可寫探測 |
| `detection-service.test.js` | 無客戶端的常駐生命週期、連續樣本、首次陽性時間、冷卻、跨重啟去重、相機獨立、設定競態、儲存錯誤與狀態 |
| `detection-api.test.js` | 未登入、跨來源、查詢與 JSON body 驗證、共享事件與持久設定 |
| 既有 backend / records / event-clips 測試 | JWT、媒體授權、檔案隔離、MP4 完成狀態、Range、日期分頁與事件前後 10 秒映射 |

## 真實模型與 Linux 容器

使用正式 server Dockerfile 建出的映像，限制 **1.5 CPU / 1536MiB**、唯讀 root filesystem，使用獨立測試儲存。HLS 測試來源由固定人物影像／空白影像編碼成 MPEG-TS，再由實際 FFmpeg 解碼及包入映像的 COCO-SSD/WASM 辨識；不是直接注入模型預測。

已通過：

1. 啟動 backend 後，在**零瀏覽器且尚未發出任何 HTTP 請求**時，直接從持久事件檔讀到第一筆人物事件；辨識分數約 0.689，影像時間來自 PDT。
2. 第二支攝影機空白時不混入第一支的事件；改為人物影像後獨立產生事件。
3. 停用後不新增事件；避開確認通知冷卻時間後重新啟用會恢復紀錄。
4. 重啟 backend 後事件 ID、設定仍存在，持續留在畫面的同一出現時段不重複記錄。
5. 停止更新 HLS 後超過 30 秒，狀態轉為等待／異常，不能保持正常監控。
6. 事件未登入為 401，跨來源修改設定為 403，容器流程未出現 server error。

這證明實際模型、解碼、事件判定和持久化能在無瀏覽器下運作；不代表已量測所有實體攝影機光線／角度的辨識準確率。

## 瀏覽器驗收方式

目標流程：登入 → 讀取伺服器狀態 → 修改一支攝影機設定 → 另一個獨立瀏覽器取得相同設定 → 關閉／切換頁面後伺服器設定不變 → 查詢事件 → 回看片段並在終點停止。

使用已安裝的 Chrome 與 Playwright 驗證正式 Vite build；本環境未提供 Browser plugin，因此使用現有 Playwright runtime，未額外安裝瀏覽器套件。UI 故障／分頁／跨瀏覽器測試用可控 API 回應及可解碼影片，實際 server 推論由上面的 Linux 容器驗證。

檢查桌面 1440×1080、平板 768px 及手機 390px；檢查頁面身份、非空內容、無建置錯誤遮罩、console、篩選分頁、開關保存失敗、過期狀態、回放終點與窄螢幕溢出。截圖遮蔽影片；測試截圖、帳密及私人錄影不提交 repo。瀏覽器不應發出 TensorFlow 模型／WASM 或人物 worker 請求。

## 正式部署核對

1. CI 的測試、兩個 build、兩個 SHA image publish 及 Deployment tag 更新都成功。
2. 兩個 Argo Application 在同一個 Deployment revision 為 Synced / Healthy；實際 backend/frontend Pod 使用指定 SHA，Ready=1/1，observedGeneration 與 generation 相同。
3. `/data` 為唯讀掛載、`/events` 為専用子目錄可寫掛載；事件初始化成功，不修改既有 auth Secret。
4. 使用既有帳號登入確認兩支即時影像、共享事件清單、歷史回放及登出；未登入不能讀取新事件／偵測 API。
5. 關閉驗證瀏覽器後，透過受控維運檢查確認偵測服務仍執行、最近分析時間繼續前進。事件是否新增取決於實際場景是否有人出現，不能為了驗收把虛構事件加入正式紀錄。
6. 只用完整 Argo sync；不跳過 PreSync，不以 force push、刪除影片／事件／PVC 或重設密碼處理部署問題。

部署版本由來源 Git commit、CI run 與 Deployment repo 的完整 SHA tags 追溯；即時健康狀態應從叢集查詢，避免靜態文件中的舊 Pod 名稱被誤當成現況。
