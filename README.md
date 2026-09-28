# CamPlatform

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

支援目前 FFMPEG chart 的 `YYYY-MM-DD/YYYY-MM-DD_HH.mp4`，以及舊版 `YYYY-MM-DD/HH.mp4`；其他安全名稱的 `.mp4` 也可列出，時間回退使用檔案 mtime。小時檔名以 `RECORDING_UTC_OFFSET=+08:00` 解讀。日期資料夾必須是有效的 `YYYY-MM-DD`。不提供任意靜態根目錄，不允許路徑穿越或 symlink 跳出錄影目錄。

一般 MP4 需有完整的 ftyp / mdat / moov 頂層區塊才會列入清單；目前 FFmpeg 錄到整點結束後才寫入 moov，尚在寫入或中斷未完成的錄影不會列出，直接讀取會回 409。此檢查確認容器結構，不能修復損壞影片或保證所有攝影機 codec 都能被瀏覽器解碼。HLS 分段不套用此完成檢查。

`/readyz` 會確認所有 `CAMERA_IDS` 目錄可讀；不需先有影片，但不能掛到空白或錯誤的儲存根目錄。檔案必須允許容器 UID/GID 1000 讀取及目錄 traversal。

## API

除登入、內部 health/readiness 外，每條路由都先驗證 JWT，包含不存在的 media、HEAD、Range 與舊路徑。無 token、過期、錯誤簽章、已登出 token 均回 401。

| 方法 / 路徑 | 用途 |
| --- | --- |
| `POST /api/auth/login` | JSON `{username,password}`；回傳 user、expiresAt、accessToken 並設定 HttpOnly Cookie |
| `GET /api/auth/me` | 回傳目前 user 與到期時間 |
| `POST /api/auth/logout` | 撤銷這次登入的 token 並清除 Cookie |
| `GET /api/cameras` | 攝影機與同源 liveUrl |
| `GET /api/cameras/:id/dates` | 日期資料夾，最新在前；可能包含目前仍在錄影的日期 |
| `GET /api/cameras/:id/records?date=YYYY-MM-DD&limit=20&offset=0` | `{records,total,limit,offset}`；date 可省略，limit 預設 50、上限 100 |
| `GET /api/cameras/:id/event-clip?at=2026-09-28T12:00:00Z` | 尋找事件前後各 10 秒；回傳 `status,parts,approximate,partial`，每段含 `record,startSeconds,endSeconds` |
| `GET /:id/hls/:filename` | 驗證後傳送 HLS playlist / segment |
| `GET /:id/api/records/:date/:filename` | MP4；支援單一 Range、206、416 及 HEAD |
| `GET /:id/api/records` | 保留旧 list 路徑，回傳同樣受保護的 records array，支援同樣查詢參數 |
| `GET /healthz`, `GET /readyz` | 程序／儲存狀態，供 Kubernetes probe 使用 |

每筆錄影包含 `id,name,date,timeStamp,size,fileUrl`。`fileUrl` 已是完整的同源路徑，不能再加 `/cam1/api/records/` 前綴。錯誤格式為 `{error:{code,message}}`。

## 人物提示與事件回放

在「即時影像」開啟各攝影機的「人物偵測」。畫面連續兩次辨識到人物後，會顯示提示並在下方「人物事件」清單記下攝影機、時間及人數。模型只辨識人物出現，不辨識身分或判斷移動方向。連續三次未見人物才重新待命，通知至少間隔 15 秒；一般每次辨識完成後間隔 1 秒再取樣，短暫經過仍可能漏報。

點「回看 ±10 秒」會定位事件前後各 10 秒，自動播放並在片段結束時停止；跨檔案／午夜會依序播放可用段落。API 以 MP4 `mvhd` 的實際長度限制範圍，不以最近的任意檔案代替缺失錄影。僅部分範圍可用時會明確提示；目前小時 MP4 須完成封存後才能回放，等待中的事件每 15 秒重新檢查。中斷且兩分鐘未更新的未完成錄影不會永久顯示為寫入中。

- 偵測僅在此頁可見、即時影像正在播放且開關啟用時運作；暫停、切到歷史頁、登出或關閉頁面會停止／暫停偵測。歷史回放不會產生人物事件。
- 事件依登入帳號保存在目前瀏覽器的 localStorage，最多 200 筆；重整後可查看，不跨裝置同步。清除瀏覽器資料也會清除事件；瀏覽器禁止儲存時會顯示警示。
- 使用延遲載入的 TensorFlow.js / COCO-SSD `lite_mobilenet_v2`。影格在瀏覽器內辨識，不上傳影像；首次啟用需從 `storage.googleapis.com/tfjs-models/` 下載模型權重。模型下載或瀏覽器運算失敗時可單獨重試，不影響影像播放器。
- 多台攝影機共用模型並依序運算。模型準確度受光線、遮擋、人物大小與裝置速度影響；此功能是監控輔助。

### 事件時間與 recorder 更新

新錄影應使用 `YYYY-MM-DD_HH-mm-ss.mp4`，HLS 應包含 `EXT-X-PROGRAM-DATE-TIME`。本 repo 的 `stream.js` 已加入 `program_date_time`；正式 recorder 的兩行變更準備在 [person-event-recorder.patch](docs/deployment/person-event-recorder.patch)，**尚未套用或部署**。在 Deployment repo 完成原有變更的提交與同步後，從其根目錄用 `git apply --check <patch完整路徑>` 檢查，再套用並依既有 GitOps 流程上線。既有每日資料夾／recorder 重啟排程不由此 patch 變更。

前端優先使用 HLS 的影像時間（hls.js `playingDate` 或原生 `getStartDate`）；缺少時間標記時以目前時間扣除播放器落後量估算，介面會註明。舊小時檔名只知道小時，起錄不在整點或中途重啟時會有偏差，回放也會註明為估算值。秒級檔名仍可能有緩衝或關鍵影格的時間偏移；部署後應以實際攝影機事件核對。自訂檔名只有檔案修改時間時，不用於事件定位。

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

- `CamPlatform/charts/cam-platform-backend`：接管既有 `ffmpeg/camplatform-server`，固定 slave02，唯讀掛載既有 `nfs-data-pvc` 至 `/data`。
- `CamPlatform/charts/cam-platform-app`：Vue / Nginx 與 Ingress；`/api`、`/cam1`、`/cam2` 全部走 JWT backend。
- `CamPlatform/environments/prod/{frontend,backend}-values.yml`：前後端同一 Git SHA。
- `argocd-apps/prod-cam-platform-{frontend,backend}.yml`：Argo CD 自動同步；前端 PreSync 檢查後端 readiness 與無 token 的 401。

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

**首次上線必須依 Deployment/CamPlatform/README.md 的遷移順序執行**：先備好 Secret/PVC/registry，停掉舊無驗證 server、移除舊 LoadBalancer / Ingress 等旁路，再合併 Deployment chart 和 CamPlatform 變更。Backend 初始 tag 刻意留空，等待首次成功的雙 image CI 回寫；不是可直接套用的已發布版本。後續一般升版自動進行。

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
