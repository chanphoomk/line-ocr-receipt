/**
 * Gemini AI Service - Invoice Parser
 * Uses Gemini 2.0 Flash Vision to extract structured data from invoice images
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini client
let genAI = null;

function getClient() {
    if (!genAI) {
        const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GOOGLE_GEMINI_API_KEY is not set');
        }
        genAI = new GoogleGenerativeAI(apiKey);
    }
    return genAI;
}

/**
 * The invoice parsing prompt - instructs Gemini to extract structured data
 */
const INVOICE_PROMPT = `You are a Thai invoice/receipt parser. Analyze this image and extract ALL data accurately.

CRITICAL RULES:
1. Count ALL line items (products/services) in the invoice
2. Return EXACTLY that many items in lineItems array
3. If an item spans multiple lines, combine them into one item
4. Skip discount lines, service charges, and totals - only extract actual products/services
5. For Thai text, preserve the original Thai characters
6. Calculate confidence based on image clarity and how certain you are

OUTPUT FORMAT - Return ONLY valid JSON, no markdown, no explanation:
{
  "invoiceNumber": "string or null",
  "invoiceDate": "string or null",
  "sellerName": "string or null",
  "sellerTaxId": "string (13 digits) or null",
  "sellerBranch": "string or null",
  "buyerName": "string or null",
  "buyerTaxId": "string or null",
  "lineItems": [
    {
      "description": "product/service name",
      "quantity": "number as string or null",
      "unitPrice": "number or null",
      "amount": "number (line total)"
    }
  ],
  "subtotal": "number or null",
  "vatAmount": "number or null",
  "grandTotal": "number (required)",
  "confidence": "number 0.0-1.0 based on extraction certainty"
}

EXAMPLES:
- If receipt shows 1 massage service = 1 lineItem
- If receipt shows 2 different products = 2 lineItems
- "Promotion & Discount" is NOT a lineItem, skip it
- "Service Charge 10%" is NOT a lineItem, skip it`;

/**
 * Process an invoice image with Gemini Vision
 * @param {Buffer} imageBuffer - The image data
 * @param {string} mimeType - Image MIME type
 * @returns {Promise<Object>} Parsed invoice data
 */
async function parseInvoice(imageBuffer, mimeType = 'image/jpeg') {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const client = getClient();
            // Use gemini-1.5-flash which has higher free tier limits (1500 RPD)
            const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });

            logger.info(`Processing invoice with Gemini Vision (attempt ${attempt}/${maxRetries})...`);

            // Prepare image for Gemini
            const imagePart = {
                inlineData: {
                    data: imageBuffer.toString('base64'),
                    mimeType,
                },
            };

            // Generate content
            const result = await model.generateContent([INVOICE_PROMPT, imagePart]);
            const response = await result.response;
            const text = response.text();

            logger.info('Gemini response received', { responseLength: text.length });

            // Parse JSON from response
            const jsonData = parseJsonResponse(text);
            
            // Validate and normalize data
            const normalizedData = normalizeInvoiceData(jsonData);

            logger.info('Invoice parsed successfully', {
                itemCount: normalizedData.lineItems.length,
                grandTotal: normalizedData.grandTotal,
                confidence: normalizedData.confidence,
            });

            return normalizedData;
        } catch (error) {
            lastError = error;
            
            // Check if rate limit error
            if (error.message && error.message.includes('429')) {
                const waitTime = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s
                logger.warn(`Rate limit hit, waiting ${waitTime/1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }
            
            // Non-rate-limit error, throw immediately
            throw error;
        }
    }

    logger.error('Failed to parse invoice after all retries', lastError);
    throw lastError;
}

/**
 * Parse JSON from Gemini response (handles markdown code blocks)
 */
function parseJsonResponse(text) {
    // Remove markdown code blocks if present
    let jsonStr = text.trim();
    
    // Handle ```json ... ``` format
    if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    
    try {
        return JSON.parse(jsonStr);
    } catch (error) {
        logger.error('Failed to parse JSON response', { text: jsonStr.substring(0, 500) });
        throw new Error('Invalid JSON response from Gemini');
    }
}

/**
 * Normalize and validate invoice data
 */
function normalizeInvoiceData(data) {
    return {
        invoiceNumber: data.invoiceNumber || null,
        invoiceDate: data.invoiceDate || null,
        sellerName: data.sellerName || null,
        sellerTaxId: extractTaxId(data.sellerTaxId),
        sellerBranch: data.sellerBranch || null,
        buyerName: data.buyerName || null,
        buyerTaxId: extractTaxId(data.buyerTaxId),
        lineItems: normalizeLineItems(data.lineItems || []),
        subtotal: parseNumber(data.subtotal),
        vatAmount: parseNumber(data.vatAmount),
        grandTotal: parseNumber(data.grandTotal) || 0,
        confidence: Math.min(1, Math.max(0, parseFloat(data.confidence) || 0.5)),
    };
}

/**
 * Normalize line items
 */
function normalizeLineItems(items) {
    if (!Array.isArray(items)) return [];
    
    return items.map((item, index) => ({
        itemNumber: index + 1,
        description: item.description || '',
        quantity: item.quantity || null,
        unitPrice: parseNumber(item.unitPrice),
        amount: parseNumber(item.amount) || 0,
    })).filter(item => item.description && item.amount > 0);
}

/**
 * Extract 13-digit Thai Tax ID
 */
function extractTaxId(text) {
    if (!text) return null;
    const match = String(text).match(/\d{13}/);
    return match ? match[0] : null;
}

/**
 * Parse number from various formats
 */
function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

/**
 * Format parsed invoice data for Google Sheets
 * @param {Object} data - Parsed invoice data from Gemini
 * @param {string} imageUrl - URL of saved image
 * @param {string} timestamp - Processing timestamp
 * @param {Object} userInfo - LINE user info
 * @returns {Array<Array>} Rows for sheets
 */
function formatForSheets(data, imageUrl, timestamp, userInfo = {}) {
    // Common header data (columns A-H)
    const headerData = [
        timestamp,                          // A: Processed At
        data.invoiceNumber || '',           // B: Invoice Number
        data.invoiceDate || '',             // C: Invoice Date
        data.sellerName || '',              // D: Seller Name
        data.sellerTaxId || '',             // E: Seller Tax ID
        data.sellerBranch || '',            // F: Seller Branch
        data.buyerName || '',               // G: Buyer Name
        data.buyerTaxId || '',              // H: Buyer Tax ID
    ];

    // Common totals data (columns N-U)
    const totalsData = [
        data.subtotal || '',                // N: Subtotal
        data.vatAmount || '',               // O: VAT 7%
        data.grandTotal || '',              // P: Grand Total
        imageUrl || '',                     // Q: Image URL
        '',                                 // R: Status
        userInfo.userId || '',              // S: User ID
        userInfo.displayName || '',         // T: User Name
        data.confidence?.toFixed(2) || '',  // U: Confidence (NEW)
    ];

    const rows = [];

    if (data.lineItems.length === 0) {
        // No items: 1 row with empty item columns
        rows.push([
            ...headerData,
            '',                             // I: Item #
            '',                             // J: Item Description
            '',                             // K: Quantity
            '',                             // L: Unit Price
            '',                             // M: Line Amount
            ...totalsData,
        ]);
    } else {
        // N items: N rows, each with header + item + totals
        data.lineItems.forEach(item => {
            rows.push([
                ...headerData,
                String(item.itemNumber),    // I: Item #
                item.description || '',     // J: Item Description
                item.quantity || '',        // K: Quantity
                item.unitPrice || '',       // L: Unit Price
                item.amount || '',          // M: Line Amount
                ...totalsData,
            ]);
        });
    }

    return rows;
}

/**
 * Get sheet headers including confidence column
 */
function getSheetHeaders() {
    return [
        'Processed At',      // A
        'Invoice Number',    // B
        'Invoice Date',      // C
        'Seller Name',       // D
        'Seller Tax ID',     // E
        'Seller Branch',     // F
        'Buyer Name',        // G
        'Buyer Tax ID',      // H
        'Item #',            // I
        'Item Description',  // J
        'Quantity',          // K
        'Unit Price',        // L
        'Line Amount',       // M
        'Subtotal',          // N
        'VAT 7%',            // O
        'Grand Total',       // P
        'Image URL',         // Q
        'Status',            // R
        'User ID',           // S
        'User Name',         // T
        'Confidence',        // U (NEW)
    ];
}

module.exports = {
    parseInvoice,
    formatForSheets,
    getSheetHeaders,
};
