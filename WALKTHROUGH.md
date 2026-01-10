# LINE OCR Thai Invoice Processor - Walkthrough

## Summary

Built a **LINE Bot** that extracts data from **Thai tax invoices (ใบกำกับภาษี)** using Google Document AI.

---

## Key Features

| Feature | Description |
| ------- | ----------- |
| 🇹🇭 Thai Invoice Support | Extracts Tax ID, Invoice #, Seller/Buyer info |
| 📊 Multi-row Format | One row per line item in Google Sheets |
| 👤 User Tracking | Records LINE User ID & Display Name |
| ⚙️ Configurable Quota | `OCR_MONTHLY_LIMIT` env var (default: 975) |
| 📁 Organized Storage | Images saved to Google Drive in YYYYMMDD folders |

---

## Google Sheets Columns (20 total)

| Col | Field | Col | Field |
| --- | ----- | --- | ----- |
| A | Processed At | K | Quantity |
| B | Invoice Number | L | Unit Price |
| C | Invoice Date | M | Amount |
| D | Seller Name | N | Subtotal |
| E | Seller Tax ID | O | VAT 7% |
| F | Seller Branch | P | Grand Total |
| G | Buyer Name | Q | Image URL |
| H | Buyer Tax ID | R | Status |
| I | Row Type | **S** | **User ID** |
| J | Item Description | **T** | **User Name** |

---

## Modified Files

| File | Changes |
| ---- | ------- |
| [src/services/line.js](file:///Users/bobbymacbookair/Desktop/PTT_WORK/OCR/src/services/line.js) | Added `getUserProfile()` |
| [src/services/ocr.js](file:///Users/bobbymacbookair/Desktop/PTT_WORK/OCR/src/services/ocr.js) | 20-column format with user info |
| [src/index.js](file:///Users/bobbymacbookair/Desktop/PTT_WORK/OCR/src/index.js) | Fetches user profile, passes to sheets |

---

## Next Steps

1. Configure `.env` with all credentials
2. Create Document AI processor (Invoice Parser or Expense Parser)
3. Test: `npm run dev` + ngrok
4. Send Thai receipt via LINE to test
5. Deploy to Railway
