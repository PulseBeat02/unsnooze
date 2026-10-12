import { STATE_DIR } from '../config.js';
import { readAccounts } from './config.js';
import { selectRoutingAccount } from './routing.js';

export async function accountResumeGate(record, {
  stateDir = STATE_DIR, selectFn = selectRoutingAccount,
  configuredFn = (provider, dir) => !!readAccounts(dir).providers[provider]?.accounts.length,
} = {}) {
  try {
    if (!['claude', 'codex', 'agy'].includes(record.agent) || !configuredFn(record.agent, stateDir)) {
      return { ready: true, managed: false };
    }
    const selected = await selectFn(record.agent, { stateDir, refresh: true,
      minFetchedAt: Math.max(record.detectedAt || 0, record.bannerAt || 0) });
    if (record.agent === 'agy') {
      const { readAgyJournal, agyOwnerAlive } = await import('./agy.js');
      const journal = readAgyJournal(stateDir);
      if (journal && journal.phase !== 'complete') {
        if (['installing', 'prepared', 'switching'].includes(journal.phase)
          || (agyOwnerAlive(journal) && (journal.account.id !== selected.account?.id
            || journal.child?.leaseId !== record.leaseId))) {
          return { ready: false, managed: true, reason: 'native_handoff' };
        }
      }
    }
    return { ready: !!selected.account, managed: true, reason: selected.reason, retryAt: selected.retryAt };
  } catch { return { ready: false, managed: true, reason: 'account_check_unavailable' }; }
}
