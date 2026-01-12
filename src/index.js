/**
 * LINE OCR Receipt Processor
 * Main server entry point - Multi-Corp Version
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
const configService = require('./services/configService');

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

    // Handle postback (Quick Reply selections)
    if (event.type === 'postback') {
        await handlePostbackEvent(event, userId);
        return;
    }

    // Handle text messages - check for commands
    if (event.type === 'message' && event.message?.type === 'text') {
        await handleTextMessage(event, userId);
        return;
    }

    // Only process image messages
    if (event.type !== 'message' || event.message?.type !== 'image') {
        return;
    }

    // Process image - userId already declared above
    const messageId = event.message.id;
    const timestamp = formatDateTime();

    try {
        // Step 0a: Check user authorization and get corp config
        const user = await configService.getUserByLineId(userId);
        if (!user || user.status !== 'active' || !user.corp) {
            await lineService.replyText(
                event.replyToken,
                configService.getUnauthorizedMessage()
            );
            return;
        }

        // Get corp configuration for routing
        const corpConfig = await configService.getCorpConfig(user.corp);
        if (!corpConfig || corpConfig.status !== 'active') {
            await lineService.replyText(
                event.replyToken,
                '⚠️ Your corporation is not active. Please contact admin.'
            );
            return;
        }

        // Step 0b: Check OCR availability (quota limit)
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

        // Check verbose modes
        const isDebugMode = process.env.VERBOSE_DEBUG_MODE === 'true';
        const isReturnOutput = process.env.VERBOSE_RETURN_OUTPUT === 'true';

        // Step 1: Send processing notification (always show quota in debug mode)
        const processingMsg = isDebugMode 
            ? `🔄 Processing your receipt image...\n🏢 Corp: ${user.corp}\n📊 Quota: ${availability.count + 1}/${availability.limit}`
            : '🔄 Processing your receipt image...';
        await lineService.replyText(event.replyToken, processingMsg);

        // Step 1.5: Get user profile for logging
        logger.info('Getting user profile...');
        const userInfo = await lineService.getUserProfile(userId);

        // Step 2: Download image from LINE
        if (isDebugMode) {
            await lineService.pushText(userId, '📥 Step 1/4: Downloading image...');
        }
        logger.info(`Downloading image: ${messageId}`);
        const imageBuffer = await lineService.downloadImage(messageId);

        // Step 3: Process with Gemini AI (Vision)
        if (isDebugMode) {
            await lineService.pushText(userId, '🔍 Step 2/4: Processing with Gemini AI...');
        }
        logger.info('Processing with Gemini AI...');
        const ocrData = await geminiService.parseInvoice(imageBuffer, 'image/jpeg');

        // Step 3.5: Increment usage counter AFTER successful OCR
        await usageService.incrementUsage();

        // Step 4: Upload to Google Drive (corp-specific folder)
        if (isDebugMode) {
            await lineService.pushText(userId, '📁 Step 3/4: Uploading to Google Drive...');
        }
        logger.info(`Uploading to Google Drive (${user.corp})...`);
        const fileName = `${user.corp}_receipt_${messageId}_${Date.now()}.jpg`;
        const uploadResult = await driveService.uploadImage(
            imageBuffer,
            fileName,
            'image/jpeg',
            corpConfig.driveFolderId  // Use corp-specific folder
        );

        // Step 5: Append to Google Sheets (corp-specific sheet)
        if (isDebugMode) {
            await lineService.pushText(userId, '📊 Step 4/4: Saving to Google Sheets...');
        }
        logger.info(`Saving to Google Sheets (${user.corp})...`);
        const rows = geminiService.formatForSheets(ocrData, uploadResult.url, timestamp, userInfo);
        await sheetsService.appendRows(rows, corpConfig.sheetId);  // Use corp-specific sheet

        // Step 6: Send success message with extracted data (only if RETURN_OUTPUT is true)
        if (isReturnOutput) {
            const successMessage = formatSuccessMessage(ocrData, uploadResult.url);
            await lineService.pushText(userId, successMessage);
        } else {
            // Minimal confirmation
            await lineService.pushText(userId, '✅ Invoice processed and saved!');
        }

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
 * Handle follow event - user adds bot as friend
 */
async function handleFollowEvent(event, userId) {
    logger.info('New user follow', { userId });
    
    try {
        // Check if user exists in config sheet
        const user = await configService.getUserByLineId(userId);
        
        if (!user) {
            // User not pre-approved
            await lineService.replyText(
                event.replyToken,
                configService.getUnauthorizedMessage()
            );
            return;
        }
        
        // Get user profile
        const profile = await lineService.getUserProfile(userId);
        
        if (user.status === 'pending') {
            // Show corp selection
            const corps = await configService.getAllCorps();
            
            if (corps.length === 0) {
                await lineService.replyText(
                    event.replyToken,
                    '⚠️ No corporations configured. Please contact admin.'
                );
                return;
            }
            
            // Update user name in sheet
            await configService.updateUser(user.rowIndex, {
                ...user,
                userName: profile.displayName || '',
            });
            
            // Send Quick Reply for corp selection
            await lineService.replyWithQuickReply(
                event.replyToken,
                `👋 Welcome ${profile.displayName || 'User'}!\n\nPlease select your corporation:`,
                corps.map(corp => ({
                    type: 'action',
                    action: {
                        type: 'postback',
                        label: corp,
                        data: `select_corp=${corp}`,
                        displayText: corp,
                    }
                }))
            );
        } else if (user.status === 'active') {
            await lineService.replyText(
                event.replyToken,
                `👋 Welcome back ${profile.displayName || 'User'}!\n\n📷 Send me a receipt image to process.\n🏢 Your corp: ${user.corp}`
            );
        } else {
            // Blocked or other status
            await lineService.replyText(
                event.replyToken,
                '⚠️ Your account is not active. Please contact admin.'
            );
        }
    } catch (error) {
        logger.error('Error handling follow event', { error: error.message });
        await lineService.replyText(
            event.replyToken,
            '❌ Error processing your request. Please try again.'
        );
    }
}

/**
 * Handle postback event - Quick Reply selections
 */
async function handlePostbackEvent(event, userId) {
    const data = event.postback?.data || '';
    logger.info('Postback received', { userId, data });
    
    try {
        // Handle corp selection
        if (data.startsWith('select_corp=')) {
            const corpName = data.replace('select_corp=', '');
            
            // Verify corp exists
            const corpConfig = await configService.getCorpConfig(corpName);
            if (!corpConfig) {
                await lineService.replyText(
                    event.replyToken,
                    '❌ Invalid corporation. Please try again.'
                );
                return;
            }
            
            // Get user and update
            const user = await configService.getUserByLineId(userId);
            if (user) {
                await configService.updateUser(user.rowIndex, {
                    ...user,
                    corp: corpName,
                    status: 'active',
                });
                
                await lineService.replyText(
                    event.replyToken,
                    `✅ You are now registered with ${corpName}!\n\n📷 Send me a receipt image to get started.`
                );
            }
        }
    } catch (error) {
        logger.error('Error handling postback', { error: error.message });
        await lineService.replyText(
            event.replyToken,
            '❌ Error processing your selection. Please try again.'
        );
    }
}

/**
 * Handle text messages - commands and admin actions
 */
async function handleTextMessage(event, userId) {
    const text = event.message.text.trim();
    const textLower = text.toLowerCase();
    
    // Usage check command
    if (textLower === '/usage' || textLower === 'usage' || textLower === 'quota') {
        const stats = await usageService.getUsageStats();
        const message = formatUsageMessage(stats);
        await lineService.replyText(event.replyToken, message);
        return;
    }
    
    // Admin change corp command
    const adminCommand = process.env.ADMIN_CHANGE_COMMAND || 'ADMIN change corp';
    if (text === adminCommand && configService.isAdmin(userId)) {
        // Show corp selection for admin
        const corps = await configService.getAllCorps();
        await lineService.replyWithQuickReply(
            event.replyToken,
            '🔧 Admin: Select new corporation:',
            corps.map(corp => ({
                type: 'action',
                action: {
                    type: 'postback',
                    label: corp,
                    data: `select_corp=${corp}`,
                    displayText: corp,
                }
            }))
        );
        return;
    }
    
    // Check if user is authorized
    const user = await configService.getUserByLineId(userId);
    if (!user || user.status !== 'active') {
        await lineService.replyText(
            event.replyToken,
            configService.getUnauthorizedMessage()
        );
        return;
    }
    
    // Default response for text messages
    await lineService.replyText(
        event.replyToken,
        `📷 Please send me an image of a receipt or invoice to process.\n\n🏢 Your corp: ${user.corp}\n\nType "usage" to check your monthly quota.`
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
