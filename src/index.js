/**
 * LINE OCR Receipt Processor
 * Main server entry point
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
    logger.info('Received event', {
        type: event.type,
        messageType: event.message?.type,
        userId: event.source?.userId,
    });

    // Handle text messages - check for commands
    if (event.type === 'message' && event.message?.type === 'text') {
        const text = event.message.text.toLowerCase().trim();

        // Usage check command
        if (text === '/usage' || text === 'usage' || text === 'quota') {
            const stats = await usageService.getUsageStats();
            const message = formatUsageMessage(stats);
            await lineService.replyText(event.replyToken, message);
            return;
        }

        // Default response for text messages
        await lineService.replyText(
            event.replyToken,
            '📷 Please send me an image of a receipt or invoice to process.\n\nType "usage" to check your monthly quota.'
        );
        return;
    }

    // Only process image messages
    if (event.type !== 'message' || event.message?.type !== 'image') {
        return;
    }

    const userId = event.source?.userId;
    const messageId = event.message.id;
    const timestamp = formatDateTime();

    try {
        // Step 0: Check OCR availability (quota limit)
        const availability = await usageService.checkOCRAvailability();

        if (!availability.canUseOCR) {
            // Quota exceeded - just return message and stop
            logger.warn('OCR quota limit reached', {
                count: availability.count,
                limit: availability.limit,
            });

            await lineService.replyText(
                event.replyToken,
                `⚠️ ${availability.message}`
            );
            return;
        }

        // Check if verbose mode is enabled
        const isVerbose = process.env.VERBOSE === 'true';

        // Step 1: Send processing notification
        await lineService.replyText(
            event.replyToken,
            `🔄 Processing your receipt image...\n📊 Quota: ${availability.count + 1}/${availability.limit}`
        );

        // Step 1.5: Get user profile for logging
        logger.info('Getting user profile...');
        const userInfo = await lineService.getUserProfile(userId);

        // Step 2: Download image from LINE
        if (isVerbose) {
            await lineService.pushText(userId, '📥 Step 1/4: Downloading image...');
        }
        logger.info(`Downloading image: ${messageId}`);
        const imageBuffer = await lineService.downloadImage(messageId);

        // Step 3: Process with Gemini AI (Vision)
        if (isVerbose) {
            await lineService.pushText(userId, '🔍 Step 2/4: Processing with Gemini AI...');
        }
        logger.info('Processing with Gemini AI...');
        const ocrData = await geminiService.parseInvoice(imageBuffer, 'image/jpeg');

        // Step 3.5: Increment usage counter AFTER successful OCR
        await usageService.incrementUsage();

        // Step 4: Upload to Google Drive
        if (isVerbose) {
            await lineService.pushText(userId, '📁 Step 3/4: Uploading to Google Drive...');
        }
        logger.info('Uploading to Google Drive...');
        const fileName = `receipt_${messageId}_${Date.now()}.jpg`;
        const uploadResult = await driveService.uploadImage(
            imageBuffer,
            fileName,
            'image/jpeg'
        );

        // Step 5: Append to Google Sheets (multi-row format with user info)
        if (isVerbose) {
            await lineService.pushText(userId, '📊 Step 4/4: Saving to Google Sheets...');
        }
        logger.info('Saving to Google Sheets...');
        const rows = geminiService.formatForSheets(ocrData, uploadResult.url, timestamp, userInfo);
        await sheetsService.appendRows(rows);

        // Step 6: Send success message with extracted data
        const successMessage = formatSuccessMessage(ocrData, uploadResult.url);
        await lineService.pushText(userId, successMessage);

        logger.info('Invoice processed successfully', {
            messageId,
            invoiceNumber: ocrData.invoiceNumber,
            seller: ocrData.sellerName,
            total: ocrData.grandTotal,
            lineItems: ocrData.lineItems?.length || 0,
            user: userInfo.displayName || userInfo.userId,
        });

    } catch (error) {
        logger.error('Failed to process receipt', {
            messageId,
            error: error.message,
            stack: error.stack,
        });

        // Notify user of error
        try {
            await lineService.pushText(
                userId,
                `❌ Sorry, I couldn't process your receipt.\n\nError: ${error.message}\n\nPlease try again with a clearer image.`
            );
        } catch (notifyError) {
            logger.error('Failed to notify user of error', notifyError);
        }
    }
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
    if (ocrData.sellerBranch) {
        lines.push(`📍 สาขา: ${ocrData.sellerBranch}`);
    }

    // Buyer info (if exists)
    if (ocrData.buyerName) {
        lines.push('');
        lines.push(`👤 ผู้ซื้อ: ${ocrData.buyerName}`);
        if (ocrData.buyerTaxId) {
            lines.push(`🏷️ Tax ID ผู้ซื้อ: ${ocrData.buyerTaxId}`);
        }
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

        // Log initial usage stats
        try {
            const stats = await usageService.getUsageStats();
            logger.info(`📊 Current usage: ${stats.used}/${stats.limit} (${stats.monthDisplay})`);
        } catch (error) {
            logger.warn('Could not get initial usage stats', error.message);
        }

        // Start server
        app.listen(config.server.port, () => {
            logger.info(`🚀 Server started on port ${config.server.port}`);
            logger.info(`📍 Environment: ${config.server.nodeEnv}`);
            logger.info(`🔗 Webhook URL: https://YOUR_DOMAIN/webhook`);
        });
    } catch (error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;
