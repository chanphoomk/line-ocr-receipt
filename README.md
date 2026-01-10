# LINE OCR Receipt Processor

A LINE Bot that automatically extracts text from receipt/invoice images using Google Document AI and saves the data to Google Drive and Google Sheets.

## Features

- 📷 **Image Processing**: Receive receipt images via LINE chat
- 🔍 **OCR Extraction**: Use Google Document AI to extract structured data
- 📁 **Google Drive Storage**: Save images in organized date folders (YYYYMMDD)
- 📊 **Google Sheets Logging**: Append extracted data to a spreadsheet
- 📈 **Usage Quota Tracking**: Monitor monthly OCR usage with auto-reset
- ⚠️ **Smart Quota Management**: Automatically pauses OCR at 975/1000 to preserve quota
- 🚀 **Railway Deployment Ready**: One-click deployment to Railway

## Usage Quota & Limits

Google Document AI provides **1,000 free pages/month**. This bot includes configurable quota management:

| Setting | Environment Variable | Default |
| ------- | -------------------- | ------- |
| Monthly limit | `OCR_MONTHLY_LIMIT` | 975 |
| Quota exceeded message | `OCR_QUOTA_MESSAGE` | "You are out of OCR quota, please contact admin." |

**Behavior:**
- When quota reached → Bot replies with your custom message and stops
- Counter automatically resets at the start of each month
- Users can type `usage` to check their quota

## Architecture

```
LINE User → LINE Platform → Railway Server → Google Document AI
                                          → Google Drive (YYYYMMDD/images)
                                          → Google Sheets (data logging)
```

## Prerequisites

1. **Node.js 20+** installed locally
2. **LINE Developers Account** with a Messaging API channel
3. **Google Cloud Project** with the following APIs enabled:
   - Document AI API
   - Google Drive API  
   - Google Sheets API
4. **Railway Account** for deployment
5. **GitHub Account** for version control

---

## Setup Instructions

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd OCR
npm install
```

### 2. LINE Bot Setup

1. Go to [LINE Developers Console](https://developers.line.biz/console/)
2. Create or select your Messaging API channel
3. Get your:
   - **Channel Access Token** (Issue a long-lived token)
   - **Channel Secret**
4. Enable **Webhooks** in the channel settings
5. Set **Webhook URL** after deploying (will be `https://your-app.railway.app/webhook`)

### 3. Google Cloud Setup

#### 3.1 Create Project & Enable APIs

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the following APIs:
   - [Document AI API](https://console.cloud.google.com/apis/library/documentai.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)

#### 3.2 Create Document AI Processor

1. Go to [Document AI Console](https://console.cloud.google.com/ai/document-ai)
2. Click **Create Processor**
3. Select **Expense Parser** (best for receipts) or **Invoice Parser**
4. Choose a location (e.g., `us`)
5. Create and copy the **Processor ID** from the URL

#### 3.3 Create Service Account

1. Go to [IAM & Admin > Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click **Create Service Account**
3. Name it (e.g., `line-ocr-bot`)
4. Grant roles:
   - **Document AI API User**
   - **Service Account Token Creator** (for Document AI)
5. Click **Done**
6. Click on the service account → **Keys** → **Add Key** → **Create new key** → **JSON**
7. Download the JSON key file

#### 3.4 Base64 Encode the Service Account Key

```bash
# macOS/Linux
base64 -i service-account.json | tr -d '\n' > service-account-base64.txt

# Or use Node.js
node -e "console.log(require('fs').readFileSync('service-account.json').toString('base64'))"
```

Save this base64 string for the `GOOGLE_SERVICE_ACCOUNT_KEY` environment variable.

### 4. Google Drive Setup

1. Create or select a folder in Google Drive
2. Get the **Folder ID** from the URL:
   ```
   https://drive.google.com/drive/folders/FOLDER_ID_HERE
   ```
3. Share the folder with your service account email:
   - Right-click folder → **Share**
   - Add the service account email (e.g., `line-ocr-bot@your-project.iam.gserviceaccount.com`)
   - Give **Editor** access

### 5. Google Sheets Setup

1. Create or select a Google Sheet
2. Get the **Spreadsheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_HERE/edit
   ```
3. Share the sheet with your service account email:
   - Click **Share**
   - Add the service account email
   - Give **Editor** access

### 6. Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# LINE Bot
LINE_CHANNEL_ACCESS_TOKEN=your_token
LINE_CHANNEL_SECRET=your_secret

# Google Cloud
GOOGLE_PROJECT_ID=your-project-id
GOOGLE_LOCATION=us
GOOGLE_PROCESSOR_ID=your-processor-id
GOOGLE_SERVICE_ACCOUNT_KEY=your-base64-encoded-json

# Google Drive
GOOGLE_DRIVE_FOLDER_ID=your-folder-id

# Google Sheets
GOOGLE_SHEET_ID=your-sheet-id
GOOGLE_SHEET_NAME=Sheet1

# Server
PORT=3000
NODE_ENV=development
```

---

## Local Development

### Run the Server

```bash
npm run dev
```

### Test with ngrok

1. Install ngrok: `brew install ngrok` (macOS); see the [doc](https://ngrok.com/docs/guides/getting-started/) for others
2. Run ngrok:
   ```bash
   ngrok http 3000
   ```
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. Set as webhook URL in LINE Developers Console: `https://abc123.ngrok.io/webhook`
5. Send a receipt image via LINE!

---

## Railway Deployment

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: LINE OCR Receipt Processor"
git remote add origin https://github.com/yourusername/your-repo.git
git push -u origin main
```

### 2. Deploy to Railway

1. Go to [Railway](https://railway.app/)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your repository
4. Railway will auto-detect Node.js and deploy

### 3. Set Environment Variables

In Railway dashboard:
1. Click on your service
2. Go to **Variables** tab
3. Add all environment variables from `.env.example`:

| Variable | Value |
|----------|-------|
| `LINE_CHANNEL_ACCESS_TOKEN` | Your LINE token |
| `LINE_CHANNEL_SECRET` | Your LINE secret |
| `GOOGLE_PROJECT_ID` | Your GCP project ID |
| `GOOGLE_LOCATION` | `us` |
| `GOOGLE_PROCESSOR_ID` | Your Document AI processor ID |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Base64 encoded service account JSON |
| `GOOGLE_DRIVE_FOLDER_ID` | Your Drive folder ID |
| `GOOGLE_SHEET_ID` | Your Sheet ID |
| `GOOGLE_SHEET_NAME` | `Sheet1` |
| `NODE_ENV` | `production` |

### 4. Update LINE Webhook URL

1. Get your Railway URL from the dashboard (e.g., `https://your-app.railway.app`)
2. Go to LINE Developers Console
3. Update webhook URL to: `https://your-app.railway.app/webhook`
4. Click **Verify** to test

---

## Usage

### Basic Commands

| Command | Description |
|---------|-------------|
| Send image | Process receipt/invoice with OCR |
| `usage` or `/usage` | Check monthly quota status |
| Any text | Get help message |

### Processing Flow

1. Add your LINE Bot as a friend
2. Send a photo of a receipt or invoice
3. Bot will reply with extracted information:
   - Merchant name
   - Date
   - Total amount
   - Line items
4. Image is saved to Google Drive in a `YYYYMMDD` folder
5. Extracted data is logged to Google Sheets

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with usage stats |
| `GET /usage` | Get current month's quota usage |
| `POST /webhook` | LINE webhook endpoint |

## Google Sheets Output Format

**Multi-row format:** Each invoice creates multiple rows (one per line item + one TOTAL row).

| Column | Header | Description |
| ------ | ------ | ----------- |
| A | Processed At | When OCR was run |
| B | Invoice Number | เลขที่ใบกำกับภาษี |
| C | Invoice Date | วันที่ออก |
| D | Seller Name | ชื่อผู้ขาย |
| E | Seller Tax ID | เลขผู้เสียภาษี (13 digits) |
| F | Seller Branch | สาขา |
| G | Buyer Name | ชื่อผู้ซื้อ (if exists) |
| H | Buyer Tax ID | เลขผู้เสียภาษี ผู้ซื้อ |
| I | Row Type | `ITEM` or `TOTAL` |
| J | Item Description | รายการสินค้า/บริการ |
| K | Quantity | จำนวน |
| L | Unit Price | ราคาต่อหน่วย |
| M | Amount | จำนวนเงิน |
| N | Subtotal | ยอดก่อน VAT |
| O | VAT 7% | ภาษีมูลค่าเพิ่ม |
| P | Grand Total | ยอดรวมทั้งสิ้น |
| Q | Image URL | Link to Google Drive |
| R | Status | For manual verification |
| S | User ID | LINE User ID |
| T | User Name | LINE Display Name |

---

## Troubleshooting

### "Invalid signature" error
- Verify `LINE_CHANNEL_SECRET` is correct
- Ensure no extra whitespace in environment variables

### OCR not extracting data
- Ensure the image is clear and well-lit
- Check Document AI processor is created and ID is correct
- Verify service account has Document AI API User role

### Google Drive upload fails
- Ensure folder is shared with service account email
- Verify `GOOGLE_DRIVE_FOLDER_ID` is correct

### Google Sheets append fails
- Ensure sheet is shared with service account email
- Verify `GOOGLE_SHEET_ID` is correct

---

## Cost Estimation

| Service | Pricing |
|---------|---------|
| Google Document AI | ~$0.10 per page (first 1,000 pages) |
| Railway | Usage-based, ~$5-20/month for light use |
| LINE Messaging API | Free for reply messages |
| Google Drive | Free (or part of Workspace) |
| Google Sheets | Free (or part of Workspace) |

---

## License

ISC
