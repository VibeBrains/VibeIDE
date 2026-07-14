#!/usr/bin/env bash
# home-build-common.sh — shared helpers for the home-build (build-from-source) scripts.
# Sourced by scripts/home-build-linux.sh and scripts/home-build-macos.sh.
#
# Home build = compile + package a runnable, portable VibeIDE for the CURRENT machine.
# It is a SELF-CONTAINED BOOTSTRAP: it installs fnm if missing, downloads+activates the
# Node version pinned in .nvmrc, runs `npm ci`, then compiles and packages. It deliberately
# has NONE of the release machinery: no version bump, no git, no donation phrase, no readiness
# guards, no manifest/checksums, no code-signing (macOS keeps only the ad-hoc signature
# required to launch on Apple Silicon), no GitHub Release. Just the app.
#
# This file is a library — running it directly is a mistake.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	echo "home-build-common.sh is a library — run scripts/home-build.sh instead." >&2
	exit 1
fi

hb_step() { printf '\033[33m▶ %s\033[0m\n' "$1"; }
hb_ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
hb_warn() { printf '\033[33m⚠ %s\033[0m\n' "$1" >&2; }
hb_die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Map `uname -m` to the arch token gulp expects (x64 / arm64).
hb_host_arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo x64 ;;
		arm64 | aarch64) echo arm64 ;;
		*) hb_die "unsupported host arch: $(uname -m) (only x64 / arm64)" ;;
	esac
}

# ── Intentions gate ───────────────────────────────────────────────────────────
# Announce exactly what the script will install / do, then let the user bail out.
# $1 = human-readable OS+arch+artifact summary. HB_ASSUME_YES=1 (or --yes upstream)
# skips the prompt; a non-interactive shell without HB_ASSUME_YES aborts (safe default).
hb_confirm_intentions() {
	local summary="$1" node_ver="$2"
	printf '\n\033[36m╔══════════════════════════════════════════════════════════╗\033[0m\n'
	printf '\033[36m║  VibeIDE — ДОМАШНЯЯ СБОРКА из исходников                  ║\033[0m\n'
	printf '\033[36m╚══════════════════════════════════════════════════════════╝\033[0m\n\n'
	printf 'Скрипт выполнит на этой машине следующее:\n'
	printf '  1. Установит \033[1mfnm\033[0m (менеджер версий Node), если его ещё нет.\n'
	printf '  2. Скачает и активирует \033[1mNode %s\033[0m (из .nvmrc) через fnm.\n' "$node_ver"
	printf '  3. Установит зависимости: \033[1mnpm ci\033[0m (если node_modules отсутствуют).\n'
	printf '  4. Скомпилирует и упакует: \033[1m%s\033[0m.\n' "$summary"
	printf '\n  Что НЕ делается: без бампа версии, git-коммитов, подписи и публикации.\n\n'
	if [[ "${HB_ASSUME_YES:-0}" == '1' ]]; then
		hb_ok 'HB_ASSUME_YES=1 / --yes — продолжаю без запроса.'
		return 0
	fi
	if [[ ! -t 0 ]]; then
		hb_die 'неинтерактивный запуск без --yes — прерываю (передай --yes, чтобы согласиться на установку fnm/Node/зависимостей).'
	fi
	local reply
	read -r -p 'Продолжить? [y/N] ' reply
	case "$reply" in
		y | Y | yes | Yes | да | Да) return 0 ;;
		*) printf 'Отменено.\n'; exit 0 ;;
	esac
}

# ── Bootstrap: fnm → Node → dependencies ──────────────────────────────────────
hb_ensure_fnm() {
	if command -v fnm > /dev/null 2>&1; then
		hb_ok "fnm уже установлен ($(fnm --version 2> /dev/null || echo '?'))"
		return 0
	fi
	hb_step 'fnm не найден — устанавливаю...'
	if [[ "$(uname -s)" == 'Darwin' ]] && command -v brew > /dev/null 2>&1; then
		brew install fnm
	else
		# Official installer; --skip-shell avoids editing the user's profile behind their back.
		curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
	fi
	# Make the freshly-installed fnm visible in THIS shell.
	local cand
	for cand in "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm" "$HOME/.fnm"; do
		[[ -x "$cand/fnm" ]] && export PATH="$cand:$PATH"
	done
	command -v fnm > /dev/null 2>&1 || hb_die 'установка fnm не удалась — поставь вручную (https://github.com/Schniz/fnm) и повтори.'
	hb_ok "fnm установлен ($(fnm --version 2> /dev/null || echo '?'))"
}

# Install the pinned Node via fnm and prepend its bin dir to PATH for this run.
hb_ensure_node() {
	local root="$1"
	local node_ver
	node_ver="$(tr -d '[:space:]' < "$root/.nvmrc" 2> /dev/null || echo 22.22.1)"
	hb_step "Устанавливаю/активирую Node $node_ver через fnm..."
	fnm install "$node_ver" 2> /dev/null || true   # idempotent; already-installed is fine
	local node_dir='' fnm_root
	for fnm_root in "${FNM_DIR:-}" "$HOME/.local/share/fnm" "$HOME/Library/Application Support/fnm" "${XDG_DATA_HOME:-$HOME/.local/share}/fnm" "$HOME/.fnm"; do
		[[ -n "$fnm_root" && -x "$fnm_root/node-versions/v$node_ver/installation/bin/node" ]] || continue
		node_dir="$fnm_root/node-versions/v$node_ver/installation/bin"
		break
	done
	if [[ -z "$node_dir" ]]; then
		node_dir="$(fnm exec --using "$node_ver" node -e "process.stdout.write(require('path').dirname(process.execPath))" 2> /dev/null || true)"
	fi
	[[ -n "$node_dir" ]] || hb_die "не удалось активировать Node $node_ver через fnm."
	export PATH="$node_dir:$PATH"
	hb_ok "Node $(node --version) активирован"
}

# Install dependencies if absent. Home build owns the whole bootstrap, so it runs npm ci
# itself — but skips it when node_modules already look complete (avoids a slow reinstall).
hb_ensure_deps() {
	local root="$1"
	if [[ -d "$root/node_modules/gulp" ]]; then
		hb_ok 'Зависимости на месте (node_modules) — пропускаю npm ci'
		return 0
	fi
	hb_step 'Устанавливаю зависимости (npm ci)...'
	( cd "$root" && npm ci )
	[[ -d "$root/node_modules/gulp" ]] || hb_die 'npm ci завершился, но node_modules/gulp нет — проверь ошибки установки выше.'
	hb_ok 'Зависимости установлены'
}

hb_bootstrap() {
	local root="$1"
	hb_ensure_fnm
	hb_ensure_node "$root"
	hb_ensure_deps "$root"
}

hb_gulp() {
	local root="$1" task="$2"
	node --max-old-space-size=8192 "$root/node_modules/gulp/bin/gulp.js" "$task"
}

# Pre-package steps that gulp does NOT do itself (React tree + .vibe-defaults manifest).
# The gulp `vscode-<plat>-<arch>` task compiles TypeScript on its own, so no separate
# compile-build here.
hb_precompile() {
	local root="$1"
	hb_step 'Extracting VibeIDE NLS strings...'
	hb_gulp "$root" extract-vibeide-locale-strings || echo '⚠ NLS extraction failed (non-fatal)'

	hb_step 'Regenerating embedded artifacts (.vibe-defaults, specs help)...'
	( cd "$root" && npm run gen:all )

	hb_step 'Rebuilding React tree (scope-tailwind + tsup)...'
	( cd "$root" && npm run buildreact )
}
