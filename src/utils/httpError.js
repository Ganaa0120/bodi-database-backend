'use strict';

/**
 * Controller-т шууд HTTP хариу болгон буцаах алдаа.
 * Transaction дотроос throw хийхэд ROLLBACK хийгдээд controller-ийн catch
 * хэсэгт `err.statusCode`-оор хариу буцаана.
 */
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

module.exports = HttpError;