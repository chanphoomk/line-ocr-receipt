/**
 * LINE OCR Receipt Processor
 * Single-Corp Version - Simple deployment for single customer
 */

const express = require('express');
const config = require('./config/env');
const logger = require('./utils/logger');
const { formatDateTime } = require('./utils/date');
const lineService = require('./services/line');
const geminiService = require('./services/gemini');
const driveService = require('./services/drive');
const sheetsService = require('./services/sheets');
const usageService = require('./services/usage');

const app = express();

// In-memory cache for retry (stores last failed image per user)
// Format: { [userId]: { imageBuffer, messageId, timestamp } }
const retryCache = new Map();
const RETRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clean up expired retry cache entries
 */
function cleanupRetryCache() {
    const now = Date.now();
    for (const [userId, data] of retryCache.entries()) {
        if (now - data.timestamp > RETRY_CACHE_TTL) {
            retryCache.delete(userId);
        }
    }
}

// Clean up cache every minute
setInterval(cleanupRetryCache, 60 * 1000);

// Health check endpoint (before LINE middleware) - MUST be simple and fast
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: config.server.nodeEnv,
    });
});

// Usage stats endpoint
app.get('/usage', async (req, res) => {
    try {
        const stats = await usageService.getUsageStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// LINE webhook endpoint with signature verification
app.post('/webhook', lineService.getMiddleware(), async (req, res) => {
    // Respond immediately to LINE (required within a few seconds)
    res.status(200).json({ success: true });

    // Process events asynchronously
    const events = req.body.events || [];

    for (const event of events) {
        try {
            await handleEvent(event);
        } catch (error) {
            logger.error('Event handling failed', {
                eventType: event.type,
                error: error.message
            });
        }
    }
});

/**
 * Handle a single webhook event
 * @param {Object} event - LINE webhook event
 */
async function handleEvent(event) {
    const userId = event.source?.userId;
    
    logger.info('Received event', {
        type: event.type,
        messageType: event.message?.type,
        userId,
    });

    // Handle follow event (user adds bot as friend)
    if (event.type === 'follow') {
        await handleFollowEvent(event, userId);
        return;
    }

    // Handle postback (retry button)
    if (event.type === 'postback') {
        await handlePostbackEvent(event, userId);
        return;
    }

    // Handle text messages - check for commands
    if (event.type === 'message' && event.message?.type === 'text') {
        await handleTextMessage(event, userId);
        return;
    }

    // Handle image messages
    if (event.type === 'message' && event.message?.type === 'image') {
        await processDocument(event, userId, 'image');
        return;
    }

    // Handle file messages (PDF support)
    if (event.type === 'message' && event.message?.type === 'file') {
        const fileName = event.message.fileName || '';
        const isPdf = fileName.toLowerCase().endsWith('.pdf');
        
        if (isPdf) {
            await processDocument(event, userId, 'pdf');
        } else {
            await lineService.replyText(
                event.replyToken,
                `⚠️ ไฟล์ ${fileName} ไม่รองรับ\n\n✅ รองรับ: รูปภาพ (JPG, PNG) หรือไฟล์ PDF`
            );
        }
        return;
    }
}

/**
 * Process document (image or PDF)
 * Optimized: Uses Reply for result, Push only as fallback (saves message quota)
 * @param {Object} event - LINE webhook event
 * @param {string} userId - User ID
 * @param {string} docType - 'image' or 'pdf'
 */
async function processDocument(event, userId, docType) {
    const messageId = event.message.id;
    const fileName = event.message.fileName || '';
    const timestamp = formatDateTime();
    const replyToken = event.replyToken;  // Save for later use
    let fileBuffer = null;

    try {
        // Step 0: Check OCR availability (global quota limit)
        const availability = await usageService.checkOCRAvailability();

        if (!availability.canUseOCR) {
            logger.warn('OCR quota limit reached', {
                count: availability.count,
                limit: availability.limit,
            });

            await lineService.replyText(
                replyToken,
                `⚠️ ${availability.message}`
            );
            return;
        }

        // Check verbose modes
        const isDebugMode = process.env.VERBOSE_DEBUG_MODE === 'true';
        const isReturnOutput = process.env.VERBOSE_RETURN_OUTPUT === 'true';

        // NOTE: We don't send "processing" message anymore to save replyToken for result
        // Only send processing notification in debug mode via push
        const docLabel = docType === 'pdf' ? 'PDF' : 'image';
        if (isDebugMode) {
            await lineService.pushText(userId, `🔄 Processing your ${docLabel}...`);
        }

        // Step 1.5: Get user profile for logging
        logger.info('Getting user profile...');
        const userInfo = await lineService.getUserProfile(userId);

        // Step 2: Download file from LINE
        if (isDebugMode) {
            await lineService.pushText(userId, `📥 Step 1/4: Downloading ${docLabel}...`);
        }
        logger.info(`Downloading ${docType}: ${messageId}`);
        fileBuffer = await lineService.downloadImage(messageId);  // Same API for both

        // Determine MIME type
        const mimeType = docType === 'pdf' ? 'application/pdf' : 'image/jpeg';

        // Step 3: Process with Gemini AI (Vision)
        if (isDebugMode) {
            await lineService.pushText(userId, '🔍 Step 2/4: Processing with Gemini AI...');
        }
        logger.info(`Processing ${docType} with Gemini AI...`);
        const ocrData = await geminiService.parseInvoice(fileBuffer, mimeType);

        // Step 3.5: Increment usage counter AFTER successful OCR
        await usageService.incrementUsage();

        // Step 4: Upload to Google Drive
        if (isDebugMode) {
            await lineService.pushText(userId, '📁 Step 3/4: Uploading to Google Drive...');
        }
        logger.info('Uploading to Google Drive...');
        const ext = docType === 'pdf' ? 'pdf' : 'jpg';
        const uploadFileName = docType === 'pdf' && fileName 
            ? fileName 
            : `receipt_${messageId}_${Date.now()}.${ext}`;
        const uploadResult = await driveService.uploadImage(
            fileBuffer,
            uploadFileName,
            mimeType
        );

        // Step 5: Append to Google Sheets
        if (isDebugMode) {
            await lineService.pushText(userId, '📊 Step 4/4: Saving to Google Sheets...');
        }
        logger.info('Saving to Google Sheets...');
        const rows = geminiService.formatForSheets(ocrData, uploadResult.url, timestamp, userInfo);
        await sheetsService.appendRows(rows);

        // Step 6: Send success message - Try Reply first (FREE), fallback to Push
        const successMessage = isReturnOutput 
            ? formatSuccessMessage(ocrData, uploadResult.url)
            : '✅ Invoice processed and saved!';
        
        // Try Reply first (saves push quota), with proper error handling
        let messageSent = false;
        try {
            await lineService.replyText(replyToken, successMessage);
            logger.info('Success message sent via REPLY (free)');
            messageSent = true;
        } catch (replyError) {
            // Reply token expired (>30s), fallback to Push
            logger.warn('Reply token expired, trying Push fallback', { error: replyError.message });
            try {
                await lineService.pushText(userId, successMessage);
                logger.info('Success message sent via PUSH (uses quota)');
                messageSent = true;
            } catch (pushError) {
                logger.error('Both Reply and Push failed', { 
                    replyError: replyError.message, 
                    pushError: pushError.message 
                });
            }
        }
        
        if (!messageSent) {
            logger.error('Could not send success message to user', { userId });
        }

        logger.info('Document processed successfully', {
            messageId,
            docType,
            invoiceNumber: ocrData.invoiceNumber,
            seller: ocrData.sellerName,
            total: ocrData.grandTotal,
            lineItems: ocrData.lineItems?.length || 0,
            user: userInfo.displayName || userInfo.userId,
            messageSent,
        });
        
        // Clear retry cache on success
        retryCache.delete(userId);

    } catch (error) {
        logger.error('Failed to process document', {
            messageId,
            docType,
            error: error.message,
            stack: error.stack,
        });

        // Cache the file for retry (only if we have the buffer)
        if (fileBuffer) {
            retryCache.set(userId, {
                fileBuffer,
                messageId,
                docType,
                mimeType: docType === 'pdf' ? 'application/pdf' : 'image/jpeg',
                timestamp: Date.now(),
            });
            logger.info('Cached document for retry', { userId, messageId, docType });
        }

        // Notify user of error - Try Reply first (FREE), then Push
        const errorMessage = `❌ ไม่สามารถประมวลผลได้\n\nError: ${error.message}\n\n💡 ส่งรูปใหม่เพื่อลองอีกครั้ง`;
        
        try {
            await lineService.replyText(replyToken, errorMessage);
            logger.info('Error message sent via REPLY (free)');
        } catch (replyError) {
            // Reply failed, try Push
            try {
                await lineService.pushText(userId, errorMessage);
                logger.info('Error message sent via PUSH');
            } catch (pushError) {
                logger.error('Failed to notify user of error', { 
                    replyError: replyError.message, 
                    pushError: pushError.message 
                });
            }
        }
    }
}

/**
 * Handle postback events (retry button, etc.)
 */
async function handlePostbackEvent(event, userId) {
    const data = event.postback?.data || '';
    logger.info('Postback received', { userId, data });
    
    if (data === 'retry_ocr') {
        // Check if we have cached image for this user
        const cachedData = retryCache.get(userId);
        
        if (!cachedData) {
            await lineService.replyText(
                event.replyToken,
                '⚠️ ไม่พบรูปภาพที่บันทึกไว้\n\n📷 กรุณาส่งรูปใบเสร็จใหม่อีกครั้ง'
            );
            return;
        }
        
        // Process the cached document
        await lineService.replyText(event.replyToken, '🔄 กำลังลองใหม่...');
        
        try {
            await processWithCachedBuffer(userId, cachedData);
        } catch (error) {
            logger.error('Retry failed', { userId, error: error.message });
            await lineService.pushText(
                userId,
                `❌ การลองใหม่ล้มเหลว\n\nError: ${error.message}\n\n📷 กรุณาส่งไฟล์ใหม่`
            );
        }
    }
}

/**
 * Process document with cached buffer (used for retry)
 * @param {string} userId - User ID
 * @param {Object} cachedData - Cached data from retry cache
 */
async function processWithCachedBuffer(userId, cachedData) {
    const { fileBuffer, messageId, docType, mimeType } = cachedData;
    const timestamp = formatDateTime();
    const isDebugMode = process.env.VERBOSE_DEBUG_MODE === 'true';
    const isReturnOutput = process.env.VERBOSE_RETURN_OUTPUT === 'true';
    
    // Get user profile
    const userInfo = await lineService.getUserProfile(userId);
    
    // Process with Gemini AI
    if (isDebugMode) {
        await lineService.pushText(userId, '🔍 Processing with Gemini AI...');
    }
    const ocrData = await geminiService.parseInvoice(fileBuffer, mimeType);
    
    // Increment usage
    await usageService.incrementUsage();
    
    // Upload to Google Drive
    if (isDebugMode) {
        await lineService.pushText(userId, '📁 Uploading to Google Drive...');
    }
    const ext = docType === 'pdf' ? 'pdf' : 'jpg';
    const fileName = `receipt_${messageId}_retry_${Date.now()}.${ext}`;
    const uploadResult = await driveService.uploadImage(fileBuffer, fileName, mimeType);
    
    // Save to Sheets
    if (isDebugMode) {
        await lineService.pushText(userId, '📊 Saving to Google Sheets...');
    }
    const rows = geminiService.formatForSheets(ocrData, uploadResult.url, timestamp, userInfo);
    await sheetsService.appendRows(rows);
    
    // Send success message
    if (isReturnOutput) {
        const successMessage = formatSuccessMessage(ocrData, uploadResult.url);
        await lineService.pushText(userId, successMessage);
    } else {
        await lineService.pushText(userId, '✅ Invoice processed and saved!');
    }
    
    // Clear retry cache
    retryCache.delete(userId);
    
    logger.info('Retry successful', { userId, messageId, docType });
}


/**
 * Format success message for user
 * @param {Object} ocrData - Extracted OCR data
 * @param {string} imageUrl - Google Drive URL
 * @returns {string} Formatted message
 */
function formatSuccessMessage(ocrData, imageUrl) {
    const lines = ['✅ ใบกำกับภาษีถูกบันทึกแล้ว!', ''];

    // Invoice header info
    if (ocrData.invoiceNumber) {
        lines.push(`🔢 เลขที่: ${ocrData.invoiceNumber}`);
    }
    if (ocrData.invoiceDate) {
        lines.push(`📅 วันที่: ${ocrData.invoiceDate}`);
    }
    
    // Seller info
    if (ocrData.sellerName) {
        lines.push(`🏪 ผู้ขาย: ${ocrData.sellerName}`);
    }
    if (ocrData.sellerTaxId) {
        lines.push(`🏷️ Tax ID: ${ocrData.sellerTaxId}`);
    }

    // Line items
    if (ocrData.lineItems && ocrData.lineItems.length > 0) {
        lines.push('');
        lines.push('📝 รายการ:');
        for (const item of ocrData.lineItems.slice(0, 5)) { // Show max 5 items
            let itemLine = `  • ${item.description || 'Item'}`;
            if (item.quantity) itemLine += ` x${item.quantity}`;
            if (item.amount) itemLine += ` = ${item.amount}`;
            lines.push(itemLine);
        }
        if (ocrData.lineItems.length > 5) {
            lines.push(`  ... และอีก ${ocrData.lineItems.length - 5} รายการ`);
        }
    }

    // Totals
    lines.push('');
    if (ocrData.subtotal) {
        lines.push(`💵 ยอดก่อน VAT: ${ocrData.subtotal}`);
    }
    if (ocrData.vatAmount) {
        lines.push(`📊 VAT 7%: ${ocrData.vatAmount}`);
    }
    if (ocrData.grandTotal) {
        lines.push(`💰 ยอดรวม: ${ocrData.grandTotal}`);
    }

    lines.push('');
    lines.push('📁 Image saved to Google Drive');
    lines.push('📊 Data logged to Google Sheets');
    
    // Show confidence score
    if (ocrData.confidence !== undefined) {
        const confidencePercent = Math.round(ocrData.confidence * 100);
        const confidenceEmoji = confidencePercent >= 80 ? '🟢' : confidencePercent >= 60 ? '🟡' : '🔴';
        lines.push(`${confidenceEmoji} Confidence: ${confidencePercent}%`);
    }

    return lines.join('\n');
}

/**
 * Handle follow event - user adds bot as friend
 * Simple welcome message for single-corp version
 */
async function handleFollowEvent(event, userId) {
    logger.info('New user follow', { userId });
    
    try {
        const profile = await lineService.getUserProfile(userId);
        
        await lineService.replyText(
            event.replyToken,
            `👋 Welcome ${profile.displayName || 'User'}!\n\n📷 ส่งรูปใบเสร็จ/ใบกำกับภาษี\n✅ ระบบจะบันทึกข้อมูลให้อัตโนมัติ\n\n💡 พิมพ์ /cmd หรือ help เพื่อดูคำสั่งทั้งหมด`
        );
    } catch (error) {
        logger.error('Error handling follow event', { error: error.message });
    }
}

/**
 * Handle text messages - commands
 */
async function handleTextMessage(event, userId) {
    const text = event.message.text.trim();
    const textLower = text.toLowerCase();
    
    // Help command - list all available commands
    if (textLower === '/cmd' || textLower === 'cmd' || textLower === '/help' || textLower === 'help') {
        const helpMessage = `📋 Available Commands:

🆔 /myid - Get your LINE User ID
📊 /usage - Check OCR quota
❓ /cmd - Show this help message

📷 Or send a receipt image to process!`;
        await lineService.replyText(event.replyToken, helpMessage);
        return;
    }
    
    // Get my LINE User ID command
    if (textLower === '/myid' || textLower === 'myid') {
        await lineService.replyText(
            event.replyToken,
            `🆔 Your LINE User ID:\n\n${userId}\n\n📋 Copy this for reference.`
        );
        return;
    }
    
    // Usage check command
    if (textLower === '/usage' || textLower === 'usage' || textLower === 'quota') {
        const stats = await usageService.getUsageStats();
        const message = formatUsageMessage(stats);
        await lineService.replyText(event.replyToken, message);
        return;
    }
    
    // Unknown text - prompt to send image
    await lineService.replyText(
        event.replyToken,
        '📷 Please send me a receipt/invoice image to process.\n\n💡 Type /cmd for help.'
    );
}

/**
 * Format usage statistics message
 * @param {Object} stats - Usage statistics
 * @returns {string} Formatted message
 */
function formatUsageMessage(stats) {
    const lines = [
        '📊 OCR Usage Statistics',
        '',
        `📅 Month: ${stats.monthDisplay}`,
        `✅ Used: ${stats.used}/${stats.limit}`,
        `📉 Remaining: ${stats.remaining}`,
        `📈 Usage: ${stats.percentUsed}%`,
    ];

    if (stats.isQuotaExceeded) {
        lines.push('');
        lines.push('⚠️ Quota exceeded - OCR paused until next month.');
    }

    return lines.join('\n');
}

// Error handling middleware
app.use((err, req, res, next) => {
    if (err.name === 'SignatureValidationFailed') {
        logger.warn('Invalid LINE signature');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    logger.error('Unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
    try {
        // Validate environment in production
        if (config.server.nodeEnv === 'production') {
            config.validateEnv();
        }

        // Initialize Google Sheets headers
        try {
            await sheetsService.initializeHeaders();
        } catch (error) {
            logger.warn('Could not initialize sheet headers', error.message);
        }

        // Initialize Usage tracking sheet
        try {
            await usageService.initializeUsageSheet();
        } catch (error) {
            logger.warn('Could not initialize usage sheet', error.message);
        }

        // Start server
        const port = config.server.port;
        app.listen(port, () => {
            logger.info(`Server started on port ${port}`);
            logger.info(`Environment: ${config.server.nodeEnv}`);
            logger.info('Single-Corp OCR Bot ready!');
        });

    } catch (error) {
        logger.error('Server startup failed', error);
        process.exit(1);
    }
}

startServer();
