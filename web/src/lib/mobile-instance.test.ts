import { describe, expect, it } from 'vitest';
import { mobileInstanceConfig } from './mobile-instance';

describe('mobile instance auth configuration', () => {
  it('uses native auth when the instance has no OIDC configuration', () => {
    expect(mobileInstanceConfig('https://selfbase.example.test', { NEXT_PUBLIC_SPACETIMEDB_DB_NAME: 'my-selfbase' })).toMatchObject({ version: 1, uri: 'wss://selfbase.example.test', databaseName: 'my-selfbase', auth: { mode: 'native' } });
  });
  it('requires a mobile client for OIDC and never silently falls back to passwords', () => {
    const env = { NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY: 'https://login.example.test', NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID: 'web' };
    expect(() => mobileInstanceConfig('https://selfbase.example.test', env)).toThrow('SELFBASE_MOBILE_OIDC_CLIENT_ID');
    const config = mobileInstanceConfig('https://selfbase.example.test', { ...env, SELFBASE_MOBILE_OIDC_CLIENT_ID: 'native', SELFBASE_MOBILE_OIDC_SCOPES: 'openid profile email offline_access' });
    expect(config.auth).toEqual({ mode: 'oidc', issuer: env.NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY, clientId: 'native', scopes: ['openid','profile','email','offline_access'] });
  });
  it('rejects insecure OIDC and WebSocket endpoints', () => {
    expect(() => mobileInstanceConfig('http://selfbase.example.test', {})).toThrow('WSS');
    expect(() => mobileInstanceConfig('https://selfbase.example.test', { NEXT_PUBLIC_SPACETIMEDB_URI: 'ws://selfbase.example.test' })).toThrow('WSS');
    expect(() => mobileInstanceConfig('https://selfbase.example.test', { NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY: 'http://login.example.test', NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID: 'web', SELFBASE_MOBILE_OIDC_CLIENT_ID: 'native' })).toThrow('HTTPS');
  });
});
