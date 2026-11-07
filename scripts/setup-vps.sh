#!/usr/bin/env bash
# One-shot VPS setup for the EvilPanda bot (Ubuntu/Debian).
# Run from inside the cloned repo as a normal user with sudo:
#   bash scripts/setup-vps.sh
# Safe to re-run: never overwrites user-config.json or .env.
set -euo pipefail

cd "$(dirname "$0")/.."
echo "== EvilPanda bot setup in $(pwd)"

if [ "$(id -u)" = "0" ]; then
  echo "!! Running as root. Better: create a user (adduser bot && usermod -aG sudo bot), log in as it, re-run."
fi

# Node.js 22
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "== Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "   node $(node -v), npm $(npm -v)"

# pm2 keeps the bot running after logout / reboot
if ! command -v pm2 >/dev/null 2>&1; then
  echo "== Installing pm2"
  sudo npm install -g pm2
fi

# Firewall: the bot needs no inbound ports
if command -v ufw >/dev/null 2>&1 && ! sudo ufw status | grep -q "Status: active"; then
  echo "== Enabling firewall (SSH only)"
  sudo ufw allow OpenSSH
  sudo ufw --force enable
fi

echo "== Installing dependencies"
npm install --no-audit --no-fund

echo "== Running tests"
npm test

[ -f user-config.json ] || { cp user-config.example.json user-config.json; echo "== Created user-config.json (shadowMode: true)"; }
[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "== Created .env (edit it next)"; }

cat <<'EOF'

== Done. Next steps:
  1. nano .env        → RPC_URL, WALLET_ADDRESS (public address only for shadow mode),
                         TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional GMGN_API_KEY
                         Do NOT set WALLET_PRIVATE_KEY until you go live.
  2. Backtest:          npm run backtest -- --lessons lessons.json
  3. Shadow + paper:    pm2 start npm --name evpanda -- start
                        pm2 logs evpanda
                        node cli.js paper
                        pm2 save && pm2 startup   (then run the command it prints)
EOF
