export const MAX_DEBUG_HISTORY = 12;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Minimal shape of `ModelRegistry.getProviderAuth()`, the resolver that
 * surfaces a credential-specific `baseUrl` (e.g. GitHub Copilot business /
 * enterprise tenants resolve a per-token proxy endpoint that differs from
 * the model's static `baseUrl`). Declared locally rather than imported so
 * the router keeps working against older `@earendil-works/pi-coding-agent`
 * releases where this method isn't in the public type declarations yet —
 * `resolveDelegatedModel` below feature-detects it at runtime and falls
 * back to the model's static `baseUrl` when it's unavailable.
 */
export interface RegistryWithProviderAuth {
  getProviderAuth?: (
    provider: string,
  ) => Promise<{ auth: { baseUrl?: string } } | undefined>;
}

/**
 * Resolves the credential-specific `baseUrl` for a model's provider, if any,
 * and returns a shallow-cloned model with it applied. Returns the original
 * model unchanged when no override is available (older pi-coding-agent
 * releases without `getProviderAuth`, no active credential, or a baseUrl
 * that matches the model's static default already).
 */
export const resolveDelegatedModel = async <
  TModel extends { provider: string; baseUrl: string },
>(
  registry: RegistryWithProviderAuth,
  model: TModel,
): Promise<TModel> => {
  try {
    const providerAuth = await registry.getProviderAuth?.(model.provider);
    const authBaseUrl = providerAuth?.auth.baseUrl;
    if (authBaseUrl && authBaseUrl !== model.baseUrl) {
      return { ...model, baseUrl: authBaseUrl };
    }
  } catch {
    // Fall back to the model's static baseUrl.
  }
  return model;
};
