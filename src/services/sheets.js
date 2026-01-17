/**
 * Google Sheets Service
 * Handles appending extracted invoice data to spreadsheet
 * Supports multi-row format (one row per line item)
 * Supports dynamic sheet routing for multi-corp setup
 */

const { google } = require('googleapis');
const config = require('../config/env');
const logger = require('../utils/logger');
const { getSheetHeaders } = require('./gemini');  // Updated: import from gemini.js

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
 * Append a single row of data to the configured Google Sheet
 * @param {Array} rowData - Array of values to append as a row
 * @param {string} customSheetId - Optional custom spreadsheet ID (for corp routing)
 * @param {string} customSheetName - Optional custom sheet/tab name (for corp routing)
 * @returns {Promise<Object>} Append result
 */
async function appendRow(rowData, customSheetId = null, customSheetName = null) {
    return appendRows([rowData], customSheetId, customSheetName);
}

/**
 * Append multiple rows to the sheet (for multi-row invoice format)
 * @param {Array<Array>} rows - Array of row arrays
 * @param {string} customSheetId - Optional custom spreadsheet ID (for corp routing)
 * @param {string} customSheetName - Optional custom sheet/tab name (for corp routing)
 * @returns {Promise<Object>} Append result
 */
async function appendRows(rows, customSheetId = null, customSheetName = null) {
    const sheets = getClient();
    const spreadsheetId = customSheetId || config.sheets.spreadsheetId;
    const sheetName = customSheetName || config.sheets.sheetName || 'Sheet1';
    const range = `${sheetName}!A:W`; // 23 columns: A-W

    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: rows,
            },
        });

        logger.info(`Appended ${rows.length} row(s) to ${spreadsheetId}/${sheetName}: ${response.data.updates?.updatedRange}`);
        return response.data;
    } catch (error) {
        logger.error(`Failed to append rows to ${spreadsheetId}/${sheetName}`, error);
        throw error;
    }
}

/**
 * Initialize the sheet with headers if empty
 * Uses the new 18-column Thai invoice format
 * @returns {Promise<void>}
 */
async function initializeHeaders() {
    const sheets = getClient();
    const spreadsheetId = config.sheets.spreadsheetId;
    const sheetName = config.sheets.sheetName;

    try {
        // Check if sheet has data
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:R1`,
        });

        if (!response.data.values || response.data.values.length === 0) {
            // Add headers using the OCR service's header definition
            const headers = getSheetHeaders();

            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1:R1`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [headers],
                },
            });

            logger.info('Initialized sheet with 18-column Thai invoice headers');
        } else {
            logger.debug('Sheet already has headers');
        }
    } catch (error) {
        logger.error('Failed to initialize sheet headers', error);
        // Don't throw - this is not critical
    }
}

/**
 * Update headers to the new 18-column format (for existing sheets)
 * @returns {Promise<void>}
 */
async function updateHeaders() {
    const sheets = getClient();
    const spreadsheetId = config.sheets.spreadsheetId;
    const sheetName = config.sheets.sheetName;

    try {
        const headers = getSheetHeaders();

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1:R1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [headers],
            },
        });

        logger.info('Updated sheet headers to 18-column format');
    } catch (error) {
        logger.error('Failed to update sheet headers', error);
        throw error;
    }
}

module.exports = {
    appendRow,
    appendRows,
    initializeHeaders,
    updateHeaders,
};
