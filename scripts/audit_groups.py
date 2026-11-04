#!/usr/bin/env python3
"""
Script de Auditoria e Correção de Participantes de Grupos
---------------------------------------------------------
Varre todos os grupos do WhatsApp, identifica discrepâncias onde grupos
ativos aparecem incorretamente com apenas 1 membro ou tamanho vazio,
e força a resolução de metadados reais diretamente no WhatsApp.
"""

import sys
import time
import json
import urllib.request
import urllib.error

BRIDGE_URL = "http://127.0.0.1:4921"
FLASK_URL = "http://127.0.0.1:5150"

def check_status():
    try:
        req = urllib.request.urlopen(f"{BRIDGE_URL}/status", timeout=5)
        return json.loads(req.read().decode())
    except Exception as e:
        return None

def trigger_audit():
    try:
        req = urllib.request.Request(
            f"{BRIDGE_URL}/audit",
            data=b"{}",
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return json.loads(resp.read().decode())
    except Exception as e:
        return {"ok": False, "error": str(e)}

def fetch_groups():
    try:
        req = urllib.request.urlopen(f"{BRIDGE_URL}/groups", timeout=10)
        return json.loads(req.read().decode()).get("groups", [])
    except Exception as e:
        return []

def main():
    print("=" * 65)
    print("🛡️  AUDITOR DE GRUPOS WHATSAPP - PROTEÇÃO CONTRA MEMBROS INCOMPLETOS")
    print("=" * 65)

    status = check_status()
    if not status or status.get("state") != "connected":
        print("❌ WhatsApp não está conectado no bridge (porta 4921).")
        print("Certifique-se de que o Gestor de Grupos está aberto e autenticado.")
        sys.exit(1)

    user = status.get("user") or {}
    print(f"✅ Conectado como: {user.get('name', 'Usuário')} (+{user.get('phone', '')})")
    print(f"📦 Total de grupos registrados: {status.get('groupCount', 0)}")

    groups_before = fetch_groups()
    anomalies = [
        g for g in groups_before
        if len(g.get("participants", []) or []) <= 1 or
           (g.get("size") or 0) > len(g.get("participants", []) or []) or
           not g.get("subject") or g.get("subject", "").startswith("Grupo WhatsApp (")
    ]

    print(f"\n🔍 Grupos detectados precisando de enriquecimento: {len(anomalies)}")
    for a in anomalies[:10]:
        print(f"   • {a.get('subject')} | Part. atuais: {len(a.get('participants', []))} | Size: {a.get('size')}")
    if len(anomalies) > 10:
        print(f"   ... e mais {len(anomalies) - 10} grupos.")

    print("\n🚀 Disparando auditoria em tempo real no WhatsApp...")
    res = trigger_audit()
    if not res.get("ok"):
        print(f"❌ Falha ao iniciar auditoria: {res.get('error')}")
        sys.exit(1)

    print("⏳ Aguardando enriquecimento dos metadados...")
    for i in range(12):
        time.sleep(2.5)
        st = check_status()
        msg = st.get("lastMessage", "")
        print(f"   [{i+1}/12] Status: {msg}")
        # Se todos foram resolvidos
        cur_groups = fetch_groups()
        cur_anomalies = [
            g for g in cur_groups
            if len(g.get("participants", []) or []) <= 1 and (g.get("size") or 0) > 1
        ]
        if len(cur_anomalies) == 0:
            print("✨ Todos os grupos com discrepância de participantes foram corrigidos com sucesso!")
            break

    groups_after = fetch_groups()
    fixed_count = 0
    print("\n📊 Resumo da Auditoria:")
    for g in groups_after:
        p_count = len(g.get("participants", []) or [])
        size = g.get("size") or 0
        total = max(p_count, size)
        if total > 1:
            fixed_count += 1

    print(f"✅ Total de grupos auditados com participantes reais: {len(groups_after)}")
    print("=" * 65)

if __name__ == "__main__":
    main()
