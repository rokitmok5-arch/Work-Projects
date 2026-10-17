import 'dotenv/config';

const port = Number(process.env.PORT) || 3001;

export const config = {
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  linkSecret: process.env.LINK_SIGNING_SECRET,
  linkTtlDays: Number(process.env.LINK_TTL_DAYS) || 14,
  adminKey: process.env.ADMIN_API_KEY,
  enableScheduler: process.env.ENABLE_SCHEDULER !== 'false',
  dataDir: process.env.DATA_DIR || 'data',
  model: process.env.CONTENT_MODEL || 'claude-opus-5-5',
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'Content Agent <content@example.com>',
  },
};
