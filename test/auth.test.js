const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server');

// Helper to make HTTP requests against express app instance
function request(server, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      ...headers,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            if (rawData) json = JSON.parse(rawData);
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: json,
            text: rawData
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Mock Google JWT generator for testing
function createMockGoogleJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    sub: 'google_user_12345',
    email: 'user@example.com',
    email_verified: true,
    name: 'Test User',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims
  })).toString('base64url');
  const signature = 'mock_signature_bytes';
  return `${header}.${payload}.${signature}`;
}

test('Google Authentication REST API Test Suite', async (t) => {
  let server;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  let createdSessionId;

  await t.test('POST /api/v1/auth/google - 400 Bad Request when idToken is missing or invalid', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      body: {}
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(res.body.error.details[0].field, 'idToken');
  });

  await t.test('POST /api/v1/auth/google - 401 Unauthorized for malformed JWT token', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      body: {
        idToken: 'not.a.valid_jwt_payload'
      }
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });

  await t.test('POST /api/v1/auth/google - 201 Created for new user registration and session creation', async () => {
    const validToken = createMockGoogleJwt({
      email: 'newuser@example.com',
      name: 'New Registered User'
    });

    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      body: {
        idToken: validToken,
        rememberMe: true
      }
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.isNewUser, true);
    assert.equal(res.body.data.user.email, 'newuser@example.com');
    assert.ok(res.body.data.session.id.startsWith('sess_'));
    assert.ok(res.body.data.session.token);

    createdSessionId = res.body.data.session.id;
  });

  await t.test('POST /api/v1/auth/google - 200 OK for subsequent sign-in by existing user', async () => {
    const validToken = createMockGoogleJwt({
      email: 'newuser@example.com',
      name: 'New Registered User'
    });

    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      body: {
        idToken: validToken
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.isNewUser, false);
    assert.equal(res.body.data.user.email, 'newuser@example.com');
  });

  await t.test('POST /api/v1/auth/google - Idempotency-Key support caches identical requests', async () => {
    const validToken = createMockGoogleJwt({
      email: 'idempotent@example.com'
    });
    const key = 'idem-key-unique-12345';

    // First call
    const res1 = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      headers: { 'Idempotency-Key': key },
      body: { idToken: validToken }
    });
    assert.equal(res1.statusCode, 201);

    // Second call with same key
    const res2 = await request(server, {
      method: 'POST',
      path: '/api/v1/auth/google',
      headers: { 'Idempotency-Key': key },
      body: { idToken: validToken }
    });
    assert.equal(res2.statusCode, 201);
    assert.equal(res2.headers['idempotency-replay'], 'true');
    assert.deepEqual(res1.body, res2.body);
  });

  await t.test('GET /api/v1/auth/sessions/:sessionId - 200 OK for active session', async () => {
    const res = await request(server, {
      method: 'GET',
      path: `/api/v1/auth/sessions/${createdSessionId}?includeUser=true`
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.session.id, createdSessionId);
    assert.equal(res.body.data.user.email, 'newuser@example.com');
  });

  await t.test('GET /api/v1/auth/sessions/:sessionId - 400 Bad Request for invalid sessionId format', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/api/v1/auth/sessions/invalid_session_format'
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  await t.test('GET /api/v1/auth/sessions/:sessionId - 404 Not Found for non-existent session', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/api/v1/auth/sessions/sess_0123456789abcdef01234567'
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error.code, 'SESSION_NOT_FOUND');
  });

  await t.test('DELETE /api/v1/auth/sessions/:sessionId - 204 No Content (idempotent)', async () => {
    // First delete
    const res1 = await request(server, {
      method: 'DELETE',
      path: `/api/v1/auth/sessions/${createdSessionId}`
    });
    assert.equal(res1.statusCode, 204);

    // Second delete (idempotent)
    const res2 = await request(server, {
      method: 'DELETE',
      path: `/api/v1/auth/sessions/${createdSessionId}`
    });
    assert.equal(res2.statusCode, 204);

    // Verification: session now returns 404
    const getRes = await request(server, {
      method: 'GET',
      path: `/api/v1/auth/sessions/${createdSessionId}`
    });
    assert.equal(getRes.statusCode, 404);
  });

  await t.test('GET /api/v1/auth/openapi.json - 200 OK returns OpenAPI specification', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/api/v1/auth/openapi.json'
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.openapi, '3.0.3');
    assert.ok(res.body.paths['/api/v1/auth/google']);
  });
});
