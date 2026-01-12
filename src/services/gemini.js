/**
 * Gemini AI Service - Invoice Parser
 * Uses Gemini Vision to extract structured data from invoice images
 * Features: Model fallback, JSON validation, configurable model
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini client
let genAI = null;

// Model fallback chain (try in order)
const MODEL_FALLBACK_CHAIN = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
];

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
 * Get the model to use (from env or default with fallback support)
 */
function getModelName() {
    return process.env.GEMINI_MODEL || MODEL_FALLBACK_CHAIN[0];
}

/**
 * The invoice parsing prompt - instructs Gemini to extract structured data
 */
const INVOICE_PROMPT = `You are a Thai invoice/receipt parser. Analyze this image and extract ALL data accurately.

CRITICAL RULES:
1. Count ALL line items including products, services, discounts, and credit notes
2. Return EXACTLY that many items in lineItems array
3. If an item spans multiple lines, combine them into one item
4. INCLUDE discounts and credit notes - they are valid line items with negative amounts
5. For Thai text, preserve the original Thai characters
6. Calculate confidence based on image clarity and how certain you are
7. For dates, use ISO format YYYY-MM-DD (e.g., "2026-01-11")
8. Classify each line item type:
   - "item" = regular product/service (positive amount)
   - "discount" = ส่วนลด, promotion, discount (negative amount)
   - "credit" = CN/Credit Note, refund, return (negative amount)

OUTPUT FORMAT - Return ONLY valid JSON, no markdown, no explanation:
{
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD format or null",
  "sellerName": "string or null",
  "sellerTaxId": "string (13 digits) or null",
  "sellerBranch": "string or null",
  "buyerName": "string or null",
  "buyerTaxId": "string or null",
  "lineItems": [
    {
      "lineType": "item | discount | credit",
      "description": "product/service/discount name",
      "quantity": "number as string or null",
      "unitPrice": "number or null",
      "amount": "number (can be negative for discounts/credits)"
    }
  ],
  "subtotal": "number or null",
  "vatAmount": "number or null",
  "grandTotal": "number (required - net after all discounts)",
  "confidence": "number 0.0-1.0 based on extraction certainty"
}

EXAMPLES:
- Regular product = { "lineType": "item", "description": "Massage 60 min", "amount": 1200 }
- Discount line = { "lineType": "discount", "description": "ส่วนลด 10%", "amount": -120 }
- Credit note = { "lineType": "credit", "description": "CN5302-00001", "amount": -97865.84 }
- If document shows "DN" prefix = item, "CN" prefix = credit`;

/**
 * Required fields for JSON validation
 */
const REQUIRED_FIELDS = ['grandTotal', 'confidence'];
const OPTIONAL_FIELDS = ['invoiceNumber', 'invoiceDate', 'sellerName', 'sellerTaxId', 
                          'sellerBranch', 'buyerName', 'buyerTaxId', 'lineItems', 
                          'subtotal', 'vatAmount'];

/**
 * Validate JSON schema from Gemini response
 */
function validateJsonSchema(data) {
    const errors = [];
    
    // Check required fields
    for (const field of REQUIRED_FIELDS) {
        if (data[field] === undefined || data[field] === null) {
            errors.push(`Missing required field: ${field}`);
        }
    }
    
    // Validate lineItems is an array
    if (data.lineItems && !Array.isArray(data.lineItems)) {
        errors.push('lineItems must be an array');
    }
    
    // Validate confidence is a number between 0-1
    if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) {
        // Try to parse it
        const conf = parseFloat(data.confidence);
        if (isNaN(conf)) {
            errors.push('confidence must be a number between 0 and 1');
        }
    }
    
    // Validate grandTotal is a number
    if (data.grandTotal !== null && data.grandTotal !== undefined) {
        const total = parseNumber(data.grandTotal);
        if (total === null) {
            errors.push('grandTotal must be a valid number');
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors,
    };
}

/**
 * Check if debug mode is enabled
 */
function isDebugMode() {
    return process.env.VERBOSE_DEBUG_MODE === 'true';
}

/**
 * Process an invoice image with Gemini Vision
 * Features: Model fallback chain, retries, JSON validation
 * @param {Buffer} imageBuffer - The image data
 * @param {string} mimeType - Image MIME type
 * @returns {Promise<Object>} Parsed invoice data
 */
async function parseInvoice(imageBuffer, mimeType = 'image/jpeg') {
    const maxRetries = 3;
    const modelsToTry = [getModelName(), ...MODEL_FALLBACK_CHAIN.filter(m => m !== getModelName())];
    let lastError;

    for (const modelName of modelsToTry) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const client = getClient();
                const model = client.getGenerativeModel({ model: modelName });

                if (isDebugMode()) {
                    logger.info(`[DEBUG] Using model: ${modelName} (attempt ${attempt}/${maxRetries})`);
                }

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

                if (isDebugMode()) {
                    logger.info(`[DEBUG] Gemini raw response length: ${text.length}`);
                }

                // Parse JSON from response
                const jsonData = parseJsonResponse(text);
                
                // Validate JSON schema
                const validation = validateJsonSchema(jsonData);
                if (!validation.isValid) {
                    logger.warn('JSON validation warnings', { errors: validation.errors });
                    // Continue anyway but log the issues
                }
                
                // Normalize data
                const normalizedData = normalizeInvoiceData(jsonData);

                if (isDebugMode()) {
                    logger.info('[DEBUG] Invoice parsed successfully', {
                        model: modelName,
                        itemCount: normalizedData.lineItems.length,
                        grandTotal: normalizedData.grandTotal,
                        confidence: normalizedData.confidence,
                    });
                }

                return normalizedData;
            } catch (error) {
                lastError = error;
                
                // Check if rate limit error - retry with backoff
                if (error.message && error.message.includes('429')) {
                    const waitTime = Math.pow(2, attempt) * 5000;
                    if (isDebugMode()) {
                        logger.warn(`[DEBUG] Rate limit hit, waiting ${waitTime/1000}s before retry...`);
                    }
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
                
                // Model not found - try next model
                if (error.message && error.message.includes('404')) {
                    if (isDebugMode()) {
                        logger.warn(`[DEBUG] Model ${modelName} not found, trying next...`);
                    }
                    break; // Break inner loop, try next model
                }
                
                // Other error - throw immediately
                throw error;
            }
        }
    }

    logger.error('Failed to parse invoice after all models and retries', lastError);
    throw lastError;
}

/**
 * Parse JSON from Gemini response (handles markdown code blocks)
 */
function parseJsonResponse(text) {
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
        invoiceDate: normalizeDate(data.invoiceDate),
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
 * Normalize date to YYYY-MM-DD format (prevents Excel serial number issue)
 */
function normalizeDate(dateStr) {
    if (!dateStr) return null;
    
    // If already in ISO format, return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr;
    }
    
    // Try to parse various date formats
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
        // Return as YYYY-MM-DD string (prevents Excel auto-conversion)
        return parsed.toISOString().split('T')[0];
    }
    
    // If can't parse, return original string prefixed with apostrophe (forces text in Excel)
    return `'${dateStr}`;
}

/**
 * Normalize line items - includes discounts and credit notes
 */
function normalizeLineItems(items) {
    if (!Array.isArray(items)) return [];
    
    return items.map((item, index) => {
        const amount = parseNumber(item.amount) || 0;
        
        // Determine line type (default to 'item' if not specified)
        let lineType = item.lineType?.toLowerCase() || 'item';
        
        // Auto-detect type from amount if not specified
        if (lineType === 'item' && amount < 0) {
            // Check if description suggests credit or discount
            const desc = (item.description || '').toLowerCase();
            if (desc.includes('cn') || desc.includes('credit') || desc.includes('refund')) {
                lineType = 'credit';
            } else {
                lineType = 'discount';
            }
        }
        
        return {
            itemNumber: index + 1,
            lineType: lineType,
            description: item.description || '',
            quantity: item.quantity || null,
            unitPrice: parseNumber(item.unitPrice),
            amount: amount,
        };
    }).filter(item => item.description && item.amount !== 0);
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
 * Column layout: A-H (header), I (item#), J (lineType), K (desc), L (qty), M (price), N (amount), O-V (totals)
 */
function formatForSheets(data, imageUrl, timestamp, userInfo = {}) {
    // Header data (columns A-H)
    const headerData = [
        timestamp,                          // A: Processed At
        data.invoiceNumber || '',           // B: Invoice Number
        data.invoiceDate || '',             // C: Invoice Date (now normalized)
        data.sellerName || '',              // D: Seller Name
        data.sellerTaxId || '',             // E: Seller Tax ID
        data.sellerBranch || '',            // F: Seller Branch
        data.buyerName || '',               // G: Buyer Name
        data.buyerTaxId || '',              // H: Buyer Tax ID
    ];

    // Totals data (columns O-V)
    const totalsData = [
        data.subtotal || '',                // O: Subtotal
        data.vatAmount || '',               // P: VAT 7%
        data.grandTotal || '',              // Q: Grand Total
        imageUrl || '',                     // R: Image URL
        '',                                 // S: Status (for manual verification)
        userInfo.userId || '',              // T: User ID
        userInfo.displayName || '',         // U: User Name
        data.confidence?.toFixed(2) || '',  // V: Confidence
    ];

    const rows = [];

    if (data.lineItems.length === 0) {
        rows.push([
            ...headerData,
            '',                             // I: Item #
            '',                             // J: Line Type
            '',                             // K: Item Description
            '',                             // L: Quantity
            '',                             // M: Unit Price
            '',                             // N: Line Amount
            ...totalsData,
        ]);
    } else {
        data.lineItems.forEach(item => {
            rows.push([
                ...headerData,
                String(item.itemNumber),    // I: Item #
                item.lineType || 'item',    // J: Line Type (item/discount/credit)
                item.description || '',     // K: Item Description
                item.quantity || '',        // L: Quantity
                item.unitPrice || '',       // M: Unit Price
                item.amount || '',          // N: Line Amount
                ...totalsData,
            ]);
        });
    }

    return rows;
}

/**
 * Get sheet headers (22 columns: A-V)
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
        'Line Type',         // J (NEW: item/discount/credit)
        'Item Description',  // K
        'Quantity',          // L
        'Unit Price',        // M
        'Line Amount',       // N
        'Subtotal',          // O
        'VAT 7%',            // P
        'Grand Total',       // Q
        'Image URL',         // R
        'Status',            // S
        'User ID',           // T
        'User Name',         // U
        'Confidence',        // V
    ];
}

module.exports = {
    parseInvoice,
    formatForSheets,
    getSheetHeaders,
    isDebugMode,
};
