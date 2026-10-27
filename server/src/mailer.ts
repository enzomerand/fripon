import nodemailer from 'nodemailer';
import type { Config } from './config';

/** How long a sign-in code lives; the e-mail says it, `auth.ts` enforces it. */
export const CODE_TTL_MINUTES = 10;

/** Sends the sign-in code. It throws when the mail could not be handed over. */
export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
}

/** The mail a person gets (French, tutoiement). */
export function codeMessage(code: string): { subject: string; text: string } {
  return {
    subject: 'Ton code Fripon',
    text: [
      `Ton code Fripon : ${code}`,
      '',
      `Il expire dans ${CODE_TTL_MINUTES} minutes. Si tu n'as rien demandé, ignore ce message.`,
    ].join('\n'),
  };
}

/** Sends through the SMTP server of `SMTP_URL` (`smtps://user:pass@host:465`). */
export function createSmtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport({
    url: smtpUrl,
    // A mail server that hangs must not hold the sign-in request for minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async sendCode(email, code) {
      await transport.sendMail({ from, to: email, ...codeMessage(code) });
    },
  };
}

/** Development only: prints the code instead of sending it. */
export function createConsoleMailer(log: (line: string) => void = console.log): Mailer {
  return {
    async sendCode(email, code) {
      log(`[mail] sign-in code for ${email}: ${code}`);
    },
  };
}

/** SMTP when `SMTP_URL` is set, the console in development without it (`loadConfig` refuses that in production). */
export function createMailer(config: Pick<Config, 'smtpUrl' | 'mailFrom' | 'production'>): Mailer {
  if (config.smtpUrl !== null) return createSmtpMailer(config.smtpUrl, config.mailFrom);
  if (config.production) throw new Error('SMTP_URL is required in production');
  return createConsoleMailer();
}
