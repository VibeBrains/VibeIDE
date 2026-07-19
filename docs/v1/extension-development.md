# Build your first VibeIDE extension

> Status: tutorial / quickstart.
> Source roadmap entry: «Документация: «Build your first VibeIDE extension»».
> Related: `docs/references-v1/extension-api-stability.md`.

VibeIDE extends VS Code's extension model with a VibeIDE-specific API surface
(`vscode.proposed.vibeide.d.ts`). This page walks through the smallest possible
extension that uses one feature from each surface — agent state, skills, plans,
constraints — as acceptance proof of the API.

## Prerequisites

- Node.js 22.x (matches VibeIDE runtime).
- VibeIDE installed locally (`scripts\vibe-dev.bat` for development build).
- Optional: VS Code itself for editing — the extension can be authored anywhere.

## Bootstrap

```bash
cd extensions/
yo code   # or copy from extensions/vibeide-sample/ when it lands
```

Pick **New Extension (TypeScript)**. Name it `vibeide-hello`.

In `package.json`:

```jsonc
{
  "name": "vibeide-hello",
  "engines": { "vibeide": ">=0.3.0" },
  "main": "./out/extension.js",
  "enabledApiProposals": [
    "vibeide-agent-status",
    "vibeide-skills-list",
    "vibeide-plans-events",
    "vibeide-constraints-query"
  ],
  "contributes": {
    "commands": [
      { "command": "vibeideHello.show", "title": "VibeIDE Hello: Show status" }
    ]
  },
  "activationEvents": ["onCommand:vibeideHello.show"]
}
```

`engines.vibeide` is the VibeIDE-specific version pin, separate from `engines.vscode`.

## Use the API

`src/extension.ts`:

```ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
    const cmd = vscode.commands.registerCommand('vibeideHello.show', async () => {
        const status = await (vscode as any).vibeide.agent.status();
        const skills = await (vscode as any).vibeide.skills.list();
        const allowed = await (vscode as any).vibeide.constraints.queryAllowed({
            tool: 'edit_file',
            target: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
        });

        const lines = [
            `Mode: ${status.mode}`,
            `Skills available: ${skills.length}`,
            `Edit allowed for workspace root: ${allowed ? 'yes' : 'no'}`,
        ];
        await vscode.window.showInformationMessage(lines.join(' · '));
    });

    context.subscriptions.push(cmd);

    const planSub = (vscode as any).vibeide.plans.subscribeToEvents((evt: any) => {
        console.log('[vibeide-hello] plan event:', evt.type, evt.planId);
    });
    context.subscriptions.push(planSub);
}

export function deactivate(): void { /* nothing */ }
```

Until `proposed` types are bundled, the cast through `any` is intentional — the actual
typings live in `vscode.proposed.vibeide-*.d.ts`. With the typings in place the cast
disappears.

## Run

```bash
cd extensions/vibeide-hello
npm install
npm run compile
```

Open the extension's folder in VibeIDE, press `F5` to launch the **Extension Development
Host**. In the host window run `VibeIDE Hello: Show status` from the command palette —
the notification fires.

## What's stable, what's proposed

See `docs/references-v1/extension-api-stability.md` for the full policy. The shortest
summary:

- All four surfaces used above are currently `proposed`. They can break in any minor
  `vibeVersion`.
- Read-only accessors (`agent.status`, `skills.list`, `constraints.queryAllowed`) are the
  first candidates for `stable`.

## Don't write to policy files from an extension

VibeIDE explicitly does **not** expose `permissions.json` or `constraints.json` writes
through the extension API. Do not work around this by reading and writing the JSON files
directly from your extension — the user's expectation is that those files are only
edited from the Unified `.vibe/` Config Panel.

## Distribute

When ready:

1. `npx vsce package` produces `vibeide-hello-<version>.vsix`.
2. Submit to **Open VSX** under category `VibeIDE` (when the category exists).
3. Or attach as a GitHub Release asset and tell users to install via "Install from VSIX".

We do not publish to the Microsoft VS Code marketplace by default — VibeIDE-specific
extensions live on Open VSX.

## Backlog

- `extensions/vibeide-sample/` ships a working version of this tutorial as a folder you
  can clone.
- Typings in `vscode.proposed.vibeide-*.d.ts` mean the `(vscode as any)` casts disappear.
- Migration section will document deprecations as they happen.
