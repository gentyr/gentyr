/**
 * gentyr remove-account <email> [--force] - Remove an account from rotation
 *
 * Tombstones all keys for the given email address. If the active key belongs
 * to the removed account, switches to the next available account first.
 *
 * --force: Allow removal even when it's the last account (sets active_key_id = null)
 *
 * @module commands/remove-account
 */

import {
  readRotationState,
  writeRotationState,
  logRotationEvent,
  selectActiveKey,
  updateActiveCredentials,
} from '../../.claude/hooks/key-sync.js';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m';

/**
 * Find all non-tombstone, non-invalid keys matching an email (case-insensitive).
 * @param {Object} keys - state.keys map
 * @param {string} email - email to match
 * @returns {string[]} matching key IDs
 */
function findKeysByEmail(keys, email) {
  const lower = email.toLowerCase();
  return Object.entries(keys)
    .filter(([, data]) => {
      if (data.status === 'tombstone' || data.status === 'invalid') return false;
      return data.account_email && data.account_email.toLowerCase() === lower;
    })
    .map(([id]) => id);
}

/**
 * List unique account emails from rotation state (excluding tombstone/invalid).
 * @param {Object} keys - state.keys map
 * @returns {string[]} unique emails
 */
function listAccountEmails(keys) {
  const emails = new Set();
  for (const data of Object.values(keys)) {
    if (data.status === 'tombstone' || data.status === 'invalid') continue;
    if (data.account_email) {
      emails.add(data.account_email);
    }
  }
  return [...emails];
}

/**
 * List registered accounts and exit.
 */
function listAccounts() {
  const state = readRotationState();
  const emails = new Map();
  for (const [id, data] of Object.entries(state.keys)) {
    if (data.status === 'tombstone' || data.status === 'invalid') continue;
    if (!data.account_email) continue;
    const e = data.account_email;
    if (!emails.has(e)) emails.set(e, { keys: 0, active: false, status: data.status });
    const entry = emails.get(e);
    entry.keys++;
    if (id === state.active_key_id) entry.active = true;
    if (data.status === 'active' && entry.status !== 'active') entry.status = data.status;
  }
  if (emails.size === 0) {
    console.log('No accounts registered.');
    return;
  }
  console.log('Registered accounts:');
  for (const [email, info] of emails) {
    const marker = info.active ? `${CYAN}* ` : '  ';
    console.log(`${marker}${email}${NC} (${info.status}, ${info.keys} key${info.keys > 1 ? 's' : ''})`);
  }
}

export default async function removeAccount(args) {
  // --list mode: display accounts and exit
  if (args.includes('--list')) {
    listAccounts();
    return;
  }

  const force = args.includes('--force');
  const positional = args.filter(a => !a.startsWith('--'));
  const email = positional[0];

  if (!email) {
    console.error(`${RED}Usage: npx gentyr remove-account <email> [--force]${NC}`);
    console.error(`\nRemoves an account and all its keys from the rotation system.`);
    process.exit(1);
  }

  // Basic email format validation
  if (!email.includes('@') || !email.includes('.')) {
    console.error(`${RED}Invalid email format: "${email}"${NC}`);
    console.error(`Expected an email address like user@example.com`);
    process.exit(1);
  }

  const state = readRotationState();

  // Find matching keys
  const matchedKeyIds = findKeysByEmail(state.keys, email);

  if (matchedKeyIds.length === 0) {
    const available = listAccountEmails(state.keys);
    console.error(`${RED}No active keys found for "${email}".${NC}`);
    if (available.length > 0) {
      console.error(`\nAvailable accounts:`);
      for (const e of available) {
        const marker = Object.entries(state.keys).some(([id, d]) =>
          d.account_email === e && id === state.active_key_id
        ) ? `${CYAN}* ` : '  ';
        console.error(`  ${marker}${e}${NC}`);
      }
    } else {
      console.error(`\nNo accounts registered in rotation state.`);
    }
    process.exit(1);
  }

  const activeIsMatched = matchedKeyIds.includes(state.active_key_id);

  // Handle active key removal
  if (activeIsMatched) {
    // Build a temporary state without the matched keys to find a replacement
    const tempState = {
      ...state,
      keys: Object.fromEntries(
        Object.entries(state.keys).filter(([id]) => !matchedKeyIds.includes(id))
      ),
      active_key_id: null,
    };

    const replacementId = selectActiveKey(tempState);

    if (replacementId) {
      const replacementKey = tempState.keys[replacementId];
      // Switch to the replacement before tombstoning
      state.active_key_id = replacementId;
      updateActiveCredentials(replacementKey);

      logRotationEvent(state, {
        timestamp: Date.now(),
        event: 'key_switched',
        key_id: replacementId,
        reason: 'account_removed',
        account_email: replacementKey.account_email || null,
      });

      console.log(`${GREEN}Switched active account to: ${replacementKey.account_email || replacementId.slice(0, 8) + '...'}${NC}`);
    } else if (force) {
      state.active_key_id = null;
      console.log(`${YELLOW}Warning: No replacement account available. Active account set to null.${NC}`);
      console.log(`${YELLOW}You will need to run /login to add a new account.${NC}`);
    } else {
      console.error(`${RED}Cannot remove the only account without --force.${NC}`);
      console.error(`This is the active account and no replacements are available.`);
      console.error(`\nUse --force to remove anyway (will set active account to null).`);
      process.exit(1);
    }
  }

  // Tombstone all matched keys
  const now = Date.now();
  for (const keyId of matchedKeyIds) {
    const keyData = state.keys[keyId];
    const preservedEmail = keyData.account_email;

    state.keys[keyId] = {
      status: 'tombstone',
      tombstoned_at: now,
      account_email: preservedEmail,
    };

    logRotationEvent(state, {
      timestamp: now,
      event: 'account_removed',
      key_id: keyId,
      reason: 'user_removed',
      account_email: preservedEmail || null,
    });
  }

  writeRotationState(state);

  // Warn about env var
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) {
    // Check if the env token matches any of the removed keys (by checking if we had an accessToken)
    // We can't check directly since we stripped it, but warn generically
    console.log(`${YELLOW}Note: CLAUDE_CODE_OAUTH_TOKEN is set in your environment.${NC}`);
    console.log(`${YELLOW}If it belongs to the removed account, clear it manually.${NC}`);
  }

  // Summary
  console.log(`\n${GREEN}Removed account: ${email}${NC}`);
  console.log(`  Keys tombstoned: ${matchedKeyIds.length}`);
  console.log(`  Active key switched: ${activeIsMatched ? 'yes' : 'no'}`);
  console.log(`\n  Tombstoned keys will be auto-cleaned after 24h.`);
  console.log(`  To re-add this account, use /login.`);
}
