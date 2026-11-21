const express = require('express');
const crypto = require('node:crypto');
const authService = require('./authService');
const { validate, rules } = require('./validation');

const router = express.Router();

/**
 * Standard Success Response Envelope Formatter
 */
function sendSuccess(res, data, statusCode = 200, meta = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      requestId: `req_${crypto.randomBytes(6).toString('hex')}`,
      ...meta
    }
  });
}

/**
 * @openapi
 * /api/v1/auth/google:
 *   post:
 *     summary: Authenticate with Google ID Token
 *     description: Verifies Google Identity Services (GIS) ID token, signs in or registers user, and issues a session.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         schema:
 *           type: string
 *         description: Optional client-generated UUID/key to make POST idempotent across network retries.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idToken
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Valid 3-part Google OAuth/OIDC JWT credential.
 *                 example: eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ...
 *               rememberMe:
 *                 type: boolean
 *                 description: Extend session duration to 30 days instead of 24 hours.
 *                 default: false
 *               provider:
 *                 type: string
 *                 enum: [google]
 *                 default: google
 *     responses:
 *       200:
 *         description: Successful sign-in for existing user
 *       201:
 *         description: First-time registration and sign-in for new user
 *       400:
 *         description: Validation failed (missing idToken, malformed body)
 *       401:
 *         description: Invalid, expired, or rejected Google token
 *       500:
 *         description: Internal server error
 */
router.post(
  '/google',
  validate({
    body: {
      idToken: rules.jwtToken,
      rememberMe: rules.optionalBoolean,
      provider: rules.optionalStringEnum(['google'])
    }
  }),
  async (req, res, next) => {
    try {
      const idempotencyKey = req.header('Idempotency-Key');

      // Idempotency: return cached response if key was already submitted
      if (idempotencyKey) {
        const cached = authService.getCachedIdempotency(idempotencyKey);
        if (cached) {
          res.set('Idempotency-Replay', 'true');
          return res.status(cached.status).json(cached.body);
        }
      }

      const { idToken, rememberMe } = req.body;

      // Verify Google ID token claims
      let googleProfile;
      try {
        googleProfile = await authService.verifyGoogleIdToken(idToken);
      } catch (err) {
        const codeMap = {
          MALFORMED_TOKEN: 'Token format is not a valid JWT',
          INVALID_TOKEN_PAYLOAD: 'Token payload could not be decoded',
          MISSING_REQUIRED_CLAIMS: 'Token missing required claims (sub, email)',
          TOKEN_EXPIRED: 'Google ID token has expired'
        };
        return res.status(401).json({
          error: {
            code: 'INVALID_CREDENTIALS',
            message: codeMap[err.message] || 'Invalid Google credential',
            provider: 'google'
          }
        });
      }

      // Authenticate or register
      const result = await authService.authenticateWithGoogle(googleProfile, rememberMe);
      const statusCode = result.isNewUser ? 201 : 200;

      const responsePayload = {
        success: true,
        data: {
          session: result.session,
          user: result.user,
          isNewUser: result.isNewUser
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: `req_${crypto.randomBytes(6).toString('hex')}`
        }
      };

      // Cache for idempotency key
      if (idempotencyKey) {
        authService.cacheIdempotency(idempotencyKey, {
          status: statusCode,
          body: responsePayload
        });
      }

      return res.status(statusCode).json(responsePayload);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/v1/auth/sessions/{sessionId}:
 *   get:
 *     summary: Retrieve active session
 *     description: Returns the session state and optionally the associated user profile. Naturally idempotent.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^sess_[a-f0-9]{16,32}$'
 *         description: The unique session identifier.
 *       - in: query
 *         name: includeUser
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *         description: Whether to include full user profile details.
 *     responses:
 *       200:
 *         description: Active session details
 *       400:
 *         description: Invalid sessionId or query parameter format
 *       404:
 *         description: Session expired or not found
 */
router.get(
  '/sessions/:sessionId',
  validate({
    params: {
      sessionId: rules.sessionId
    },
    query: {
      includeUser: rules.optionalQueryBoolean
    }
  }),
  (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const includeUser = req.query.includeUser !== 'false';

      const found = authService.getSession(sessionId);
      if (!found) {
        return res.status(404).json({
          error: {
            code: 'SESSION_NOT_FOUND',
            message: `Active session '${sessionId}' was not found or has expired`
          }
        });
      }

      const responseData = {
        session: {
          id: found.session.id,
          createdAt: found.session.createdAt,
          expiresAt: found.session.expiresAt,
          rememberMe: found.session.rememberMe
        }
      };

      if (includeUser && found.user) {
        responseData.user = {
          id: found.user.id,
          email: found.user.email,
          name: found.user.name,
          avatarUrl: found.user.avatarUrl,
          provider: found.user.provider
        };
      }

      return sendSuccess(res, responseData, 200);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @openapi
 * /api/v1/auth/sessions/{sessionId}:
 *   delete:
 *     summary: Revoke session (Sign Out)
 *     description: Revokes an active session. Idempotent — subsequent calls return 204 No Content.
 *     tags:
 *       - Authentication
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^sess_[a-f0-9]{16,32}$'
 *     responses:
 *       204:
 *         description: Session revoked successfully
 *       400:
 *         description: Malformed sessionId parameter
 */
router.delete(
  '/sessions/:sessionId',
  validate({
    params: {
      sessionId: rules.sessionId
    }
  }),
  (req, res, next) => {
    try {
      const { sessionId } = req.params;
      // Deleting a session is idempotent
      authService.deleteSession(sessionId);
      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * OpenAPI 3.0 Document Endpoint
 */
router.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Google Authentication REST API',
      version: '1.0.0',
      description: 'RESTful API for Google Sign-In verification, user provisioning, and session lifecycle.'
    },
    paths: {
      '/api/v1/auth/google': {
        post: {
          summary: 'Authenticate with Google ID Token',
          description: 'Verifies Google Identity token and issues a session token. Supports Idempotency-Key header.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['idToken'],
                  properties: {
                    idToken: { type: 'string', description: 'JWT ID token from Google Identity Services' },
                    rememberMe: { type: 'boolean', default: false },
                    provider: { type: 'string', enum: ['google'], default: 'google' }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Sign-in success for existing user' },
            '201': { description: 'Sign-in and account registration for new user' },
            '400': { description: 'Bad request / validation error' },
            '401': { description: 'Unauthorized / invalid Google credential' },
            '500': { description: 'Internal server error' }
          }
        }
      },
      '/api/v1/auth/sessions/{sessionId}': {
        get: {
          summary: 'Retrieve active session',
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'includeUser', in: 'query', required: false, schema: { type: 'string', enum: ['true', 'false'] } }
          ],
          responses: {
            '200': { description: 'Active session returned' },
            '400': { description: 'Validation error' },
            '404': { description: 'Session not found or expired' }
          }
        },
        delete: {
          summary: 'Revoke active session',
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }
          ],
          responses: {
            '204': { description: 'Session revoked successfully (idempotent)' },
            '400': { description: 'Validation error' }
          }
        }
      }
    }
  });
});

module.exports = router;
