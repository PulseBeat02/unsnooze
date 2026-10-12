import { STATE_DIR } from '../config.js';
import { hasAccounts } from './config.js';
import { selectRoutingAccount } from './routing.js';

export async function accountResumeGate(record, {
  stateDir = STATE_DIR, selectFn = selectRoutingAccount, configuredFn = hasAccounts,
} = {}) {
  if (!['claude', 'codex', 'agy'].includes(record.agent) || !configuredFn(record.agent, stateDir)) {
    return { ready: true, managed: false };
  }
  try {
    const selected = await selectFn(record.agent, { stateDir, refresh: true,
      minFetchedAt: Math.max(record.detectedAt || 0, record.bannerAt || 0) });
    return { ready: !!selected.account, managed: true, reason: selected.reason, retryAt: selected.retryAt };
  } catch { return { ready: false, managed: true, reason: 'account_check_unavailable' }; }
}
