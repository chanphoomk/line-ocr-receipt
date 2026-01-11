/**
 * OCR Service - Google Document AI
 * Processes Thai receipt/invoice images and extracts structured data
 * 
 * Supports Thai Tax Invoice (ใบกำกับภาษี) fields:
 * - Seller/Buyer info with Tax ID
 * - Invoice number and date
 * - Line items with qty, unit price, amount
 * - Subtotal, VAT 7%, Grand Total
 */

const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
const config = require('../config/env');
const logger = require('../utils/logger');

// Initialize Document AI client with credentials
let client = null;

function getClient() {
    if (!client) {
        const credentials = config.google.getCredentials();
        client = new DocumentProcessorServiceClient({
            credentials,
            projectId: config.google.projectId,
        });
    }
    return client;
}

/**
 * Process an image through Document AI
 * @param {Buffer} imageBuffer - The image buffer to process
 * @param {string} mimeType - The MIME type of the image
 * @returns {Promise<Object>} Extracted invoice data
 */
async function processReceipt(imageBuffer, mimeType = 'image/jpeg') {
    try {
        const documentAiClient = getClient();

        const processorName = `projects/${config.google.projectId}/locations/${config.google.location}/processors/${config.google.processorId}`;

        logger.info(`Processing receipt with Document AI: ${processorName}`);

        const request = {
            name: processorName,
            rawDocument: {
                content: imageBuffer.toString('base64'),
                mimeType,
            },
        };

        const [result] = await documentAiClient.processDocument(request);
        const { document } = result;

        // Extract Thai invoice data
        const extractedData = parseThaiInvoice(document);

        logger.info('Invoice processed successfully', {
            textLength: document.text?.length || 0,
            entitiesFound: extractedData.entities?.length || 0,
            lineItemsFound: extractedData.lineItems?.length || 0,
        });

        return extractedData;
    } catch (error) {
        logger.error('Failed to process invoice with Document AI', error);
        throw error;
    }
}

/**
 * Parse Document AI response for Thai invoice fields
 * @param {Object} document - Document AI document response
 * @returns {Object} Structured Thai invoice data
 */
function parseThaiInvoice(document) {
    const data = {
        rawText: document.text || '',
        
        // Invoice info
        invoiceNumber: null,
        invoiceDate: null,
        
        // Seller info
        sellerName: null,
        sellerTaxId: null,
        sellerBranch: null,
        sellerAddress: null,
        
        // Buyer info
        buyerName: null,
        buyerTaxId: null,
        buyerAddress: null,
        
        // Amounts
        subtotal: null,
        vatAmount: null,
        grandTotal: null,
        
        // Line items
        lineItems: [],
        
        // Raw entities for debugging
        entities: [],
    };

    // Extract entities from the document
    if (document.entities && document.entities.length > 0) {
        for (const entity of document.entities) {
            const entityData = {
                type: entity.type,
                mentionText: entity.mentionText,
                confidence: entity.confidence,
            };
            data.entities.push(entityData);

            // Map entity types to Thai invoice fields
            const type = entity.type?.toLowerCase() || '';
            const text = entity.mentionText?.trim() || '';

            // Invoice identification
            if (type.includes('invoice_id') || type.includes('invoice_number') || type.includes('receipt_number')) {
                data.invoiceNumber = text;
            }
            
            // Dates
            if (type.includes('invoice_date') || type.includes('receipt_date') || type === 'date') {
                data.invoiceDate = text;
            }

            // Seller/Supplier info
            if (type.includes('supplier_name') || type.includes('vendor_name') || type.includes('seller_name')) {
                data.sellerName = text;
            }
            if (type.includes('supplier_tax_id') || type.includes('vendor_tax_id') || type.includes('supplier_id')) {
                data.sellerTaxId = extractTaxId(text);
            }
            if (type.includes('supplier_address') || type.includes('vendor_address')) {
                data.sellerAddress = text;
            }

            // Buyer/Receiver info
            if (type.includes('receiver_name') || type.includes('buyer_name') || type.includes('customer_name') || type.includes('ship_to_name')) {
                data.buyerName = text;
            }
            if (type.includes('receiver_tax_id') || type.includes('buyer_tax_id') || type.includes('customer_id')) {
                data.buyerTaxId = extractTaxId(text);
            }
            if (type.includes('receiver_address') || type.includes('buyer_address') || type.includes('ship_to_address')) {
                data.buyerAddress = text;
            }

            // Amounts
            if (type.includes('subtotal') || type === 'net_amount') {
                data.subtotal = extractAmount(text);
            }
            if (type.includes('tax_amount') || type.includes('total_tax') || type.includes('vat')) {
                data.vatAmount = extractAmount(text);
            }
            if (type.includes('total_amount') || type.includes('grand_total') || type === 'total') {
                data.grandTotal = extractAmount(text);
            }

            // Line items
            if (type === 'line_item') {
                const lineItem = parseLineItem(entity);
                if (lineItem) {
                    data.lineItems.push(lineItem);
                }
            }
        }
    }

    // Try to extract from raw text if entities are missing
    if (!data.sellerTaxId || !data.invoiceNumber) {
        extractFromRawText(data);
    }

    // Extract branch from seller name or address
    if (!data.sellerBranch) {
        data.sellerBranch = extractBranch(data.sellerName, data.sellerAddress, data.rawText);
    }

    return data;
}

/**
 * Parse a line item entity
 * @param {Object} entity - Line item entity
 * @returns {Object} Parsed line item
 */
function parseLineItem(entity) {
    const item = {
        description: entity.mentionText?.trim() || '',
        quantity: null,
        unitPrice: null,
        amount: null,
    };

    if (entity.properties) {
        for (const prop of entity.properties) {
            const propType = prop.type?.toLowerCase() || '';
            const propText = prop.mentionText?.trim() || '';

            if (propType.includes('description') || propType.includes('product')) {
                item.description = propText;
            }
            if (propType.includes('quantity') || propType.includes('qty')) {
                item.quantity = extractNumber(propText);
            }
            if (propType.includes('unit_price') || propType.includes('price')) {
                item.unitPrice = extractAmount(propText);
            }
            if (propType.includes('amount') || propType.includes('line_total')) {
                item.amount = extractAmount(propText);
            }
        }
    }

    return item;
}

/**
 * Extract 13-digit Thai Tax ID from text
 * @param {string} text - Text containing tax ID
 * @returns {string|null} Extracted tax ID
 */
function extractTaxId(text) {
    if (!text) return null;
    
    // Remove spaces, dashes, and other separators
    const cleaned = text.replace(/[\s\-\.]/g, '');
    
    // Look for 13-digit number (Thai Tax ID format)
    const match = cleaned.match(/\d{13}/);
    if (match) {
        return match[0];
    }
    
    // Return cleaned text if it looks like a tax ID
    if (/^\d+$/.test(cleaned) && cleaned.length >= 10) {
        return cleaned;
    }
    
    return text;
}

/**
 * Extract numeric amount from text
 * @param {string} text - Text containing amount
 * @returns {string|null} Extracted amount
 */
function extractAmount(text) {
    if (!text) return null;
    
    // Remove Thai Baht symbol, commas, spaces
    const cleaned = text.replace(/[฿,\s]/g, '').replace(/บาท/g, '');
    
    // Extract number with decimals
    const match = cleaned.match(/[\d,]+\.?\d*/);
    if (match) {
        return match[0].replace(/,/g, '');
    }
    
    return text;
}

/**
 * Extract numeric value from text
 * @param {string} text - Text containing number
 * @returns {string|null} Extracted number
 */
function extractNumber(text) {
    if (!text) return null;
    
    const match = text.match(/[\d,]+\.?\d*/);
    if (match) {
        return match[0].replace(/,/g, '');
    }
    
    return text;
}

/**
 * Extract branch info from text
 * @param {string} sellerName - Seller name
 * @param {string} sellerAddress - Seller address
 * @param {string} rawText - Full document text
 * @returns {string|null} Branch info
 */
function extractBranch(sellerName, sellerAddress, rawText) {
    const textToSearch = `${sellerName || ''} ${sellerAddress || ''} ${rawText || ''}`;
    
    // Look for "สำนักงานใหญ่" (Head Office)
    if (textToSearch.includes('สำนักงานใหญ่')) {
        return 'สำนักงานใหญ่';
    }
    
    // Look for branch number pattern "สาขา XXXXX" or "สาขาที่ XXXXX"
    const branchMatch = textToSearch.match(/สาขา(?:ที่)?\s*(\d{5}|\d+)/);
    if (branchMatch) {
        return `สาขา ${branchMatch[1]}`;
    }
    
    return null;
}

/**
 * Extract data from raw text using regex patterns
 * @param {Object} data - Data object to populate
 */
function extractFromRawText(data) {
    const text = data.rawText;
    
    // Thai Tax ID pattern (13 digits, may have dashes)
    if (!data.sellerTaxId) {
        const taxIdMatch = text.match(/เลข(?:ประจำตัว)?(?:ผู้เสียภาษี|ภาษีอากร)[:\s]*(\d[\d\-\s]{11,16}\d)/);
        if (taxIdMatch) {
            data.sellerTaxId = extractTaxId(taxIdMatch[1]);
        } else {
            // Look for standalone 13-digit number
            const standaloneMatch = text.match(/(?<!\d)\d{13}(?!\d)/);
            if (standaloneMatch) {
                data.sellerTaxId = standaloneMatch[0];
            }
        }
    }
    
    // Invoice number patterns
    if (!data.invoiceNumber) {
        const invoicePatterns = [
            /เลขที่[:\s]*([A-Za-z0-9\-\/]+)/,
            /Invoice\s*(?:No\.?|#)?[:\s]*([A-Za-z0-9\-\/]+)/i,
            /(?:INV|REC|TAX)[:\s\-]*(\d+)/i,
        ];
        
        for (const pattern of invoicePatterns) {
            const match = text.match(pattern);
            if (match) {
                data.invoiceNumber = match[1].trim();
                break;
            }
        }
    }
    
    // Date patterns
    if (!data.invoiceDate) {
        const datePatterns = [
            /วันที่[:\s]*(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})/,
            /(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})/,
            /(\d{1,2}\s+(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+\d{2,4})/,
        ];
        
        for (const pattern of datePatterns) {
            const match = text.match(pattern);
            if (match) {
                data.invoiceDate = match[1].trim();
                break;
            }
        }
    }
}

/**
 * Filter out invalid line items (discounts, fees, empty items)
 * @param {Array} lineItems - Raw line items from OCR
 * @returns {Array} Filtered valid line items
 */
function filterValidLineItems(lineItems) {
    if (!lineItems || !Array.isArray(lineItems)) {
        return [];
    }

    const invalidPatterns = [
        /discount/i,
        /ส่วนลด/,
        /service\s*charge/i,
        /ค่าบริการ/,
        /promotion/i,
        /โปรโมชั่น/,
        /rounding/i,
        /ปัดเศษ/,
        /vat/i,
        /ภาษี/,
        /^sub\s*total/i,
        /^total/i,
        /^net/i,
    ];

    return lineItems.filter(item => {
        // Must have a description
        if (!item.description || item.description.trim().length < 2) {
            return false;
        }

        // Skip if description matches invalid patterns
        const desc = item.description.toLowerCase();
        for (const pattern of invalidPatterns) {
            if (pattern.test(desc)) {
                return false;
            }
        }

        // Skip if amount is 0, negative, or empty
        const amount = parseFloat(String(item.amount).replace(/[^0-9.-]/g, ''));
        if (isNaN(amount) || amount <= 0) {
            return false;
        }

        return true;
    });
}

/**
 * Format extracted data for Google Sheets
 * - 0 items: 1 row with invoice header + totals
 * - 1 item: 1 row with invoice header + item + totals (all together)
 * - N items: N rows, each with invoice header + one item + totals
 * 
 * @param {Object} data - Extracted invoice data
 * @param {string} imageUrl - URL of the saved image
 * @param {string} timestamp - Processing timestamp
 * @param {Object} userInfo - LINE user info {userId, displayName}
 * @returns {Array<Array>} Array of rows for sheets
 */
function formatForSheets(data, imageUrl, timestamp, userInfo = {}) {
    // Filter valid line items
    const validItems = filterValidLineItems(data.lineItems);
    
    // Common invoice header data (columns A-H)
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
    
    // Common totals data (columns N-T)
    const totalsData = [
        data.subtotal || '',                // N: Subtotal
        data.vatAmount || '',               // O: VAT 7%
        data.grandTotal || '',              // P: Grand Total
        imageUrl || '',                     // Q: Image URL
        '',                                 // R: Status
        userInfo.userId || '',              // S: User ID
        userInfo.displayName || '',         // T: User Name
    ];
    
    const rows = [];
    
    if (validItems.length === 0) {
        // No items: 1 row with header + empty item columns + totals
        rows.push([
            ...headerData,
            '',                             // I: Item #
            '',                             // J: Item Description
            '',                             // K: Quantity
            '',                             // L: Unit Price
            '',                             // M: Line Amount
            ...totalsData,
        ]);
    } else if (validItems.length === 1) {
        // 1 item: 1 row with everything combined
        const item = validItems[0];
        rows.push([
            ...headerData,
            '1',                            // I: Item #
            item.description || '',         // J: Item Description
            item.quantity || '',            // K: Quantity
            item.unitPrice || '',           // L: Unit Price
            item.amount || '',              // M: Line Amount
            ...totalsData,
        ]);
    } else {
        // Multiple items: N rows, each with header + item + totals
        validItems.forEach((item, index) => {
            rows.push([
                ...headerData,
                String(index + 1),          // I: Item #
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
 * Get the header row for sheets initialization
 * @returns {Array} Header row
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
        'Item #',            // I - Item number (1, 2, 3... or blank)
        'Item Description',  // J
        'Quantity',          // K
        'Unit Price',        // L
        'Line Amount',       // M - Amount for this line item
        'Subtotal',          // N - Invoice subtotal
        'VAT 7%',            // O
        'Grand Total',       // P - Invoice total
        'Image URL',         // Q
        'Status',            // R
        'User ID',           // S - LINE User ID
        'User Name',         // T - LINE Display Name
    ];
}

module.exports = {
    processReceipt,
    parseThaiInvoice,
    formatForSheets,
    getSheetHeaders,
    extractTaxId,
    extractAmount,
};

