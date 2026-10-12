// Usage output retains every measured pool. Routing considers only windows
// known to apply to the requested model; unknown groups remain conservative.
export function scopeUsage(provider, entry, model, { now = Date.now() } = {}) {
  if (!entry || typeof model !== 'string' || !model.trim()) return entry;
  const requested = model.toLowerCase();
  const relevant = window => {
    if (!window.group) return true;
    const group = window.group.toLowerCase();
    if (provider === 'agy') {
      if (/gemini/.test(requested)) return group !== 'claude and gpt models';
      if (/claude|gpt|codex/.test(requested)) return group !== 'gemini models';
    }
    if (provider === 'claude') {
      if (group === 'opus') return /opus/.test(requested);
      if (group === 'sonnet') return /sonnet/.test(requested);
      if (['oauth apps', 'cowork'].includes(group)) return false;
    }
    if (provider === 'codex' && group === 'code review') return /review/.test(requested);
    return true;
  };
  const windows = (entry.windows || []).filter(relevant);
  const times = windows.map(w => w.fetchedAt ?? entry.fetchedAt);
  const fetchedAt = times.length ? Math.min(...times) : entry.fetchedAt;
  const status = ['ok', 'quota_exhausted'].includes(entry.status)
    ? windows.length ? windows.some(w => w.usedPercent >= 100) ? 'quota_exhausted' : 'ok' : 'unknown'
    : entry.status;
  return { ...entry, windows, status, fetchedAt,
    stale: !Number.isFinite(fetchedAt) || now - fetchedAt >= 60000 || fetchedAt > now
      || windows.some(w => w.resetAt != null && w.resetAt <= now)
      || !['ok', 'quota_exhausted'].includes(status) };
}
