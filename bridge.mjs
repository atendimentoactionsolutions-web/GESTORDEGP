import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import * as baileysModule from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const makeWASocket = baileysModule.default || baileysModule.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = baileysModule;

const PORT = 4921;
const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "wa_auth");
const GROUPS_CACHE_FILE = path.join(DATA_DIR, "groups_cache.json");
const ENGAGEMENT_FILE = path.join(DATA_DIR, "engagement.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

let sock = null;
let isStarting = false;
let isSyncingGroups = false;
let groupsStore = {}; // jid -> GroupMetadata
let lastSyncTimestamp = null;

// Tabelas de mapeamento de LID -> Número de Telefone
const lidToPn = {};
const pnToLid = {};

// Armazenamento de engajamento e métricas de visualização de mensagens enviadas
let engagementStore = {};
if (fs.existsSync(ENGAGEMENT_FILE)) {
  try {
    engagementStore = JSON.parse(fs.readFileSync(ENGAGEMENT_FILE, "utf-8")) || {};
  } catch (e) {
    engagementStore = {};
  }
}

function saveEngagement() {
  try {
    const tmp = `${ENGAGEMENT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(engagementStore, null, 2), "utf-8");
    fs.renameSync(tmp, ENGAGEMENT_FILE);
  } catch (e) {
    console.error("Erro ao salvar dados de engajamento:", e.message);
  }
}

function getGroupEngagement(jid, totalParticipants = 0) {
  if (!jid) return { messagesSentCount: 0, totalViewsCount: 0, viewRate: 0, status: "sem_envio", unreadCount: 0 };
  
  if (!engagementStore[jid]) {
    engagementStore[jid] = {
      messagesSentCount: 0,
      totalViewsCount: 0,
      lastMessageSentAt: null,
      lastActivityAt: null,
      unreadCount: 0,
      viewRate: 0,
      status: "sem_envio",
      sentMessages: {}
    };
  }

  const eg = engagementStore[jid];
  const participants = totalParticipants || (groupsStore[jid]?.participants?.length) || (groupsStore[jid]?.size) || 1;

  if (eg.messagesSentCount > 0) {
    const rate = Math.min(100, Math.round((eg.totalViewsCount / (eg.messagesSentCount * Math.max(1, participants))) * 100));
    eg.viewRate = rate;
    if (rate <= 15) eg.status = "baixa";
    else if (rate <= 50) eg.status = "media";
    else eg.status = "alta";
  } else {
    eg.viewRate = 0;
    eg.status = "sem_envio";
  }
  return eg;
}

const RADAR_FILE = path.join(DATA_DIR, "radar_groups.json");
let radarStore = {};
if (fs.existsSync(RADAR_FILE)) {
  try {
    radarStore = JSON.parse(fs.readFileSync(RADAR_FILE, "utf-8")) || {};
  } catch (e) {
    radarStore = {};
  }
}

function saveRadar() {
  try {
    const tmp = `${RADAR_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(radarStore, null, 2), "utf-8");
    fs.renameSync(tmp, RADAR_FILE);
  } catch (e) {
    console.error("Erro ao salvar radar:", e.message);
  }
}

const RADAR_BLACKLIST = [
  // 1. E-commerce / Achadinhos / Afiliados
  "shopee", "mercado livre", "mercadolivre", "aliexpress", "shein",
  "achadinho", "achadinhos", "achados", "cupom", "cupons", "promoção",
  "promocao", "promocoes", "promoções", "oferta", "ofertas", "afiliado",
  "afiliados", "renda extra", "renda online", "trabalhe em casa", "investimento",
  "trader", "ganhar dinheiro", "monetizze", "hotmart", "kiwify", "eduzz",

  // 2. IPTV, PTV, Streaming Pirata, TV Box, Canais
  "iptv", "ptv", "p2p", "tv box", "tvbox", "tv0800", "canais", "servidor iptv",
  "teste iptv", "teste gratis", "teste grátis", "lista iptv", "streaming",
  "filmes e séries", "filmes & séries", "assistir filmes", "recode", "p2p tv",
  "tela & pipoca", "canais fechados", "canais liberados",

  // 3. Conteúdo Adulto / +18 / Prostituição / Nudes / Sexo
  "+18", "18+", "🔞", "conteudo adulto", "conteúdo adulto", "conteudos",
  "conteúdos", "vendas de conteúdo", "vendas de conteudos", "pack", "packs",
  "privacy", "onlyfans", "nude", "nudes", "nudez", "vaza", "vazados", "vazou",
  "putaria", "porno", "pornô", "porn", "erotico", "erótico", "sexo", "safadas",
  "novinhas", "acompanhante", "acompanhantes", "garota de programa",
  "massagem relaxante", "massagem erotica", "massagem sensual",

  // 4. Jogos, Cassinos, Apostas, Golpes, Farmácia Ilegal
  "bet", "cassino", "tigrinho", "mineradora", "crypto", "pix premiado",
  "sorteio", "rifa", "pix ltda", "tabela pix", "robô do pix", "robo do pix",
  "esquema", "cartão clonado", "cartao clonado", "nota fake", "sem receita", "s/receita",
  "remédio sem receita", "remedio sem receita", "farmácia popular s/receita",
  "tarja preta", "anabolizante", "anabolizantes", "drogas"
];

const SP_BAIRROS_RADAR = [
  ["Zona Leste", ["zona leste", "zl"]],
  ["Zona Sul", ["zona sul", "zs"]],
  ["Zona Norte", ["zona norte", "zn"]],
  ["Zona Oeste", ["zona oeste", "zo"]],
  ["Centro de SP", ["centro sp", "sé", "república", "bela vista", "consolação", "bom retiro", "santa cecília", "liberdade", "cambuci", "brás", "bras", "pari"]],
  ["Parelheiros / Marsilac", ["parelheiros", "marsilac"]],
  ["Grajaú", ["grajaú", "grajau"]],
  ["Interlagos / Socorro", ["interlagos", "socorro", "represa"]],
  ["Santo Amaro", ["santo amaro", "brooklin", "campo belo"]],
  ["Campo Limpo", ["campo limpo", "piraporinha", "joão xxiii", "joao xxiii"]],
  ["Capão Redondo", ["capão redondo", "capao redondo", "capão", "capao"]],
  ["Morumbi", ["morumbi", "vila andrade", "panamby"]],
  ["Vila Mariana / Moema", ["vila mariana", "moema", "saúde", "saude", "jabaquara"]],
  ["Ipiranga / Sacomã", ["ipiranga", "sacomã", "sacoma", "heliópolis", "heliopolis", "cursino"]],
  ["Cidade Dutra / Pedreira", ["cidade dutra", "pedreira", "autódromo", "autodromo"]],
  ["Tatuapé / Anália Franco", ["tatuapé", "tatuape", "anália franco", "analia franco"]],
  ["Mooca / Belém", ["mooca", "belém", "belem", "vila prudente", "são lucas", "sao lucas", "sapopemba"]],
  ["Penha / Cangaíba", ["penha", "cangaíba", "cangaiba", "ponte rasa", "artur alvim", "arthur alvim"]],
  ["Itaquera", ["itaquera", "cidade líder", "cidade lider"]],
  ["São Mateus", ["são mateus", "sao mateus", "iguatemi"]],
  ["Guaianases / Lajeado", ["guaianases", "guainazes", "lajeado"]],
  ["São Miguel / Itaim Paulista", ["são miguel", "sao miguel", "itaim paulista", "ermelino matarazzo"]],
  ["Vila Formosa / Aricanduva", ["vila formosa", "aricanduva", "carrão", "carrao"]],
  ["Santana / Tucuruvi", ["santana", "tucuruvi", "mandaqui"]],
  ["Tremembé / Jaçanã", ["tremembé", "tremembe", "jaçanã", "jacana"]],
  ["Vila Maria / Guilherme", ["vila maria", "vila guilherme"]],
  ["Casa Verde / Limão", ["casa verde", "limão", "limao", "cachoeirinha"]],
  ["Freguesia do Ó / Brasilândia", ["freguesia do ó", "freguesia do o", "freguesia", "brasilândia", "brasilandia"]],
  ["Pirituba / Jaraguá", ["pirituba", "jaraguá", "jaragua", "perus"]],
  ["Lapa / Leopoldina", ["lapa", "vila leopoldina", "barra funda"]],
  ["Pinheiros / Perdizes", ["pinheiros", "perdizes", "vila madalena", "butantã", "butanta", "rio pequeno", "jaguare", "jaguaré", "raposo"]],
  ["ABC Paulista", ["abc", "santo andré", "santo andre", "são bernardo", "sao bernardo", "são caetano", "sao caetano", "diadema", "mauá", "maua", "vila luzita", "clube de campo"]],
  ["Osasco / Barueri", ["osasco", "barueri", "alphaville", "carapicuíba", "carapicuiba"]],
  ["Cotia / Taboão / Embu", ["cotia", "taboão", "taboao", "embu das artes", "embu", "itapecerica"]],
  ["Guarulhos", ["guarulhos", "cumbica"]],
  ["Franco da Rocha / Mairiporã", ["franco da rocha", "mairiporã", "mairipora", "francisco morato", "caieiras"]],
  ["Alto Tietê", ["itaquaquecetuba", "ferraz", "poá", "poa", "suzano", "mogi das cruzes"]]
];

let isScanningRadar = false;

async function processInviteCode(code, fromGroupId = "", fromGroupName = "") {
  if (!code || typeof code !== "string") return null;
  const cleanCode = code.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleanCode || cleanCode.length < 18) return null;

  if (radarStore[cleanCode]) {
    return radarStore[cleanCode].discarded ? null : radarStore[cleanCode];
  }

  if (!sock) return null;

  try {
    const meta = await sock.groupGetInviteInfo(cleanCode);
    if (!meta || !meta.id) return null;

    const subject = (meta.subject || "").trim();
    const desc = (meta.desc || "").trim();
    const fullText = `${subject} ${desc}`.toLowerCase();

    // 1. Se o usuário JÁ PARTICIPA do grupo, descarta do radar imediatamente (o radar só mostra grupos novos para entrar)
    if (meta.id && groupsStore[meta.id]) {
      radarStore[cleanCode] = {
        code: cleanCode,
        discarded: true,
        reason: "already_participating",
        alreadyInGroup: true,
        joined: true
      };
      saveRadar();
      return null;
    }

    // 2. Blacklist rigorosa: Shopee, Mercado Livre, IPTV/PTV, +18, Pornô, Golpes, Farmácia Ilegal
    const cleanDesc = desc.toLowerCase().replace(/(proibid[oa]|n[aã]o\s+[eé]\s+permitid[oa]|vetad[oa]|sem)\s+[^.\n;]{1,40}/gi, " ");
    const isBlackSub = RADAR_BLACKLIST.some((w) => subject.toLowerCase().includes(w));
    const isBlackDesc = RADAR_BLACKLIST.some((w) => cleanDesc.includes(w));

    if (isBlackSub || isBlackDesc) {
      radarStore[cleanCode] = {
        code: cleanCode,
        discarded: true,
        reason: "blacklist_strict",
        evaluatedAt: new Date().toISOString()
      };
      saveRadar();
      return null;
    }

    // 2. Classificação: Bairros SP, Desapego, Rolo, Vendas
    let category = "vendas";
    let bairroName = "";

    for (const [bName, aliases] of SP_BAIRROS_RADAR) {
      if (aliases.some((a) => fullText.includes(a))) {
        category = "bairro";
        bairroName = bName;
        break;
      }
    }

    const isDesapego = ["desapego", "desapega", "desapegue", "bazar", "brechó", "brecho", "usados", "usado"].some((w) => fullText.includes(w));
    if (isDesapego) category = "desapego";

    const isRolo = ["rolo", "rolos", "troca", "trocas", "brique", "escambo", "feira do rolo"].some((w) => fullText.includes(w));
    if (isRolo) category = "rolo";

    const alreadyInGroup = !!(meta.id && groupsStore[meta.id]);

    radarStore[cleanCode] = {
      code: cleanCode,
      link: `https://chat.whatsapp.com/${cleanCode}`,
      id: meta.id,
      subject: subject || `Grupo (${cleanCode.slice(0, 8)})`,
      desc: desc,
      size: meta.size || 0,
      creation: meta.creation || 0,
      owner: meta.owner || "",
      category,
      bairroName,
      fromGroupId,
      fromGroupName: fromGroupName || "Grupo WhatsApp",
      foundAt: new Date().toISOString(),
      discarded: false,
      alreadyInGroup,
      joined: alreadyInGroup,
      joinApprovalMode: !!meta.joinApprovalMode
    };
    saveRadar();
    console.log(`[Radar] Grupo aprovado: "${subject}" (${category}${bairroName ? ` - ${bairroName}` : ""})`);
    return radarStore[cleanCode];
  } catch (err) {
    const errMsg = String(err.message || "").toLowerCase();
    const isTempError = errMsg.includes("rate-overlimit") || errMsg.includes("timeout") || errMsg.includes("timed out") || errMsg.includes("temporarily");
    if (!isTempError) {
      radarStore[cleanCode] = {
        code: cleanCode,
        discarded: true,
        reason: err.message || "invalid",
        evaluatedAt: new Date().toISOString()
      };
      saveRadar();
    }
    return null;
  }
}

async function scanRadarNow() {
  if (isScanningRadar || !sock) return;
  isScanningRadar = true;
  console.log("[Radar] Iniciando varredura em grupos e descrições...");

  try {
    const linkRegex = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,24})/gi;
    const allGroups = Object.values(groupsStore);

    for (const g of allGroups) {
      if (!sock) break;
      const text = `${g.subject || ""} ${g.desc || ""}`;
      let match;
      while ((match = linkRegex.exec(text)) !== null) {
        const code = match[1];
        if (!radarStore[code]) {
          await processInviteCode(code, g.id, g.subject);
          await new Promise((r) => setTimeout(r, 650));
        }
      }
    }
  } catch (err) {
    console.error("[Radar] Erro na varredura:", err.message);
  } finally {
    isScanningRadar = false;
    console.log(`[Radar] Varredura concluída. Total de grupos no radar: ${Object.values(radarStore).filter(x => !x.discarded).length}`);
  }
}

function purgeGhostGroupsNow() {
  let purged = 0;
  for (const [jid, g] of Object.entries(groupsStore)) {
    if (!jid || !jid.endsWith("@g.us")) {
      delete groupsStore[jid];
      purged++;
    }
  }
  if (purged > 0) {
    connectionStatus.groupCount = Object.keys(groupsStore).length;
    saveGroupsCache();
  }
  return purged;
}

function cleanDigits(val) {
  if (!val || typeof val !== "string") return "";
  return val.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function registerLidPnMapping(lidRaw, pnRaw) {
  const lid = cleanDigits(String(lidRaw));
  const pn = cleanDigits(String(pnRaw));
  if (lid && pn) {
    lidToPn[lid] = pn;
    pnToLid[pn] = lid;
  }
}

function scanLidMappingFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (file.startsWith("lid-mapping-") && file.endsWith("_reverse.json")) {
        const lidNum = file.replace("lid-mapping-", "").replace("_reverse.json", "");
        if (!lidToPn[lidNum]) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8"));
            if (raw) registerLidPnMapping(lidNum, String(raw));
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

let connectionStatus = {
  state: "disconnected", // 'disconnected', 'connecting', 'qr', 'connected'
  qrDataUrl: null,
  user: null, // { id, name, phone }
  groupCount: 0,
  isSyncing: false,
  lastSync: null,
  lastError: null,
  lastMessage: "Aguardando inicialização...",
};

// Carrega cache existente se houver
if (fs.existsSync(GROUPS_CACHE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_CACHE_FILE, "utf-8"));
    if (raw && typeof raw === "object") {
      groupsStore = raw.groups || {};
      lastSyncTimestamp = raw.lastSync || null;
      connectionStatus.groupCount = Object.keys(groupsStore).length;
      connectionStatus.lastSync = lastSyncTimestamp;
    }
  } catch (err) {
    console.error("Erro ao carregar cache prévio de grupos:", err.message);
  }
}

function saveGroupsCache() {
  try {
    const payload = {
      lastSync: lastSyncTimestamp || new Date().toISOString(),
      groupsCount: Object.keys(groupsStore).length,
      groups: groupsStore,
    };
    const tmp = `${GROUPS_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, GROUPS_CACHE_FILE);
  } catch (err) {
    console.error("Erro ao salvar cache de grupos:", err.message);
  }
}

function enrichParticipant(p) {
  if (!p) return;
  const pId = p.id || "";
  if (!p.phoneNumber) {
    if (pId.endsWith("@lid")) {
      const lidDigits = cleanDigits(pId);
      if (lidToPn[lidDigits]) {
        p.phoneNumber = lidToPn[lidDigits];
      }
    } else if (pId.endsWith("@s.whatsapp.net")) {
      p.phoneNumber = cleanDigits(pId);
    }
  }
  if (!p.phoneNumber && p.lid) {
    const lidDigits = cleanDigits(p.lid);
    if (lidToPn[lidDigits]) {
      p.phoneNumber = lidToPn[lidDigits];
    }
  }
}

let isResolvingMetadata = false;

async function resolveMissingGroupMetadata(forceAll = false) {
  if (!sock || isResolvingMetadata) return;
  isResolvingMetadata = true;

  try {
    const allKeys = Object.keys(groupsStore);
    const missing = allKeys.filter((jid) => {
      const g = groupsStore[jid];
      if (!g) return false;
      if (forceAll) return true;

      // Se for comunidade confirmada, não re-audita (raiz de comunidade sempre retorna 1 participante)
      if (g.isCommunity) return false;

      // Se já foi auditado nas últimas 2 horas, não sobrecarrega a conexão
      if (g.lastAuditedAt && (Date.now() - g.lastAuditedAt < 1000 * 60 * 60 * 2)) return false;

      const pLen = g.participants?.length || 0;
      const size = g.size || 0;
      const sub = (g.subject || "").trim();

      // Precisa resolver se:
      // 1. Tem 1 participante ou 0 participantes na lista
      if (pLen <= 1) return true;
      // 2. Não tem nome real ou está com placeholder temporário
      if (!sub || sub.startsWith("Grupo WhatsApp (") || sub.startsWith("Grupo ")) return true;
      // 3. A lista de participantes é menor que o tamanho reportado pelo WhatsApp
      if (size > pLen) return true;

      return false;
    });

    if (missing.length === 0) {
      isResolvingMetadata = false;
      return;
    }

    console.log(`[Bridge] Auditoria de Metadados: Verificando ${missing.length} grupos com discrepâncias ou participante único...`);
    let resolved = 0;

    for (const jid of missing) {
      if (!sock) break;
      const g = groupsStore[jid];
      if (!g) continue;

      g.lastAuditedAt = Date.now();

      try {
        const fullMeta = await sock.groupMetadata(jid);
        if (fullMeta) {
          if (fullMeta.isCommunity || fullMeta.isCommunityAnnounce) {
            g.isCommunity = true;
          }
          if (fullMeta.subject && fullMeta.subject.trim()) {
            g.subject = fullMeta.subject.trim();
          }
          g.desc = fullMeta.desc || g.desc || "";
          
          if (Array.isArray(fullMeta.participants) && fullMeta.participants.length > 0) {
            g.participants = fullMeta.participants;
            for (const p of g.participants) {
              enrichParticipant(p);
            }
          }
          g.size = Math.max(fullMeta.size || 0, g.participants?.length || 0, fullMeta.participants?.length || 0, g.size || 0);
          g.creation = fullMeta.creation || g.creation;
          g.owner = fullMeta.owner || g.owner;
          g.announce = fullMeta.announce ?? g.announce;
          g.restrict = fullMeta.restrict ?? g.restrict;
          resolved++;
        }
      } catch (err) {
        // NUNCA deleta o grupo do usuário em caso de erro! Mantém o grupo acessível para sair ou gerenciar.
        const rawGid = jid.split("@")[0];
        if (!g.subject || !g.subject.trim()) {
          g.subject = `Grupo WhatsApp (${rawGid.slice(-6)})`;
        }
      }

      if (resolved > 0 && resolved % 5 === 0) {
        connectionStatus.groupCount = Object.keys(groupsStore).length;
        saveGroupsCache();
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    connectionStatus.groupCount = Object.keys(groupsStore).length;
    connectionStatus.lastMessage = `${connectionStatus.groupCount} grupos carregados (${resolved} auditados com membros reais).`;
    saveGroupsCache();
    console.log(`[Bridge] Auditoria concluída: ${resolved} grupos atualizados com dados reais.`);
  } catch (err) {
    console.error("[Bridge] Erro na auditoria de metadados:", err.message);
  } finally {
    isResolvingMetadata = false;
  }
}

async function fetchGroupsNow() {
  if (!sock) return groupsStore;
  if (isSyncingGroups) return groupsStore;

  isSyncingGroups = true;
  connectionStatus.isSyncing = true;
  connectionStatus.lastMessage = "Buscando todos os mais de 400 grupos no WhatsApp...";

  // Escaneia arquivos LID para enriquecer números de telefone
  scanLidMappingFiles(AUTH_DIR);
  for (const fallbackDir of [
    "/Users/mac/Desktop/CONTATO EXTRATOR /data/wa_auth",
    "/Users/mac/Desktop/CONTATO EXTRATOR/data/wa_auth"
  ]) {
    scanLidMappingFiles(fallbackDir);
  }

  try {
    const allGroups = await sock.groupFetchAllParticipating();
    if (allGroups && typeof allGroups === "object") {
      const rawCount = Object.keys(allGroups).length;
      console.log(`[Bridge] groupFetchAllParticipating retornou ${rawCount} grupos brutos.`);

      for (const [jid, meta] of Object.entries(allGroups)) {
        if (!meta.participants || !Array.isArray(meta.participants)) {
          meta.participants = [];
        }
        for (const p of meta.participants) {
          enrichParticipant(p);
        }

        // Se o grupo não tem nome no XML inicial, atribui identificador legível temporário
        if (!meta.subject || !meta.subject.trim()) {
          const rawGid = jid.split("@")[0];
          meta.subject = `Grupo ${rawGid.slice(-6)}`;
        }

        // PROTEÇÃO CONTRA PERDA DE PARTICIPANTES / DADOS:
        // Se já tínhamos uma contagem de participantes maior no cache, NUNCA sobreescreve por uma lista menor ou com apenas 1 membro!
        const existing = groupsStore[jid];
        if (existing) {
          if (existing.participants && existing.participants.length > meta.participants.length) {
            meta.participants = existing.participants;
          }
          if (existing.size && existing.size > (meta.size || 0)) {
            meta.size = existing.size;
          }
          if (existing.subject && (!meta.subject || meta.subject.startsWith("Grupo "))) {
            meta.subject = existing.subject;
          }
          if (existing.desc && !meta.desc) {
            meta.desc = existing.desc;
          }
        }

        meta.size = Math.max(meta.size || 0, meta.participants?.length || 0);
        groupsStore[jid] = meta;
      }

      lastSyncTimestamp = new Date().toISOString();
      connectionStatus.groupCount = Object.keys(groupsStore).length;
      connectionStatus.lastSync = lastSyncTimestamp;
      connectionStatus.lastMessage = `${connectionStatus.groupCount} grupos carregados com sucesso.`;
      saveGroupsCache();

      // Resolve em background grupos que precisam de nome e participantes completos
      setTimeout(() => {
        resolveMissingGroupMetadata();
      }, 300);
    }
  } catch (err) {
    console.error("Erro ao sincronizar grupos:", err.message);
    connectionStatus.lastError = err.message;
  } finally {
    isSyncingGroups = false;
    connectionStatus.isSyncing = false;
  }
  return groupsStore;
}

async function startWhatsApp() {
  if (isStarting) return;
  isStarting = true;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    scanLidMappingFiles(AUTH_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1043857760],
    }));

    connectionStatus.state = "connecting";
    connectionStatus.lastMessage = "Conectando ao WhatsApp...";

    // Limpa instância anterior se houver
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {}
      sock = null;
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2500,
    });

    sock.ev.on("creds.update", () => {
      saveCreds();
    });

    sock.ev.on("lid-mapping.update", (mapping) => {
      if (Array.isArray(mapping)) {
        for (const m of mapping) {
          if (m && m.lid && m.pn) registerLidPnMapping(m.lid, m.pn);
        }
      } else if (mapping && mapping.lid && mapping.pn) {
        registerLidPnMapping(mapping.lid, mapping.pn);
      }
    });

    // Monitora alterações em grupos em tempo real
    sock.ev.on("groups.update", (updates) => {
      if (Array.isArray(updates)) {
        for (const update of updates) {
          if (update && update.id && groupsStore[update.id]) {
            Object.assign(groupsStore[update.id], update);
          }
        }
        saveGroupsCache();
      }
    });

    // Monitora nomes de grupos vindos das conversas (chats)
    sock.ev.on("chats.upsert", (chats) => {
      if (Array.isArray(chats)) {
        let changed = false;
        for (const chat of chats) {
          if (chat && chat.id && chat.id.endsWith("@g.us")) {
            const chatName = (chat.name || chat.subject || "").trim();
            if (chatName) {
              if (!groupsStore[chat.id]) {
                groupsStore[chat.id] = { id: chat.id, subject: chatName, participants: [] };
                changed = true;
              } else if (!groupsStore[chat.id].subject || groupsStore[chat.id].subject.startsWith("Grupo ")) {
                groupsStore[chat.id].subject = chatName;
                changed = true;
              }
            }
          }
        }
        if (changed) {
          connectionStatus.groupCount = Object.keys(groupsStore).length;
          saveGroupsCache();
        }
      }
    });

    sock.ev.on("chats.update", (updates) => {
      if (Array.isArray(updates)) {
        let changed = false;
        for (const update of updates) {
          if (update && update.id && update.id.endsWith("@g.us")) {
            const chatName = (update.name || update.subject || "").trim();
            if (chatName && groupsStore[update.id]) {
              groupsStore[update.id].subject = chatName;
              changed = true;
            }
          }
        }
        if (changed) {
          saveGroupsCache();
        }
      }
    });

    // Monitora mensagens enviadas pelo usuário e atividade nos grupos
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (!Array.isArray(messages)) return;
      let changed = false;
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        if (!jid || !jid.endsWith("@g.us")) continue;

        getGroupEngagement(jid);
        const eg = engagementStore[jid];
        eg.lastActivityAt = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();

        // Radar de Grupos: detecta links de convite enviados nas mensagens
        const msgText = m.message?.conversation ||
                        m.message?.extendedTextMessage?.text ||
                        m.message?.imageMessage?.caption ||
                        m.message?.videoMessage?.caption || "";

        if (msgText && msgText.includes("chat.whatsapp.com")) {
          const linkRegex = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,24})/gi;
          let match;
          while ((match = linkRegex.exec(msgText)) !== null) {
            const code = match[1];
            if (!radarStore[code]) {
              processInviteCode(code, jid, groupsStore[jid]?.subject || "Grupo WhatsApp").catch(() => {});
            }
          }
        }

        if (m.key.fromMe) {
          eg.messagesSentCount = (eg.messagesSentCount || 0) + 1;
          eg.lastMessageSentAt = eg.lastActivityAt;
          const msgId = m.key.id;
          if (!eg.sentMessages) eg.sentMessages = {};
          if (!eg.sentMessages[msgId]) {
            eg.sentMessages[msgId] = {
              sentAt: eg.lastMessageSentAt,
              views: 0,
              viewers: [],
            };
          }
          changed = true;
        }
      }
      if (changed) saveEngagement();
    });

    // Monitora recibos de leitura / visualização das mensagens enviadas
    sock.ev.on("message-receipt.update", (receipts) => {
      if (!Array.isArray(receipts)) return;
      let changed = false;
      for (const item of receipts) {
        const jid = item.key?.remoteJid;
        const msgId = item.key?.id;
        const isFromMe = item.key?.fromMe;
        if (!jid || !jid.endsWith("@g.us") || !isFromMe || !msgId) continue;

        getGroupEngagement(jid);
        const eg = engagementStore[jid];
        if (!eg.sentMessages) eg.sentMessages = {};
        if (!eg.sentMessages[msgId]) {
          eg.sentMessages[msgId] = {
            sentAt: Date.now(),
            views: 0,
            viewers: [],
          };
        }

        const receiptObj = item.receipt || {};
        const viewer = receiptObj.userJid || item.userJid;
        if (viewer && !eg.sentMessages[msgId].viewers.includes(viewer)) {
          eg.sentMessages[msgId].viewers.push(viewer);
          eg.sentMessages[msgId].views = eg.sentMessages[msgId].viewers.length;

          let totalV = 0;
          for (const sent of Object.values(eg.sentMessages)) {
            totalV += sent.views || 0;
          }
          eg.totalViewsCount = totalV;
          changed = true;
        }
      }
      if (changed) saveEngagement();
    });

    // Monitora saídas e entradas de participantes em tempo real
    sock.ev.on("group-participants.update", ({ id, participants, action }) => {
      if (!groupsStore[id]) return;
      const myPhone = connectionStatus.user?.phone;

      if (action === "remove") {
        const isMe = participants.some((p) => myPhone && p.includes(myPhone));
        if (isMe) {
          delete groupsStore[id];
          connectionStatus.groupCount = Object.keys(groupsStore).length;
          saveGroupsCache();
          return;
        }
        groupsStore[id].participants = (groupsStore[id].participants || []).filter(
          (p) => !participants.includes(p.id)
        );
        groupsStore[id].size = groupsStore[id].participants.length;
      } else if (action === "add") {
        for (const pId of participants) {
          const newPart = { id: pId, admin: null };
          enrichParticipant(newPart);
          groupsStore[id].participants.push(newPart);
        }
        groupsStore[id].size = groupsStore[id].participants.length;
      }
      saveGroupsCache();
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus.state = "qr";
        try {
          connectionStatus.qrDataUrl = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
          connectionStatus.lastMessage = "QR Code pronto! Aponte o WhatsApp para conectar.";
        } catch (e) {
          console.error("Erro ao gerar QR Code:", e);
        }
      }

      if (connection === "open") {
        isStarting = false;
        connectionStatus.state = "connected";
        connectionStatus.qrDataUrl = null;

        const rawUser = sock.user || {};
        const userJid = rawUser.id || "";
        const userPhone = cleanDigits(userJid);

        connectionStatus.user = {
          id: userJid,
          name: rawUser.name || rawUser.notify || "Usuário WhatsApp",
          phone: userPhone,
        };
        connectionStatus.lastMessage = `Conectado como +${userPhone}! Carregando grupos...`;
        console.log(`[Bridge] Conexão bem-sucedida (+${userPhone})`);

        // Busca grupos participantes
        setTimeout(() => {
          fetchGroupsNow();
        }, 1200);

        // Dispara varredura do Radar de Grupos
        setTimeout(() => {
          scanRadarNow();
        }, 3500);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "Desconexão";
        console.log(`[Bridge] Conexão fechada. Código: ${statusCode}, Motivo: ${reason}`);

        connectionStatus.state = "disconnected";
        connectionStatus.qrDataUrl = null;
        connectionStatus.lastMessage = `Desconectado: ${reason}`;

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isConflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440 || (reason && String(reason).toLowerCase().includes("conflict"));

        if (isLoggedOut) {
          console.log("[Bridge] Sessão revogada no celular. Limpando credenciais para novo QR Code...");
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          isStarting = false;
          setTimeout(() => startWhatsApp(), 1500);
        } else if (isConflict) {
          console.warn("[Bridge] Conflito detectado (440): Outra instância/dispositivo conectou com esta conta. Aguardando 40s para evitar disputa de conexão...");
          connectionStatus.lastMessage = "Aviso: Outra conexão ativa com este WhatsApp. Aguardando estabilização...";
          setTimeout(() => {
            isStarting = false;
            startWhatsApp();
          }, 40000);
        } else {
          console.log("[Bridge] Reconectando automaticamente em 5 segundos...");
          setTimeout(() => {
            isStarting = false;
            startWhatsApp();
          }, 5000);
        }
      }
    });

  } catch (err) {
    console.error("[Bridge] Falha ao iniciar:", err);
    connectionStatus.state = "disconnected";
    connectionStatus.lastError = err.message;
    connectionStatus.lastMessage = `Erro: ${err.message}`;
    isStarting = false;
  }
}

// Servidor HTTP Local
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // 1. Status Geral
  if (req.method === "GET" && url.pathname === "/status") {
    res.end(JSON.stringify(connectionStatus));
    return;
  }

  // 2. Obter Todos os Grupos
  if (req.method === "GET" && url.pathname === "/groups") {
    const list = Object.values(groupsStore).map((g) => {
      const eg = getGroupEngagement(g.id, g.participants?.length || g.size || 0);
      return {
        ...g,
        engagement: eg,
      };
    });
    res.end(
      JSON.stringify({
        ok: true,
        count: list.length,
        isSyncing: isSyncingGroups,
        lastSync: lastSyncTimestamp,
        groups: list,
      })
    );
    return;
  }

  // 3. Forçar Sincronização em Tempo Real
  if (req.method === "POST" && url.pathname === "/refresh") {
    if (connectionStatus.state !== "connected" || !sock) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "WhatsApp não está conectado no momento." }));
      return;
    }
    const updated = await fetchGroupsNow();
    res.end(JSON.stringify({ ok: true, count: Object.keys(updated).length }));
    return;
  }

  // 3.1 Limpar Fantasmas / Órfãos
  if (req.method === "POST" && url.pathname === "/purge-ghosts") {
    const purged = purgeGhostGroupsNow();
    // Inicia resolução do que restar sem bloquear
    if (sock) {
      resolveMissingGroupMetadata();
    }
    res.end(JSON.stringify({ ok: true, purged, remaining: Object.keys(groupsStore).length }));
    return;
  }

  // 3.2 Auditar Grupos (Corrige grupos com 1 participante, nomes faltantes e discrepâncias)
  if (req.method === "POST" && url.pathname === "/audit") {
    if (connectionStatus.state !== "connected" || !sock) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "WhatsApp não está conectado no momento." }));
      return;
    }
    resolveMissingGroupMetadata(false);
    res.end(JSON.stringify({ ok: true, message: "Auditoria iniciada para verificar e corrigir participantes reais de todos os grupos." }));
    return;
  }

  // 4. Sair do Grupo (1 clique com tratamento à prova de falhas)
  if (req.method === "POST" && url.pathname === "/leave") {
    if (connectionStatus.state !== "connected" || !sock) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "WhatsApp não está conectado." }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const groupIds = [];
        if (payload.groupId) groupIds.push(payload.groupId);
        if (Array.isArray(payload.groupIds)) groupIds.push(...payload.groupIds);

        if (groupIds.length === 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Nenhum ID de grupo fornecido para saída." }));
          return;
        }

        const results = [];
        for (const rawId of groupIds) {
          const targetJid = rawId.includes("@") ? rawId : `${rawId}@g.us`;
          const currentMeta = groupsStore[targetJid] || groupsStore[rawId];
          const cachedCount = Math.max(currentMeta?.participants?.length || 0, currentMeta?.size || 0);

          // VERIFICAÇÃO DE SEGURANÇA EM TEMPO REAL:
          // Se o grupo está listado com <= 3 membros no cache, faz uma consulta ao vivo no WhatsApp antes de sair!
          if (cachedCount <= 3) {
            try {
              const liveMeta = await sock.groupMetadata(targetJid);
              const realCount = Math.max(liveMeta?.participants?.length || 0, liveMeta?.size || 0);
              if (realCount > 3) {
                // Atualiza o grupo no cache com os participantes reais
                if (currentMeta) {
                  currentMeta.participants = liveMeta.participants || currentMeta.participants;
                  currentMeta.size = realCount;
                  if (liveMeta.subject) currentMeta.subject = liveMeta.subject;
                  for (const p of currentMeta.participants) enrichParticipant(p);
                  saveGroupsCache();
                }
                console.warn(`[Segurança] Saída impedida para ${targetJid}: Mostrava ${cachedCount} membros, mas na realidade possui ${realCount} participantes!`);
                results.push({
                  id: rawId,
                  status: "prevented_leave",
                  realCount: realCount,
                  subject: liveMeta.subject || currentMeta?.subject || "Grupo",
                  ok: false,
                  error: `Aviso de Segurança: O grupo "${liveMeta.subject || currentMeta?.subject || 'Grupo'}" possui ${realCount} participantes no WhatsApp (não apenas ${cachedCount}). A saída foi bloqueada para proteger você de sair de um grupo ativo!`
                });
                continue;
              }
            } catch (liveErr) {
              console.log(`[Segurança] Checagem ao vivo do grupo ${targetJid}:`, liveErr.message);
            }
          }

          try {
            console.log(`[Bridge] Saindo do grupo: ${targetJid}`);
            await sock.groupLeave(targetJid);
            delete groupsStore[targetJid];
            delete groupsStore[rawId];
            results.push({ id: rawId, status: "left", ok: true });
          } catch (leaveErr) {
            console.warn(`[Bridge] Aviso ao sair do grupo ${targetJid}:`, leaveErr.message);
            // Se o erro for 404 (já não faz parte), consideramos removido do cache com sucesso
            const errMsg = String(leaveErr.message || "");
            if (errMsg.includes("404") || errMsg.includes("item-not-found") || errMsg.includes("not-authorized")) {
              delete groupsStore[targetJid];
              delete groupsStore[rawId];
              results.push({ id: rawId, status: "left", ok: true });
            } else {
              // Tenta fallback com apenas os dígitos
              try {
                const altId = targetJid.split("@")[0];
                await sock.groupLeave(altId);
                delete groupsStore[targetJid];
                delete groupsStore[rawId];
                results.push({ id: rawId, status: "left", ok: true });
              } catch (altErr) {
                results.push({ id: rawId, status: "error", error: altErr.message, ok: false });
              }
            }
          }
          await new Promise((r) => setTimeout(r, 450));
        }

        connectionStatus.groupCount = Object.keys(groupsStore).length;
        saveGroupsCache();

        const successCount = results.filter((r) => r.ok).length;
        res.end(
          JSON.stringify({
            ok: successCount > 0,
            successCount,
            totalRequested: groupIds.length,
            results,
            remainingGroups: connectionStatus.groupCount,
          })
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 5. Logout & Limpeza de Sessão
  if (req.method === "POST" && url.pathname === "/logout") {
    try {
      if (sock) {
        await sock.logout().catch(() => {});
        sock.end(undefined);
        sock = null;
      }
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      groupsStore = {};
      saveGroupsCache();
      connectionStatus = {
        state: "disconnected",
        qrDataUrl: null,
        user: null,
        groupCount: 0,
        isSyncing: false,
        lastSync: null,
        lastError: null,
        lastMessage: "Sessão desconectada.",
      };
      setTimeout(() => {
        isStarting = false;
        startWhatsApp();
      }, 1000);
      res.end(JSON.stringify({ ok: true, message: "Desconectado com sucesso." }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 6. Importar Sessão Ativa
  if (req.method === "POST" && url.pathname === "/import-session") {
    try {
      const candidates = [
        "/Users/mac/Desktop/CONTATO EXTRATOR /data/wa_auth",
        "/Users/mac/Desktop/CONTATO EXTRATOR/data/wa_auth"
      ];
      const sourceAuth = candidates.find((d) => fs.existsSync(d));
      if (!sourceAuth) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "Nenhuma sessão ativa encontrada no Extrator de Contatos." }));
        return;
      }

      if (sock) {
        try {
          sock.ev.removeAllListeners();
          sock.end(undefined);
        } catch (e) {}
        sock = null;
      }

      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });

      // Cópia ultra-rápida nativa com cpSync
      fs.cpSync(sourceAuth, AUTH_DIR, { recursive: true });

      console.log(`[Bridge] Sessão importada com sucesso de ${sourceAuth}!`);
      isStarting = false;
      setTimeout(() => startWhatsApp(), 500);

      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 7. Reconectar
  if (req.method === "POST" && url.pathname === "/reconnect") {
    try {
      if (sock) {
        sock.end(undefined);
        sock = null;
      }
    } catch (e) {}
    isStarting = false;
    startWhatsApp();
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 8. Radar de Grupos: Listar (SOMENTE grupos que o usuário NÃO participa e livres de spam/+18/IPTV)
  if (req.method === "GET" && url.pathname === "/radar") {
    const list = Object.values(radarStore)
      .filter((x) => !x.discarded && x.subject && x.subject.trim() && x.id)
      // 1. Blacklist rigorosa: remove Shopee, Mercado Livre, IPTV/PTV, +18, etc.
      .filter((x) => {
        const cleanDesc = (x.desc || "").toLowerCase().replace(/(proibid[oa]|n[aã]o\s+[eé]\s+permitid[oa]|vetad[oa]|sem)\s+[^.\n;]{1,40}/gi, " ");
        const isBlackSub = RADAR_BLACKLIST.some((w) => (x.subject || "").toLowerCase().includes(w));
        const isBlackDesc = RADAR_BLACKLIST.some((w) => cleanDesc.includes(w));
        return !isBlackSub && !isBlackDesc;
      })
      // 2. EXCLUSIVO: SOMENTE GRUPOS QUE O USUÁRIO NÃO ESTÁ!
      .map((x) => {
        const inGroup = !!(x.id && groupsStore[x.id]);
        return {
          ...x,
          alreadyInGroup: inGroup,
          joined: inGroup || !!x.joined,
        };
      })
      .filter((x) => !x.alreadyInGroup && !x.joined)
      .sort((a, b) => new Date(b.foundAt) - new Date(a.foundAt));

    const totalTracked = list.length;
    const bairrosCount = list.filter((x) => x.category === "bairro").length;
    const desapegoCount = list.filter((x) => x.category === "desapego").length;
    const roloCount = list.filter((x) => x.category === "rolo").length;
    const vendasCount = list.filter((x) => x.category === "vendas").length;

    res.end(
      JSON.stringify({
        ok: true,
        count: totalTracked,
        isScanning: isScanningRadar,
        summary: {
          total: totalTracked,
          bairros: bairrosCount,
          desapego: desapegoCount,
          rolo: roloCount,
          vendas: vendasCount,
        },
        groups: list,
      })
    );
    return;
  }

  // 9. Radar de Grupos: Forçar Varredura
  if (req.method === "POST" && url.pathname === "/radar/scan") {
    if (!sock || connectionStatus.state !== "connected") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "WhatsApp não está conectado." }));
      return;
    }
    scanRadarNow();
    res.end(
      JSON.stringify({
        ok: true,
        message: "Varredura do Radar iniciada em background.",
        isScanning: true,
      })
    );
    return;
  }

  // 10. Radar de Grupos: Inspecionar Link Manual ou Texto
  if (req.method === "POST" && url.pathname === "/radar/inspect") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const rawLink = payload.link || payload.text || "";
        const linkRegex = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,24})/i;
        const match = linkRegex.exec(rawLink);
        const code = match ? match[1] : rawLink.trim();

        if (!code) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Nenhum link ou código de grupo válido detectado." }));
          return;
        }

        const result = await processInviteCode(code, "manual", "Inserido Manualmente");
        if (result) {
          res.end(JSON.stringify({ ok: true, group: result }));
        } else {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Link descartado por ser achadinho/shopee/mercado livre ou link inválido/expirado." }));
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 11. Radar de Grupos: Entrar no Grupo pelo Link (com proteção contra conflict e grupos fechados)
  if (req.method === "POST" && url.pathname === "/radar/join") {
    if (!sock || connectionStatus.state !== "connected") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "WhatsApp não está conectado." }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const code = (payload.code || "").trim();
        if (!code) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "Código do convite ausente." }));
          return;
        }

        // 1. Checagem prévia: se já temos o id e o usuário já participa do grupo
        let targetJid = radarStore[code]?.id;
        let inviteInfo = null;

        if (targetJid && groupsStore[targetJid]) {
          if (radarStore[code]) {
            radarStore[code].joined = true;
            radarStore[code].alreadyInGroup = true;
            saveRadar();
          }
          res.end(
            JSON.stringify({
              ok: true,
              status: "already_member",
              groupId: targetJid,
              message: "Você já participa deste grupo no WhatsApp!",
            })
          );
          return;
        }

        // 2. Busca metadados do convite para checar ID e aprovação
        try {
          inviteInfo = await sock.groupGetInviteInfo(code);
          if (inviteInfo && inviteInfo.id) {
            targetJid = inviteInfo.id;
            if (radarStore[code]) {
              radarStore[code].id = inviteInfo.id;
              radarStore[code].joinApprovalMode = !!inviteInfo.joinApprovalMode;
              saveRadar();
            }
            if (groupsStore[inviteInfo.id]) {
              if (radarStore[code]) {
                radarStore[code].joined = true;
                radarStore[code].alreadyInGroup = true;
                saveRadar();
              }
              res.end(
                JSON.stringify({
                  ok: true,
                  status: "already_member",
                  groupId: inviteInfo.id,
                  message: "Você já participa deste grupo no WhatsApp!",
                })
              );
              return;
            }
          }
        } catch (infoErr) {
          console.warn(`[Radar] Aviso ao obter info do convite ${code}:`, infoErr.message);
        }

        console.log(`[Radar] Entrando no grupo via link: ${code}...`);

        try {
          const joinedGroupId = await sock.groupAcceptInvite(code);
          const finalId = joinedGroupId || targetJid;
          if (radarStore[code]) {
            radarStore[code].joined = true;
            radarStore[code].alreadyInGroup = true;
            if (finalId) radarStore[code].id = finalId;
            saveRadar();
          }

          if (finalId) {
            setTimeout(async () => {
              try {
                const meta = await sock.groupMetadata(finalId);
                if (meta) {
                  groupsStore[finalId] = meta;
                  connectionStatus.groupCount = Object.keys(groupsStore).length;
                  saveGroupsCache();
                }
              } catch (e) {}
            }, 600);
          }

          res.end(
            JSON.stringify({
              ok: true,
              status: "joined",
              groupId: finalId,
              message: "Você entrou no grupo com sucesso!",
            })
          );
        } catch (joinErr) {
          const errMsg = String(joinErr.message || "").toLowerCase();
          const statusCode = joinErr.output?.statusCode || joinErr.data?.attrs?.code;
          console.log(`[Radar] Retorno ao aceitar convite ${code}: msg="${errMsg}", status=${statusCode}`);

          // CASO A: CONFLICT (409) -> O usuário JÁ é membro deste grupo
          if (errMsg.includes("conflict") || statusCode === 409 || String(joinErr).includes("409")) {
            if (radarStore[code]) {
              radarStore[code].joined = true;
              radarStore[code].alreadyInGroup = true;
              saveRadar();
            }
            res.end(
              JSON.stringify({
                ok: true,
                status: "already_member",
                groupId: targetJid,
                message: "Você já participa deste grupo no WhatsApp!",
              })
            );
            return;
          }

          // CASO B: GRUPO REQUER APROVAÇÃO DOS ADMS (fechado / restrito)
          if (
            errMsg.includes("approval") ||
            errMsg.includes("not-authorized") ||
            errMsg.includes("401") ||
            errMsg.includes("request") ||
            inviteInfo?.joinApprovalMode
          ) {
            if (radarStore[code]) {
              radarStore[code].joinApprovalMode = true;
              saveRadar();
            }
            res.end(
              JSON.stringify({
                ok: true,
                status: "approval_needed",
                link: `https://chat.whatsapp.com/${code}`,
                message: "Este grupo requer aprovação dos administradores. Solicitação encaminhada!",
              })
            );
            return;
          }

          // CASO C: LINK REVOGADO / EXPIRADO
          if (errMsg.includes("404") || errMsg.includes("gone") || errMsg.includes("not-found") || errMsg.includes("revoked")) {
            if (radarStore[code]) {
              radarStore[code].discarded = true;
              radarStore[code].reason = "link_revoked";
              saveRadar();
            }
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                ok: false,
                status: "revoked",
                error: "Este link de convite expirou ou foi revogado pelos administradores.",
              })
            );
            return;
          }

          // CASO D: FALLBACK SEGURO
          res.end(
            JSON.stringify({
              ok: true,
              status: "fallback_link",
              link: `https://chat.whatsapp.com/${code}`,
              message: "Processando convite no WhatsApp...",
            })
          );
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 12. Radar de Grupos: Remover / Descartar Link
  if (req.method === "POST" && url.pathname === "/radar/remove") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const code = (payload.code || "").trim();
        if (code && radarStore[code]) {
          radarStore[code].discarded = true;
          saveRadar();
        }
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 13. Radar de Grupos: Limpar / Apagar Todos os Grupos do Radar
  if (req.method === "POST" && url.pathname === "/radar/clear") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const category = (payload.category || "all").trim().toLowerCase();

        let removedCount = 0;
        if (category === "all") {
          removedCount = Object.keys(radarStore).length;
          radarStore = {};
        } else {
          for (const [code, item] of Object.entries(radarStore)) {
            if (item && item.category === category) {
              delete radarStore[code];
              removedCount++;
            }
          }
        }
        saveRadar();
        console.log(`[Radar] Limpeza executada: ${removedCount} grupos removidos.`);
        res.end(JSON.stringify({ ok: true, removedCount }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Rota não encontrada" }));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Porta ${PORT} já está ativa por outra instância.`);
    process.exit(0);
  } else {
    console.error("Erro no servidor HTTP do bridge:", err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Bridge] WhatsApp Bridge operacional em http://127.0.0.1:${PORT}`);
  startWhatsApp();

  // Watchdog contínuo em background: verifica a cada 5 minutos se há grupos com discrepância de participantes
  setInterval(() => {
    if (sock && connectionStatus.state === "connected" && !isResolvingMetadata && !isSyncingGroups) {
      resolveMissingGroupMetadata(false);
    }
  }, 300000);
});
