# CamPlatform

Vue 3 + Vite 的雙攝影機監控前端，提供即時 HLS 與錄影回放。登入驗證依需求完全在瀏覽器內完成，不需要後端。

## 本機開發

```powershell
npm install
npm run dev
```

開發伺服器預設把 `/cam1`、`/cam2` 轉送到 `http://127.0.0.1:3000`。若要讀取 Kubernetes 內既有的 stream server，可先執行：

```powershell
kubectl -n ffmpeg port-forward service/camplatform-server 3000:3000
```

也可以覆寫 proxy 目標：

```powershell
$env:CAM_STREAM_PROXY_TARGET = 'https://your-stream-host.example'
npm run dev
Remove-Item Env:CAM_STREAM_PROXY_TARGET
```

## 正式建置

```powershell
npm run build
npm run preview
```

正式環境以 same-origin 的 `/cam1`、`/cam2` 讀取串流；`Deployment` repo 的 Ingress 會把這兩個 prefix 轉送到 `ffmpeg/camplatform-server:3000`。

## 歷史錄影

登入後切換「歷史影像」，可分別選擇客廳（cam1）與大門（cam2）的日期、時段，在頁內播放、拖曳進度或下載 MP4。預設載入各攝影機最新的日期，保留的舊日期都可以查詢。重新整理會更新片段狀態；錄製中或未完成的檔案不開放播放。

slave02 的 `/data/cam1`、`/data/cam2` 由既有 NFS PVC `nfs-data-pvc` 掛載到 stream server 的 `/video`。後端預設讀取：

```text
/video/cam1/YYYY-MM-DD/YYYY-MM-DD_HH.mp4
/video/cam2/YYYY-MM-DD/YYYY-MM-DD_HH.mp4
```

也支援舊版 `YYYY-MM-DD/HH.mp4`。影片不需複製或重新編碼；API 檢查 MP4 的 `moov` / `mdat` 結構，只讀取少量標頭並跳過影片內容，避免讀取整個大型檔案。近期仍未封檔的片段顯示「錄製中」；超過兩分鐘未更新且未封檔則顯示「檔案未完成」。播放是否成功仍取決於檔案內容與瀏覽器的編碼支援。

API：

- `GET /cam1/api/records`：回傳 `{ camera, date, dates, records }`，預設最新日期。
- `GET /cam1/api/records?date=2026-09-17`：指定日期（台北時間的錄影檔名）。
- `GET /cam1/api/records/2026-09-17/2026-09-17_08.mp4`：原始 MP4，支援 HEAD 與 HTTP Range，方便跳轉影片進度。
- cam2 使用相同端點格式；缺少儲存掛載回傳 503，無錄影日期回傳空列表，不會混為同一狀態。

本機若直接使用 slave02 的資料目錄，可設定 `VIDEO_ROOT=/data`；Windows 測試也可指定本機資料夾：

```powershell
$env:VIDEO_ROOT = 'D:\camera-recordings'
npm run server
# 另一個終端執行 npm run dev
```

`VIDEO_ROOT` 同時作為 HLS 和錄影的根目錄。正式部署建議以唯讀方式掛載 PVC；歷史 API 不會修改或刪除錄影，也不跟隨攝影機、日期或影片的符號連結。

此功能需要同時更新 frontend 與 server image。CI 會在兩個 image 建置成功後，一起更新 Deployment repo 的前、後端 Argo CD tag；server chart 保留既有 Service 與 PVC，以唯讀方式提供錄影。Ingress 已有 `/cam1`、`/cam2` prefix，不需要新增路由。

```powershell
npm test
npm run build
```

## Docker Hub 與 Argo CD

推送到 `main` 後，GitHub Actions 會使用 `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` 建置並推送：

- `hackdog30678/camplatform-server:<git-sha>`
- `hackdog30678/camplatform-frontend:<git-sha>`

Workflow 先執行後端測試與前端正式建置，兩個 image 都推送成功後，使用 `DEPLOY_REPO_TOKEN` 在同一次 commit 將完整 Git SHA 回寫到 `Deployment/CamPlatform/environments/prod/frontend-values.yml` 與 `server-values.yml`。Argo CD 偵測到 tag 變更後會分別自動 rollout 前、後端；`latest` 僅為相容舊用途，正式部署使用完整 SHA。

## 安全界線

純前端登入只能隱藏 UI：帳密與登入狀態都可由使用者在瀏覽器內檢視或繞過，也不會保護直接存取的串流 URL。若攝影機影像需要真正的存取控制，必須對整個 hostname 使用 Cloudflare Access、Ingress authentication 或其他伺服器端驗證。
