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
 * Output: 18 columns (A-R) for Google Sheets
 */
const INVOICE_PROMPT = `You are a Thai invoice/receipt parser. Analyze this image and extract ALL data accurately.

CRITICAL RULES:
1. Extract ALL line items including: products, services, discounts, service charges, and VAT
2. SUM of all lineItems amounts MUST EQUAL grandTotal
3. For Thai text, preserve the original Thai characters
4. For dates, use ISO format YYYY-MM-DD (e.g., "2026-01-11")

DOCUMENT TYPE - Classify the document:
- "Tax Invoice" = ใบกำกับภาษี (has Tax ID, formal)
- "Receipt" = ใบเสร็จรับเงิน (simple receipt)
- "Credit Note" = ใบลดหนี้ (refund/return document)
- "Quotation" = ใบเสนอราคา (not yet paid)

EXPENSE CATEGORY - Suggest based on content:
- "Food" = restaurants, cafes, groceries
- "Travel" = transport, fuel, parking, hotels
- "Office" = supplies, equipment, furniture
- "Marketing" = advertising, promotions
- "Utilities" = phone, internet, electricity
- "Other" = if unsure

LINE TYPE CLASSIFICATION:
- "item" = regular product/service (positive amount)
- "discount" = ส่วนลด, promotion, member discount (negative amount)
- "credit" = CN/Credit Note, refund, return (negative amount)
- "service" = Service charge, ค่าบริการ (positive amount)
- "vat" = VAT 7%, ภาษีมูลค่าเพิ่ม (positive amount, only if shown as separate line)

CALCULATION RULES:
1. quantity: default to 1 if not shown
2. unitPrice: price per unit
3. amount: unitPrice × quantity (can be negative for discounts)
4. SUM of all amounts = grandTotal

OUTPUT FORMAT - Return ONLY valid JSON, no markdown:
{
  "documentType": "Tax Invoice | Receipt | Credit Note | Quotation",
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "sellerName": "string or null",
  "sellerTaxId": "13-digit string or null",
  "expenseCategory": "Food | Travel | Office | Marketing | Utilities | Other",
  "lineItems": [
    {
      "lineType": "item | discount | credit | service | vat",
      "description": "item name",
      "quantity": 1,
      "unitPrice": 100.00,
      "amount": 100.00
    }
  ],
  "subtotal": "number - sum of items only",
  "vatAmount": "number - 0 if VAT is a line item",
  "grandTotal": "number - must equal sum of all lineItems",
  "confidence": "0.0-1.0"
}

EXAMPLE:
{
  "documentType": "Receipt",
  "invoiceNumber": "SMT006P1290016186",
  "invoiceDate": "2026-01-11",
  "sellerName": "SSamthing Together",
  "sellerTaxId": "0107566000453",
  "expenseCategory": "Food",
  "lineItems": [
    { "lineType": "item", "description": "Signature Set", "quantity": 1, "unitPrice": 699, "amount": 699 },
    { "lineType": "discount", "description": "Member Discount", "quantity": 1, "unitPrice": -70, "amount": -70 },
    { "lineType": "service", "description": "Service Charge 10%", "quantity": 1, "unitPrice": 143.80, "amount": 143.80 },
    { "lineType": "vat", "description": "VAT 7%", "quantity": 1, "unitPrice": 110.73, "amount": 110.73 }
  ],
  "subtotal": 629,
  "vatAmount": 0,
  "grandTotal": 882.53,
  "confidence": 0.92
}`;

/**
 * Required fields for JSON validation
 */
const REQUIRED_FIELDS = ['grandTotal', 'confidence'];
const OPTIONAL_FIELDS = ['documentType', 'invoiceNumber', 'invoiceDate', 'sellerName', 
                          'sellerTaxId', 'expenseCategory', 'lineItems', 'subtotal', 'vatAmount'];

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
 * Normalize and validate invoice data for 18-column layout
 */
function normalizeInvoiceData(data) {
    const lineItems = normalizeLineItems(data.lineItems || []);
    
    // Check if VAT is a separate line item
    const hasVatLineItem = lineItems.some(item => item.lineType === 'vat');
    
    // Validate/default document type
    const validDocTypes = ['Tax Invoice', 'Receipt', 'Credit Note', 'Quotation'];
    let documentType = data.documentType || 'Receipt';
    if (!validDocTypes.includes(documentType)) {
        documentType = 'Receipt';
    }
    
    // Validate/default expense category
    const validCategories = ['Food', 'Travel', 'Office', 'Marketing', 'Utilities', 'Other'];
    let expenseCategory = data.expenseCategory || 'Other';
    if (!validCategories.includes(expenseCategory)) {
        expenseCategory = 'Other';
    }
    
    return {
        documentType: documentType,
        invoiceNumber: data.invoiceNumber || null,
        invoiceDate: normalizeDate(data.invoiceDate),
        sellerName: data.sellerName || null,
        sellerTaxId: extractTaxId(data.sellerTaxId),
        expenseCategory: expenseCategory,
        lineItems: lineItems,
        subtotal: parseNumber(data.subtotal),
        vatAmount: hasVatLineItem ? 0 : parseNumber(data.vatAmount),  // 0 if VAT is a line item
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
 * Normalize line items - includes all types: item, discount, credit, service, vat
 */
function normalizeLineItems(items) {
    if (!Array.isArray(items)) return [];
    
    return items.map((item, index) => {
        const rawAmount = parseNumber(item.amount);
        const rawUnitPrice = parseNumber(item.unitPrice);
        const rawQuantity = parseNumber(item.quantity) || 1;  // Default qty to 1
        
        // Calculate missing values
        let quantity = rawQuantity;
        let unitPrice = rawUnitPrice;
        let amount = rawAmount;
        
        // Fill in missing values based on what we have
        if (amount !== null && unitPrice === null && quantity) {
            // Have amount, missing unitPrice: calculate unitPrice = amount / quantity
            unitPrice = amount / quantity;
        } else if (unitPrice !== null && amount === null && quantity) {
            // Have unitPrice, missing amount: calculate amount = unitPrice * quantity
            amount = unitPrice * quantity;
        } else if (unitPrice === null && amount === null) {
            // Both missing, skip this item
            amount = 0;
        }
        
        // Determine line type (default to 'item' if not specified)
        let lineType = item.lineType?.toLowerCase() || 'item';
        
        // Validate line type
        const validTypes = ['item', 'discount', 'credit', 'service', 'vat'];
        if (!validTypes.includes(lineType)) {
            lineType = 'item';
        }
        
        // Auto-detect type from amount and description if not specified correctly
        if (lineType === 'item' && amount < 0) {
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
            quantity: quantity,
            unitPrice: unitPrice,
            amount: amount || 0,
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
 * 18-column layout: A-R
 */
function formatForSheets(data, imageUrl, timestamp, userInfo = {}) {
    // Header data (columns A-G)
    const headerData = [
        timestamp,                          // A: Processed At
        data.invoiceDate || '',             // B: Invoice Date
        data.invoiceNumber || '',           // C: Invoice Number
        data.documentType || 'Receipt',     // D: Document Type
        data.sellerName || '',              // E: Seller Name
        data.sellerTaxId || '',             // F: Seller Tax ID
        data.expenseCategory || 'Other',    // G: Expense Category
    ];

    // Totals data (columns N-R)
    const totalsData = [
        data.subtotal || '',                // N: Subtotal
        data.vatAmount || '',               // O: VAT 7%
        data.grandTotal || '',              // P: Grand Total
        imageUrl || '',                     // Q: Image URL
        data.confidence?.toFixed(2) || '',  // R: Confidence
    ];

    const rows = [];

    if (data.lineItems.length === 0) {
        rows.push([
            ...headerData,
            '',                             // H: Item #
            '',                             // I: Line Type
            '',                             // J: Description
            '',                             // K: Quantity
            '',                             // L: Unit Price
            '',                             // M: Amount
            ...totalsData,
        ]);
    } else {
        data.lineItems.forEach(item => {
            rows.push([
                ...headerData,
                String(item.itemNumber),    // H: Item #
                item.lineType || 'item',    // I: Line Type
                item.description || '',     // J: Description
                item.quantity || 1,         // K: Quantity
                item.unitPrice || '',       // L: Unit Price
                item.amount || '',          // M: Amount
                ...totalsData,
            ]);
        });
    }

    return rows;
}

/**
 * Get sheet headers (18 columns: A-R)
 */
function getSheetHeaders() {
    return [
        'Processed At',      // A
        'Invoice Date',      // B
        'Invoice Number',    // C
        'Document Type',     // D
        'Seller Name',       // E
        'Seller Tax ID',     // F
        'Expense Category',  // G
        'Item #',            // H
        'Line Type',         // I
        'Description',       // J
        'Quantity',          // K
        'Unit Price',        // L
        'Amount',            // M (renamed from Line Amount)
        'Subtotal',          // N
        'VAT 7%',            // O
        'Grand Total',       // P
        'Image URL',         // Q
        'Confidence',        // R
    ];
}

module.exports = {
    parseInvoice,
    formatForSheets,
    getSheetHeaders,
    isDebugMode,
};
