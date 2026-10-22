#!/bin/bash
# 部署 stock-web 到广州服务器：打包 server/+web/ → scp → 解包 → 安装 systemd unit → 重启。
# 用法：在本机 VM 执行 bash ~/workspace/stock-web/deploy/deploy.sh
set -euo pipefail
SRC="$HOME/workspace/stock-web"
SSH="$HOME/workspace/sub-aggregator/sshsrv.sh"
TGZ="/tmp/stock-web-deploy.tgz"

tar -czf "$TGZ" -C "$SRC" server web deploy/stock-web.service
MODE=scp "$SSH" "$TGZ" root@101.96.215.3:/tmp/stock-web-deploy.tgz
"$SSH" '
set -e
mkdir -p /opt/stock-web/data
tar -xzf /tmp/stock-web-deploy.tgz -C /opt/stock-web
cp /opt/stock-web/deploy/stock-web.service /etc/systemd/system/stock-web.service
systemctl daemon-reload
systemctl enable --now stock-web.service
sleep 1.5
systemctl is-active stock-web.service
curl -s http://127.0.0.1:18765/health
echo
'
echo "deploy done"
