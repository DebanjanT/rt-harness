#!/usr/bin/env bash
# ============================================================================
# rt-harness — one-shot setup script (Linux + macOS)
#
#   ./setup.sh          install everything, then start the app
#   ./setup.sh --no-run install everything, don't start
#
# Checks/installs: Node.js (>=20) + npm, all npm dependencies (root, server,
# client), native module rebuild (better-sqlite3, node-pty), and a production
# build. It does NOT install any model server (Ollama/FreeToken/MLX/…) — you
# choose which provider and model to use; the script only checks whether an
# OpenAI-compatible server is already reachable.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

C_BLUE='\033[1;34m'; C_GREEN='\033[1;32m'; C_YELLOW='\033[1;33m'; C_RED='\033[1;31m'; C_OFF='\033[0m'
info()  { echo -e "${C_BLUE}[setup]${C_OFF} $*"; }
ok()    { echo -e "${C_GREEN}[ ok ]${C_OFF} $*"; }
warn()  { echo -e "${C_YELLOW}[warn]${C_OFF} $*"; }
fail()  { echo -e "${C_RED}[fail]${C_OFF} $*"; exit 1; }

NO_RUN=false
[[ "${1:-}" == "--no-run" ]] && NO_RUN=true

REQUIRED_NODE_MAJOR=20

# ----------------------------------------------------------------------------
# 0. Detect OS + available package managers
# ----------------------------------------------------------------------------
OS="unknown"
PKG=""
if [[ "$(uname)" == "Darwin" ]]; then
  OS="mac"
  command -v brew >/dev/null 2>&1 && PKG="brew"
elif [[ -f /etc/os-release ]]; then
  OS="linux"
  . /etc/os-release
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v pacman >/dev/null 2>&1; then PKG="pacman"
  fi
fi
info "Detected OS: $OS (package manager: ${PKG:-none})"

# ----------------------------------------------------------------------------
# 1. Node.js >= 20 + npm
# ----------------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge "$REQUIRED_NODE_MAJOR" ]]
}

install_node() {
  case "$PKG" in
    apt)
      info "Installing Node.js 20.x via NodeSource (apt)…"
      command -v curl >/dev/null 2>&1 || { sudo apt-get update && sudo apt-get install -y curl; }
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    dnf)
      info "Installing Node.js 20.x via dnf modules…"
      sudo dnf module install -y nodejs:20 || sudo dnf install -y nodejs
      ;;
    pacman)
      info "Installing nodejs + npm via pacman…"
      sudo pacman -Sy --noconfirm nodejs npm
      ;;
    brew)
      info "Installing Node.js via Homebrew…"
      brew install node@20 && brew link --overwrite node@20 || brew install node
      ;;
    *)
      warn "No supported package manager found."
      if [[ "$OS" == "linux" ]] && [[ "$EUID" -ne 0 ]]; then
        info "Installing Node 20 into ~/.local via official binaries (no sudo needed)…"
        NODE_VER="v20.18.1"
        ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && NARCH="x64" || NARCH="arm64"
        mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"
        curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NARCH}.tar.xz" \
          | tar -xJ -C "$HOME/.local/lib"
        export PATH="$HOME/.local/lib/node-${NODE_VER}-linux-${NARCH}/bin:$PATH"
        # persist for future shells
        grep -q "node-${NODE_VER}" "$HOME/.bashrc" 2>/dev/null || \
          echo "export PATH=\"$HOME/.local/lib/node-${NODE_VER}-linux-${NARCH}/bin:\$PATH\"" >> "$HOME/.bashrc"
      else
        fail "Please install Node.js ${REQUIRED_NODE_MAJOR}+ from https://nodejs.org and re-run this script."
      fi
      ;;
  esac
}

if node_ok; then
  ok "Node.js $(node -v) + npm $(npm -v)"
else
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v) is too old (need >= ${REQUIRED_NODE_MAJOR}) — upgrading…"
  else
    info "Node.js not found — installing…"
  fi
  install_node
  node_ok || fail "Node.js installation failed — install Node ${REQUIRED_NODE_MAJOR}+ manually from https://nodejs.org"
  ok "Node.js $(node -v) + npm $(npm -v)"
fi

# ----------------------------------------------------------------------------
# 2. Build essentials for native modules (Linux only — node-gyp needs them)
#    (better-sqlite3 / node-pty ship prebuilds for common platforms; these are
#     only needed when a prebuild is missing and compilation kicks in)
# ----------------------------------------------------------------------------
if [[ "$OS" == "linux" ]]; then
  if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
    info "Installing build tools (make/g++/python3) for native modules…"
    case "$PKG" in
      apt)   sudo apt-get update && sudo apt-get install -y build-essential python3 ;;
      dnf)   sudo dnf group install -y "Development Tools" && sudo dnf install -y python3 ;;
      pacman) sudo pacman -Sy --noconfirm base-devel python ;;
      *)     warn "Install build-essential/gcc manually if npm install fails." ;;
    esac
  else
    ok "Build tools present"
  fi
fi

# macOS: Xcode CLT needed only if compiling from source
if [[ "$OS" == "mac" ]] && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools not installed (only needed if native module prebuilds are missing)."
  warn "Run: xcode-select --install"
fi

# ----------------------------------------------------------------------------
# 3. Model server check (NOT installed here — just detected)
#    You may use any OpenAI-compatible provider (Ollama, FreeToken, MLX-LM,
#    LM Studio, vLLM…). If none is reachable, we tell you how to point the
#    harness at yours — we never assume which one you'll run.
# ----------------------------------------------------------------------------
check_model_server() {
  local port="$1"
  curl -s -o /dev/null -m 2 "http://127.0.0.1:${port}/v1/models" 2>/dev/null && return 0
  curl -s -o /dev/null -m 2 "http://127.0.0.1:${port}/models" 2>/dev/null && return 0
  return 1
}

MODEL_SERVER_FOUND=""
for port in 11434 1919 8080 1234 8000 1337 11435; do
  if check_model_server "$port"; then
    MODEL_SERVER_FOUND="$port"
    break
  fi
done

if [[ -n "$MODEL_SERVER_FOUND" ]]; then
  ok "Model server detected on http://127.0.0.1:${MODEL_SERVER_FOUND} — you're all set"
else
  warn "No model server detected on common ports (11434/1919/8080/1234…)."
  echo "         rt-harness works with ANY OpenAI-compatible server. Start whichever"
  echo "         you prefer, e.g.:"
  echo "           · Ollama:            ollama serve"
  echo "           · FreeToken:         start your freetoken server"
  echo "           · MLX-LM (Apple):    mlx_lm.server --model <model> --port 8080"
  echo "           · LM Studio / vLLM:  start with its OpenAI-compatible port"
  echo "         Then add it in the app: model switcher → ＋ Add custom endpoint"
  echo "         (or select it directly — built-ins: Ollama/FreeToken/MLX are prefilled)."
fi

# ----------------------------------------------------------------------------
# 4. npm dependencies (root, server, client)
# ----------------------------------------------------------------------------
npm_install() {
  local dir="$1"
  info "Installing dependencies in ./$dir …"
  (cd "$dir" && npm install --no-audit --no-fund) || return 1
  ok "Dependencies installed: ./$dir"
}

npm_install .      || fail "npm install failed in project root"
npm_install server || fail "npm install failed in server/"
npm_install client || fail "npm install failed in client/"

# ----------------------------------------------------------------------------
# 5. Native modules sanity check (better-sqlite3, node-pty) — rebuild if broken
# ----------------------------------------------------------------------------
info "Verifying native modules (better-sqlite3, node-pty)…"
if ! (cd server && node -e "require('better-sqlite3'); require('node-pty')" >/dev/null 2>&1); then
  warn "Native modules broken (or Node was upgraded) — rebuilding from source…"
  (cd server && npm rebuild better-sqlite3 node-pty --build-from-source) \
    || fail "Native module rebuild failed — see error above"
fi
ok "Native modules load correctly"

# ----------------------------------------------------------------------------
# 6. Build check (catches TS errors early; also proves everything compiles)
# ----------------------------------------------------------------------------
info "Building server + client (verification build)…"
(cd server && npm run build >/dev/null) || fail "Server build failed"
(cd client && npm run build >/dev/null) || fail "Client build failed"
ok "Both packages build cleanly"

echo
echo -e "${C_GREEN}============================================================${C_OFF}"
echo -e "${C_GREEN}  rt-harness is ready!${C_OFF}"
echo -e "${C_GREEN}============================================================${C_OFF}"
echo
echo "  Start everything (server :8787 + client :5173):"
echo -e "    ${C_YELLOW}npm run dev${C_OFF}"
echo
echo "  Then open http://localhost:5173"
echo
echo "  Model server: start YOUR provider before chatting (Ollama, FreeToken,"
echo "  MLX-LM, LM Studio, vLLM — anything OpenAI-compatible)."
echo

if [[ "$NO_RUN" == "true" ]]; then
  info "Skipping startup (--no-run given)."
  exit 0
fi

# ----------------------------------------------------------------------------
# 7. Start the app
# ----------------------------------------------------------------------------
read -r -p "Start rt-harness now? [Y/n] " answer
answer="${answer:-Y}"
if [[ "$answer" =~ ^[Yy] ]]; then
  info "Starting server + client (Ctrl+C stops both)…"
  exec npm run dev
fi
