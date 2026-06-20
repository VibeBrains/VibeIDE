# Persona vs Custom Modes — service boundary

> Status: normative.
> Source: roadmap §987 (`vibePersonaService.ts` orphan).

## Statement

`VibePersonaService` and `VibeCustomModesService` solve **different** problems and
must remain two services. They do not duplicate each other.

## Boundary

| Aspect             | `VibePersonaService`                                    | `VibeCustomModesService`                                  |
|--------------------|---------------------------------------------------------|-----------------------------------------------------------|
| **Scope**          | Agent communication style.                              | Tool capability profile + system prompt swap.             |
| **Persistence**    | `.vibe/persona.json` (workspace).                       | `.vibe/modes/*.json` (workspace) + global mode catalog.    |
| **Knobs**          | verbosity / formality / language / ask-before-assume.   | Allowed tools, MCP servers, system prompt, model preset.  |
| **Touched by**     | LLM message preamble (every request).                   | Mode picker (Chat / Plan / etc), runtime tool gating.     |
| **Owner**          | Agent UX (how it talks).                                | Agent capability (what it can do).                        |
| **Default value**  | DEFAULT_PERSONA (concise/technical/en).                 | Built-in modes (chat, plan, gather).                      |

## Interaction

The agent runtime composes a request as:
1. Capability fence from active **mode** — which tools, which model, which system prompt template.
2. Communication overlay from active **persona** — verbosity, language, "ask before assume" suffixes.

Persona never grants/revokes capabilities. Mode never adjusts tone.

## Why two services

Combining them was considered and rejected:
- Persona changes are workspace-scoped per project but rarely change mid-session.
- Mode changes happen many times per session (Chat → Plan → Gather → Chat).
- Mode files ship in user marketplace catalogs; persona files contain workspace-level
  preferences that should not be shared verbatim.
- A mode swap should not reset persona settings, and a persona tweak should not
  require re-selecting a mode.

## Acceptance / non-duplication test

`scripts/vibe-services-inventory.js` lists both as **separate** entries. If a future
PR introduces overlap (e.g. tool-allowlist field on persona, or verbosity field on
mode), this contract document is the place to update first; the services are then
refactored to stay disjoint.
