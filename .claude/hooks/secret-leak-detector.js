#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Secret Leak Detector
 *
 * Scans user messages for known secret patterns (API keys, tokens, credentials)
 * and warns the user before the message is processed. Does NOT block the message —
 * just emits a systemMessage warning.
 *
 * Why: Secrets pasted into chat end up in the conversation transcript stored on disk.
 * This hook catches common patterns and reminds the user to rotate the credential.
 *
 * Input: User message on stdin
 * Output: JSON to stdout with systemMessage if a secret pattern is detected.
 *
 * @version 1.0.0
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// 1. Known secret patterns
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // 1Password
  {
    name: '1Password Service Account Token',
    pattern: /ops_[A-Za-z0-9+/=_-]{50,}/,
    advice: 'Rotate in 1Password > Settings > Service Accounts > Regenerate.',
  },
  // GitHub
  {
    name: 'GitHub Personal Access Token (classic)',
    pattern: /ghp_[A-Za-z0-9]{36,}/,
    advice: 'Revoke at github.com/settings/tokens and create a new one.',
  },
  {
    name: 'GitHub Fine-Grained Token',
    pattern: /github_pat_[A-Za-z0-9_]{30,}/,
    advice: 'Revoke at github.com/settings/tokens and create a new one.',
  },
  // Render
  {
    name: 'Render API Key',
    pattern: /rnd_[A-Za-z0-9]{30,}/,
    advice: 'Regenerate at dashboard.render.com/account/api-keys.',
  },
  // Vercel
  {
    name: 'Vercel Token',
    pattern: /(?:^|\s)([A-Za-z0-9]{24,})\s*$/,
    skip: true, // Too generic — only match with context below
  },
  // Resend
  {
    name: 'Resend API Key',
    pattern: /re_[A-Za-z0-9]{20,}/,
    advice: 'Regenerate at resend.com/api-keys.',
  },
  // Supabase service role key (JWT format, starts with eyJ)
  {
    name: 'Supabase Service Role Key (or other JWT)',
    pattern: /eyJ[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]{100,}\.[A-Za-z0-9_-]{40,}/,
    advice: 'If this is a service_role key, rotate in Supabase Dashboard > Project Settings > API.',
  },
  // Elastic API Key (base64-encoded, typically id:key format)
  {
    name: 'Elastic API Key',
    pattern: /(?:^|\s)[A-Za-z0-9+/]{40,}={0,2}(?:\s|$)/,
    contextRequired: /elastic|kibana|cloud\.es/i,
    advice: 'Regenerate in Elastic Cloud > Deployments > Security > API Keys.',
  },
  // Cloudflare API Token
  {
    name: 'Cloudflare API Token',
    pattern: /[A-Za-z0-9_-]{40}(?:\s|$)/,
    contextRequired: /cloudflare|cf_/i,
    advice: 'Regenerate at dash.cloudflare.com/profile/api-tokens.',
  },
  // Codecov Token
  {
    name: 'Codecov Upload Token',
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    contextRequired: /codecov/i,
    advice: 'Regenerate at app.codecov.io > your repo > Settings.',
  },
  // Generic AWS-style keys
  {
    name: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/,
    advice: 'Rotate in AWS IAM > Security credentials.',
  },
  // Generic private key blocks
  {
    name: 'Private Key',
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
    advice: 'This private key is now exposed. Generate a new key pair immediately.',
  },
  // Stripe
  {
    name: 'Stripe Secret Key',
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{20,}/,
    advice: 'Rotate at dashboard.stripe.com/apikeys.',
  },
  // OpenAI
  {
    name: 'OpenAI API Key',
    pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/,
    advice: 'Rotate at platform.openai.com/api-keys.',
  },
  // Anthropic
  {
    name: 'Anthropic API Key',
    pattern: /sk-ant-[A-Za-z0-9_-]{80,}/,
    advice: 'Rotate at console.anthropic.com/settings/keys.',
  },
  // Slack
  {
    name: 'Slack Bot/User Token',
    pattern: /xox[bporas]-[A-Za-z0-9-]{20,}/,
    advice: 'Rotate at api.slack.com/apps > your app > OAuth & Permissions.',
  },
];

// ---------------------------------------------------------------------------
// 2. Read user message from stdin
// ---------------------------------------------------------------------------

function output(message) {
  if (message) {
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage: message,
    }));
  } else {
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
  }
}

try {
  // Skip for spawned sessions — agents don't paste secrets
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    output(null);
    process.exit(0);
  }

  // Read user message from stdin
  let userMessage = '';
  try {
    userMessage = readFileSync('/dev/stdin', 'utf-8');
  } catch {
    // No stdin available
    output(null);
    process.exit(0);
  }

  if (!userMessage || userMessage.length < 10) {
    output(null);
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 3. Scan for known secret patterns
  // ---------------------------------------------------------------------------

  const detected = [];

  for (const secret of SECRET_PATTERNS) {
    if (secret.skip) continue;

    const match = secret.pattern.test(userMessage);
    if (!match) continue;

    // Some patterns are too generic — require context words nearby
    if (secret.contextRequired && !secret.contextRequired.test(userMessage)) {
      continue;
    }

    detected.push(secret);
  }

  if (detected.length === 0) {
    output(null);
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // 4. Build warning message
  // ---------------------------------------------------------------------------

  const names = detected.map(s => s.name);
  const advices = [...new Set(detected.map(s => s.advice).filter(Boolean))];

  let warning = `SECRET DETECTED in your message: ${names.join(', ')}.\n\n`;
  warning += 'This credential is now in the conversation transcript (stored on disk).\n';
  warning += 'You should rotate it after this session.\n';

  if (advices.length > 0) {
    warning += '\nHow to rotate:\n';
    for (const advice of advices) {
      warning += `  - ${advice}\n`;
    }
  }

  warning += '\nThe message was NOT blocked — Claude will process it normally.';

  output(warning);
} catch {
  // Never block on errors — fail open
  output(null);
}
