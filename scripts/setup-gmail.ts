/**
 * Gmail OAuth2 Setup Helper
 *
 * Run this script to obtain the OAuth2 refresh token needed for the Gmail API.
 *
 * Prerequisites:
 * 1. Go to https://console.cloud.google.com/
 * 2. Create a project (or select an existing one)
 * 3. Enable the Gmail API: APIs & Services → Library → search "Gmail API" → Enable
 * 4. Create OAuth2 credentials:
 *    - APIs & Services → Credentials → Create Credentials → OAuth client ID
 *    - Application type: Web application
 *    - Authorized redirect URI: http://localhost:3000/oauth2callback
 * 5. Copy the Client ID and Client Secret into your .env file:
 *    GMAIL_CLIENT_ID=your-client-id
 *    GMAIL_CLIENT_SECRET=your-client-secret
 * 6. Run this script: npx tsx scripts/setup-gmail.ts
 * 7. Open the URL printed in the console, authorize the app
 * 8. Copy the refresh token printed after authorization into your .env:
 *    GMAIL_REFRESH_TOKEN=your-refresh-token
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';

const PORT = 3000;

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n❌ Missing Gmail OAuth2 credentials in .env file.');
    console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.\n');
    console.error('Steps:');
    console.error('1. Go to https://console.cloud.google.com/');
    console.error('2. Create a project and enable the Gmail API');
    console.error('3. Create OAuth2 credentials (Web application)');
    console.error('4. Set redirect URI to: http://localhost:3000/oauth2callback');
    console.error('5. Copy Client ID and Client Secret to .env\n');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    `http://localhost:${PORT}/oauth2callback`,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    prompt: 'consent', // Force refresh token
  });

  console.log('\n📧 Gmail OAuth2 Setup\n');
  console.log('Open this URL in your browser to authorize:\n');
  console.log(authUrl);
  console.log('\nWaiting for authorization callback...\n');

  // Start a temporary server to capture the OAuth callback
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost:${PORT}`);

    if (url.pathname === '/oauth2callback') {
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        const refreshToken = tokens.refresh_token;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>✅ Authorization successful!</h1><p>You can close this window. Check the terminal for the refresh token.</p>');

        console.log('✅ Authorization successful!\n');
        if (refreshToken) {
          console.log('Add this to your .env file:\n');
          console.log(`GMAIL_REFRESH_TOKEN=${refreshToken}\n`);
        } else {
          console.log('⚠️  No refresh token received. This can happen if you already authorized.');
          console.log('Try revoking access at https://myaccount.google.com/permissions and re-running.\n');
          if (tokens.access_token) {
            console.log('Access token (temporary):', tokens.access_token);
          }
        }

        server.close();
        process.exit(0);
      } catch (err) {
        res.writeHead(500);
        res.end('Error exchanging code for tokens');
        console.error('Error:', err);
        server.close();
        process.exit(1);
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(PORT, () => {
    console.log(`Callback server listening on port ${PORT}`);
  });
}

main().catch(console.error);
