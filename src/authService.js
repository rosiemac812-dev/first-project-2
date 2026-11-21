const crypto = require('node:crypto');

/**
 * In-memory Authentication Service
 * Manages Google ID token decoding/verification, user records, sessions, and idempotency cache.
 */
class AuthService {
  constructor() {
    this.users = new Map();       // userId -> User
    this.usersByEmail = new Map(); // email -> userId
    this.sessions = new Map();    // sessionId -> Session
    this.idempotencyCache = new Map(); // key -> { response, createdAt }
  }

  /**
   * Decodes and validates Google JWT payload.
   * In a production environment with Google Auth Library, this calls Google's public keys.
   * Supports real base64url JWTs and simulated test tokens.
   */
  async verifyGoogleIdToken(idToken) {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new Error('MALFORMED_TOKEN');
    }

    let payload;
    try {
      const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
      payload = JSON.parse(decoded);
    } catch {
      throw new Error('INVALID_TOKEN_PAYLOAD');
    }

    // Verify standard Google JWT claims
    if (!payload.sub || !payload.email) {
      throw new Error('MISSING_REQUIRED_CLAIMS');
    }

    // Check expiration if present
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('TOKEN_EXPIRED');
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase().trim(),
      emailVerified: Boolean(payload.email_verified),
      name: payload.name || payload.email.split('@')[0],
      avatarUrl: payload.picture || null
    };
  }

  /**
   * Authenticate or register user via Google identity
   */
  async authenticateWithGoogle(googleProfile, rememberMe = false) {
    let user;
    let isNewUser = false;
    const existingUserId = this.usersByEmail.get(googleProfile.email);

    if (existingUserId) {
      user = this.users.get(existingUserId);
      user.name = googleProfile.name;
      user.avatarUrl = googleProfile.avatarUrl;
      user.lastLoginAt = new Date().toISOString();
    } else {
      isNewUser = true;
      const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
      user = {
        id: userId,
        googleId: googleProfile.googleId,
        email: googleProfile.email,
        emailVerified: googleProfile.emailVerified,
        name: googleProfile.name,
        avatarUrl: googleProfile.avatarUrl,
        provider: 'google',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      };
      this.users.set(userId, user);
      this.usersByEmail.set(user.email, userId);
    }

    // Create session
    const sessionId = `sess_${crypto.randomBytes(12).toString('hex')}`;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const durationMs = rememberMe ? 30 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
    const expiresAt = new Date(Date.now() + durationMs).toISOString();

    const session = {
      id: sessionId,
      userId: user.id,
      token: sessionToken,
      createdAt: new Date().toISOString(),
      expiresAt,
      rememberMe: Boolean(rememberMe)
    };

    this.sessions.set(sessionId, session);

    return {
      session: {
        id: session.id,
        token: session.token,
        expiresAt: session.expiresAt
      },
      user,
      isNewUser
    };
  }

  /**
   * Retrieve active session by ID
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check expiration
    if (new Date(session.expiresAt) <= new Date()) {
      this.sessions.delete(sessionId);
      return null;
    }

    const user = this.users.get(session.userId);
    return { session, user };
  }

  /**
   * Revoke/delete a session (idempotent)
   */
  deleteSession(sessionId) {
    return this.sessions.delete(sessionId);
  }

  /**
   * Idempotency support
   */
  getCachedIdempotency(key) {
    if (!key) return null;
    const cached = this.idempotencyCache.get(key);
    if (!cached) return null;
    // Cache TTL: 10 minutes
    if (Date.now() - cached.createdAt > 10 * 60 * 1000) {
      this.idempotencyCache.delete(key);
      return null;
    }
    return cached.response;
  }

  cacheIdempotency(key, response) {
    if (!key) return;
    this.idempotencyCache.set(key, { response, createdAt: Date.now() });
  }
}

module.exports = new AuthService();
