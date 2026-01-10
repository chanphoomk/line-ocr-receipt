/**
 * LINE Bot Service
 * Handles webhook events and image message processing
 */

const line = require('@line/bot-sdk');
const config = require('../config/env');
const logger = require('../utils/logger');

// Initialize LINE client
const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.line.channelAccessToken,
});

// Initialize blob client for downloading content
const blobClient = new line.messagingApi.MessagingApiBlobClient({
    channelAccessToken: config.line.channelAccessToken,
});

/**
 * Download image content from LINE servers
 * @param {string} messageId - The message ID to download
 * @returns {Promise<Buffer>} Image buffer
 */
async function downloadImage(messageId) {
    try {
        logger.debug(`Downloading image: ${messageId}`);
        const stream = await blobClient.getMessageContent(messageId);

        // Collect stream data into buffer
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        logger.info(`Downloaded image: ${messageId}, size: ${buffer.length} bytes`);
        return buffer;
    } catch (error) {
        logger.error(`Failed to download image: ${messageId}`, error);
        throw error;
    }
}

/**
 * Send reply message to user
 * @param {string} replyToken - Reply token from webhook event
 * @param {string} text - Message text to send
 */
async function replyText(replyToken, text) {
    try {
        await client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text }],
        });
        logger.debug(`Replied with: ${text.substring(0, 50)}...`);
    } catch (error) {
        logger.error('Failed to send reply', error);
        throw error;
    }
}

/**
 * Send push message to user (when reply token expired)
 * @param {string} userId - User ID to send message to
 * @param {string} text - Message text to send
 */
async function pushText(userId, text) {
    try {
        await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text }],
        });
        logger.debug(`Pushed message to ${userId}: ${text.substring(0, 50)}...`);
    } catch (error) {
        logger.error('Failed to push message', error);
        throw error;
    }
}

/**
 * Get LINE middleware for signature verification
 */
function getMiddleware() {
    return line.middleware({
        channelSecret: config.line.channelSecret,
    });
}

/**
 * Get user profile from LINE
 * @param {string} userId - LINE User ID
 * @returns {Promise<Object>} User profile with displayName, pictureUrl, userId
 */
async function getUserProfile(userId) {
    try {
        const profile = await client.getProfile(userId);
        logger.debug(`Got profile for user: ${profile.displayName}`);
        return {
            userId: profile.userId,
            displayName: profile.displayName || '',
            pictureUrl: profile.pictureUrl || '',
        };
    } catch (error) {
        logger.warn(`Failed to get user profile: ${userId}`, error.message);
        // Return basic info on error (user may have blocked the bot)
        return {
            userId: userId,
            displayName: '',
            pictureUrl: '',
        };
    }
}

module.exports = {
    client,
    blobClient,
    downloadImage,
    replyText,
    pushText,
    getMiddleware,
    getUserProfile,
};
