/**
 * Request validation middleware and schemas
 */

function validate(schema) {
  return (req, res, next) => {
    const issues = [];

    // 1. Path parameter validation
    if (schema.params) {
      for (const [param, validator] of Object.entries(schema.params)) {
        const val = req.params[param];
        const error = validator(val, param);
        if (error) {
          issues.push({ location: 'path', field: param, value: val, issue: error });
        }
      }
    }

    // 2. Query parameter validation
    if (schema.query) {
      for (const [param, validator] of Object.entries(schema.query)) {
        const val = req.query[param];
        const error = validator(val, param);
        if (error) {
          issues.push({ location: 'query', field: param, value: val, issue: error });
        }
      }
    }

    // 3. Request body validation
    if (schema.body) {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        issues.push({ location: 'body', field: '_root', issue: 'Request body must be a valid JSON object' });
      } else {
        for (const [field, validator] of Object.entries(schema.body)) {
          const val = req.body[field];
          const error = validator(val, field);
          if (error) {
            issues.push({ location: 'body', field, value: val, issue: error });
          }
        }
      }
    }

    if (issues.length > 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'One or more request parameters failed validation',
          details: issues
        }
      });
    }

    next();
  };
}

// Validator rules
const rules = {
  requiredString: (val, field) => {
    if (typeof val !== 'string' || val.trim().length === 0) {
      return `${field} is required and must be a non-empty string`;
    }
    return null;
  },

  jwtToken: (val, field) => {
    if (typeof val !== 'string' || val.trim().length === 0) {
      return `${field} is required and must be a non-empty string`;
    }
    const parts = val.split('.');
    if (parts.length !== 3) {
      return `${field} must be a valid 3-part JWT format (header.payload.signature)`;
    }
    return null;
  },

  sessionId: (val, field) => {
    if (!val || typeof val !== 'string' || !/^sess_[a-f0-9]{16,32}$/i.test(val)) {
      return `${field} must match format 'sess_<hex_16_to_32>'`;
    }
    return null;
  },

  optionalBoolean: (val, field) => {
    if (val !== undefined && typeof val !== 'boolean') {
      return `${field} must be a boolean if provided`;
    }
    return null;
  },

  optionalStringEnum: (allowed) => (val, field) => {
    if (val !== undefined && !allowed.includes(val)) {
      return `${field} must be one of: ${allowed.join(', ')}`;
    }
    return null;
  },

  optionalQueryBoolean: (val, field) => {
    if (val !== undefined && val !== 'true' && val !== 'false' && val !== '1' && val !== '0') {
      return `${field} must be 'true' or 'false' if provided`;
    }
    return null;
  }
};

module.exports = {
  validate,
  rules
};
