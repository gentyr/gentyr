/**
 * Anthropic model pricing for token usage cost computation.
 *
 * Prices are in micro-USD per 1M tokens (1 micro-USD = 1e-6 USD = 1e-12 USD per token).
 * Working in micro-USD keeps everything in integer arithmetic and avoids float drift
 * when summing across millions of events.
 *
 * Verified: 2026-05-19 (https://www.anthropic.com/pricing#api)
 *
 * Schema for each model:
 *   input          — per 1M input tokens
 *   output         — per 1M output tokens
 *   cache_write    — per 1M cache_creation_input_tokens (5m TTL writes)
 *   cache_read     — per 1M cache_read_input_tokens
 *
 * Update path: edit constants here, bump the date comment, run tests.
 */

export const PRICING_MICRO_USD_PER_MTOK = {
  // Claude 4.x family (current production models as of 2026-05-19)
  'claude-opus-4-7':         { input: 15_000_000, output: 75_000_000, cache_write: 18_750_000, cache_read: 1_500_000 },
  'claude-opus-4-7[1m]':     { input: 15_000_000, output: 75_000_000, cache_write: 18_750_000, cache_read: 1_500_000 },
  'claude-opus-4-6':         { input: 15_000_000, output: 75_000_000, cache_write: 18_750_000, cache_read: 1_500_000 },
  'claude-sonnet-4-6':       { input:  3_000_000, output: 15_000_000, cache_write:  3_750_000, cache_read:   300_000 },
  'claude-haiku-4-5':        { input:    800_000, output:  4_000_000, cache_write:  1_000_000, cache_read:    80_000 },
  'claude-haiku-4-5-20251001': { input:  800_000, output:  4_000_000, cache_write:  1_000_000, cache_read:    80_000 },
};

const _missingModelsLogged = new Set();

/**
 * Compute the cost (in micro-USD, integer) of a usage event.
 *
 * @param {string} model - The model identifier from the JSONL message
 * @param {object} usage - { input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens }
 * @param {(msg: string) => void} [warn] - Optional logger for unknown-model warnings (once per model)
 * @returns {number} cost in micro-USD (integer)
 */
export function computeCostMicroUsd(model, usage, warn) {
  const price = PRICING_MICRO_USD_PER_MTOK[model];
  if (!price) {
    if (warn && !_missingModelsLogged.has(model)) {
      _missingModelsLogged.add(model);
      warn(`No pricing for model "${model}" — cost recorded as 0`);
    }
    return 0;
  }
  const inputTok = usage.input_tokens || 0;
  const outputTok = usage.output_tokens || 0;
  const cacheWriteTok = usage.cache_creation_tokens || 0;
  const cacheReadTok = usage.cache_read_tokens || 0;
  const cost =
    Math.round((inputTok * price.input) / 1_000_000) +
    Math.round((outputTok * price.output) / 1_000_000) +
    Math.round((cacheWriteTok * price.cache_write) / 1_000_000) +
    Math.round((cacheReadTok * price.cache_read) / 1_000_000);
  return cost;
}

/**
 * Convert micro-USD (integer) to a USD float for display.
 */
export function microToDollars(micro) {
  return micro / 1_000_000;
}

/**
 * Format a micro-USD value as a human-readable dollar string.
 * Examples:
 *   12_345_678  -> "$12.35"
 *   1_234       -> "$0.0012"
 *   0           -> "$0.00"
 */
export function formatCost(micro) {
  if (!Number.isFinite(micro) || micro === 0) return '$0.00';
  const dollars = micro / 1_000_000;
  if (dollars >= 0.01) {
    return `$${dollars.toFixed(2)}`;
  }
  if (dollars >= 0.0001) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(6)}`;
}

/**
 * For tests: clear the missing-model warning cache.
 */
export function _resetMissingModelCache() {
  _missingModelsLogged.clear();
}
