# V1 providers with authentication fetch loaders

V1 providers that inject credentials through an authentication loader need explicit composition when selected hooks or retained historical context require prompt projection. The default harness entrypoint installs its prompt transport during configuration, and OpenCode 1.19.5 reapplies configuration after authentication-loader options. Without composition, the configuration fetch can replace the provider's authenticated fetch. A tool-only configuration with no retained context does not install the authentication-loader wrapper.

`composeV1Provider` from `opencode-harness-hooks/v1` or `opencode-harness-hooks/opencode` combines an initialized provider plugin with the guarded V1 harness. The bridge leaves the managed provider's configuration fetch unset and wraps the fetch returned by its authentication loader. Native prompt-context projection and private-header removal happen before the original authenticated fetch receives the request. Credential injection, refresh and request routing stay with the provider.

## Configure an explicit bridge

Create a local plugin module that initializes the intended provider once and passes its returned hooks to the helper. This example assumes the provider exports a factory accepting options and returning a plugin initializer; use the provider's actual initialization API:

```js
import createProvider from 'existing-provider-package'
import { composeV1Provider } from 'opencode-harness-hooks/opencode'

export default async function bridge(input, options) {
  const provider = await createProvider(options.provider)(input)
  return composeV1Provider(input, options.hooks, provider)
}
```

Load that module as one V1 plugin tuple. Its `provider` options are the existing provider's configuration, and its `hooks` options are the reviewed harness options described in the [stock-host guide](stock-hosts.md#select-native-sources-explicitly). Use the bridge in place of separate entries for that provider and the harness. Loading the same policies through another harness entry can execute them again; no deduplication is performed.

The helper accepts the provider's returned hooks, not a module name or credential values. It does not import or discover other configured plugins. The existing provider's authentication methods and loader arguments are retained. Shared host hooks run in provider-then-harness order after successful activation. Rejected configurations retain the harness guards directly so provider errors cannot hide them. Whole-plugin and session cleanup attempt the harness first and then the provider, even if either fails. Multiple cleanup failures remain available in an `AggregateError`. Closing a session cancels its admitted prompt requests even when provider cleanup fails.

## Boundaries and failures

The provider must expose an authentication provider ID and loader. Missing loader support retains fatal harness admission guards with `HOST_PROMPT_AUTH_LOADER_UNAVAILABLE`. Invalid loader output reports `HOST_PROMPT_AUTH_FETCH_UNAVAILABLE`; original loader failures retain their original error. API-key-only loader output can use the ordinary fetch fallback.

For the managed provider, a separate configured `provider.options.fetch` conflicts with the authentication loader and is rejected with `HOST_PROMPT_TRANSPORT_UNAVAILABLE`. The rejection also blocks prompt admission if the host swallows the configuration error. The resolved provider fetch is checked again before request execution. Legitimate fetches from repeated loader calls remain owned by the bridge and keep their respective authenticated delegates. The bridge does not choose one of two independent fetch implementations silently.

Tool-only composition with no retained prompt context preserves the original authentication loader. A bounded discovery read of [durable session state](session-state.md) identifies historical context that still requires projection after a source-selection change. The helper exercises one bridged authentication provider together with ordinary configured providers. Multiple authentication plugins sharing one harness runtime, arbitrary providers and authentication refresh protocols still need their own integration evidence. V2 uses its separate binding and does not use this helper. All other [stock-host limitations](stock-hosts.md) remain applicable, including selected Stop rejection.

## Verify composition

The installed-host probe uses a loopback provider with a credential transformation on every request. It requires that transformation together with mixed native prompt context, private-header removal, automatic titles, follow-up prompts and tool enforcement:

```sh
npm run build
npm run test:host:plugin -- --host v1 --binary /path/to/opencode --dialect mixed --prompts --preapproval --auth-composition
```

The probe also accepts `--auth-composition` with V1 tool-only and activation-rejection checks. It makes no model-account requests. A passing synthetic authentication transformation does not certify a particular provider's credential refresh behavior; verify the intended provider separately before activation.
