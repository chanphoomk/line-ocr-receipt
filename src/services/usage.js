/**
 * Usage Tracking Service
 * Tracks OCR API usage per month with configurable limits
 * 
 * Storage Options:
 * 1. Google Sheets (recommended for multi-instance) - stores in a dedicated sheet
 * 2. Local JSON file (simple, single instance)
 * 
 * This implementation uses Google Sheets for persistence across deployments
 */

const { google } = require('googleapis');
const config = require('../config/env');
const logger = require('../utils/logger');

// Usage limits - configurable via environment variables
const MONTHLY_LIMIT = parseInt(process.env.OCR_MONTHLY_LIMIT, 10) || 975;
const QUOTA_EXCEEDED_MESSAGE = process.env.OCR_QUOTA_MESSAGE || 'You are out of OCR quota, please contact admin.'

// Cache for current month's usage
let usageCache = {
    month: null,  // Format: YYYYMM
    count: 0,
    lastUpdated: null,
};

// Initialize Sheets client
let sheetsClient = null;

function getClient() {
    if (!sheetsClient) {
        const credentials = config.google.getCredentials();
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        sheetsClient = google.sheets({ version: 'v4', auth });
    }
    return sheetsClient;
}

/**
 * Get current month key in YYYYMM format
 * @returns {string} Month key
 */
function getCurrentMonthKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}${month}`;
}

/**
 * Get usage count for current month from Google Sheets
 * Uses a dedicated "Usage" sheet in the same spreadsheet
 * @returns {Promise<number>} Current month's usage count
 */
async function getUsageCount() {
    const currentMonth = getCurrentMonthKey();

    // Return cached value if still valid (same month, updated within last minute)
    if (usageCache.month === currentMonth &&
        usageCache.lastUpdated &&
        Date.now() - usageCache.lastUpdated < 60000) {
        return usageCache.count;
    }

    const sheets = getClient();
    const spreadsheetId = config.sheets.spreadsheetId;

    try {
        // Try to read from Usage sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Usage!A:B',
        });

        const rows = response.data.values || [];

        // Find current month's row
        for (const row of rows) {
            if (row[0] === currentMonth) {
                const count = parseInt(row[1], 10) || 0;
                usageCache = { month: currentMonth, count, lastUpdated: Date.now() };
                return count;
            }
        }

        // No entry for current month - it's 0
        usageCache = { month: currentMonth, count: 0, lastUpdated: Date.now() };
        return 0;

    } catch (error) {
        // If Usage sheet doesn't exist, try to create it
        if (error.message?.includes('Unable to parse range')) {
            await initializeUsageSheet();
            usageCache = { month: currentMonth, count: 0, lastUpdated: Date.now() };
            return 0;
        }

        logger.error('Failed to get usage count', error);
        // Return cached value or 0 on error (fail open for UX)
        return usageCache.count || 0;
    }
}

/**
 * Increment usage count for current month
 * @returns {Promise<number>} New usage count
 */
async function incrementUsage() {
    const currentMonth = getCurrentMonthKey();
    const sheets = getClient();
    const spreadsheetId = config.sheets.spreadsheetId;

    try {
        // Get current count
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Usage!A:B',
        });

        const rows = response.data.values || [];
        let rowIndex = -1;
        let currentCount = 0;

        // Find current month's row
        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] === currentMonth) {
                rowIndex = i + 1; // Sheets are 1-indexed
                currentCount = parseInt(rows[i][1], 10) || 0;
                break;
            }
        }

        const newCount = currentCount + 1;

        if (rowIndex > 0) {
            // Update existing row
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `Usage!B${rowIndex}`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[newCount]],
                },
            });
        } else {
            // Append new row for this month
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: 'Usage!A:B',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: [[currentMonth, newCount]],
                },
            });
        }

        // Update cache
        usageCache = { month: currentMonth, count: newCount, lastUpdated: Date.now() };

        logger.info(`OCR usage incremented: ${newCount}/${MONTHLY_LIMIT}`);
        return newCount;

    } catch (error) {
        logger.error('Failed to increment usage', error);
        // Still increment cache for approximate tracking
        usageCache.count = (usageCache.count || 0) + 1;
        return usageCache.count;
    }
}

/**
 * Check if OCR is available (under quota limit)
 * @returns {Promise<Object>} Status object with canUseOCR and message
 */
async function checkOCRAvailability() {
    const count = await getUsageCount();

    if (count >= MONTHLY_LIMIT) {
        return {
            canUseOCR: false,
            count,
            limit: MONTHLY_LIMIT,
            remaining: 0,
            message: QUOTA_EXCEEDED_MESSAGE,
        };
    }

    return {
        canUseOCR: true,
        count,
        limit: MONTHLY_LIMIT,
        remaining: MONTHLY_LIMIT - count,
        message: null,
    };
}

/**
 * Initialize the Usage sheet if it doesn't exist
 */
async function initializeUsageSheet() {
    const sheets = getClient();
    const spreadsheetId = config.sheets.spreadsheetId;

    try {
        // First, check if the sheet already exists
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
        });

        const usageSheetExists = spreadsheet.data.sheets?.some(
            (sheet) => sheet.properties?.title === 'Usage'
        );

        if (!usageSheetExists) {
            // Add Usage sheet
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: 'Usage',
                                },
                            },
                        },
                    ],
                },
            });

            // Add header row
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Usage!A1:B1',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [['Month', 'Count']],
                },
            });

            logger.info('Created Usage tracking sheet');
        }
    } catch (error) {
        logger.error('Failed to initialize Usage sheet', error);
        throw error;
    }
}

/**
 * Get usage statistics for display
 * @returns {Promise<Object>} Usage stats
 */
async function getUsageStats() {
    const count = await getUsageCount();
    const currentMonth = getCurrentMonthKey();

    return {
        month: currentMonth,
        monthDisplay: `${currentMonth.substring(0, 4)}-${currentMonth.substring(4)}`,
        used: count,
        limit: MONTHLY_LIMIT,
        remaining: Math.max(0, MONTHLY_LIMIT - count),
        percentUsed: Math.round((count / MONTHLY_LIMIT) * 100),
        isQuotaExceeded: count >= MONTHLY_LIMIT,
    };
}

module.exports = {
    MONTHLY_LIMIT,
    QUOTA_EXCEEDED_MESSAGE,
    getUsageCount,
    incrementUsage,
    checkOCRAvailability,
    initializeUsageSheet,
    getUsageStats,
};
