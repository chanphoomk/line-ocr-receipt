/**
 * Environment Configuration Loader
 * Loads and validates all required environment variables
 */

require('dotenv').config();

const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'GOOGLE_PROJECT_ID',
  'GOOGLE_PROCESSOR_ID',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'GOOGLE_DRIVE_FOLDER_ID',
  'GOOGLE_SHEET_ID',
];

// Validate required environment variables
function validateEnv() {
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Parse the base64-encoded service account key
function getServiceAccountCredentials() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  try {
    const jsonString = Buffer.from(base64Key, 'base64').toString('utf-8');
    return JSON.parse(jsonString);
  } catch (error) {
    throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY: Failed to decode base64 or parse JSON');
  }
}

// Only validate in production or when explicitly requested
if (process.env.NODE_ENV === 'production') {
  validateEnv();
}

module.exports = {
  // LINE Configuration
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
  },

  // Google Cloud Configuration
  google: {
    projectId: process.env.GOOGLE_PROJECT_ID,
    location: process.env.GOOGLE_LOCATION || 'us',
    processorId: process.env.GOOGLE_PROCESSOR_ID,
    getCredentials: getServiceAccountCredentials,
  },

  // Google Drive Configuration
  drive: {
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
  },

  // Google Sheets Configuration
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Sheet1',
  },

  // Server Configuration
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  },

  // Utility functions
  validateEnv,
  getServiceAccountCredentials,
};
