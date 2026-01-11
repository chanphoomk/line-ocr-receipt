/**
 * OAuth Token Helper
 * Run this locally ONCE to get your refresh token
 * 
 * Usage:
 * 1. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env
 * 2. Run: node scripts/get-oauth-token.js
 * 3. Open the URL in browser and login
 * 4. Copy the refresh token to Railway
 */

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in .env');
    process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\n📋 STEP 1: Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n📋 STEP 2: Login with your Google account and authorize the app');
console.log('\n⏳ Waiting for callback...\n');

// Start local server to receive callback
const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/oauth/callback')) {
        const url = new URL(req.url, 'http://localhost:3000');
        const code = url.searchParams.get('code');

        if (code) {
            try {
                const { tokens } = await oauth2Client.getToken(code);
                
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                    <body style="font-family: Arial; padding: 40px; background: #1a1a2e; color: #eee;">
                        <h1>✅ Success!</h1>
                        <p>Copy these values to Railway environment variables:</p>
                        <hr>
                        <h3>GOOGLE_OAUTH_REFRESH_TOKEN:</h3>
                        <textarea style="width: 100%; height: 100px; font-size: 12px;">${tokens.refresh_token}</textarea>
                        <hr>
                        <p>You can close this window now.</p>
                    </body>
                    </html>
                `);

                console.log('\n✅ SUCCESS! Here are your tokens:\n');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('GOOGLE_OAUTH_REFRESH_TOKEN:');
                console.log(tokens.refresh_token);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('\n📋 Add these to Railway environment variables:');
                console.log('   - GOOGLE_OAUTH_CLIENT_ID');
                console.log('   - GOOGLE_OAUTH_CLIENT_SECRET');
                console.log('   - GOOGLE_OAUTH_REFRESH_TOKEN');
                console.log('\n');

                setTimeout(() => {
                    server.close();
                    process.exit(0);
                }, 2000);

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error: ' + error.message);
                console.error('❌ Error getting token:', error.message);
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('No code received');
        }
    }
});

server.listen(3000, () => {
    console.log('🚀 Local server running on http://localhost:3000');
});
