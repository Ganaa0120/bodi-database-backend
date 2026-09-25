'use strict';

require('dotenv').config();

const REQUIRED_VARS = [
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'ACCESS_TOKEN_SECRET',
];

function assertRequiredEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Дутуу байгаа environment variable(ууд): ${missing.join(', ')}. .env файлаа .env.example-тэй харьцуулж шалгана уу.`
    );
  }

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ACCESS_TOKEN_SECRET === 'change_this_to_a_long_random_secret'
  ) {
    throw new Error(
      'ACCESS_TOKEN_SECRET нь production дээр default утгаараа байна. Random утгаар солино уу.'
    );
  }
}

assertRequiredEnv();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    sslMode: process.env.PGSSLMODE || 'require',
  },

  jwt: {
    accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '30m',
    refreshTokenTtlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '7', 10),
  },

  security: {
    maxFailedLoginAttempts: parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS || '5', 10),
    lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '15', 10),
  },

  // Заавал биш — тохируулаагүй бол зөвхөн лого upload feature идэвхгүй болно,
  // сервер бусад бүх зүйлдээ хэвийн ажиллана.
  azureStorage: {
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || null,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY || null,
    container: process.env.AZURE_STORAGE_CONTAINER || 'company-logos',
  },

  seed: {
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL,
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD,
    superAdminFullName: process.env.SUPER_ADMIN_FULL_NAME || 'Super Admin',
  },
};