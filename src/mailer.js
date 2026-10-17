import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

// Sends email over SMTP. Without SMTP_HOST, writes each email to
// <dataDir>/outbox/ so the flow can be tried without a mail server.
export function createMailer({ smtp, dataDir, log = console }) {
  if (smtp.host) {
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    return {
      send: ({ to, subject, html, text }) => transport.sendMail({ from: smtp.from, to, subject, html, text }),
    };
  }

  const outbox = path.join(dataDir, 'outbox');
  return {
    async send({ to, subject, html }) {
      mkdirSync(outbox, { recursive: true });
      const file = path.join(outbox, `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.html`);
      writeFileSync(file, `<!-- To: ${to} | Subject: ${subject} -->\n${html}`);
      log.info?.(`[outbox] "${subject}" for ${to} -> ${file}`);
    },
  };
}
