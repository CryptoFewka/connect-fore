import { describe, expect, test } from 'bun:test';
import { roomSocketUrl } from '../src/net/client';
import { challengeUrl } from '../src/net/protocol';

describe('the socket URL a bundled app would build', () => {
  test('upgrades a real https origin to wss', () => {
    expect(roomSocketUrl('ABCDE', 'https://fore.automa.agency')).toBe(
      'wss://fore.automa.agency/api/room/ABCDE',
    );
  });

  test('keeps a plain http origin on ws, for local wrangler', () => {
    expect(roomSocketUrl('ABCDE', 'http://127.0.0.1:8787')).toBe(
      'ws://127.0.0.1:8787/api/room/ABCDE',
    );
  });

  test('trailing slashes on the origin do not double up the path', () => {
    expect(roomSocketUrl('ABCDE', 'https://fore.automa.agency/')).toBe(
      'wss://fore.automa.agency/api/room/ABCDE',
    );
  });

  /**
   * The whole reason any of this exists. `capacitor:` is a non-special scheme,
   * so the URL spec refuses to switch it to `wss:` and the assignment silently
   * does nothing. Returning that string would hand `new WebSocket()` something
   * it throws on, and the retry loop would bury the throw as a permanent
   * "RECONNECTING" with no error anywhere.
   */
  test('refuses a scheme it cannot upgrade, rather than returning a dud', () => {
    expect(() => roomSocketUrl('ABCDE', 'capacitor://localhost')).toThrow(/VITE_API_ORIGIN/);
  });

  test('and says which variable to set', () => {
    expect(() => roomSocketUrl('ABCDE', 'ionic://localhost')).toThrow(/fore\.automa\.agency/);
  });
});

describe('challenge links', () => {
  test('are built against whatever origin they are given', () => {
    expect(challengeUrl('https://fore.automa.agency', 'QRSTV')).toBe(
      'https://fore.automa.agency/#/r/QRSTV',
    );
  });
});
