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

// Cache for parsed credentials
let cachedCredentials = null;

// Parse the base64-encoded service account key (lazy loading)
function getServiceAccountCredentials() {
  // Return cached if already parsed
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  
  if (!base64Key) {
    console.error('ERROR: GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    return null;
  }
  
  try {
    const jsonString = Buffer.from(base64Key, 'base64').toString('utf-8');
    cachedCredentials = JSON.parse(jsonString);
    return cachedCredentials;
  } catch (error) {
    console.error('ERROR: Invalid GOOGLE_SERVICE_ACCOUNT_KEY - failed to decode base64 or parse JSON');
    console.error('Key length:', base64Key?.length || 0);
    return null;
  }
}

// Don't validate at module load time - let the server start first

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
