# Renaiss FMV Alert System

監控 [Renaiss](https://renaiss.io) 市場上所有掛單卡牌的 FMV（Fair Market Value）變動，當 FMV 更新後與掛單價差距達到設定閾值時，自動發送通知到 Discord。

## 功能

- 自動抓取所有掛單卡牌的 FMV 並儲存快照
- 定期偵測 FMV 是否發生變動
- 若 FMV 變動後，掛單價與新 FMV 差距 >= 20%，則發送 Discord 警報
- 警報分為兩種：
  - **Overpriced（紅色）**：掛單價高於 FMV 超過閾值
  - **Underpriced（綠色）**：掛單價低於 FMV 超過閾值（撿便宜機會）

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

### 2. 建立 Discord Webhook

1. 進入你的 Discord 頻道
2. 頻道設定 → Integrations → Webhooks → New Webhook
3. 複製 Webhook URL

### 3. 設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`：

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
FMV_THRESHOLD_PERCENT=20
CHECK_INTERVAL_MINUTES=30
```

### 4. 啟動

```bash
npm start
```

首次執行會自動抓取所有掛單卡牌並儲存 FMV 快照，之後每隔設定的時間自動比對。

---

## 設定說明

| 環境變數 | 預設值 | 說明 |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | （必填）| Discord Webhook URL |
| `FMV_THRESHOLD_PERCENT` | `20` | 掛單價與 FMV 差距觸發警報的百分比門檻 |
| `CHECK_INTERVAL_MINUTES` | `30` | 每次檢查的間隔（分鐘） |

---

## 執行邏輯

```
啟動
  │
  ▼
第一次 check()
  ├─ 沒有快照 → 抓所有掛單卡，存 fmv-snapshot.json → 結束等待下次
  └─ 有快照   → 比對 FMV 變動
                  │
                  ▼
              找出 FMV 有變的卡
                  │
                  ▼
              計算 |掛單價 - 新FMV| / 新FMV
                  ├─ < 門檻 → 略過
                  └─ >= 門檻 → 加入警報清單
                               │
                               ▼
                           發送 Discord 通知
                               │
                               ▼
                           更新快照
  │
  ▼
每 N 分鐘重複 check()
```

### Discord 通知內容

每張觸發警報的卡會包含：

| 欄位 | 說明 |
|---|---|
| Card | 卡牌完整名稱 |
| Owner | 目前擁有者 |
| Grade | 評級公司與等級（如 PSA 10） |
| Year | 發行年份 |
| Previous FMV | 上次快照的 FMV |
| Current FMV | 最新 FMV |
| FMV Change | 變動金額與百分比 |
| List Price | 目前掛單價格 |
| Gap | 掛單價與新 FMV 的差距百分比 |

---

## 資料說明

- 快照儲存於 `data/fmv-snapshot.json`
- 掛單價（`askPriceInUSDT`）為鏈上 18 位小數格式，程式自動轉換為 USDT 金額
- 每次分頁抓取最多 100 張，頁間間隔 1 秒避免請求過快

---

## 長期運行建議

程式預設為前景執行，關閉終端後會停止。如需長期運行，建議使用：

**pm2：**
```bash
npm install -g pm2
pm2 start index.js --name renaiss-fmv-alert
pm2 save
pm2 startup
```

**背景執行（臨時）：**
```bash
nohup npm start &
```
