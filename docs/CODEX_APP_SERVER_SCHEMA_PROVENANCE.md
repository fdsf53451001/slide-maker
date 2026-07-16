# Codex app-server schema provenance

This QA baseline is pinned to `codex-cli 0.144.4`.

The protocol bundle was generated locally on 2026-07-14 with the installed Codex binary, without starting a model turn or image generation:

```sh
codex --version
codex app-server generate-json-schema --out /tmp/slide-maker-codex-schema --experimental
```

Generated-file SHA-256 checksums:

| File                                        | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `codex_app_server_protocol.v2.schemas.json` | `a4d714356d5c157d4fcf0cd59ccb3d8ed38b4150fb3a6002ac37f694ea163cbe` |
| `ClientRequest.json`                        | `d8474445e109c242a2cc1169ed6d8644f86df3a097230c8c52bdc107a9014efa` |
| `ServerNotification.json`                   | `fb0d6bf6b9f192257f452340de3fdca6b4b2c8e1a216aafaf48837a006e14bea` |
| `v1/InitializeResponse.json`                | `86dcd236d0576a82c85b933586dc45731260eab1b6edb3447b03f790277322b1` |
| `v2/ThreadStartParams.json`                 | `4f30cb90cae47ff01adba8d863228b2aa198232df895dbfc996d594270326744` |
| `v2/ThreadStartResponse.json`               | `eb5135241a7806db436100493c91214ef3516c4a9bd9aae700abc418c71be132` |
| `v2/TurnStartParams.json`                   | `a28f74287e18b8a18c7aa6966ee7552a8ed2ae13c03f4ba12e9af48f7370f19d` |
| `v2/TurnStartResponse.json`                 | `7cfae42a4652fe38119d6a0a625910357c869c448c985513a4cd5966031e18bc` |
| `v2/ItemCompletedNotification.json`         | `2905f1169b0990af2b114358b0b14ddb071fdd2643ac7e43a62c8db40643abcf` |
| `v2/TurnCompletedNotification.json`         | `900bc6e40f0aeb5aa498ec874f026a2a077356ac1dc740c1928cfdca29630345` |

Security-relevant schema facts used by QA:

- `ThreadStartParams.sandbox` is the kebab-case enum `read-only`; `TurnStartParams.sandboxPolicy.type` is the camelCase value `readOnly`.
- `InitializeResponse` requires `codexHome`, `platformFamily`, `platformOs`, and `userAgent`.
- `ThreadStartResponse` requires `approvalPolicy`, `approvalsReviewer`, `cwd`, `model`, `modelProvider`, `sandbox`, and `thread`.
- A returned `Thread` requires `cliVersion`, `createdAt`, `cwd`, `ephemeral`, `id`, `modelProvider`, `preview`, `sessionId`, `source`, `status`, `turns`, and `updatedAt`.
- `TurnStartResponse.turn` requires `id`, `items`, and `status`.
- The `imageGeneration` item schema requires `id`, `result`, `status`, and `type`; `savedPath` is optional. A saved-path-only fixture should therefore use an empty `result` string rather than omit the required field.

This file records provenance only. Runtime remains fail-closed on any CLI version other than `0.144.4`.
