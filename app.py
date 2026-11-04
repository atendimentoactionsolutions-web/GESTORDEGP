# -*- coding: utf-8 -*-
"""
GESTOR INTELIGENTE DE GRUPOS WHATSAPP (Python Backend + Flask)
Gerencia grupos, analisa distribuição geográfica por DDD (com foco em DDD 11 - SP Capital),
permissões de envio (somente ADM), controle de porte e saída facilitada em 1 clique.
"""

import os
import sys
import json
import time
import subprocess
import atexit
import requests
from typing import Dict, List, Any, Optional
from flask import Flask, request, jsonify, send_from_directory

from group_classifier import (
    analyze_group_participants,
    compute_global_summary,
    DDD_INFO
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")
BRIDGE_PORT = 4921
BRIDGE_URL = f"http://127.0.0.1:{BRIDGE_PORT}"
FLASK_PORT = 5150
BRIDGE_LOG_FILE = os.path.join(DATA_DIR, "bridge.log")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="")
bridge_process: Optional[subprocess.Popen] = None
bridge_log_handle = None


def find_node_executable() -> str:
    """Localiza o Node.js portátil ou instalado na máquina."""
    local_node = os.path.join(BASE_DIR, ".runtime", "node", "bin", "node")
    if os.path.exists(local_node) and os.access(local_node, os.X_OK):
        return local_node
    for candidate in [
        "/Users/mac/Desktop/CONTATO EXTRATOR /.runtime/node/bin/node",
        "/Users/mac/Desktop/CONTATO EXTRATOR/.runtime/node/bin/node",
        "/usr/local/bin/node"
    ]:
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "node"


def ensure_bridge_running():
    """Garante que o bridge do WhatsApp esteja em execução contínua sem deadlocks de pipe."""
    global bridge_process, bridge_log_handle
    try:
        resp = requests.get(f"{BRIDGE_URL}/status", timeout=1.2)
        if resp.status_code == 200:
            return  # Bridge já está ativo
    except Exception:
        pass

    node_bin = find_node_executable()
    bridge_script = os.path.join(BASE_DIR, "bridge.mjs")

    print(f"[Python] Inicializando WhatsApp Bridge via {node_bin}...")
    try:
        bridge_log_handle = open(BRIDGE_LOG_FILE, "a", encoding="utf-8")
        bridge_process = subprocess.Popen(
            [node_bin, bridge_script],
            cwd=BASE_DIR,
            stdout=bridge_log_handle,
            stderr=bridge_log_handle
        )
        # Aguarda brevemente para inicialização do socket
        for _ in range(12):
            time.sleep(0.3)
            try:
                r = requests.get(f"{BRIDGE_URL}/status", timeout=0.8)
                if r.status_code == 200:
                    break
            except Exception:
                pass
        print("[Python] WhatsApp Bridge operacional.")
    except Exception as e:
        print(f"[Python] Falha ao iniciar processo do bridge: {e}")


def cleanup_bridge():
    """Encerra com segurança o processo filho ao desligar o servidor Python."""
    global bridge_process, bridge_log_handle
    if bridge_process and bridge_process.poll() is None:
        try:
            print("[Python] Encerrando WhatsApp Bridge...")
            bridge_process.terminate()
            bridge_process.wait(timeout=2)
        except Exception:
            try:
                bridge_process.kill()
            except Exception:
                pass
    if bridge_log_handle and not bridge_log_handle.closed:
        try:
            bridge_log_handle.close()
        except Exception:
            pass


atexit.register(cleanup_bridge)


@app.before_request
def check_bridge_health():
    """Verifica se as rotas da API encontram o bridge ativo."""
    if request.path.startswith("/api/"):
        try:
            requests.get(f"{BRIDGE_URL}/status", timeout=0.6)
        except Exception:
            ensure_bridge_running()


@app.after_request
def add_cors_and_security(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


# ==========================================
# ROTAS DA API REST
# ==========================================

@app.route("/api/status", methods=["GET"])
def get_status():
    """Retorna estado da conexão e QR Code em tempo real."""
    try:
        resp = requests.get(f"{BRIDGE_URL}/status", timeout=3.0)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({
            "state": "disconnected",
            "qrDataUrl": None,
            "user": None,
            "groupCount": 0,
            "isSyncing": False,
            "lastSync": None,
            "lastError": str(e),
            "lastMessage": "Conectando ao WhatsApp Bridge local..."
        })


@app.route("/api/groups", methods=["GET"])
def get_groups():
    """
    Retorna lista de grupos enriquecida com análises de DDD,
    com suporte a busca, filtros avançados e ordenação.
    """
    try:
        # Busca status para saber quem é o usuário atual
        status_resp = requests.get(f"{BRIDGE_URL}/status", timeout=3.0).json()
        current_user_jid = (status_resp.get("user") or {}).get("id")

        resp = requests.get(f"{BRIDGE_URL}/groups", timeout=25.0)
        data = resp.json()
        raw_groups = data.get("groups", [])
    except Exception as e:
        return jsonify({"ok": False, "error": f"Erro de comunicação com o WhatsApp Bridge: {e}"}), 500

    # Classifica todos os grupos participantes (sem excluir nenhum grupo do usuário)
    classified_groups = []
    for g in raw_groups:
        analyzed = analyze_group_participants(g, current_user_jid)
        classified_groups.append(analyzed)

    # Parâmetros de filtro
    q_tab = request.args.get("tab", "all").strip().lower() # all, low_views, low_sp11, high_sp11, admin_only, user_admin
    q_search = request.args.get("search", "").strip().lower()
    q_ddd = request.args.get("ddd", "").strip().lower()
    q_permission = request.args.get("permission", "").strip().lower() # admin_only, all_members
    q_size = request.args.get("size", "").strip().lower() # small, medium, large, giant
    q_role = request.args.get("role", "").strip().lower() # admin, member
    q_sort = request.args.get("sort", "views_asc" if q_tab == "low_views" else "members_desc").strip().lower()
    q_sp11 = request.args.get("sp11", "").strip().lower() # all, low, high
    q_engagement = request.args.get("engagement", "").strip().lower() # low, media, alta, sem_envio
    q_max_sp = request.args.get("max_sp", "").strip()
    q_min_sp = request.args.get("min_sp", "").strip()

    filtered = []
    for g in classified_groups:
        # 0. Filtro por Aba Principal (Organização Imediata e Direta)
        if q_tab == "small":
            # Grupos menores (1 a 20 membros) - exclui Comunidades que apenas listam o admin na raiz
            if g.get("total_participants", 0) > 20 or g.get("is_community"):
                continue
        elif q_tab == "bairros":
            # Grupos identificados com nome de bairro ou região de SP / Grande SP
            if not g.get("is_bairro"):
                continue
        elif q_tab == "desapego":
            # Grupos de desapego, bazar, brechó, usados
            if not g.get("is_desapego"):
                continue
        elif q_tab == "rolo":
            # Grupos de rolo, trocas, feira do rolo
            if not g.get("is_rolo"):
                continue
        elif q_tab == "low_views":
            # Grupos que menos visualizam as mensagens ou onde o envio é restrito
            if not g.get("is_low_views"):
                continue
        elif q_tab == "low_sp11":
            # Grupos com menor porcentagem de São Paulo Capital (DDD 11) - ordenados do menor para o maior
            if g.get("sp_capital_percent", 0) > 85.0 or g.get("total_identified_phones", 0) == 0:
                continue
        elif q_tab == "high_sp11":
            # Grupos com foco total em São Paulo Capital (DDD 11)
            if not g.get("is_sp_capital_predominant") and g.get("sp_capital_percent", 0) < 70.0:
                continue
        elif q_tab == "admin_only":
            # Somente administradores podem enviar mensagens
            if not g.get("only_admins_can_send"):
                continue
        elif q_tab == "user_admin":
            # Onde o usuário logado é administrador
            if not g.get("user_is_admin"):
                continue

        # 0.1 Filtro Específico de Visualização / Engajamento
        if q_engagement:
            if q_engagement == "low" and not g.get("is_low_views"):
                continue
            elif q_engagement in ("media", "alta", "sem_envio") and g.get("engagement_status") != q_engagement:
                continue

        # 1. Filtro de Busca (Nome ou Descrição)
        if q_search:
            subject = (g.get("subject") or "").lower()
            desc = (g.get("desc") or "").lower()
            if q_search not in subject and q_search not in desc:
                continue

        # 2. Filtro de DDD e Predominância Geográfica
        if q_ddd and q_ddd != "all":
            if q_ddd in ("11", "sp_capital"):
                # Grupos onde DDD 11 é predominante
                if not g["is_sp_capital_predominant"] and g["top_ddd"] != "11":
                    continue
            elif q_ddd in ("low_sp11", "least_sp11"):
                # Menos pessoas com DDD 11 (menor presença de São Paulo)
                if g["sp_capital_percent"] > 55.0:
                    continue
            elif q_ddd == "sp_interior":
                if g["top_ddd"] not in ("12", "13", "14", "15", "16", "17", "18", "19"):
                    continue
            elif q_ddd == "rj":
                if g["top_ddd"] not in ("21", "22", "24"):
                    continue
            elif q_ddd == "mg":
                if g["top_ddd"] not in ("31", "32", "33", "34", "35", "37", "38"):
                    continue
            elif q_ddd == "sul":
                if g["top_ddd"] not in ("41", "42", "43", "44", "45", "46", "47", "48", "49", "51", "53", "54", "55"):
                    continue
            elif q_ddd == "nordeste":
                if g["top_ddd"] not in ("71", "73", "74", "75", "77", "79", "81", "82", "83", "84", "85", "86", "87", "88", "89", "98", "99"):
                    continue
            elif q_ddd == "centro_oeste":
                if g["top_ddd"] not in ("61", "62", "64", "65", "66", "67"):
                    continue
            elif q_ddd == "norte":
                if g["top_ddd"] not in ("63", "68", "69", "91", "92", "93", "94", "95", "96", "97"):
                    continue
            elif q_ddd == "internacional":
                if not g["top_ddd"].startswith("+") and g["top_ddd"] != "Int":
                    continue
            else:
                # Código DDD específico (ex: "19", "21", "31")
                if g["top_ddd"] != q_ddd:
                    continue

        # 2.1 Filtro Específico de Concentração de DDD 11 (São Paulo)
        if q_sp11 and q_sp11 != "all":
            if q_sp11 == "low":
                # Grupos com MENOS pessoas com DDD 11 (São Paulo Capital)
                if g["sp_capital_percent"] > 55.0:
                    continue
            elif q_sp11 == "high":
                # Grupos com alta concentração de DDD 11
                if g["sp_capital_percent"] < 75.0:
                    continue

        # 2.2 Filtro por Porcentagem Exata Máxima / Mínima de SP
        if q_max_sp:
            try:
                if g["sp_capital_percent"] > float(q_max_sp):
                    continue
            except ValueError:
                pass

        if q_min_sp:
            try:
                if g["sp_capital_percent"] < float(q_min_sp):
                    continue
            except ValueError:
                pass

        # 3. Filtro de Permissão de Mensagens
        if q_permission == "admin_only":
            if not g["only_admins_can_send"]:
                continue
        elif q_permission == "all_members":
            if g["only_admins_can_send"]:
                continue

        # 4. Filtro por Porte de Grupo
        if q_size == "small":
            if g["total_participants"] > 20 or g.get("is_community"):
                continue
        elif q_size == "medium":
            if not (20 < g["total_participants"] <= 60):
                continue
        elif q_size == "large":
            if not (60 < g["total_participants"] <= 256):
                continue
        elif q_size == "giant":
            if g["total_participants"] <= 256:
                continue

        # 5. Filtro por Função do Usuário
        if q_role == "admin":
            if not g["user_is_admin"]:
                continue
        elif q_role == "member":
            if g["user_is_admin"]:
                continue

        filtered.append(g)

    # 6. Ordenação
    if q_sort == "views_asc":
        # Menor visualização primeiro (grupos onde menos pessoas vêem as mensagens do usuário)
        filtered.sort(key=lambda x: (not x.get("is_low_views"), x.get("view_rate", 0.0), x.get("views_count", 0), -x["total_participants"]))
    elif q_sort == "views_desc":
        # Maior visualização primeiro
        filtered.sort(key=lambda x: (x.get("view_rate", 0.0), x.get("views_count", 0)), reverse=True)
    elif q_sort == "members_desc":
        filtered.sort(key=lambda x: x["total_participants"], reverse=True)
    elif q_sort == "members_asc":
        # Menores grupos reais primeiro (Comunidades raízes são mantidas protegidas)
        filtered.sort(key=lambda x: (x.get("is_community", False), x["total_participants"]), reverse=False)
    elif q_sort == "sp11_asc":
        # Menor percentual de DDD 11 primeiro (os que têm menos gente de São Paulo)
        filtered.sort(key=lambda x: (x["sp_capital_percent"], x["sp_capital_count"], -x["total_participants"]))
    elif q_sort == "sp11_desc":
        # Maior percentual de DDD 11 primeiro
        filtered.sort(key=lambda x: (x["is_sp_capital_predominant"], x["sp_capital_percent"], x["sp_capital_count"]), reverse=True)
    elif q_sort == "name_asc":
        filtered.sort(key=lambda x: (x["subject"] or "").lower())
    elif q_sort == "created_desc":
        filtered.sort(key=lambda x: x.get("creation", 0), reverse=True)

    summary = compute_global_summary(classified_groups)

    return jsonify({
        "ok": True,
        "total_unfiltered": len(classified_groups),
        "total_filtered": len(filtered),
        "summary": summary,
        "groups": filtered
    })


@app.route("/api/summary", methods=["GET"])
def get_summary():
    """Retorna sumário executivo com contadores e métricas globais."""
    try:
        status_resp = requests.get(f"{BRIDGE_URL}/status", timeout=3.0).json()
        current_user_jid = (status_resp.get("user") or {}).get("id")

        resp = requests.get(f"{BRIDGE_URL}/groups", timeout=15.0)
        raw_groups = resp.json().get("groups", [])
        classified = [analyze_group_participants(g, current_user_jid) for g in raw_groups]
        summary = compute_global_summary(classified)
        return jsonify({"ok": True, "summary": summary})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/group/<path:group_id>", methods=["GET"])
def get_group_details(group_id: str):
    """Retorna dados detalhados e participantes de um grupo específico."""
    try:
        status_resp = requests.get(f"{BRIDGE_URL}/status", timeout=3.0).json()
        current_user_jid = (status_resp.get("user") or {}).get("id")

        resp = requests.get(f"{BRIDGE_URL}/groups", timeout=15.0)
        raw_groups = resp.json().get("groups", [])
        match = next((g for g in raw_groups if g.get("id") == group_id), None)
        if not match:
            return jsonify({"ok": False, "error": "Grupo não encontrado"}), 404

        analyzed = analyze_group_participants(match, current_user_jid)
        return jsonify({"ok": True, "group": analyzed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/groups/leave", methods=["POST"])
def leave_group():
    """
    Aciona a saída de um ou vários grupos com 1 clique.
    Payload: {"groupId": "1203630xxx@g.us"} OU {"groupIds": ["...", "..."]}
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        resp = requests.post(f"{BRIDGE_URL}/leave", json=data, timeout=35.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": f"Falha ao processar saída: {e}"}), 500


@app.route("/api/groups/refresh", methods=["POST"])
def refresh_groups():
    """Força atualização dos grupos do WhatsApp em tempo real."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/refresh", timeout=30.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": f"Falha ao sincronizar: {e}"}), 500


@app.route("/api/groups/purge-ghosts", methods=["POST"])
def purge_ghosts():
    """Limpa grupos fantasmas / órfãos do cache."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/purge-ghosts", timeout=10.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/groups/audit", methods=["POST"])
def audit_groups():
    """Audita e sincroniza participantes reais de todos os grupos."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/audit", timeout=10.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/whatsapp/logout", methods=["POST"])
def logout_whatsapp():
    """Desconecta a sessão do WhatsApp."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/logout", timeout=10.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/whatsapp/import-session", methods=["POST"])
def import_session():
    """Importa sessão já autenticada do Extrator de Contatos."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/import-session", timeout=20.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/ddd-list", methods=["GET"])
def get_ddd_list():
    """Retorna lista de referência de DDDs brasileiros."""
    return jsonify({"ok": True, "ddds": DDD_INFO})


# ==========================================
# ROTAS DO RADAR DE GRUPOS
# ==========================================

@app.route("/api/radar", methods=["GET"])
def get_radar():
    """Retorna grupos capturados pelo radar (links nos grupos e conversas)."""
    try:
        category = request.args.get("category", "all").strip().lower()
        search = request.args.get("search", "").strip().lower()

        resp = requests.get(f"{BRIDGE_URL}/radar", timeout=5.0)
        data = resp.json()
        groups = data.get("groups", [])

        # Filtragem na API Flask
        if category and category != "all":
            groups = [g for g in groups if g.get("category") == category]

        if search:
            groups = [
                g for g in groups
                if search in (g.get("subject") or "").lower()
                or search in (g.get("desc") or "").lower()
                or search in (g.get("bairroName") or "").lower()
            ]

        data["groups"] = groups
        data["filtered_count"] = len(groups)
        return jsonify(data)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/radar/scan", methods=["POST"])
def scan_radar():
    """Inicia varredura ativa de links nas descrições e mensagens dos grupos."""
    try:
        resp = requests.post(f"{BRIDGE_URL}/radar/scan", timeout=5.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/radar/inspect", methods=["POST"])
def inspect_radar_link():
    """Inspeciona link ou código de grupo e adiciona ao radar se for válido."""
    try:
        payload = request.get_json(force=True, silent=True) or {}
        resp = requests.post(f"{BRIDGE_URL}/radar/inspect", json=payload, timeout=12.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/radar/join", methods=["POST"])
def join_radar_group():
    """Entra em um grupo descoberto no radar."""
    try:
        payload = request.get_json(force=True, silent=True) or {}
        resp = requests.post(f"{BRIDGE_URL}/radar/join", json=payload, timeout=15.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/radar/remove", methods=["POST"])
def remove_radar_group():
    """Descarta link do radar."""
    try:
        payload = request.get_json(force=True, silent=True) or {}
        resp = requests.post(f"{BRIDGE_URL}/radar/remove", json=payload, timeout=5.0)
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/")
def serve_index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    ensure_bridge_running()
    print("=" * 70)
    print("🚀 GESTOR INTELIGENTE DE GRUPOS WHATSAPP")
    print(f"🌐 Acesse no seu navegador: http://127.0.0.1:{FLASK_PORT}")
    print("=" * 70)
    try:
        app.run(host="127.0.0.1", port=FLASK_PORT, debug=False)
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"[Aviso] Porta {FLASK_PORT} já está em uso por outra instância do Gestor.")
        else:
            raise e
