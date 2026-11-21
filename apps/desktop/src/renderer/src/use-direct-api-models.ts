import { useEffect, useState } from 'react';
import type { AppSettings } from '@kai/contracts';
import { unwrap } from './types';

/** What each server listed the last time it answered, so reopening a menu does not ask again. A failed ask is not kept. */
const known = new Map<string, readonly string[]>();

/**
 * The models the Direct API's server lists right now (a gateway's gateway/coding, gateway/auto and so on), for menus that
 * offer a model by name. It asks once per server, quietly: if the server does not answer the list is empty and the menu
 * falls back on the models remembered in Settings.
 */
export function useDirectApiModels(settings: Pick<AppSettings, 'directApi'> | undefined): readonly string[] {
  const direct = settings?.directApi;
  const key = direct && direct.enabled ? `${direct.provider}|${direct.baseUrl}|${direct.credentialId}` : '';
  const [models, setModels] = useState<readonly string[]>(() => known.get(key) ?? []);

  useEffect(() => {
    if (!direct || !key) { setModels([]); return undefined; }
    const remembered = known.get(key);
    if (remembered) { setModels(remembered); return undefined; }
    let alive = true;
    void window.kaiDesktop
      .listProviderModels({ provider: direct.provider, baseUrl: direct.baseUrl, credentialId: direct.credentialId })
      .then(unwrap)
      .then((catalog) => {
        if (!alive || catalog.source !== 'live') return;
        known.set(key, catalog.models);
        setModels(catalog.models);
      })
      .catch(() => undefined);
    return () => { alive = false; };
    // The key already holds everything the request is made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return models;
}
