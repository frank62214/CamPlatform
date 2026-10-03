# CamPlatform

完整的現況、API、監控／回放規則與部署限制見 [系統規格](docs/SPEC.md)。

Vue 3 + Express 5 的攝影機監控平台。登入由後端驗證 scrypt 密碼雜湊並簽發 JWT；即時 HLS（playlist / segment）、歷史清單及 MP4 回放（GET / HEAD / Range）都必須攜帶有效 token。前端以同源 HttpOnly Cookie 傳送，API client 也可用 Bearer；不再把帳密放進前端，也不把 token 放進 URL 或 sessionStorage。

## 本機啟動

需要 Node.js 20.19+ 或 22.12+；CI / Docker 使用 Node 22。

```powershell
npm ci
npm run auth:setup
```

此指令互動輸入帳號及至少 12 字元密碼（隱藏輸入），產生 `.env`，內含隨機 JWT 簽章 key 與 scrypt 密碼 hash。既有檔案不會被覆寫。請將 `.env` 的 `DATA_ROOT` 設為本機或已掛載的錄影根目錄，例如 `C:/camera-data`；Linux 上預設 `/data`。只有一台相機時設 `CAMERA_IDS=cam1`。

```powershell
# Terminal 1
npm run server:dev

# Terminal 2
npm run dev
```

開啟 Vite 顯示的網址（預設 `http://localhost:5173`）。Vite 保留 `/api` 前綴及 Host，將 API / media 代理到 `http://127.0.0.1:3000`；可用 `CAM_STREAM_PROXY_TARGET` 覆寫。`npm run server` 讀取程序環境變數，`server:dev` 才會載入 `.env`。`npm run preview` 只預覽靜態前端，不提供 API 代理；整合測試請使用 `npm run dev` 或正式 Ingress。

## 既有錄影格式

後端只讀取現有檔案，不寫入、刪除或重新編碼錄影：

```text
/data/
  cam1/
    hls/stream.m3u8
    hls/stream0.ts
    2026-09-07/2026-09-07_23.mp4
    2026-09-06/12.mp4
  cam2/
    ...
```

支援目前 FFMPEG recorder 的 `YYYY-MM-DD/YYYY-MM-DD_HH-MM-SS_UUID.mp4`、不含 UUID 的秒級檔名，以及舊版小時／分鐘檔名（含 `HH.mp4`、`HHMM.mp4`、`HHMMSS.mp4`）。UUID 保留重啟前的片段，避免同一時段覆寫。其他安全名稱的 `.mp4` 也可列出，時間回退使用檔案 mtime。檔名時間以 `RECORDING_UTC_OFFSET=+08:00` 解讀，並回傳時間精度；小時檔名不代表實際起點恰好在整點。日期資料夾必須是有效的 `YYYY-MM-DD`，預先建立但沒有錄影的空日期不會搶走預設選取。不提供任意靜態根目錄，不允許路徑穿越或 symlink 跳出錄影目錄。

一般 MP4 需有完整的 ftyp / mdat / moov 頂層區塊才可播放；FFmpeg 結束片段後才寫入 moov。歷史清單會區分可播放、錄製中及未完成的檔案，未完成的 `fileUrl` 為 null，直接讀取會回 409。此檢查確認容器結構，不能修復損壞影片或保證所有攝影機 codec 都能被瀏覽器解碼。HLS 分段不套用此完成檢查。

`/readyz` 會確認所有 `CAMERA_IDS` 目錄可讀；不需先有影片，但不能掛到空白或錯誤的儲存根目錄。檔案必須允許容器 UID/GID 1000 讀取及目錄 traversal。

## API

除登入、內部 health/readiness 外，每條路由都先驗證 JWT，包含不存在的 media、HEAD、Range 與舊路徑。無 token、過期、錯誤簽章、已登出 token 均回 401。

| 方法 / 路徑 | 用途 |
| --- | --- |
| `POST /api/auth/login` | JSON `{username,password}`；回傳 user、expiresAt、accessToken 並設定 HttpOnly Cookie |
| `GET /api/auth/me` | 回傳目前 user 與到期時間 |
| `POST /api/auth/logout` | 撤銷這次登入的 token 並清除 Cookie |
| `GET /api/cameras` | 攝影機與同源 liveUrl |
| `GET /api/detection` | 伺服器偵測及各攝影機狀態 |
| `POST /api/cameras/:id/detection` | 保存 `{enabled:boolean}`，需同源驗證 |
| `GET /api/person-events?cameraId=cam1&date=YYYY-MM-DD&limit=50&offset=0` | 持久事件清單、總數與保留天數 |
| `GET /api/cameras/:id/dates` | 日期資料夾，最新在前；可能包含目前仍在錄影的日期 |
| `GET /api/cameras/:id/records?date=YYYY-MM-DD&limit=20&offset=0` | `{records,total,limit,offset}`；date 可省略，limit 預設 50、上限 100 |
| `GET /api/cameras/:id/event-clip?at=2026-09-28T12:00:00Z` | 尋找事件前後各 10 秒；回傳 `status,parts,approximate,partial`，每段含 `record,startSeconds,endSeconds` |
| `GET /:id/hls/:filename` | 驗證後傳送 HLS playlist / segment |
| `GET /:id/api/records/:date/:filename` | MP4；支援單一 Range、206、416 及 HEAD |
| `GET /:id/api/records` | 保留旧 list 路徑，回傳同樣受保護的 records array，支援同樣查詢參數 |
| `GET /healthz`, `GET /readyz` | 程序／儲存狀態，供 Kubernetes probe 使用 |

每筆錄影包含 `id,name,date,timeStamp,size,fileUrl`，另有 `time,timePrecision,status` 等顯示資訊。可播放的 `fileUrl` 已是完整的同源路徑，不能再加 `/cam1/api/records/` 前綴；未完成時為 null。錯誤格式為 `{error:{code,message}}`。

## 人物持續監控與事件回放

人物偵測由伺服器常駐執行，與瀏覽器生命週期無關。即時頁面的「伺服器持續偵測」開關會保存該攝影機的伺服器設定；關閉網頁、切換分頁或登出不會停止已啟用的攝影機。網頁每 5 秒讀取偵測狀態及共享事件，支援攝影機、日期篩選和分頁，所有授權裝置看到同一份紀錄。

伺服器從現有唯讀 HLS 分段擷取影格，優先依 `EXT-X-PROGRAM-DATE-TIME` 加取樣位置保存影像時間；若來源時間缺失或偏離目前時間，改依新寫入分段的檔案時間估算，事件明確標示「估算時間」。COCO-SSD / WASM 在 Node worker 執行，不阻塞 API，也不需要瀏覽器下載模型；模型在 image 建置時校驗 SHA-256 並包入映像。過期檔案、重複影格或分析失敗不會被當作有效人物觀察。

分數至少 0.6、連續兩次有效取樣看見人物才記錄一次出現，連續三次未見人物才重新待命，每支攝影機兩次確認通知至少間隔 15 秒。預設每輪等待 2 秒；HLS 分段及處理速度影響實際頻率，快速經過、光線及遮擋仍可能造成漏報或誤報。此功能不辨識身分。

事件與啟用設定保存到獨立可寫的 `EVENTS_ROOT/events.json`；正式環境保留最近 **7 天／最多 20,000 筆**。瀏覽器不再以 localStorage 保存正式事件；舊瀏覽器紀錄不自動匯入，也不回掃之前未偵測的影片。設定、事件及必要的去重狀態可跨 backend 重啟保留。

點「回看 ±10 秒」會定位事件前後各 10 秒，自動播放並在片段結束時停止；跨檔案／午夜會依序播放可用段落。API 以 MP4 `mvhd` 實際長度限制範圍，不用附近無關檔案替代。部分缺失會提示；**目前小時 MP4 須封檔後才能回放**，等待中的事件每 15 秒重新檢查。事件保存與錄影清理獨立，影片已清理時事件仍可能存在。

本機啟用需安裝 FFmpeg、執行 `npm run model:prepare`，並設定 `DETECTION_ENABLED=true`、可寫且不位於 `DATA_ROOT` 內的 `EVENTS_ROOT`。正式設定及完整行為見 [系統規格](docs/SPEC.md)、[驗收紀錄](docs/VERIFICATION.md)。

模型 API 參考 [COCO-SSD 官方文件](https://github.com/tensorflow/tfjs-models/blob/master/coco-ssd/README.md)；串流時間標記參考 [FFmpeg HLS 文件](https://ffmpeg.org/ffmpeg-formats.html#hls-2)。

## 驗證設定

完整範例在 [.env.example](.env.example)。必要值是 `JWT_SECRET`（至少 32 bytes）、`AUTH_USERNAME`、`AUTH_PASSWORD_HASH`。不提供可登入的預設帳密。

- JWT：固定 HS256、issuer/audience/subject/expiry/session 驗證，預設 1 小時，可設 `TOKEN_TTL_SECONDS`（1–86400 秒）。
- 正式環境必須設定 `NODE_ENV=production`、`COOKIE_SECURE=true`、HTTPS 的 `PUBLIC_ORIGIN`；登入／登出檢查 Origin，登入只接受 JSON。Cookie 為 HttpOnly、SameSite=Strict、Path=/，不設 Domain。
- 影片與 API 送出 `Cache-Control: private, no-store`。Ingress/CDN 不得覆寫成公共快取。
- 登入限制預設同一連線來源 60 秒內 20 次，可設定 `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_SECONDS`。不信任任意 `X-Forwarded-For`；Ingress 後面會共用實際代理來源的額度。
- JWT session allowlist 存在記憶體，採 **單副本 + Recreate**。登出即撤銷這顆 token，重啟、部署、密鑰輪替後需重新登入。若要多副本，必須先加入共用 session store。
- 此版本提供單一管理帳號；多使用者／攝影機分權尚未實作。

## Docker、CI/CD 與正式部署

正式部署由旁邊的 **Deployment repo** 管理：

- `CamPlatform/charts/cam-platform-server`：沿用既有 `ffmpeg/camplatform-server` 與 server Application，固定 slave02，唯讀掛載既有 `nfs-data-pvc` 至 `/data`。
- `CamPlatform/charts/cam-platform-app`：Vue / Nginx 與 Ingress；`/api`、`/cam1`、`/cam2` 全部走 JWT backend。
- `CamPlatform/environments/prod/{frontend,server}-values.yml`：前後端同一 Git SHA。
- `argocd-apps/prod-cam-platform-{frontend,server}.yml`：Argo CD 自動同步；server PreSync 檢查 Secret／設定與錄影目錄，前端 PreSync 檢查後端 readiness 與無 token 的 401。不建立另一個 backend Application 搶管相同資源。

部署使用既有 recorder PVC；它在 Deployment 設定為 slave02 的 NFS export，對應使用者既有 `/data/cam1`。上線前要實際確認 PVC 根目錄就是 cam1/cam2；本機無叢集 context 時不能假設已讀到遠端影片。

PR 與 main 先執行 `npm test`、`npm run build` 及前後端 Docker build；main 兩個 image 都成功發布後，才在一個 Deployment commit 更新兩個 tags。只發布完整 SHA，不再發布 `latest`。GitHub repository 需設定：

- `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`：可發布 `hackdog30678/camplatform-server` / `camplatform-frontend`。
- `DEPLOY_REPO_TOKEN`：可更新 `hackdog33456/Deployment` 的 main。

Kubernetes `ffmpeg` namespace 需有 `dockerhub-secret`、`camplatform-auth`：

```powershell
npm run auth:secret -- --env-file .env --output camplatform-auth.secret.json
kubectl -n ffmpeg apply -f camplatform-auth.secret.json
Remove-Item -LiteralPath ./camplatform-auth.secret.json
```

helper 只將 `JWT_SECRET`、`AUTH_USERNAME`、`AUTH_PASSWORD_HASH` 寫入 Secret；正式 cookie、origin、儲存設定由 chart 提供。不要提交 `.env` 或 `*.secret.json`。更換 Secret 後要 restart 後端。

**首次上線依 Deployment/CamPlatform/README.md 的遷移順序執行**：先備好 Secret/PVC/registry，確認舊 LoadBalancer／Ingress 等旁路不會繞過登入，再更新既有 server chart。更新 chart 時保留目前已發布 tag，CI 在兩個新 image 都發布成功後才一起換成新 SHA。server PreSync 若找不到 Secret、設定無效或讀不到目錄，會在更換目前 server 前失敗；待補齊設定後重新完整同步即可。前端需等 JWT backend 檢查通過才更新。不可 selective sync 跳過 hooks。

舊 `k8s/deployment.yaml`、Deployment 的 `StreamServer/deployment.yaml` 已退役，不再建立空 PVC 或拉未驗證的 latest。若先前真的套用了原始碼 repo 的 `camplatform` namespace，需先盤點該 namespace 的工作負載、外部入口和 PVC：先停掉舊 server / 外部入口並保留錄影 PVC，再由正式 `ffmpeg` GitOps 管理。不要刪除 PVC/PV，也不要使用 `rollout undo` 回到無驗證 image。

`stream.js` 只作本地 RTSP→HLS producer，需 `RTSP_URL`，不再提供 HTTP 靜態影片服務；正式錄影繼續由既有 Deployment/FFMPEG chart 管理。正式 host 必須使用 HTTPS，Cloudflare/Ingress 不得快取受保護路徑。

## 檢查

```powershell
npm test
npm run build
npm audit
docker build -f Dockerfile.server -t camplatform-server:local .
docker build -f Dockerfile.frontend -t camplatform-frontend:local .
```

API tests 使用暫存影片 fixtures，涵蓋 token、Cookie、來源、限流、登出／過期、日期／分頁、MP4 完成狀態、Range、路徑穿越及 symlink。Windows 缺少建立 file symlink 權限時只略過該測項，Linux CI 會執行。實際 slave02 錄影與外部入口請依 Deployment README 的正式 smoke checks 驗證。

JWT 實作使用 [jose](https://github.com/panva/jose)；token 驗證 API 參考 [jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)。
