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
  makeCacheableSignalKeyStore,
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
let reconnectTimer = null;
let consecutiveDisconnects = 0;
let lastAutoAuditAt = 0;
let lastAutoRadarScanAt = 0;
let groupsStore = {}; // jid -> GroupMetadata
let lastSyncTimestamp = null;

// Tabelas de mapeamento de LID -> Número de Telefone
const lidToPn = {};
const pnToLid = {};

// Cria gravador atômico assíncrono com debounce para não travar o event loop
function createDebouncedSaver(filePath, getData, defaultDelayMs = 5000) {
  let timer = null;
  let dirty = false;
  let writing = false;
  let pendingWhileWriting = false;

  async function writeNow() {
    if (writing) {
      pendingWhileWriting = true;
      return;
    }
    if (!dirty) return;
    dirty = false;
    writing = true;
    const tmp = `${filePath}.tmp`;
    try {
      const json = JSON.stringify(getData());
      await fs.promises.writeFile(tmp, json, "utf-8");
      await fs.promises.rename(tmp, filePath);
    } catch (e) {
      console.error(`Erro ao salvar ${path.basename(filePath)}:`, e.message);
    } finally {
      writing = false;
      if (pendingWhileWriting || dirty) {
        pendingWhileWriting = false;
        schedule(1000);
      }
    }
  }

  function schedule(delayMs = defaultDelayMs) {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, delayMs);
  }

  function flushSync() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return;
    dirty = false;
    const tmp = `${filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(getData()), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error(`Erro ao salvar ${path.basename(filePath)} (sync):`, e.message);
    }
  }

  return { schedule, writeNow, flushSync };
}

const MAX_SENT_MESSAGES_PER_GROUP = 15;
const MAX_VIEWER_LIST_MESSAGES = 10;
const ENGAGEMENT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14 dias

// Set em memória para deduplicação O(1) de visualizadores por "groupId|msgId"
const viewerSets = new Map();

function getViewerSet(groupId, msgId, initialViewers = []) {
  const key = `${groupId}|${msgId}`;
  let set = viewerSets.get(key);
  if (!set) {
    set = new Set();
    if (Array.isArray(initialViewers)) {
      for (const v of initialViewers) {
        const d = cleanDigits(String(v));
        if (d) set.add(d);
      }
    }
    viewerSets.set(key, set);
  }
  return set;
}

// Armazenamento de engajamento e métricas de visualização de mensagens enviadas
let engagementStore = {};
if (fs.existsSync(ENGAGEMENT_FILE)) {
  try {
    engagementStore = JSON.parse(fs.readFileSync(ENGAGEMENT_FILE, "utf-8")) || {};
  } catch (e) {
    engagementStore = {};
  }
}

const engagementSaver = createDebouncedSaver(ENGAGEMENT_FILE, () => engagementStore, 15000);

function saveEngagement(immediate = false) {
  if (immediate) engagementSaver.schedule(500);
  else engagementSaver.schedule(15000);
}

function pruneAndRecalcEngagementEntry(jid, eg) {
  if (!eg || typeof eg !== "object") return;
  const sentMap = eg.sentMessages && typeof eg.sentMessages === "object" ? eg.sentMessages : {};
  const now = Date.now();
  const entries = Object.entries(sentMap)
    .filter(([, m]) => m && typeof m === "object")
    .filter(([, m]) => !m.sentAt || (now - m.sentAt <= ENGAGEMENT_MAX_AGE_MS))
    .sort((a, b) => (b[1].sentAt || 0) - (a[1].sentAt || 0));

  // Se todas forem mais antigas que 14 dias, mantém até 5 últimas para não zerar referência bruscamente
  const kept = entries.length > 0
    ? entries.slice(0, MAX_SENT_MESSAGES_PER_GROUP)
    : Object.entries(sentMap)
        .filter(([, m]) => m && typeof m === "object")
        .sort((a, b) => (b[1].sentAt || 0) - (a[1].sentAt || 0))
        .slice(0, 5);

  const keptIds = new Set(kept.map(([id]) => id));
  for (const oldId of Object.keys(sentMap)) {
    if (!keptIds.has(oldId)) {
      viewerSets.delete(`${jid}|${oldId}`);
    }
  }

  const newSentMap = {};
  let totalViews = 0;

  kept.forEach(([msgId, m], idx) => {
    const vSet = getViewerSet(jid, msgId, m.viewers);
    const viewsCount = Math.max(Number(m.views || 0), vSet.size);
    totalViews += viewsCount;

    if (idx < MAX_VIEWER_LIST_MESSAGES) {
      newSentMap[msgId] = {
        sentAt: m.sentAt || now,
        views: viewsCount,
        viewers: Array.from(vSet)
      };
    } else {
      viewerSets.delete(`${jid}|${msgId}`);
      newSentMap[msgId] = {
        sentAt: m.sentAt || now,
        views: viewsCount
      };
    }
  });

  eg.sentMessages = newSentMap;
  eg.messagesSentCount = kept.length;
  eg.totalViewsCount = totalViews;
}

function compactEngagementStore(validGroupIds = null) {
  let changed = false;
  for (const [jid, eg] of Object.entries(engagementStore)) {
    if (validGroupIds && !validGroupIds.has(jid)) {
      delete engagementStore[jid];
      changed = true;
      continue;
    }
    const beforeCount = Object.keys(eg?.sentMessages || {}).length;
    pruneAndRecalcEngagementEntry(jid, eg);
    const afterCount = Object.keys(eg?.sentMessages || {}).length;
    if (beforeCount !== afterCount) changed = true;
  }
  return changed;
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

const radarSaver = createDebouncedSaver(RADAR_FILE, () => radarStore, 2000);

function saveRadar(immediate = false) {
  if (immediate) radarSaver.schedule(200);
  else radarSaver.schedule(2000);
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
  ["Centro de SP", ["centro sp", "centro de sp", "sé", "praça da sé", "metro se", "metrô sé", "república", "bela vista", "consolação", "bom retiro", "santa cecília", "liberdade", "cambuci", "brás", "bras", "pari"]],
  ["Parelheiros / Marsilac", ["parelheiros", "marsilac"]],
  ["Grajaú", ["grajaú", "grajau"]],
  ["Interlagos / Socorro", ["interlagos", "socorro", "represa guarapiranga"]],
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
  ["ABC Paulista", ["abc", "santo andré", "santo andre", "são bernardo", "sao bernardo", "são caetano", "sao caetano", "diadema", "mauá", "maua", "vila luzita", "clube de campo", "represa"]],
  ["Osasco / Barueri", ["osasco", "barueri", "alphaville", "carapicuíba", "carapicuiba"]],
  ["Cotia / Taboão / Embu", ["cotia", "taboão", "taboao", "embu das artes", "embu", "itapecerica"]],
  ["Guarulhos", ["guarulhos", "cumbica"]],
  ["Franco da Rocha / Mairiporã", ["franco da rocha", "mairiporã", "mairipora", "francisco morato", "caieiras"]],
  ["Alto Tietê", ["itaquaquecetuba", "ferraz", "poá", "poa", "suzano", "mogi das cruzes"]]
];

function stripAccents(str) {
  return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function escapeRegexStr(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordMatch(normalizedText, terms) {
  for (const rawTerm of terms) {
    const term = stripAccents(rawTerm).trim();
    if (!term) continue;
    const regex = new RegExp(`(?:^|[^a-z0-9])${escapeRegexStr(term)}(?:$|[^a-z0-9])`);
    if (regex.test(normalizedText)) return true;
  }
  return false;
}

let isScanningRadar = false;
const inFlightInviteCodes = new Set();
const radarInviteQueue = [];
let isProcessingInviteQueue = false;
let radarRateLimitUntil = 0;

function enqueueRadarInvite(code, fromGroupId = "", fromGroupName = "") {
  if (!code || typeof code !== "string") return;
  const cleanCode = code.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleanCode || cleanCode.length < 18) return;
  if (radarStore[cleanCode] || inFlightInviteCodes.has(cleanCode)) return;
  if (Date.now() < radarRateLimitUntil) return;
  if (radarInviteQueue.some((item) => item.code === cleanCode)) return;
  if (radarInviteQueue.length >= 40) return;

  radarInviteQueue.push({ code: cleanCode, fromGroupId, fromGroupName });
  drainRadarInviteQueue();
}

async function drainRadarInviteQueue() {
  if (isProcessingInviteQueue || !sock) return;
  isProcessingInviteQueue = true;
  try {
    while (radarInviteQueue.length > 0 && sock) {
      if (Date.now() < radarRateLimitUntil) {
        radarInviteQueue.length = 0;
        break;
      }
      const next = radarInviteQueue.shift();
      if (!next || radarStore[next.code]) continue;
      await processInviteCode(next.code, next.fromGroupId, next.fromGroupName);
      await new Promise((r) => setTimeout(r, 1100));
    }
  } finally {
    isProcessingInviteQueue = false;
  }
}

async function processInviteCode(code, fromGroupId = "", fromGroupName = "") {
  if (!code || typeof code !== "string") return null;
  const cleanCode = code.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!cleanCode || cleanCode.length < 18) return null;

  if (radarStore[cleanCode]) {
    return radarStore[cleanCode].discarded ? null : radarStore[cleanCode];
  }

  if (!sock || inFlightInviteCodes.has(cleanCode)) return null;
  if (Date.now() < radarRateLimitUntil) return null;

  inFlightInviteCodes.add(cleanCode);
  try {
    const meta = await sock.groupGetInviteInfo(cleanCode);
    if (!meta || !meta.id) return null;

    const subject = (meta.subject || "").trim();
    const desc = (meta.desc || "").trim();
    const normalizedText = stripAccents(`${subject} ${desc}`);

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

    // 3. Classificação com bordas de palavra: Bairros SP, Desapego, Rolo, Vendas
    let category = "vendas";
    let bairroName = "";

    for (const [bName, aliases] of SP_BAIRROS_RADAR) {
      if (hasWordMatch(normalizedText, aliases)) {
        category = "bairro";
        bairroName = bName;
        break;
      }
    }

    const isDesapego = hasWordMatch(normalizedText, ["desapego", "desapega", "desapegue", "desapegos", "bazar", "brecho", "usados", "usado"]);
    if (isDesapego) category = "desapego";

    const isRolo = hasWordMatch(normalizedText, ["rolo", "rolos", "troca", "trocas", "brique", "escambo", "feira do rolo"]);
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
    const isRateLimit = errMsg.includes("rate-overlimit") || errMsg.includes("429");
    if (isRateLimit) {
      radarRateLimitUntil = Date.now() + 1000 * 60 * 5;
      console.warn("[Radar] Rate-limit detectado pelo WhatsApp. Pausando consultas do radar por 5 minutos.");
      return null;
    }
    const isTempError = errMsg.includes("timeout") || errMsg.includes("timed out") || errMsg.includes("temporarily");
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
  } finally {
    inFlightInviteCodes.delete(cleanCode);
  }
}

async function scanRadarNow() {
  if (isScanningRadar || !sock) return;
  if (Date.now() < radarRateLimitUntil) return;
  isScanningRadar = true;
  lastAutoRadarScanAt = Date.now();
  console.log("[Radar] Iniciando varredura em grupos e descrições...");

  try {
    const linkRegex = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,24})/gi;
    const allGroups = Object.values(groupsStore);

    for (const g of allGroups) {
      if (!sock || Date.now() < radarRateLimitUntil) break;
      const text = `${g.subject || ""} ${g.desc || ""}`;
      linkRegex.lastIndex = 0;
      let match;
      while ((match = linkRegex.exec(text)) !== null) {
        if (!sock || Date.now() < radarRateLimitUntil) break;
        const code = match[1];
        if (!radarStore[code]) {
          await processInviteCode(code, g.id, g.subject);
          await new Promise((r) => setTimeout(r, 1100));
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

// Compacta engagementStore na inicialização (poda histórico antigo/órfão que inflamava o arquivo)
{
  const validIds = Object.keys(groupsStore).length > 0 ? new Set(Object.keys(groupsStore)) : null;
  const compacted = compactEngagementStore(validIds);
  if (compacted) {
    console.log("[Bridge] Histórico de engajamento compactado na inicialização.");
    saveEngagement(true);
  }
}

const groupsCacheSaver = createDebouncedSaver(
  GROUPS_CACHE_FILE,
  () => ({
    lastSync: lastSyncTimestamp || new Date().toISOString(),
    groupsCount: Object.keys(groupsStore).length,
    groups: groupsStore,
  }),
  3000
);

function saveGroupsCache(immediate = false) {
  if (immediate) groupsCacheSaver.schedule(300);
  else groupsCacheSaver.schedule(3000);
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
let auditRateLimitUntil = 0;

async function resolveMissingGroupMetadata(forceAll = false) {
  if (!sock || isResolvingMetadata) return;
  if (!forceAll && Date.now() < auditRateLimitUntil) return;
  isResolvingMetadata = true;
  lastAutoAuditAt = Date.now();

  try {
    const allKeys = Object.keys(groupsStore);
    const missing = allKeys.filter((jid) => {
      const g = groupsStore[jid];
      if (!g) return false;
      if (forceAll) return true;

      // Se for comunidade confirmada ou grupo já confirmado como unitário, não re-audita
      if (g.isCommunity || g.noMoreParticipants) return false;

      // Se já foi auditado nas últimas 12 horas, não sobrecarrega a conexão
      if (g.lastAuditedAt && (Date.now() - g.lastAuditedAt < 1000 * 60 * 60 * 12)) return false;

      const pLen = g.participants?.length || 0;
      const size = g.size || 0;
      const sub = (g.subject || "").trim();

      // Precisa resolver se:
      // 1. Tem 1 participante ou 0 participantes na lista
      if (pLen <= 1) return true;
      // 2. Não tem nome real ou está com placeholder temporário
      if (!sub || sub.startsWith("Grupo WhatsApp (") || sub.startsWith("Grupo ")) return true;
      // 3. Diferença relevante (>= 3) entre tamanho reportado e lista de participantes
      if (size - pLen >= 3) return true;

      return false;
    });

    if (missing.length === 0) {
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
          g.size = Math.max(fullMeta.size || 0, g.participants?.length || 0);
          if ((g.participants?.length || 0) <= 1 && g.size <= 1) {
            g.noMoreParticipants = true;
          } else {
            delete g.noMoreParticipants;
          }
          g.creation = fullMeta.creation || g.creation;
          g.owner = fullMeta.owner || g.owner;
          g.announce = fullMeta.announce ?? g.announce;
          g.restrict = fullMeta.restrict ?? g.restrict;
          resolved++;
        }
      } catch (err) {
        const errMsg = String(err.message || "").toLowerCase();
        if (errMsg.includes("rate-overlimit") || errMsg.includes("429")) {
          auditRateLimitUntil = Date.now() + 1000 * 60 * 15;
          console.warn("[Bridge] Rate-limit do WhatsApp durante auditoria. Interrompendo ciclo por 15 minutos.");
          break;
        }
        // NUNCA deleta o grupo do usuário em caso de erro! Mantém o grupo acessível para sair ou gerenciar.
        const rawGid = jid.split("@")[0];
        if (!g.subject || !g.subject.trim()) {
          g.subject = `Grupo WhatsApp (${rawGid.slice(-6)})`;
        }
      }

      await new Promise((r) => setTimeout(r, 1200));
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
  connectionStatus.lastMessage = "Sincronizando grupos no WhatsApp...";

  // Escaneia arquivos LID para enriquecer números de telefone
  scanLidMappingFiles(AUTH_DIR);
  if (process.env.EXTRATOR_AUTH_DIR) {
    scanLidMappingFiles(process.env.EXTRATOR_AUTH_DIR);
  }

  try {
    const allGroups = await sock.groupFetchAllParticipating();
    if (allGroups && typeof allGroups === "object") {
      const rawCount = Object.keys(allGroups).length;
      console.log(`[Bridge] groupFetchAllParticipating retornou ${rawCount} grupos brutos.`);

      // Remove do cache grupos que o usuário já saiu ou foi removido fora deste painel
      if (rawCount > 0) {
        let removedStale = 0;
        for (const existingJid of Object.keys(groupsStore)) {
          if (!allGroups[existingJid]) {
            delete groupsStore[existingJid];
            delete engagementStore[existingJid];
            removedStale++;
          }
        }
        if (removedStale > 0) {
          console.log(`[Bridge] Removidos ${removedStale} grupos que não existem mais na conta.`);
          saveEngagement();
        }
      }

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

        const existing = groupsStore[jid];
        if (existing) {
          // Só preserva participantes antigos se o WhatsApp retornou stub incompleto (<= 1 membro para grupo maior)
          if (
            meta.participants.length <= 1 &&
            existing.participants &&
            existing.participants.length > 1 &&
            (meta.size || 0) > 1
          ) {
            meta.participants = existing.participants;
          }
          if (existing.subject && (!meta.subject || meta.subject.startsWith("Grupo "))) {
            meta.subject = existing.subject;
          }
          if (existing.desc && !meta.desc) {
            meta.desc = existing.desc;
          }
          if (existing.lastAuditedAt) meta.lastAuditedAt = existing.lastAuditedAt;
          if (existing.isCommunity) meta.isCommunity = existing.isCommunity;
          if (existing.noMoreParticipants) meta.noMoreParticipants = existing.noMoreParticipants;
        }

        meta.size = Math.max(meta.size || 0, meta.participants?.length || 0);
        groupsStore[jid] = meta;
      }

      lastSyncTimestamp = new Date().toISOString();
      connectionStatus.groupCount = Object.keys(groupsStore).length;
      connectionStatus.lastSync = lastSyncTimestamp;
      connectionStatus.lastMessage = `${connectionStatus.groupCount} grupos carregados com sucesso.`;
      saveGroupsCache();

      // Só dispara auditoria automática se já passaram ao menos 30 min desde a última
      if (Date.now() - lastAutoAuditAt > 1000 * 60 * 30) {
        setTimeout(() => {
          resolveMissingGroupMetadata(false);
        }, 1500);
      }
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

function cleanupSocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.end(undefined);
  } catch (e) {}
  sock = null;
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isStarting = false;
    startWhatsApp();
  }, delayMs);
}

async function startWhatsApp() {
  if (isStarting) return;
  isStarting = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    scanLidMappingFiles(AUTH_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1043857760],
    }));

    connectionStatus.state = "connecting";
    connectionStatus.lastMessage = "Conectando ao WhatsApp...";

    cleanupSocket();

    const silentLogger = pino({ level: "silent" });
    sock = makeWASocket({
      version,
      logger: silentLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, silentLogger) : state.keys,
      },
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

        // Radar de Grupos: enfileira com rate-limit apenas em mensagens em tempo real
        if (type === "notify") {
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
                enqueueRadarInvite(code, jid, groupsStore[jid]?.subject || "Grupo WhatsApp");
              }
            }
          }
        }

        if (m.key.fromMe) {
          eg.lastMessageSentAt = eg.lastActivityAt;
          const msgId = m.key.id;
          if (!eg.sentMessages) eg.sentMessages = {};
          if (msgId && !eg.sentMessages[msgId]) {
            eg.sentMessages[msgId] = {
              sentAt: eg.lastMessageSentAt,
              views: 0,
              viewers: [],
            };
            pruneAndRecalcEngagementEntry(jid, eg);
            changed = true;
          }
        }
      }
      if (changed) saveEngagement();
    });

    // Monitora recibos de leitura / visualização das mensagens enviadas
    sock.ev.on("message-receipt.update", (receipts) => {
      if (!Array.isArray(receipts)) return;
      let changed = false;
      const touchedGroups = new Set();

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
        const viewerDigits = viewer ? cleanDigits(String(viewer)) : "";
        if (viewerDigits) {
          const vSet = getViewerSet(jid, msgId, eg.sentMessages[msgId].viewers);
          if (!vSet.has(viewerDigits)) {
            vSet.add(viewerDigits);
            eg.sentMessages[msgId].views = Math.max(eg.sentMessages[msgId].views || 0, vSet.size);
            eg.sentMessages[msgId].viewers = Array.from(vSet);
            touchedGroups.add(jid);
            changed = true;
          }
        }
      }

      if (changed) {
        for (const jid of touchedGroups) {
          pruneAndRecalcEngagementEntry(jid, engagementStore[jid]);
        }
        saveEngagement();
      }
    });

    // Monitora saídas e entradas de participantes em tempo real
    sock.ev.on("group-participants.update", ({ id, participants, action }) => {
      if (!groupsStore[id]) return;
      const myPhone = connectionStatus.user?.phone;

      if (action === "remove") {
        const isMe = participants.some((p) => myPhone && p.includes(myPhone));
        if (isMe) {
          delete groupsStore[id];
          delete engagementStore[id];
          connectionStatus.groupCount = Object.keys(groupsStore).length;
          saveGroupsCache();
          saveEngagement();
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
        consecutiveDisconnects = 0;
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

        // Varredura automática do Radar no máximo 1x a cada 6 horas (botão manual funciona a qualquer hora)
        if (Date.now() - lastAutoRadarScanAt > 1000 * 60 * 60 * 6) {
          setTimeout(() => {
            scanRadarNow();
          }, 6000);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "Desconexão";
        console.log(`[Bridge] Conexão fechada. Código: ${statusCode}, Motivo: ${reason}`);

        connectionStatus.state = "disconnected";
        connectionStatus.qrDataUrl = null;
        connectionStatus.lastMessage = `Desconectado: ${reason}`;
        cleanupSocket();

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isConflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440 || (reason && String(reason).toLowerCase().includes("conflict"));

        if (isLoggedOut) {
          console.log("[Bridge] Sessão revogada no celular. Limpando credenciais para novo QR Code...");
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          scheduleReconnect(2000);
        } else if (isConflict) {
          console.warn("[Bridge] Conflito detectado (440): Outra instância/dispositivo conectou com esta conta. Aguardando 45s para evitar disputa de conexão...");
          connectionStatus.lastMessage = "Aviso: Outra conexão ativa com este WhatsApp. Aguardando estabilização...";
          scheduleReconnect(45000);
        } else {
          consecutiveDisconnects++;
          const backoffMs = Math.min(60000, 5000 * Math.pow(2, Math.min(consecutiveDisconnects - 1, 3)));
          console.log(`[Bridge] Reconectando automaticamente em ${Math.round(backoffMs / 1000)} segundos...`);
          scheduleReconnect(backoffMs);
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
        engagement: {
          messagesSentCount: eg.messagesSentCount || 0,
          totalViewsCount: eg.totalViewsCount || 0,
          viewRate: eg.viewRate || 0,
          status: eg.status || "sem_envio",
          lastMessageSentAt: eg.lastMessageSentAt || null,
          lastActivityAt: eg.lastActivityAt || null,
        },
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
            delete engagementStore[targetJid];
            delete engagementStore[rawId];
            results.push({ id: rawId, status: "left", ok: true });
          } catch (leaveErr) {
            console.warn(`[Bridge] Aviso ao sair do grupo ${targetJid}:`, leaveErr.message);
            // Se o erro for 404 (já não faz parte), consideramos removido do cache com sucesso
            const errMsg = String(leaveErr.message || "");
            if (errMsg.includes("404") || errMsg.includes("item-not-found") || errMsg.includes("not-authorized")) {
              delete groupsStore[targetJid];
              delete groupsStore[rawId];
              delete engagementStore[targetJid];
              delete engagementStore[rawId];
              results.push({ id: rawId, status: "left", ok: true });
            } else {
              // Tenta fallback com apenas os dígitos
              try {
                const altId = targetJid.split("@")[0];
                await sock.groupLeave(altId);
                delete groupsStore[targetJid];
                delete groupsStore[rawId];
                delete engagementStore[targetJid];
                delete engagementStore[rawId];
                results.push({ id: rawId, status: "left", ok: true });
              } catch (altErr) {
                results.push({ id: rawId, status: "error", error: altErr.message, ok: false });
              }
            }
          }
          await new Promise((r) => setTimeout(r, 450));
        }

        connectionStatus.groupCount = Object.keys(groupsStore).length;
        saveGroupsCache(true);
        saveEngagement(true);

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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (sock) {
        try {
          sock.ev.removeAllListeners();
          await sock.logout().catch(() => {});
          sock.end(undefined);
        } catch (e) {}
        sock = null;
      }
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      groupsStore = {};
      engagementStore = {};
      viewerSets.clear();
      saveGroupsCache(true);
      saveEngagement(true);
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
      scheduleReconnect(1000);
      res.end(JSON.stringify({ ok: true, message: "Desconectado com sucesso." }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // 6. Importar Sessão Ativa (opcional via env EXTRATOR_AUTH_DIR)
  if (req.method === "POST" && url.pathname === "/import-session") {
    try {
      const candidates = [process.env.EXTRATOR_AUTH_DIR].filter(Boolean);
      const sourceAuth = candidates.find((d) => fs.existsSync(d));
      if (!sourceAuth) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "Nenhuma sessão externa configurada para importação. Conecte pelo QR Code." }));
        return;
      }

      cleanupSocket();

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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupSocket();
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

  // Watchdog leve em background: verifica a cada 30 minutos apenas grupos realmente pendentes (respeita cooldown de 12h)
  setInterval(() => {
    if (sock && connectionStatus.state === "connected" && !isResolvingMetadata && !isSyncingGroups) {
      resolveMissingGroupMetadata(false);
    }
  }, 1800000);
});

function flushAllStoresAndExit() {
  cleanupSocket();
  engagementSaver.flushSync();
  groupsCacheSaver.flushSync();
  radarSaver.flushSync();
  process.exit(0);
}

process.on("SIGINT", flushAllStoresAndExit);
process.on("SIGTERM", flushAllStoresAndExit);
