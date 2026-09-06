import { afterEach, describe, expect, it } from 'vitest';

import { assertPrivilegedMutation } from './privileged-request';

const ENV_KEYS = [
  'NODE_ENV',
  'WOLF_RESEARCH_ADMIN_TOKEN',
  'WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS',
] as const;

const originalEnvironment = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
const mutableEnvironment = process.env as Record<string, string | undefined>;

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete mutableEnvironment[key];
    else mutableEnvironment[key] = value;
  }
}

function localRequest(headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3010/api/evals', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3010',
      origin: 'http://127.0.0.1:3010',
      ...headers,
    },
  });
}

describe('assertPrivilegedMutation', () => {
  afterEach(restoreEnvironment);

  it('fails closed for production loopback requests without explicit opt-in', () => {
    mutableEnvironment.NODE_ENV = 'production';
    delete mutableEnvironment.WOLF_RESEARCH_ADMIN_TOKEN;
    delete mutableEnvironment.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS;

    expect(() => assertPrivilegedMutation(localRequest())).toThrow(
      'WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS',
    );
  });

  it('allows an explicitly enabled production loopback request', () => {
    mutableEnvironment.NODE_ENV = 'production';
    delete mutableEnvironment.WOLF_RESEARCH_ADMIN_TOKEN;
    mutableEnvironment.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS = '1';

    expect(() => assertPrivilegedMutation(localRequest())).not.toThrow();
  });

  it('does not turn the loopback switch into a network-wide bypass', () => {
    mutableEnvironment.NODE_ENV = 'production';
    delete mutableEnvironment.WOLF_RESEARCH_ADMIN_TOKEN;
    mutableEnvironment.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS = '1';

    const request = new Request('http://192.168.1.20:3010/api/evals', {
      method: 'POST',
      headers: {
        host: '192.168.1.20:3010',
        origin: 'http://192.168.1.20:3010',
      },
    });
    expect(() => assertPrivilegedMutation(request)).toThrow('已拒绝写入');
  });

  it('keeps a configured admin token mandatory even with loopback opt-in', () => {
    mutableEnvironment.NODE_ENV = 'production';
    mutableEnvironment.WOLF_RESEARCH_ADMIN_TOKEN = 'local-secret';
    mutableEnvironment.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS = '1';

    expect(() => assertPrivilegedMutation(localRequest())).toThrow('管理令牌');
    expect(() => assertPrivilegedMutation(localRequest({
      'x-wolf-research-admin-token': 'local-secret',
    }))).not.toThrow();
  });

  it('rejects cross-origin requests before applying the local switch', () => {
    mutableEnvironment.NODE_ENV = 'production';
    delete mutableEnvironment.WOLF_RESEARCH_ADMIN_TOKEN;
    mutableEnvironment.WOLF_RESEARCH_ALLOW_LOOPBACK_MUTATIONS = '1';

    expect(() => assertPrivilegedMutation(localRequest({
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
    }))).toThrow('跨站');
  });
});
