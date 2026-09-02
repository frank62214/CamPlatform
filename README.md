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

## 安全界線

純前端登入只能隱藏 UI：帳密與登入狀態都可由使用者在瀏覽器內檢視或繞過，也不會保護直接存取的串流 URL。若攝影機影像需要真正的存取控制，必須對整個 hostname 使用 Cloudflare Access、Ingress authentication 或其他伺服器端驗證。
