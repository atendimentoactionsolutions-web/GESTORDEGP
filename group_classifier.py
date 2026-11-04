# -*- coding: utf-8 -*-
"""
Motor de Classificação e Inteligência de Grupos de WhatsApp por DDD e Métricas.
Identifica distribuição geográfica, predominância de DDD (com foco em DDD 11 - SP Capital),
permissões de envio (somente ADM), controle de porte e saída simplificada.
"""

import re
from typing import Dict, List, Any, Optional, Tuple
from collections import Counter

# Mapeamento completo e oficial de todos os 67 DDDs do Brasil
DDD_INFO: Dict[str, Dict[str, str]] = {
    # São Paulo (Capital, Litoral e Interior)
    "11": {"estado": "SP", "regiao": "SP Capital e Grande SP", "macro": "SP Capital", "cidade_ref": "São Paulo / Região Metropolitana"},
    "12": {"estado": "SP", "regiao": "Vale do Paraíba / Litoral Norte", "macro": "SP Interior", "cidade_ref": "São José dos Campos / Taubaté"},
    "13": {"estado": "SP", "regiao": "Baixada Santista / Litoral Sul", "macro": "SP Interior", "cidade_ref": "Santos / Praia Grande"},
    "14": {"estado": "SP", "regiao": "Centro-Oeste Paulista", "macro": "SP Interior", "cidade_ref": "Bauru / Marília / Jaú / Botucatu"},
    "15": {"estado": "SP", "regiao": "Sudoeste Paulista", "macro": "SP Interior", "cidade_ref": "Sorocaba / Itapetininga"},
    "16": {"estado": "SP", "regiao": "Nordeste Paulista", "macro": "SP Interior", "cidade_ref": "Ribeirão Preto / Franca / Araraquara"},
    "17": {"estado": "SP", "regiao": "Noroeste Paulista", "macro": "SP Interior", "cidade_ref": "São José do Rio Preto / Barretos"},
    "18": {"estado": "SP", "regiao": "Oeste Paulista", "macro": "SP Interior", "cidade_ref": "Presidente Prudente / Araçatuba"},
    "19": {"estado": "SP", "regiao": "Leste Paulista / Campinas", "macro": "SP Interior", "cidade_ref": "Campinas / Piracicaba / Americana"},

    # Rio de Janeiro
    "21": {"estado": "RJ", "regiao": "Rio de Janeiro Capital e Região Metropolitana", "macro": "Sudeste", "cidade_ref": "Rio de Janeiro / Niterói"},
    "22": {"estado": "RJ", "regiao": "Região dos Lagos e Norte Fluminense", "macro": "Sudeste", "cidade_ref": "Campos / Cabo Frio / Macaé"},
    "24": {"estado": "RJ", "regiao": "Região Serrana e Sul Fluminense", "macro": "Sudeste", "cidade_ref": "Petrópolis / Volta Redonda"},

    # Espírito Santo
    "27": {"estado": "ES", "regiao": "Grande Vitória e Norte Capixaba", "macro": "Sudeste", "cidade_ref": "Vitória / Vila Velha"},
    "28": {"estado": "ES", "regiao": "Sul Capixaba", "macro": "Sudeste", "cidade_ref": "Cachoeiro de Itapemirim"},

    # Minas Gerais
    "31": {"estado": "MG", "regiao": "Belo Horizonte e Região Metropolitana", "macro": "Sudeste", "cidade_ref": "Belo Horizonte / Contagem"},
    "32": {"estado": "MG", "regiao": "Zona da Mata / Campo das Vertentes", "macro": "Sudeste", "cidade_ref": "Juiz de Fora / Barbacena"},
    "33": {"estado": "MG", "regiao": "Vale do Rio Doce / Mucuri", "macro": "Sudeste", "cidade_ref": "Governador Valadares / Teófilo Otoni"},
    "34": {"estado": "MG", "regiao": "Triângulo Mineiro / Alto Paranaíba", "macro": "Sudeste", "cidade_ref": "Uberlândia / Uberaba"},
    "35": {"estado": "MG", "regiao": "Sul / Sudoeste de Minas", "macro": "Sudeste", "cidade_ref": "Poços de Caldas / Pouso Alegre"},
    "37": {"estado": "MG", "regiao": "Centro-Oeste de Minas", "macro": "Sudeste", "cidade_ref": "Divinópolis / Itaúna"},
    "38": {"estado": "MG", "regiao": "Norte de Minas", "macro": "Sudeste", "cidade_ref": "Montes Claros"},

    # Paraná
    "41": {"estado": "PR", "regiao": "Curitiba e Região Metropolitana", "macro": "Sul", "cidade_ref": "Curitiba / Paranaguá"},
    "42": {"estado": "PR", "regiao": "Campos Gerais e Centro-Sul", "macro": "Sul", "cidade_ref": "Ponta Grossa / Guarapuava"},
    "43": {"estado": "PR", "regiao": "Norte Pioneiro e Londrina", "macro": "Sul", "cidade_ref": "Londrina / Apucarana"},
    "44": {"estado": "PR", "regiao": "Noroeste Paranaense", "macro": "Sul", "cidade_ref": "Maringá / Campo Mourão"},
    "45": {"estado": "PR", "regiao": "Oeste Paranaense", "macro": "Sul", "cidade_ref": "Cascavel / Foz do Iguaçu"},
    "46": {"estado": "PR", "regiao": "Sudoeste Paranaense", "macro": "Sul", "cidade_ref": "Francisco Beltrão / Pato Branco"},

    # Santa Catarina
    "47": {"estado": "SC", "regiao": "Norte e Vale do Itajaí", "macro": "Sul", "cidade_ref": "Joinville / Blumenau / Itajaí"},
    "48": {"estado": "SC", "regiao": "Florianópolis e Sul", "macro": "Sul", "cidade_ref": "Florianópolis / Criciúma"},
    "49": {"estado": "SC", "regiao": "Oeste Catarinense", "macro": "Sul", "cidade_ref": "Chapecó / Concórdia"},

    # Rio Grande do Sul
    "51": {"estado": "RS", "regiao": "Porto Alegre e Região Metropolitana", "macro": "Sul", "cidade_ref": "Porto Alegre / Canoas"},
    "53": {"estado": "RS", "regiao": "Pelotas e Sul Gaúcho", "macro": "Sul", "cidade_ref": "Pelotas / Rio Grande"},
    "54": {"estado": "RS", "regiao": "Serra Gaúcha", "macro": "Sul", "cidade_ref": "Caxias do Sul / Bento Gonçalves"},
    "55": {"estado": "RS", "regiao": "Santa Maria e Noroeste Gaúcho", "macro": "Sul", "cidade_ref": "Santa Maria / Passo Fundo"},

    # Centro-Oeste
    "61": {"estado": "DF/GO", "regiao": "Brasília e Entorno", "macro": "Centro-Oeste", "cidade_ref": "Brasília / Taguatinga"},
    "62": {"estado": "GO", "regiao": "Goiânia e Região Central", "macro": "Centro-Oeste", "cidade_ref": "Goiânia / Anápolis"},
    "64": {"estado": "GO", "regiao": "Sul e Sudoeste Goiano", "macro": "Centro-Oeste", "cidade_ref": "Rio Verde / Caldas Novas"},
    "65": {"estado": "MT", "regiao": "Cuiabá e Pantanal", "macro": "Centro-Oeste", "cidade_ref": "Cuiabá / Várzea Grande"},
    "66": {"estado": "MT", "regiao": "Rondonópolis e Norte do Mato Grosso", "macro": "Centro-Oeste", "cidade_ref": "Rondonópolis / Sinop"},
    "67": {"estado": "MS", "regiao": "Mato Grosso do Sul", "macro": "Centro-Oeste", "cidade_ref": "Campo Grande / Dourados"},

    # Norte
    "63": {"estado": "TO", "regiao": "Tocantins", "macro": "Norte", "cidade_ref": "Palmas / Araguaína"},
    "68": {"estado": "AC", "regiao": "Acre", "macro": "Norte", "cidade_ref": "Rio Branco"},
    "69": {"estado": "RO", "regiao": "Rondônia", "macro": "Norte", "cidade_ref": "Porto Velho / Ji-Paraná"},
    "91": {"estado": "PA", "regiao": "Belém e Região Metropolitana", "macro": "Norte", "cidade_ref": "Belém / Ananindeua"},
    "92": {"estado": "AM", "regiao": "Manaus e Região Metropolitana", "macro": "Norte", "cidade_ref": "Manaus"},
    "93": {"estado": "PA", "regiao": "Santarém e Oeste do Pará", "macro": "Norte", "cidade_ref": "Santarém"},
    "94": {"estado": "PA", "regiao": "Marabá e Sul do Pará", "macro": "Norte", "cidade_ref": "Marabá"},
    "95": {"estado": "RR", "regiao": "Roraima", "macro": "Norte", "cidade_ref": "Boa Vista"},
    "96": {"estado": "AP", "regiao": "Amapá", "macro": "Norte", "cidade_ref": "Macapá"},
    "97": {"estado": "AM", "regiao": "Interior do Amazonas", "macro": "Norte", "cidade_ref": "Tefé / Tabatinga"},

    # Nordeste
    "71": {"estado": "BA", "regiao": "Salvador e Região Metropolitana", "macro": "Nordeste", "cidade_ref": "Salvador / Camaçari"},
    "73": {"estado": "BA", "regiao": "Sul da Bahia", "macro": "Nordeste", "cidade_ref": "Ilhéus / Itabuna / Porto Seguro"},
    "74": {"estado": "BA", "regiao": "Norte da Bahia", "macro": "Nordeste", "cidade_ref": "Juazeiro / Jacobina"},
    "75": {"estado": "BA", "regiao": "Feira de Santana e Centro-Norte", "macro": "Nordeste", "cidade_ref": "Feira de Santana / Alagoinhas"},
    "77": {"estado": "BA", "regiao": "Sudoeste e Oeste da Bahia", "macro": "Nordeste", "cidade_ref": "Vitória da Conquista / Barreiras"},
    "79": {"estado": "SE", "regiao": "Sergipe", "macro": "Nordeste", "cidade_ref": "Aracaju"},
    "81": {"estado": "PE", "regiao": "Recife e Região Metropolitana", "macro": "Nordeste", "cidade_ref": "Recife / Olinda / Jaboatão"},
    "82": {"estado": "AL", "regiao": "Alagoas", "macro": "Nordeste", "cidade_ref": "Maceió / Arapiraca"},
    "83": {"estado": "PB", "regiao": "Paraíba", "macro": "Nordeste", "cidade_ref": "João Pessoa / Campina Grande"},
    "84": {"estado": "RN", "regiao": "Rio Grande do Norte", "macro": "Nordeste", "cidade_ref": "Natal / Mossoró"},
    "85": {"estado": "CE", "regiao": "Fortaleza e Região Metropolitana", "macro": "Nordeste", "cidade_ref": "Fortaleza / Caucaia"},
    "86": {"estado": "PI", "regiao": "Teresina e Norte do Piauí", "macro": "Nordeste", "cidade_ref": "Teresina / Parnaíba"},
    "87": {"estado": "PE", "regiao": "Interior de Pernambuco", "macro": "Nordeste", "cidade_ref": "Petrolina / Caruaru / Garanhuns"},
    "88": {"estado": "CE", "regiao": "Interior do Ceará", "macro": "Nordeste", "cidade_ref": "Juazeiro do Norte / Sobral"},
    "89": {"estado": "PI", "regiao": "Sul do Piauí", "macro": "Nordeste", "cidade_ref": "Picos / Floriano"},
    "98": {"estado": "MA", "regiao": "São Luís e Norte Maranhense", "macro": "Nordeste", "cidade_ref": "São Luís / Imperatriz"},
    "99": {"estado": "MA", "regiao": "Sul Maranhense", "macro": "Nordeste", "cidade_ref": "Imperatriz / Balsas"},
}

# ==========================================================
# MAPEAMENTO DE BAIRROS DE SP, DESAPEGO, ROLO E TEMÁTICAS
# ==========================================================
SP_BAIRROS_LIST = [
    ("Zona Leste", ["zona leste", "zl"]),
    ("Zona Sul", ["zona sul", "zs"]),
    ("Zona Norte", ["zona norte", "zn"]),
    ("Zona Oeste", ["zona oeste", "zo"]),
    ("Centro de SP", ["centro sp", "sé", "se", "república", "republica", "bela vista", "consolação", "consolacao", "bom retiro", "santa cecília", "santa cecilia", "liberdade", "cambuci", "brás", "bras", "pari"]),
    ("Parelheiros / Marsilac", ["parelheiros", "marsilac", "colônia"]),
    ("Grajaú", ["grajaú", "grajau", "cantinho do céu"]),
    ("Interlagos / Socorro", ["interlagos", "socorro", "represa", "veleiros"]),
    ("Santo Amaro", ["santo amaro", "brooklin", "campo belo", "chácara flora"]),
    ("Campo Limpo", ["campo limpo", "piraporinha", "jd joão xxiii", "jd joao xxiii", "joão xxiii", "joao xxiii", "vila das belezas"]),
    ("Capão Redondo", ["capão redondo", "capao redondo", "capão", "capao", "parque fernanda"]),
    ("Morumbi", ["morumbi", "vila andrade", "panamby", "portal do morumbi"]),
    ("Vila Mariana / Moema", ["vila mariana", "moema", "saúde", "saude", "jabaquara", "praça da árvore", "santa cruz"]),
    ("Ipiranga / Sacomã", ["ipiranga", "sacomã", "sacoma", "heliópolis", "heliopolis", "cursino", "alto do ipiranga"]),
    ("Cidade Dutra / Pedreira", ["cidade dutra", "pedreira", "autódromo", "autodromo", "rio bonito"]),
    ("Tatuapé / Anália Franco", ["tatuapé", "tatuape", "anália franco", "analia franco", "vila gomes cardim"]),
    ("Mooca / Belém", ["mooca", "belém", "belem", "vila prudente", "são lucas", "sao lucas", "sapopemba", "quarta parada"]),
    ("Penha / Cangaíba", ["penha", "cangaíba", "cangaiba", "ponte rasa", "artur alvim", "arthur alvim"]),
    ("Itaquera", ["itaquera", "cidade líder", "cidade lider", "josé bonifácio", "jose bonifacio"]),
    ("São Mateus", ["são mateus", "sao mateus", "iguatemi", "parque do carmo", "são rafael"]),
    ("Guaianases / Lajeado", ["guaianases", "guainazes", "lajeado", "jd robru"]),
    ("São Miguel / Itaim Paulista", ["são miguel", "sao miguel", "itaim paulista", "ermelino matarazzo", "jardim helena"]),
    ("Vila Formosa / Aricanduva", ["vila formosa", "aricanduva", "carrão", "carrao", "vila matilde"]),
    ("Santana / Tucuruvi", ["santana", "tucuruvi", "mandaqui", "jardim são paulo", "parada inglesa"]),
    ("Tremembé / Jaçanã", ["tremembé", "tremembe", "jaçanã", "jacana", "horto florestal"]),
    ("Vila Maria / Guilherme", ["vila maria", "vila guilherme", "parque novo mundo", "coroa"]),
    ("Casa Verde / Limão", ["casa verde", "limão", "limao", "cachoeirinha", "imirim"]),
    ("Freguesia do Ó / Brasilândia", ["freguesia do ó", "freguesia do o", "freguesia", "brasilândia", "brasilandia", "itaberaba"]),
    ("Pirituba / Jaraguá", ["pirituba", "jaraguá", "jaragua", "perus", "taipas", "anhanguera"]),
    ("Lapa / Leopoldina", ["lapa", "vila leopoldina", "vila romana", "barra funda", "água branca", "agua branca"]),
    ("Pinheiros / Perdizes", ["pinheiros", "perdizes", "vila madalena", "butantã", "butanta", "rio pequeno", "jaguare", "jaguaré", "raposo tavares", "raposo"]),
    ("ABC Paulista", ["abc", "santo andré", "santo andre", "são bernardo", "sao bernardo", "são caetano", "sao caetano", "diadema", "mauá", "maua", "vila luzita", "clube de campo", "represa"]),
    ("Osasco / Barueri", ["osasco", "barueri", "alphaville", "carapicuíba", "carapicuiba", "itapevi", "jandira"]),
    ("Cotia / Taboão / Embu", ["cotia", "taboão da serra", "taboao da serra", "taboão", "taboao", "embu das artes", "embu", "itapecerica"]),
    ("Guarulhos", ["guarulhos", "cumbica", "vila galvão", "cecap"]),
    ("Franco da Rocha / Mairiporã", ["franco da rocha", "mairiporã", "mairipora", "francisco morato", "caieiras"]),
    ("Alto Tietê", ["itaquaquecetuba", "ferraz de vasconcelos", "poá", "poa", "suzano", "mogi das cruzes"])
]

DESAPEGO_KEYWORDS = [
    "desapego", "desapega", "desapegue", "desapegos", "bazar", "brechó", "brecho",
    "usados", "usado", "seminovos", "seminovo", "roupas usadas", "móveis usados"
]

ROLO_KEYWORDS = [
    "rolo", "rolos", "roloo", "troca", "trocas", "brique", "escambo", "barganha",
    "feira do rolo", "feiradorolo", "troco", "permutas", "permuta"
]

VENDAS_KEYWORDS = [
    "venda", "vendas", "compra", "compras", "classificados", "negócios", "negocios",
    "comércio", "comercio", "anúncios", "anuncios", "divulga", "divulgação", "divulgacao"
]

SHOPEE_MERCADOLIVRE_BLACKLIST = [
    "shopee", "mercado livre", "mercadolivre", "aliexpress", "shein", "achadinho",
    "achadinhos", "achados", "cupom", "cupons", "promoção", "promocao", "promocoes",
    "promoções", "oferta", "ofertas", "afiliado", "afiliados", "renda extra", "bet",
    "cassino", "tigrinho", "mineradora", "crypto", "pix premiado", "sorteio", "rifa",
    "renda online", "trabalhe em casa", "investimento", "trader", "ganhar dinheiro"
]


def classify_group_theme(subject: str, desc: str = "") -> Dict[str, Any]:
    """
    Classifica se o grupo pertence a Bairros de São Paulo, Desapego, Rolo ou Vendas,
    e identifica se possui termos proibidos de achadinhos/shopee/mercado livre.
    """
    text = f"{subject} {desc}".lower()

    # 1. Identificação de Bairros de SP / Grande SP
    is_bairro = False
    bairro_name = ""
    for name, aliases in SP_BAIRROS_LIST:
        for alias in aliases:
            pattern = r"(?:\b|^)" + re.escape(alias) + r"(?:\b|$)"
            if re.search(pattern, text):
                is_bairro = True
                bairro_name = name
                break
        if is_bairro:
            break

    # 2. Desapego
    is_desapego = any(
        re.search(r"(?:\b|^)" + re.escape(w) + r"(?:\b|$)", text)
        for w in DESAPEGO_KEYWORDS
    )

    # 3. Rolo / Trocas
    is_rolo = any(
        re.search(r"(?:\b|^)" + re.escape(w) + r"(?:\b|$)", text)
        for w in ROLO_KEYWORDS
    )

    # 4. Vendas / Negócios locais
    is_vendas = any(
        re.search(r"(?:\b|^)" + re.escape(w) + r"(?:\b|$)", text)
        for w in VENDAS_KEYWORDS
    )

    # 5. Blacklist de Achadinhos / Shopee / Mercado Livre
    is_blacklisted_shopee = any(
        w in text for w in SHOPEE_MERCADOLIVRE_BLACKLIST
    )

    tags = []
    if is_bairro and bairro_name:
        tags.append(f"Bairro: {bairro_name}")
    if is_desapego:
        tags.append("Desapego")
    if is_rolo:
        tags.append("Rolo / Trocas")
    if is_vendas and not (is_desapego or is_rolo):
        tags.append("Vendas Locais")

    return {
        "is_bairro": is_bairro,
        "bairro_name": bairro_name,
        "is_desapego": is_desapego,
        "is_rolo": is_rolo,
        "is_vendas": is_vendas,
        "is_blacklisted_shopee": is_blacklisted_shopee,
        "theme_tags": tags
    }


def extract_phone_and_ddd(raw_id: str, phone_number: Optional[str] = None) -> Tuple[str, str, str, str]:
    """
    Extrai o DDD e metadados geográficos com precisão.
    Retorna tupla: (numero_limpo, ddd_ou_sigla, rotulo_completo, macro_regiao)
    """
    # 1. Se foi fornecido phone_number resolvido
    if phone_number and str(phone_number).strip():
        candidate = str(phone_number).strip()
    # 2. Se for LID sem número de telefone associado, trata como identidade protegida
    elif raw_id and str(raw_id).endswith("@lid"):
        return ("", "Privado", "ID Protegido (LID)", "Privado")
    else:
        candidate = raw_id or ""

    # Remove sufixos como @s.whatsapp.net ou :44@s.whatsapp.net
    candidate = candidate.split("@")[0].split(":")[0]
    digits = re.sub(r"\D", "", candidate)

    if not digits:
        return ("", "Desconhecido", "Número não identificado", "Desconhecido")

    # Brasil: começa com 55 e possui 12 ou 13 dígitos
    # 55 + [DDD 2 dígitos] + [9 dígitos celular ou 8 dígitos fixo]
    if digits.startswith("55") and len(digits) in (12, 13):
        ddd = digits[2:4]
        if ddd in DDD_INFO:
            info = DDD_INFO[ddd]
            return (digits, ddd, f"DDD {ddd} ({info['estado']} - {info['cidade_ref']})", info["macro"])
        else:
            return (digits, ddd, f"DDD {ddd} (Brasil)", "Outro DDD BR")

    # Se começa com 1 e tem 11 dígitos, é América do Norte (+1 EUA / Canadá)
    if digits.startswith("1") and len(digits) == 11:
        return (digits, "+1", "EUA / Canadá (+1)", "Internacional")

    # Formato nacional brasileiro sem DDI 55
    # Celular com 11 dígitos: DDD + 9 + 8 dígitos
    if len(digits) == 11 and digits[2] == "9" and digits[:2] in DDD_INFO:
        ddd = digits[:2]
        info = DDD_INFO[ddd]
        return (f"55{digits}", ddd, f"DDD {ddd} ({info['estado']} - {info['cidade_ref']})", info["macro"])

    # Fixo com 10 dígitos: DDD + [2-5] + 7 dígitos
    if len(digits) == 10 and digits[2] in "2345" and digits[:2] in DDD_INFO:
        ddd = digits[:2]
        info = DDD_INFO[ddd]
        return (f"55{digits}", ddd, f"DDD {ddd} ({info['estado']} - {info['cidade_ref']})", info["macro"])

    # Internacional: prefixos conhecidos
    ddi_map = {
        "351": "Portugal (+351)",
        "54": "Argentina (+54)",
        "595": "Paraguai (+595)",
        "598": "Uruguai (+598)",
        "34": "Espanha (+34)",
        "39": "Itália (+39)",
        "44": "Reino Unido (+44)",
        "33": "França (+33)",
        "49": "Alemanha (+49)",
        "86": "China (+86)",
        "81": "Japão (+81)",
        "52": "México (+52)",
        "57": "Colômbia (+57)",
        "56": "Chile (+56)"
    }

    for ddi, name in ddi_map.items():
        if digits.startswith(ddi):
            return (digits, f"+{ddi}", name, "Internacional")

    # Outro internacional
    if len(digits) >= 8:
        prefix = digits[:3]
        return (digits, f"+{prefix}", f"Internacional (+{prefix}...)", "Internacional")

    return (digits, "Desconhecido", "Número não identificado", "Desconhecido")


def classify_group_size(count: int) -> str:
    """Classifica o tamanho do grupo em faixas claras de membros."""
    if count <= 15:
        return "Pequeno (≤15)"
    elif count <= 60:
        return "Médio (16-60)"
    elif count <= 256:
        return "Grande (61-256)"
    else:
        return "Gigante (>256)"


def analyze_group_participants(
    group_data: Dict[str, Any],
    current_user_jid: Optional[str] = None
) -> Dict[str, Any]:
    """
    Analisa os participantes de um grupo e gera métricas detalhadas de DDD,
    predominância de São Paulo Capital (DDD 11), permissões e cargos.
    """
    participants = group_data.get("participants", []) or []
    raw_size = int(group_data.get("size") or 0)
    # Sempre utiliza o maior valor confiável entre o total da lista e o tamanho oficial reportado pelo WhatsApp
    total_participants = max(len(participants), raw_size)
    is_unverified_size = bool(total_participants <= 1)

    current_user_digits = ""
    if current_user_jid:
        current_user_digits = re.sub(r"\D", "", current_user_jid.split("@")[0].split(":")[0])

    ddd_counter = Counter()
    macro_counter = Counter()
    participant_details = []
    user_is_admin = False
    admins_count = 0

    sp_capital_count = 0
    sp_interior_count = 0
    rj_count = 0
    mg_count = 0
    sul_count = 0
    nordeste_count = 0
    centro_oeste_count = 0
    norte_count = 0
    international_count = 0
    private_lid_count = 0

    for p in participants:
        p_id = p.get("id", "")
        p_pn = p.get("phoneNumber")
        admin_type = p.get("admin")

        if admin_type in ("admin", "superadmin"):
            admins_count += 1

        digits, ddd, label, macro = extract_phone_and_ddd(p_id, p_pn)

        # Checa se este participante é o usuário conectado
        is_me = False
        if current_user_digits and digits and (digits == current_user_digits or current_user_digits in digits):
            is_me = True
            if admin_type in ("admin", "superadmin"):
                user_is_admin = True

        if ddd == "Privado":
            private_lid_count += 1
        elif ddd != "Desconhecido":
            ddd_counter[ddd] += 1
            macro_counter[macro] += 1

        # Contagens de referência regional
        if ddd == "11":
            sp_capital_count += 1
        elif ddd in ("12", "13", "14", "15", "16", "17", "18", "19"):
            sp_interior_count += 1
        elif ddd in ("21", "22", "24"):
            rj_count += 1
        elif ddd in ("31", "32", "33", "34", "35", "37", "38"):
            mg_count += 1
        elif macro == "Sul":
            sul_count += 1
        elif macro == "Nordeste":
            nordeste_count += 1
        elif macro == "Centro-Oeste":
            centro_oeste_count += 1
        elif macro == "Norte":
            norte_count += 1
        elif macro == "Internacional":
            international_count += 1

        # Formatação do telefone para exibição humana
        formatted_phone = digits
        if digits.startswith("55") and len(digits) in (12, 13):
            formatted_phone = f"+55 ({digits[2:4]}) {digits[4:-4]}-{digits[-4:]}"
        elif digits.startswith("1") and len(digits) == 11:
            formatted_phone = f"+1 ({digits[1:4]}) {digits[4:7]}-{digits[7:]}"
        elif digits:
            formatted_phone = f"+{digits}"
        else:
            formatted_phone = "Identidade Protegida (LID)"

        participant_details.append({
            "id": p_id,
            "phoneNumber": digits,
            "formatted": formatted_phone,
            "ddd": ddd,
            "label": label,
            "macro": macro,
            "admin": admin_type,
            "isMe": is_me
        })

    # Total de participantes que possuem número de telefone identificável
    total_identified = sum(ddd_counter.values())

    # Base para cálculo de porcentagens geográficas: participantes identificados
    calc_base = total_identified if total_identified > 0 else total_participants

    # Top DDD e Porcentagem
    top_ddd = "N/A"
    top_ddd_count = 0
    top_ddd_percent = 0.0
    top_ddd_label = "Sem dados de DDD"

    if ddd_counter:
        most_common = ddd_counter.most_common(1)[0]
        top_ddd = most_common[0]
        top_ddd_count = most_common[1]
        top_ddd_percent = round((top_ddd_count / calc_base * 100), 1) if calc_base > 0 else 0.0

        if top_ddd in DDD_INFO:
            info = DDD_INFO[top_ddd]
            top_ddd_label = f"DDD {top_ddd} - {info['regiao']} ({info['estado']})"
        elif top_ddd.startswith("+"):
            top_ddd_label = f"Internacional ({top_ddd})"
        else:
            top_ddd_label = f"DDD {top_ddd}"

    # Porcentagens de São Paulo baseadas na amostra real identificada
    sp_capital_percent = round((sp_capital_count / calc_base * 100), 1) if calc_base > 0 else 0.0
    sp_interior_percent = round((sp_interior_count / calc_base * 100), 1) if calc_base > 0 else 0.0

    # Predominância de São Paulo Capital (DDD 11):
    is_sp_capital_predominant = (top_ddd == "11") or (sp_capital_percent >= 50.0)

    # Distribuição ordenada dos top DDDs
    ddd_distribution = []
    for ddd_key, count in ddd_counter.most_common(15):
        pct = round((count / calc_base * 100), 1) if calc_base > 0 else 0.0
        info_dict = DDD_INFO.get(ddd_key, {})
        ddd_distribution.append({
            "ddd": ddd_key,
            "count": count,
            "percent": pct,
            "estado": info_dict.get("estado", "Exterior" if ddd_key.startswith("+") else "BR"),
            "regiao": info_dict.get("regiao", "Internacional"),
            "cidade_ref": info_dict.get("cidade_ref", ""),
            "macro": info_dict.get("macro", "Outro")
        })

    # Permissões do WhatsApp
    announce = bool(group_data.get("announce", False))
    restrict = bool(group_data.get("restrict", False))

    # Descrição textual da concentração
    if is_sp_capital_predominant:
        concentration = f"Maioria SP Capital (DDD 11: {sp_capital_percent}%)"
    elif top_ddd_percent >= 45.0:
        concentration = f"Maioria {top_ddd_label} ({top_ddd_percent}%)"
    elif total_participants > 0:
        concentration = f"Misto (Maior: DDD {top_ddd} com {top_ddd_percent}%)"
    else:
        concentration = "Grupo sem participantes"

    subject = (group_data.get("subject") or "").strip()
    if not subject:
        raw_gid = group_data.get("id") or ""
        clean_gid = raw_gid.split("@")[0].split("-")[-1]
        subject = f"Grupo WhatsApp ({clean_gid[-6:]})" if len(clean_gid) >= 6 else f"Grupo {clean_gid}"

    # Classificação temática (Bairros de SP, Desapego, Rolo, Vendas)
    desc_text = group_data.get("desc") or ""
    theme = classify_group_theme(subject, desc_text)

    # Métricas de Visualização e Engajamento de Mensagens Enviadas
    engagement = group_data.get("engagement") or {}
    messages_sent_by_me = int(engagement.get("messagesSentCount", 0))
    views_count = int(engagement.get("totalViewsCount", 0))
    view_rate = float(engagement.get("viewRate", 0.0))
    engagement_status = engagement.get("status", "sem_envio")
    last_message_sent_at = engagement.get("lastMessageSentAt")
    last_activity_at = engagement.get("lastActivityAt")

    # Grupo de menor visualização: mensagens enviadas com taxa de visualização < 20%, ou silenciado para membros
    is_low_views = (messages_sent_by_me > 0 and view_rate < 20.0) or (announce and not user_is_admin) or (engagement_status == "baixa")

    # Identifica se é Raiz de Comunidade WhatsApp (onde o WhatsApp só lista os administradores na raiz)
    is_community = bool(
        group_data.get("isCommunity") or 
        group_data.get("isCommunityAnnounce") or 
        "comunidade foi criada" in desc_text.lower() or
        "comunidade de colaboradores" in desc_text.lower()
    )

    return {
        "id": group_data.get("id"),
        "subject": subject,
        "is_ghost": False,
        "desc": desc_text,
        "owner": group_data.get("owner", ""),
        "creation": group_data.get("creation", 0),
        "total_participants": total_participants,
        "is_unverified_size": is_unverified_size,
        "is_community": is_community,
        "total_identified_phones": total_identified,
        "private_lid_count": private_lid_count,
        "size_category": classify_group_size(total_participants),
        "only_admins_can_send": announce,
        "restrict_info": restrict,
        "user_is_admin": user_is_admin,
        "admins_count": admins_count,
        "is_bairro": theme["is_bairro"],
        "bairro_name": theme["bairro_name"],
        "is_desapego": theme["is_desapego"],
        "is_rolo": theme["is_rolo"],
        "is_vendas": theme["is_vendas"],
        "is_blacklisted_shopee": theme["is_blacklisted_shopee"],
        "theme_tags": theme["theme_tags"],
        "messages_sent_by_me": messages_sent_by_me,
        "views_count": views_count,
        "view_rate": view_rate,
        "engagement_status": engagement_status,
        "is_low_views": is_low_views,
        "last_message_sent_at": last_message_sent_at,
        "last_activity_at": last_activity_at,
        "top_ddd": top_ddd,
        "top_ddd_count": top_ddd_count,
        "top_ddd_percent": top_ddd_percent,
        "top_ddd_label": top_ddd_label,
        "is_sp_capital_predominant": is_sp_capital_predominant,
        "sp_capital_count": sp_capital_count,
        "sp_capital_percent": sp_capital_percent,
        "sp_interior_count": sp_interior_count,
        "sp_interior_percent": sp_interior_percent,
        "rj_count": rj_count,
        "mg_count": mg_count,
        "sul_count": sul_count,
        "nordeste_count": nordeste_count,
        "centro_oeste_count": centro_oeste_count,
        "norte_count": norte_count,
        "international_count": international_count,
        "concentration": concentration,
        "ddd_distribution": ddd_distribution,
        "all_participants": participant_details
    }


def compute_global_summary(groups_classified: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Computa sumário executivo de todos os grupos analisados.
    """
    total_groups = len(groups_classified)
    total_members = sum(g["total_participants"] for g in groups_classified)

    sp_capital_groups = sum(1 for g in groups_classified if g["is_sp_capital_predominant"])
    low_sp11_groups = sum(1 for g in groups_classified if g.get("sp_capital_percent", 0) < 85.0 and g.get("total_identified_phones", 0) > 0)
    low_views_groups = sum(1 for g in groups_classified if g.get("is_low_views"))
    admin_only_groups = sum(1 for g in groups_classified if g["only_admins_can_send"])
    user_admin_groups = sum(1 for g in groups_classified if g["user_is_admin"])

    # Contagens temáticas
    bairro_groups = sum(1 for g in groups_classified if g.get("is_bairro"))
    desapego_groups = sum(1 for g in groups_classified if g.get("is_desapego"))
    rolo_groups = sum(1 for g in groups_classified if g.get("is_rolo"))
    vendas_groups = sum(1 for g in groups_classified if g.get("is_vendas"))

    small_groups = sum(1 for g in groups_classified if g["total_participants"] <= 20)
    medium_groups = sum(1 for g in groups_classified if 20 < g["total_participants"] <= 60)
    large_groups = sum(1 for g in groups_classified if 60 < g["total_participants"] <= 256)
    giant_groups = sum(1 for g in groups_classified if g["total_participants"] > 256)

    # Top DDDs globais
    global_ddd_counter = Counter()
    for g in groups_classified:
        for item in g.get("ddd_distribution", []):
            global_ddd_counter[item["ddd"]] += item["count"]

    top_global_ddds = []
    for ddd, count in global_ddd_counter.most_common(10):
        info = DDD_INFO.get(ddd, {})
        top_global_ddds.append({
            "ddd": ddd,
            "count": count,
            "percent": round((count / total_members * 100), 1) if total_members > 0 else 0.0,
            "label": f"DDD {ddd} ({info.get('estado', 'Ext')} - {info.get('cidade_ref', 'Geral')})"
        })

    return {
        "total_groups": total_groups,
        "total_members": total_members,
        "sp_capital_groups": sp_capital_groups,
        "sp_capital_groups_percent": round((sp_capital_groups / total_groups * 100), 1) if total_groups > 0 else 0.0,
        "low_sp11_groups": low_sp11_groups,
        "low_views_groups": low_views_groups,
        "bairro_groups": bairro_groups,
        "desapego_groups": desapego_groups,
        "rolo_groups": rolo_groups,
        "vendas_groups": vendas_groups,
        "admin_only_groups": admin_only_groups,
        "free_chat_groups": total_groups - admin_only_groups,
        "user_admin_groups": user_admin_groups,
        "small_groups": small_groups,
        "medium_groups": medium_groups,
        "large_groups": large_groups,
        "giant_groups": giant_groups,
        "top_global_ddds": top_global_ddds
    }
