// functions/api/send-notification.js
//
// POST { password, title, message } → sends a push to every subscribed
// device via FCM's topic messaging. The Firebase service-account key
// lives only in the FIREBASE_SERVICE_ACCOUNT Cloudflare secret — never
// sent to the browser, never in any committed file.

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { password, title, message, path } = body;

  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (!title || !message) {
    return json({ error: 'title and message are required' }, 400);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    return json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not valid JSON' }, 500);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    return json({ error: 'Firebase auth failed: ' + e.message }, 500);
  }

  const projectId = serviceAccount.project_id;
  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const fcmRes = await fetch(fcmUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        topic: 'all_users',
        notification: { title, body: message },
        // also sent as data so the app's foreground listener can save
        // it into the on-device notification history for the bell page
        data: {
          title,
          body: message,
          path: path || '',
          sentAt: new Date().toISOString()
        }
      }
    })
  });

  const fcmResult = await fcmRes.json();

  if (!fcmRes.ok) {
    return json({ error: 'FCM send failed', details: fcmResult }, 502);
  }

  return json({ success: true, fcm: fcmResult }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── Google OAuth2 service-account token exchange (JWT Bearer flow) ──
// Implemented with the Web Crypto API only — no external libraries,
// since Cloudflare Pages Functions run on the Workers runtime.
async function getGoogleAccessToken(serviceAccount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaimSet = base64url(JSON.stringify(claimSet));
  const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  const signedJwt = `${unsignedJwt}.${base64urlFromArrayBuffer(signature)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt
    })
  });

  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(tokenJson.error_description || 'token exchange failed');
  }
  return tokenJson.access_token;
}

function base64url(str) {
  return base64urlFromArrayBuffer(new TextEncoder().encode(str));
}

function base64urlFromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}
