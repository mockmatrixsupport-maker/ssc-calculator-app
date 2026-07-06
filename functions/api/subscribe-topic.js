// functions/api/subscribe-topic.js
//
// POST { token } → subscribes that device's FCM registration token to the
// "all_users" topic. Called once by the app right after it registers for
// push. No password needed — worst case someone subscribes a junk token
// to your own topic, which is harmless (it just never receives anything
// useful back).

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { token } = body;
  if (!token) {
    return json({ error: 'token is required' }, 400);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    return json({ error: 'Server misconfigured: FIREBASE_SERVICE_ACCOUNT invalid' }, 500);
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount);
  } catch (e) {
    return json({ error: 'Firebase auth failed: ' + e.message }, 500);
  }

  const res = await fetch(`https://iid.googleapis.com/iid/v1/${token}/rel/topics/all_users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'access_token_auth': 'true'
    }
  });

  const result = await res.json().catch(() => ({}));

  if (!res.ok) {
    return json({ error: 'Topic subscribe failed', details: result }, 502);
  }

  return json({ success: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── same Google OAuth2 service-account token exchange as send-notification.js ──
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

