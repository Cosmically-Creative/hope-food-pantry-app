import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../src/turnstile.js';
import { createPostmarkMailer } from '../src/mail/postmark.js';
import { createSesMailer } from '../src/mail/ses.js';

const timeout = AbortSignal.timeout.bind(AbortSignal);
afterEach(() => vi.restoreAllMocks());

function shortDeadline(expected: number) {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    expect(ms).toBe(expected);
    return timeout(5);
  });
}

function stalled(signal?: AbortSignal | null): Promise<never> {
  if (!signal) throw new Error('Missing request deadline');
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  });
}

const mail = {
  from:'pantry@example.invalid', to:'volunteer@example.invalid', replyTo:'pantry@example.invalid',
  subject:'Test', text:'Test', html:'<p>Test</p>',
};

describe('outbound request deadlines', () => {
  it('fails closed when Turnstile never responds', async () => {
    shortDeadline(10_000);
    const result = await verifyTurnstile({
      secret:'real-secret', token:'token', remoteIp:'203.0.113.1',
      expectedHostname:'example.invalid', expectedAction:'signup',
      fetchImpl: async (_url, init) => stalled(init?.signal),
    });
    expect(result).toEqual({ok:false, reason:'unavailable'});
  });

  it('bounds Turnstile response-body reading too', async () => {
    shortDeadline(10_000);
    const result = await verifyTurnstile({
      secret:'real-secret', token:'token', remoteIp:'203.0.113.1',
      expectedHostname:'example.invalid', expectedAction:'signup',
      fetchImpl: async (_url, init) => Object.assign(new Response('{}'), {json:() => stalled(init?.signal)}),
    });
    expect(result).toEqual({ok:false, reason:'unavailable'});
  });

  it('marks a Postmark timeout uncertain instead of retrying', async () => {
    shortDeadline(15_000);
    const driver = createPostmarkMailer('test-token', async (_url, init) => stalled(init?.signal));
    expect((await driver.send(mail)).result).toBe('unknown');
  });

  it('marks a stalled Postmark success body uncertain', async () => {
    shortDeadline(15_000);
    const driver = createPostmarkMailer('test-token', async (_url, init) => Object.assign(new Response('{}'), {json:() => stalled(init?.signal)}));
    expect((await driver.send(mail)).result).toBe('unknown');
  });

  it('passes SES a deadline and treats an abort as uncertain', async () => {
    shortDeadline(15_000);
    const driver = createSesMailer({region:'us-east-1', accessKeyId:'test', secretAccessKey:'test',
      client:{send:async (_command, options) => stalled(options?.abortSignal)},
    });
    expect((await driver.send(mail)).result).toBe('unknown');
  });
});
