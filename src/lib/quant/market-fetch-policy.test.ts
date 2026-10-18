import { describe, expect, it } from 'vitest';
import { hasDisallowedMarketFetch } from './market-fetch-policy';
import { chartPanelClientSource } from '@/lib/utils/scaffold-chart-panel';

describe('market fetch policy', () => {
  it('accepts the shipped interactive chart including its session request', () => {
    expect(hasDisallowedMarketFetch(chartPanelClientSource)).toBe(false);
  });

  it.each([
    "fetch('/api/market/quotes/realtime/300666')",
    "globalThis.fetch('/api/market/quotes/session/' + encodeURIComponent(symbol), { signal })",
    'fetch(`/api/market/quotes/session/${encodeURIComponent(symbol)}?refresh=1`)',
    "fetch('/api/market/quotes?symbol=' + encodeURIComponent(symbol))",
    "// fetch(url)\nconst label = 'fetch(url)';",
  ])('allows a provably same-origin market request: %s', (source) => {
    expect(hasDisallowedMarketFetch(source)).toBe(false);
  });

  it.each([
    "fetch('https://example.com/data')",
    "fetch('//example.com/data')",
    "fetch('/api/other')",
    "fetch('/api/market-evil/quotes')",
    "fetch('/api/market/../../admin')",
    "fetch('/api/market/%2e%2e/admin')",
    "fetch('/api/market/quotes/' + symbol)",
    "fetch('/api/market/' + encodeURIComponent(symbol) + '/admin')",
    'fetch(`/api/market/quotes/${symbol}`)',
    "fetch(url)",
    "fetch(...args)",
    "globalThis.fetch(url)",
    "window['fetch'](url)",
    "fetch('/api/market/quotes'); fetch(url)",
    "fetch('/api/market/quotes', { body: fetch(url) })",
  ])('blocks external, escaping or unproven destinations: %s', (source) => {
    expect(hasDisallowedMarketFetch(source)).toBe(true);
  });
});
