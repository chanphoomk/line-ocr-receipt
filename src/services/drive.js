/**
 * Google Drive Service
 * Handles file uploads and folder management using OAuth 2.0
 * 
 * Uses OAuth refresh token to upload files as the authenticated user,
 * avoiding service account storage quota limitations.
 */

const { google } = require('googleapis');
const config = require('../config/env');
const logger = require('../utils/logger');
const { formatDateFolder } = require('../utils/date');

// OAuth 2.0 client
let oauth2Client = null;
let driveClient = null;

/**
 * Get OAuth2 client with refresh token
 */
function getOAuth2Client() {
    if (!oauth2Client) {
        const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

        if (!clientId || !clientSecret || !refreshToken) {
            logger.error('Missing OAuth credentials. Required: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN');
            throw new Error('Missing Google OAuth credentials for Drive upload');
        }

        oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oauth2Client.setCredentials({
            refresh_token: refreshToken,
        });

        logger.info('OAuth2 client initialized for Drive uploads');
    }
    return oauth2Client;
}

/**
 * Get Drive client
 */
function getClient() {
    if (!driveClient) {
        const auth = getOAuth2Client();
        driveClient = google.drive({ version: 'v3', auth });
    }
    return driveClient;
}

/**
 * Find or create a date-formatted folder (YYYYMMDD)
 * @param {Date} date - Date for folder name
 * @param {string} parentFolderId - Optional parent folder ID (for corp-specific routing)
 * @returns {Promise<string>} Folder ID
 */
async function getOrCreateDateFolder(date = new Date(), parentFolderId = null) {
    const drive = getClient();
    const folderName = formatDateFolder(date);
    const parentId = parentFolderId || config.drive.folderId;

    try {
        // Search for existing folder
        const searchResponse = await drive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (searchResponse.data.files && searchResponse.data.files.length > 0) {
            const existingFolder = searchResponse.data.files[0];
            logger.debug(`Found existing folder: ${folderName} (${existingFolder.id})`);
            return existingFolder.id;
        }

        // Create new folder
        const createResponse = await drive.files.create({
            requestBody: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId],
            },
            fields: 'id',
        });

        logger.info(`Created new folder: ${folderName} (${createResponse.data.id})`);
        return createResponse.data.id;
    } catch (error) {
        logger.error(`Failed to get/create folder: ${folderName}`, error);
        throw error;
    }
}

/**
 * Upload image to Google Drive
 * @param {Buffer} imageBuffer - Image data
 * @param {string} fileName - Name for the file
 * @param {string} mimeType - MIME type of the image
 * @param {string} corpFolderId - Optional corp-specific folder ID
 * @param {Date} date - Date for folder organization
 * @returns {Promise<Object>} Upload result with file ID and URL
 */
async function uploadImage(imageBuffer, fileName, mimeType = 'image/jpeg', corpFolderId = null, date = new Date()) {
    const drive = getClient();

    try {
        // Get or create the date folder (within corp folder if specified)
        const folderId = await getOrCreateDateFolder(date, corpFolderId);

        // Create readable stream from buffer
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(imageBuffer);
        stream.push(null);

        // Upload the file
        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
            },
            media: {
                mimeType,
                body: stream,
            },
            fields: 'id, name, webViewLink, webContentLink',
        });

        const fileData = response.data;
        logger.info(`Uploaded image: ${fileName} (${fileData.id})`);

        return {
            id: fileData.id,
            name: fileData.name,
            webViewLink: fileData.webViewLink,
            webContentLink: fileData.webContentLink,
            url: `https://drive.google.com/file/d/${fileData.id}/view`,
        };
    } catch (error) {
        logger.error(`Failed to upload image: ${fileName}`, error);
        throw error;
    }
}

/**
 * Make a file publicly accessible (optional)
 * @param {string} fileId - The file ID
 * @returns {Promise<void>}
 */
async function makePublic(fileId) {
    const drive = getClient();

    try {
        await drive.permissions.create({
            fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });
        logger.debug(`Made file public: ${fileId}`);
    } catch (error) {
        logger.error(`Failed to make file public: ${fileId}`, error);
        throw error;
    }
}

module.exports = {
    getOrCreateDateFolder,
    uploadImage,
    makePublic,
};
