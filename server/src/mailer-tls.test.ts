import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmtpMailer } from './mailer';

/** The real nodemailer (`mailer.test.ts` mocks it) against a local server that offers no STARTTLS. */
describe('createSmtpMailer without TLS on offer', () => {
  let server: Server;

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses to send, before any password or code goes out', async () => {
    let received = '';
    server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 fake ESMTP\r\n');
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        received += chunk;
        socket.write(
          chunk.startsWith('EHLO') ? '250-fake\r\n250 AUTH PLAIN LOGIN\r\n' : '250 OK\r\n',
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const mailer = createSmtpMailer(
      `smtp://user:secret-password@127.0.0.1:${port}`,
      'Fripon <hello@fripon.test>',
    );

    await expect(mailer.sendCode('someone@fripon.test', '123456')).rejects.toThrow();
    expect(received).toContain('EHLO');
    expect(received).not.toContain('AUTH');
    expect(received).not.toContain('123456');
  });
});
