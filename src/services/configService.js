/**
 * Config Service - Manages users and corporate configuration from Google Sheets
 * 
 * Config Sheet Structure:
 * - Tab "users": User ID, User Name, Corp, Status, Registered, Last Active
 * - Tab "corps": Corp Name, Sheet ID, Drive Folder ID, Quota Limit, Status
 */

const { google } = require('googleapis');
const logger = require('../utils/logger');

// Get auth client (reuse from existing setup)
function getAuth() {
    const credentials = JSON.parse(
        Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString()
    );
    return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

// Get Sheets API instance
async function getSheetsApi() {
    const auth = getAuth();
    return google.sheets({ version: 'v4', auth });
}

/**
 * Get config sheet ID and tab names from ENV
 */
function getConfigInfo() {
    return {
        sheetId: process.env.CONFIG_SHEET_ID,
        usersTab: process.env.CONFIG_USERS_TAB || 'users',
        corpsTab: process.env.CONFIG_CORPS_TAB || 'corps',
    };
}

/**
 * Get user by LINE User ID
 * @param {string} lineUserId - LINE User ID
 * @returns {Object|null} User object or null if not found
 */
async function getUserByLineId(lineUserId) {
    try {
        const config = getConfigInfo();
        if (!config.sheetId) {
            logger.warn('CONFIG_SHEET_ID not set, skipping user lookup');
            return null;
        }

        const sheets = await getSheetsApi();
        const range = `${config.usersTab}!A:F`;
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.sheetId,
            range,
        });

        const rows = response.data.values || [];
        if (rows.length <= 1) return null; // Only header or empty

        // Find user row (skip header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[0] === lineUserId) {
                return {
                    rowIndex: i + 1, // 1-indexed for sheets
                    userId: row[0] || '',
                    userName: row[1] || '',
                    corp: row[2] || '',
                    status: row[3] || 'pending',
                    registered: row[4] || '',
                    lastActive: row[5] || '',
                };
            }
        }

        return null; // User not found
    } catch (error) {
        logger.error('Error getting user by LINE ID', { error: error.message });
        throw error;
    }
}

/**
 * Update user in config sheet
 * @param {number} rowIndex - Row index (1-indexed)
 * @param {Object} data - Data to update
 */
async function updateUser(rowIndex, data) {
    try {
        const config = getConfigInfo();
        const sheets = await getSheetsApi();

        const values = [[
            data.userId || '',
            data.userName || '',
            data.corp || '',
            data.status || 'pending',
            data.registered || '',
            data.lastActive || new Date().toISOString().split('T')[0],
        ]];

        await sheets.spreadsheets.values.update({
            spreadsheetId: config.sheetId,
            range: `${config.usersTab}!A${rowIndex}:F${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
        });

        logger.info('User updated', { rowIndex, userId: data.userId });
    } catch (error) {
        logger.error('Error updating user', { error: error.message });
        throw error;
    }
}

/**
 * Add new user to config sheet (status=pending)
 * @param {string} lineUserId - LINE User ID
 * @param {string} userName - Display name
 */
async function addUser(lineUserId, userName = '') {
    try {
        const config = getConfigInfo();
        const sheets = await getSheetsApi();

        const values = [[
            lineUserId,
            userName,
            '', // Corp (TBD)
            'pending',
            new Date().toISOString().split('T')[0],
            '',
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId: config.sheetId,
            range: `${config.usersTab}!A:F`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values },
        });

        logger.info('New user added', { lineUserId, userName });
    } catch (error) {
        logger.error('Error adding user', { error: error.message });
        throw error;
    }
}

/**
 * Get corporate configuration by name
 * Corps tab structure: Corp Name | Sheet ID | Sheet Name | Drive Folder ID | Quota Limit | Status | Current Usage
 * @param {string} corpName - Corporation name
 * @returns {Object|null} Corp config or null if not found
 */
async function getCorpConfig(corpName) {
    try {
        const config = getConfigInfo();
        const sheets = await getSheetsApi();
        const range = `${config.corpsTab}!A:G`;
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.sheetId,
            range,
        });

        const rows = response.data.values || [];
        if (rows.length <= 1) return null;

        // Find corp row (skip header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[0] === corpName) {
                return {
                    corpName: row[0] || '',
                    sheetId: row[1] || '',
                    sheetName: row[2] || 'Sheet1',  // NEW: Sheet/tab name
                    driveFolderId: row[3] || '',
                    quotaLimit: parseInt(row[4]) || 500,
                    status: row[5] || 'active',
                    currentUsage: parseInt(row[6]) || 0,
                };
            }
        }

        return null;
    } catch (error) {
        logger.error('Error getting corp config', { error: error.message });
        throw error;
    }
}

/**
 * Get all active corporations (for Quick Reply)
 * @returns {Array} List of active corp names
 */
async function getAllCorps() {
    try {
        const config = getConfigInfo();
        const sheets = await getSheetsApi();
        const range = `${config.corpsTab}!A:E`;
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.sheetId,
            range,
        });

        const rows = response.data.values || [];
        if (rows.length <= 1) return [];

        const corps = [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const status = row[4] || 'active';
            if (status === 'active') {
                corps.push(row[0]);
            }
        }

        return corps;
    } catch (error) {
        logger.error('Error getting all corps', { error: error.message });
        throw error;
    }
}

/**
 * Check if a LINE user ID is an admin
 * @param {string} lineUserId - LINE User ID
 * @returns {boolean} True if admin
 */
function isAdmin(lineUserId) {
    const adminIds = process.env.ADMIN_USER_IDS || '';
    const admins = adminIds.split(',').map(id => id.trim()).filter(Boolean);
    return admins.includes(lineUserId);
}

/**
 * Get unauthorized user message
 */
function getUnauthorizedMessage() {
    return process.env.UNAUTHORIZED_MESSAGE || 
        '⚠️ You are not authorized to use this service.\n\nPlease contact admin for access.';
}

/**
 * Get corp usage statistics
 * Corps tab structure: Corp Name | Sheet ID | Sheet Name | Drive Folder ID | Quota Limit | Status | Current Usage
 * @param {string} corpName - Corporation name
 * @returns {Object} Usage stats for the corp
 */
async function getCorpUsageStats(corpName) {
    try {
        const config = getConfigInfo();
        if (!config.sheetId) {
            return { used: 0, limit: 500, remaining: 500, percentUsed: 0 };
        }
        
        const sheets = await getSheetsApi();
        const range = `${config.corpsTab}!A:G`;
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.sheetId,
            range,
        });

        const rows = response.data.values || [];
        
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[0] === corpName) {
                const limit = parseInt(row[4]) || 500;  // Column E
                const used = parseInt(row[6]) || 0;     // Column G
                const remaining = Math.max(0, limit - used);
                const percentUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;
                
                return {
                    corpName,
                    used,
                    limit,
                    remaining,
                    percentUsed,
                    isQuotaExceeded: used >= limit,
                    rowIndex: i + 1,
                };
            }
        }
        
        return { corpName, used: 0, limit: 500, remaining: 500, percentUsed: 0 };
    } catch (error) {
        logger.error('Error getting corp usage stats', { error: error.message });
        return { used: 0, limit: 500, remaining: 500, percentUsed: 0 };
    }
}

/**
 * Increment corp usage counter (Column G)
 * @param {string} corpName - Corporation name
 */
async function incrementCorpUsage(corpName) {
    try {
        const stats = await getCorpUsageStats(corpName);
        if (!stats.rowIndex) {
            logger.warn('Corp not found for usage increment', { corpName });
            return;
        }
        
        const config = getConfigInfo();
        const sheets = await getSheetsApi();
        
        const newUsage = (stats.used || 0) + 1;
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: config.sheetId,
            range: `${config.corpsTab}!G${stats.rowIndex}`,  // Column G = Current Usage
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[newUsage]] },
        });
        
        logger.info('Corp usage incremented', { corpName, newUsage });
    } catch (error) {
        logger.error('Error incrementing corp usage', { error: error.message });
    }
}

/**
 * Check if corp can use OCR (quota not exceeded)
 * @param {string} corpName - Corporation name
 * @returns {Object} { canUse, message, stats }
 */
async function checkCorpQuota(corpName) {
    const stats = await getCorpUsageStats(corpName);
    
    if (stats.isQuotaExceeded) {
        return {
            canUse: false,
            message: `Corp ${corpName} has reached its monthly quota (${stats.used}/${stats.limit})`,
            stats,
        };
    }
    
    return { canUse: true, message: '', stats };
}

module.exports = {
    getUserByLineId,
    updateUser,
    addUser,
    getCorpConfig,
    getAllCorps,
    isAdmin,
    getUnauthorizedMessage,
    getCorpUsageStats,
    incrementCorpUsage,
    checkCorpQuota,
};
