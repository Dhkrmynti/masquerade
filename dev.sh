#!/usr/bin/env bash
# Local stack: anvil chain + contracts + static site.
# anvil keeps state in memory, so every restart redeploys from scratch.
set -euo pipefail
cd "$(dirname "$0")"
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # anvil dev account #0

if ! cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1; then
  anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --silent &
  sleep 2
fi
(cd contracts && OWNER=$OWNER forge script script/DeployLocal.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender $OWNER >/dev/null)
echo "contracts deployed → deployments/local.json"
(cd agent && [ -d node_modules ] || npm install --silent; node src/runner.js > ../agent.log 2>&1 &)
echo "agent → http://127.0.0.1:5199 (log: agent.log)"
echo "site: http://127.0.0.1:5198/app.html#envoys"
exec python3 -m http.server 5198 --bind 127.0.0.1
