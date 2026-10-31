/**
 * Choose a model route that can actually be called.
 *
 * `modelCatalog().default` can name a provider this deployment cannot reach —
 * for example `deepseek-official` when only an account-backed provider has
 * credentials. Picking the catalog default blindly is what produced
 * "no API key for provider route" on every summarizer run.
 */

/**
 * Pick a routable provider/model pair from a model catalog.
 *
 * @param {{ default?: { provider?: string, model?: string }, groups?: Array<{ id: string, models?: Array<{ id: string }> }> }} catalog Model catalog.
 * @param {{ provider?: string, model?: string }} [preferred] A route the user configured.
 * @returns {{ provider: string, model: string, effort: string }} The chosen route; empty strings when nothing is routable.
 */
export function pickRoute(catalog, preferred = {}) {
  const effort = typeof preferred.effort === 'string' ? preferred.effort : String(preferred.effort ?? '');
  const groups = Array.isArray(catalog?.groups) ? catalog.groups.filter(group => typeof group?.id === 'string' && group.id !== '') : [];
  const routable = new Set(groups.map(group => group.id));

  // 1. An explicitly configured route wins, as long as the catalog knows it.
  const wantedProvider = typeof preferred.provider === 'string' ? preferred.provider : '';
  const wantedModel = typeof preferred.model === 'string' ? preferred.model : '';
  if (wantedProvider !== '' && routable.has(wantedProvider)) {
    const group = groups.find(item => item.id === wantedProvider);
    const models = Array.isArray(group?.models) ? group.models : [];
    const model = wantedModel !== '' && models.some(item => item.id === wantedModel)
      ? wantedModel
      : models[0]?.id ?? '';
    if (model !== '') return { provider: wantedProvider, model, effort };
  }

  // 2. The catalog default, when that provider is actually routable.
  const defaultProvider = typeof catalog?.default?.provider === 'string' ? catalog.default.provider : '';
  const defaultModel = typeof catalog?.default?.model === 'string' ? catalog.default.model : '';
  if (defaultProvider !== '' && routable.has(defaultProvider) && defaultModel !== '') {
    return { provider: defaultProvider, model: defaultModel, effort: '' };
  }

  // 3. Anything routable, preferring account-backed providers over "official".
  const account = groups.find(group => group.id.includes('account'));
  const fallback = account ?? groups[0];
  if (fallback === undefined) return { provider: '', model: '', effort: '' };
  const models = Array.isArray(fallback.models) ? fallback.models : [];
  return { provider: fallback.id, model: models[0]?.id ?? '', effort: '' };
}
