#!/usr/bin/env bash
# ==============================================================
# Script de Instalação e Deploy Automático na VPS (Ubuntu / Debian)
# GESTOR INTELIGENTE DE GRUPOS WHATSAPP (Porta 5150)
# ==============================================================

set -e

echo "=========================================================="
echo "🚀 INICIANDO DEPLOY DO GESTOR DE GRUPOS WHATSAPP NA VPS"
echo "=========================================================="

# 1. Atualização do Sistema
echo "📦 [1/5] Atualizando pacotes do sistema..."
sudo apt-get update -y
sudo apt-get install -y curl wget git python3 python3-pip python3-venv build-essential ufw

# 2. Instalação do Node.js 20 LTS (se não instalado)
if ! command -v node &> /dev/null; then
    echo "📦 [2/5] Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ [2/5] Node.js já instalado ($(node -v))"
fi

# 3. Instalação das dependências do Node.js
echo "📦 [3/5] Instalando dependências npm..."
npm install --omit=dev

# 4. Instalação das dependências Python
echo "📦 [4/5] Instalando dependências Python..."
pip3 install -r requirements.txt --break-system-packages 2>/dev/null || pip3 install -r requirements.txt

# 5. Configuração do Serviço Systemd (para rodar 24/7 reiniciando sozinho se cair)
echo "⚙️ [5/5] Configurando serviço em segundo plano (systemd)..."

APP_DIR=$(pwd)
USER_NAME=$(whoami)

sudo tee /etc/systemd/system/gestor-whatsapp.service > /dev/null <<EOF
[Unit]
Description=Gestor Inteligente de Grupos WhatsApp
After=network.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/python3 ${APP_DIR}/app.py
Restart=always
RestartSec=5
Environment=PATH=/usr/bin:/usr/local/bin:${PATH}
Environment=FLASK_PORT=5150

[Install]
WantedBy=multi-user.target
EOF

# Libera a porta 5150 no firewall caso esteja ativo
sudo ufw allow 5150/tcp 2>/dev/null || true

# Ativa e inicia o serviço
sudo systemctl daemon-reload
sudo systemctl enable gestor-whatsapp
sudo systemctl restart gestor-whatsapp

# Obtém IP público
PUB_IP=$(curl -s https://api.ipify.org || echo "IP_DA_SUA_VPS")

echo "=========================================================="
echo "✅ DEPLOY CONCLUÍDO COM SUCESSO!"
echo "🌐 Acesse no seu navegador: http://${PUB_IP}:5150"
echo "=========================================================="
echo "Comandos úteis no terminal da VPS:"
echo " • Ver status: sudo systemctl status gestor-whatsapp"
echo " • Ver logs:   sudo journalctl -u gestor-whatsapp -f"
echo " • Reiniciar:  sudo systemctl restart gestor-whatsapp"
echo " • Parar:      sudo systemctl stop gestor-whatsapp"
echo "=========================================================="
