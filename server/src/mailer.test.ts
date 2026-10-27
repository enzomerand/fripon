import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({}));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import {
  CODE_TTL_MINUTES,
  codeMessage,
  createConsoleMailer,
  createMailer,
  createSmtpMailer,
} from './mailer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('codeMessage', () => {
  it('is French, with the code and the 10 minutes', () => {
    const { subject, text } = codeMessage('042917');
    expect(subject).toBe('Ton code Fripon');
    expect(text).toContain('042917');
    expect(text).toContain(
      "Il expire dans 10 minutes. Si tu n'as rien demandé, ignore ce message.",
    );
    expect(CODE_TTL_MINUTES).toBe(10);
  });
});

describe('createSmtpMailer', () => {
  it('sends the message through the SMTP url, with timeouts', async () => {
    const mailer = createSmtpMailer(
      'smtps://user:pass@smtp.example.com:465',
      'Fripon <hello@fripon.test>',
    );
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'smtps://user:pass@smtp.example.com:465',
        connectionTimeout: expect.any(Number),
        socketTimeout: expect.any(Number),
      }),
    );

    await mailer.sendCode('sam@example.com', '123456');
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Fripon <hello@fripon.test>',
      to: 'sam@example.com',
      ...codeMessage('123456'),
    });
  });

  it('lets a failure out', async () => {
    sendMail.mockRejectedValueOnce(new Error('connection refused'));
    const mailer = createSmtpMailer('smtp://localhost', 'a@b.c');
    await expect(mailer.sendCode('sam@example.com', '123456')).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('createConsoleMailer', () => {
  it('prints the code instead of sending it', async () => {
    const log = vi.fn();
    await createConsoleMailer(log).sendCode('sam@example.com', '123456');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('123456'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sam@example.com'));
  });
});

describe('createMailer', () => {
  it('uses SMTP when SMTP_URL is set', async () => {
    const mailer = createMailer({
      smtpUrl: 'smtp://localhost',
      mailFrom: 'a@b.c',
      production: true,
    });
    await mailer.sendCode('sam@example.com', '123456');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('falls back to the console in development', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mailer = createMailer({ smtpUrl: null, mailFrom: 'a@b.c', production: false });
    await mailer.sendCode('sam@example.com', '123456');
    expect(sendMail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('123456'));
    log.mockRestore();
  });

  it('refuses to print codes in production', () => {
    expect(() => createMailer({ smtpUrl: null, mailFrom: 'a@b.c', production: true })).toThrow(
      /SMTP_URL/,
    );
  });
});
