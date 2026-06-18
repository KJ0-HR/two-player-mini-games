import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDir = process.env.DATA_DIR || root;
let accountsPath = process.env.ACCOUNTS_PATH || join(dataDir, "accounts.json");
const fallbackAccountsPath = join(tmpdir(), "two-player-mini-games", "accounts.json");
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const supabaseServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const accountStore = supabaseUrl && supabaseServiceKey ? "supabase" : "file";
const port = Number(process.env.PORT || 5177);
const rooms = new Map();
const ROUND_MS = 60000;
const NEXT_ROUND_DELAY_MS = 1600;
const GOMOKU_SIZE = 25;
const CHAT_BUBBLE_MS = 6000;
const CAMERA_FRAME_MS = 1400;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function loadAccounts() {
  try {
    const raw = await readFile(accountsPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { accounts: {} };
    }
    if ((error.code === "EACCES" || error.code === "EPERM") && accountsPath !== fallbackAccountsPath) {
      accountsPath = fallbackAccountsPath;
      return loadAccounts();
    }
    throw error;
  }
}

async function saveAccounts(data) {
  try {
    await mkdir(dirname(accountsPath), { recursive: true });
    await writeFile(accountsPath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    if ((error.code === "EACCES" || error.code === "EPERM") && accountsPath !== fallbackAccountsPath) {
      accountsPath = fallbackAccountsPath;
      await saveAccounts(data);
      return;
    }
    throw error;
  }
}

function accountFromDatabase(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.display_id || row.account_id,
    salt: row.salt,
    passwordHash: row.password_hash,
    avatar: row.avatar || "",
    createdAt: row.created_at,
  };
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`数据库请求失败：${response.status} ${detail}`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getStoredAccount(key) {
  if (accountStore === "supabase") {
    const rows = await supabaseRequest(
      `accounts?account_id=eq.${encodeURIComponent(key)}&select=account_id,display_id,salt,password_hash,avatar,created_at&limit=1`
    );
    return accountFromDatabase(rows?.[0]);
  }

  const data = await loadAccounts();
  return data.accounts[key] || null;
}

async function createStoredAccount(key, account) {
  if (accountStore === "supabase") {
    try {
      await supabaseRequest("accounts", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          account_id: key,
          display_id: account.id,
          salt: account.salt,
          password_hash: account.passwordHash,
          avatar: account.avatar || "",
          created_at: account.createdAt,
        }),
      });
      return;
    } catch (error) {
      if (error.status === 409) {
        throw new Error("这个游戏ID已经被注册，请换一个。");
      }
      throw error;
    }
  }

  const data = await loadAccounts();
  data.accounts[key] = account;
  await saveAccounts(data);
}

async function updateStoredAvatar(key, avatar) {
  if (accountStore === "supabase") {
    const account = await getStoredAccount(key);
    if (!account) {
      throw new Error("账户不存在，请重新登录。");
    }
    await supabaseRequest(`accounts?account_id=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ avatar }),
    });
    account.avatar = avatar;
    return account;
  }

  const data = await loadAccounts();
  const account = data.accounts[key];
  if (!account) {
    throw new Error("账户不存在，请重新登录。");
  }
  account.avatar = avatar;
  await saveAccounts(data);
  return account;
}

function normalizeAccountId(value) {
  return String(value || "").trim();
}

function validateAccountInput(accountId, password) {
  if (!/^[A-Za-z0-9_-]{3,16}$/.test(accountId)) {
    throw new Error("游戏ID只能用 3 到 16 位字母、数字、下划线或短横线。");
  }
  if (String(password || "").length < 4) {
    throw new Error("密码至少需要 4 位。");
  }
}

function hashPassword(password, salt) {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function publicAccount(account) {
  return {
    id: account.id,
    avatar: account.avatar || "",
  };
}

function validateAvatarData(avatar) {
  const value = String(avatar || "");
  if (!value) {
    return "";
  }
  if (value.length > 700000) {
    throw new Error("头像图片太大，请换一张小一点的图片。");
  }
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
    throw new Error("头像格式不正确，请选择图片文件。");
  }
  return value;
}

async function registerAccount(payload) {
  const accountId = normalizeAccountId(payload.accountId);
  const password = String(payload.password || "");
  validateAccountInput(accountId, password);

  const key = accountId.toLowerCase();
  if (await getStoredAccount(key)) {
    throw new Error("这个游戏ID已经被注册，请换一个。");
  }

  const salt = randomBytes(16).toString("hex");
  const account = {
    id: accountId,
    salt,
    passwordHash: hashPassword(password, salt),
    avatar: "",
    createdAt: new Date().toISOString(),
  };
  await createStoredAccount(key, account);
  return publicAccount(account);
}

async function loginAccount(payload) {
  const accountId = normalizeAccountId(payload.accountId);
  const password = String(payload.password || "");
  validateAccountInput(accountId, password);

  const account = await getStoredAccount(accountId.toLowerCase());
  if (!account || account.passwordHash !== hashPassword(password, account.salt)) {
    throw new Error("游戏ID或密码不正确。");
  }
  return publicAccount(account);
}

async function updateAvatar(payload) {
  const accountId = normalizeAccountId(payload.accountId);
  const avatar = validateAvatarData(payload.avatar);
  if (!accountId) {
    throw new Error("请先登录账户。");
  }

  const account = await updateStoredAvatar(accountId.toLowerCase(), avatar);
  return publicAccount(account);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("请求内容过大"));
      }
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
  });
}

function pruneGameTransient(game) {
  if (!game) {
    return;
  }
  const now = Date.now();
  game.chatBubbles = (game.chatBubbles || []).filter((bubble) => bubble.expiresAt > now);
  if (game.cameraFrame && game.cameraFrame.expiresAt <= now) {
    game.cameraFrame = null;
  }
}

function publicRoom(room) {
  pruneGameTransient(room.game);
  const game = room.game
    ? {
        status: room.game.status,
        round: room.game.round,
        deadlineAt: room.game.deadlineAt,
        question: room.game.question
          ? {
              id: room.game.question.id,
              text: room.game.question.text,
              level: room.game.question.level,
            }
          : null,
        scores: Object.fromEntries(room.players.map((player) => [player.id, room.game.scores[player.id] || 0])),
        lastResult: room.game.lastResult,
        board: room.game.board || null,
        currentPlayerId: room.game.currentPlayerId || null,
        winnerId: room.game.winnerId || null,
        winnerName: room.game.winnerId ? room.players.find((player) => player.id === room.game.winnerId)?.name || "" : "",
        moves: room.game.moves || [],
        pendingUndo: room.game.pendingUndo || null,
        message: room.game.message || "",
        chatBubbles: room.game.chatBubbles || [],
        cameraFrame: room.game.cameraFrame || null,
        serverNow: Date.now(),
      }
    : null;

  return {
    roomCode: room.roomCode,
    gameId: room.gameId,
    players: room.players.map(({ id, name, ready, avatar }) => ({ id, name, ready, avatar: avatar || "" })),
    game,
  };
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify(publicRoom(room))}\n\n`;
  room.clients.forEach((client) => client.write(payload));
}

function upsertPlayer(room, playerId, playerName, playerAvatar = "") {
  const existing = room.players.find((player) => player.id === playerId);
  if (existing) {
    existing.name = playerName;
    existing.avatar = playerAvatar;
    if (room.game) {
      room.game.scores[playerId] ??= 0;
    }
    return;
  }
  if (room.players.length >= 2) {
    throw new Error("房间已满");
  }
  room.players.push({ id: playerId, name: playerName, ready: false, avatar: playerAvatar });
  if (room.game) {
    room.game.scores[playerId] = 0;
  }
}

function createGameState() {
  return {
    status: "lobby",
    round: 0,
    question: null,
    deadlineAt: null,
    scores: {},
    lastResult: null,
    timer: null,
    nextTimer: null,
    chatBubbles: [],
    cameraFrame: null,
  };
}

function addChatBubble(room, player, text) {
  const cleanText = String(text || "").trim().slice(0, 80);
  if (!cleanText) {
    throw new Error("聊天内容不能为空。");
  }
  room.game.chatBubbles = room.game.chatBubbles || [];
  room.game.chatBubbles.push({
    id: `${Date.now()}-${randomInt(1000, 9999)}`,
    playerId: player.id,
    text: cleanText,
    expiresAt: Date.now() + CHAT_BUBBLE_MS,
  });
}

function updateCameraFrame(room, player, frame) {
  const value = String(frame || "");
  const pending = room.game.pendingUndo;
  if (!pending || pending.condition !== "camera" || pending.status !== "waiting-camera") {
    throw new Error("当前没有摄像头挑战。");
  }
  if (pending.requesterId !== player.id) {
    throw new Error("只有申请悔棋的一方可以同步摄像头。");
  }
  if (value.length > 350000 || !/^data:image\/jpe?g;base64,[A-Za-z0-9+/=]+$/i.test(value)) {
    throw new Error("摄像头画面格式不正确。");
  }
  room.game.cameraFrame = {
    playerId: player.id,
    viewerId: pending.opponentId,
    frame: value,
    expiresAt: Date.now() + CAMERA_FRAME_MS,
  };
}

function clearGameTimers(game) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
  if (game.nextTimer) {
    clearTimeout(game.nextTimer);
    game.nextTimer = null;
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function choice(items) {
  return items[randomInt(0, items.length - 1)];
}

function roundAnswer(value) {
  return Number(Number(value).toFixed(6));
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function fractionText(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  const n = numerator / divisor;
  const d = denominator / divisor;
  return d === 1 ? String(n) : `${n}/${d}`;
}

function generateMathQuestion(round) {
  const templates = [
    () => {
      const a = randomInt(1, 20);
      const b = randomInt(1, 20);
      return { text: `${a} + ${b} = ?`, answer: a + b, level: "小学一年级" };
    },
    () => {
      const a = randomInt(12, 50);
      const b = randomInt(1, a);
      return { text: `${a} - ${b} = ?`, answer: a - b, level: "小学一年级" };
    },
    () => {
      const a = randomInt(2, 12);
      const b = randomInt(2, 12);
      return { text: `${a} × ${b} = ?`, answer: a * b, level: "小学二年级" };
    },
    () => {
      const divisor = randomInt(2, 12);
      const quotient = randomInt(2, 12);
      return { text: `${divisor * quotient} ÷ ${divisor} = ?`, answer: quotient, level: "小学二年级" };
    },
    () => {
      const a = randomInt(2, 18);
      const b = randomInt(2, 18);
      const c = randomInt(2, 8);
      const d = randomInt(1, 30);
      return { text: `(${a} + ${b}) × ${c} - ${d} = ?`, answer: (a + b) * c - d, level: "小学高年级" };
    },
    () => {
      const denominator = choice([3, 4, 5, 6, 8, 10]);
      const a = randomInt(1, denominator - 1);
      const b = randomInt(1, denominator - 1);
      return {
        text: `${a}/${denominator} + ${b}/${denominator} = ?`,
        answer: (a + b) / denominator,
        level: "分数计算",
        hint: `可填 ${fractionText(a + b, denominator)} 或小数`,
      };
    },
    () => {
      const x = randomInt(-9, 9);
      const m = randomInt(2, 9);
      const b = randomInt(-12, 12);
      return { text: `解 x：${m}x ${b >= 0 ? "+" : "-"} ${Math.abs(b)} = ${m * x + b}`, answer: x, level: "初中方程" };
    },
    () => {
      const n = randomInt(3, 15);
      const a = randomInt(2, 8);
      return { text: `√${n * n} + ${a}² = ?`, answer: n + a * a, level: "初中代数" };
    },
    () => {
      const a = randomInt(1, 4);
      const b = randomInt(-5, 5);
      const c = randomInt(-8, 8);
      const x = randomInt(-3, 4);
      return {
        text: `若 f(x) = ${a}x³ ${b >= 0 ? "+" : "-"} ${Math.abs(b)}x² ${c >= 0 ? "+" : "-"} ${Math.abs(c)}x，求 f'(${x})`,
        answer: 3 * a * x * x + 2 * b * x + c,
        level: "高等数学：导数",
      };
    },
    () => {
      const a = choice([2, 4, 6]);
      const b = randomInt(-5, 8);
      const upper = randomInt(1, 6);
      return {
        text: `计算 ∫₀^${upper} (${a}x ${b >= 0 ? "+" : "-"} ${Math.abs(b)}) dx`,
        answer: roundAnswer((a * upper * upper) / 2 + b * upper),
        level: "高等数学：定积分",
      };
    },
  ];

  const question = choice(templates)();
  return {
    id: `${Date.now()}-${round}-${randomInt(1000, 9999)}`,
    text: question.hint ? `${question.text}（${question.hint}）` : question.text,
    level: question.level,
    answer: roundAnswer(question.answer),
  };
}

function parseAnswer(value) {
  const input = String(value || "").trim().replaceAll("，", ".").replace(/\s/g, "");
  if (!input) {
    return null;
  }

  const fraction = input.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return null;
    }
    return numerator / denominator;
  }

  const number = Number(input);
  return Number.isFinite(number) ? number : null;
}

function isCorrectAnswer(input, expected) {
  const answer = parseAnswer(input);
  if (answer === null) {
    return false;
  }
  return Math.abs(answer - expected) <= 0.000001;
}

function scheduleRoundTimeout(room) {
  clearGameTimers({ timer: room.game.timer, nextTimer: null });
  const questionId = room.game.question?.id;
  const waitMs = Math.max(0, room.game.deadlineAt - Date.now());
  room.game.timer = setTimeout(() => {
    if (room.game.status !== "playing" || room.game.question?.id !== questionId) {
      return;
    }
    finishRound(room, {
      type: "timeout",
      message: "时间到，无人得分。",
      answer: room.game.question.answer,
    });
  }, waitMs);
}

function startMathGame(room) {
  clearGameTimers(room.game);
  room.game.status = "playing";
  room.game.round = 0;
  room.game.lastResult = null;
  room.game.scores = Object.fromEntries(room.players.map((player) => [player.id, 0]));
  nextQuestion(room);
}

function nextQuestion(room) {
  clearGameTimers(room.game);
  room.game.status = "playing";
  room.game.round += 1;
  room.game.question = generateMathQuestion(room.game.round);
  room.game.deadlineAt = Date.now() + ROUND_MS;
  room.game.lastResult = null;
  scheduleRoundTimeout(room);
  broadcast(room);
}

function finishRound(room, result) {
  clearGameTimers(room.game);
  room.game.status = "between";
  room.game.lastResult = result;
  room.game.deadlineAt = null;
  broadcast(room);
  room.game.nextTimer = setTimeout(() => nextQuestion(room), NEXT_ROUND_DELAY_MS);
}

function emptyGomokuBoard() {
  return Array.from({ length: GOMOKU_SIZE }, () => Array.from({ length: GOMOKU_SIZE }, () => ""));
}

function startGomokuGame(room) {
  clearGameTimers(room.game);
  room.game.status = "playing";
  room.game.round = 0;
  room.game.question = null;
  room.game.deadlineAt = null;
  room.game.scores = {};
  room.game.lastResult = null;
  room.game.board = emptyGomokuBoard();
  room.game.moves = [];
  room.game.currentPlayerId = room.players[0].id;
  room.game.winnerId = null;
  room.game.pendingUndo = null;
  room.game.chatBubbles = [];
  room.game.cameraFrame = null;
  room.game.message = `${room.players[0].name} 执黑先手。`;
  broadcast(room);
}

function playerStone(room, playerId) {
  const index = room.players.findIndex((player) => player.id === playerId);
  return index === 0 ? "black" : index === 1 ? "white" : "";
}

function nextGomokuPlayerId(room, playerId) {
  return room.players.find((player) => player.id !== playerId)?.id || playerId;
}

function countDirection(board, row, col, stone, rowStep, colStep) {
  let count = 0;
  let r = row + rowStep;
  let c = col + colStep;
  while (r >= 0 && r < GOMOKU_SIZE && c >= 0 && c < GOMOKU_SIZE && board[r][c] === stone) {
    count += 1;
    r += rowStep;
    c += colStep;
  }
  return count;
}

function hasFiveInRow(board, row, col, stone) {
  return [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ].some(([rowStep, colStep]) => {
    const total = 1 + countDirection(board, row, col, stone, rowStep, colStep) + countDirection(board, row, col, stone, -rowStep, -colStep);
    return total >= 5;
  });
}

function playGomokuMove(room, player, row, col) {
  if (room.game.status !== "playing") {
    throw new Error("五子棋还没有开始。");
  }
  if (room.game.winnerId) {
    throw new Error("本局已经结束。");
  }
  if (room.game.pendingUndo) {
    throw new Error("正在处理悔棋申请，请稍等。");
  }
  if (room.game.currentPlayerId !== player.id) {
    throw new Error("还没轮到你落子。");
  }
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= GOMOKU_SIZE || col < 0 || col >= GOMOKU_SIZE) {
    throw new Error("落子位置不正确。");
  }
  if (room.game.board[row][col]) {
    throw new Error("这里已经有棋子了。");
  }

  const stone = playerStone(room, player.id);
  room.game.board[row][col] = stone;
  room.game.moves.push({ row, col, playerId: player.id, stone });

  if (hasFiveInRow(room.game.board, row, col, stone)) {
    room.game.status = "finished";
    room.game.winnerId = player.id;
    room.game.message = `${player.name} 连成五子，获胜。`;
    return;
  }

  if (room.game.moves.length === GOMOKU_SIZE * GOMOKU_SIZE) {
    room.game.status = "finished";
    room.game.message = "棋盘已满，本局平局。";
    return;
  }

  room.game.currentPlayerId = nextGomokuPlayerId(room, player.id);
  const nextPlayer = room.players.find((item) => item.id === room.game.currentPlayerId);
  room.game.message = `轮到 ${nextPlayer?.name || "下一位玩家"} 落子。`;
}

function requestUndo(room, player) {
  if (room.game.status !== "playing") {
    throw new Error("只有对局中才能申请悔棋。");
  }
  if (room.game.pendingUndo) {
    throw new Error("已经有一个悔棋申请在处理中。");
  }
  const lastMove = room.game.moves.at(-1);
  if (!lastMove) {
    throw new Error("还没有可悔棋的落子。");
  }
  if (lastMove.playerId !== player.id) {
    throw new Error("只能在自己刚落子后申请悔棋。");
  }
  const opponent = room.players.find((item) => item.id !== player.id);
  room.game.pendingUndo = {
    requesterId: player.id,
    opponentId: opponent?.id || "",
    status: "choosing",
    condition: null,
    phrase: "",
  };
  room.game.message = `${player.name} 申请悔棋，等待对方选择条件。`;
}

function chooseUndoCondition(room, player, condition, phrase) {
  const pending = room.game.pendingUndo;
  if (!pending || pending.status !== "choosing") {
    throw new Error("当前没有等待选择的悔棋申请。");
  }
  if (pending.opponentId !== player.id) {
    throw new Error("只有被申请方可以选择悔棋条件。");
  }
  if (condition === "camera") {
    pending.condition = "camera";
    pending.status = "waiting-camera";
    room.game.message = "对方要求申请者打开摄像头 10 秒后悔棋。";
    return;
  }
  if (condition === "phrase") {
    const cleanPhrase = String(phrase || "").trim().slice(0, 40);
    if (!cleanPhrase) {
      throw new Error("请填写要让对方输入的文字。");
    }
    pending.condition = "phrase";
    pending.status = "waiting-phrase";
    pending.phrase = cleanPhrase;
    room.game.message = "对方设置了文字挑战，申请者输入指定文字后悔棋。";
    return;
  }
  throw new Error("悔棋条件不正确。");
}

function completeUndo(room, player, proof) {
  const pending = room.game.pendingUndo;
  if (!pending || !["waiting-camera", "waiting-phrase"].includes(pending.status)) {
    throw new Error("当前没有可完成的悔棋条件。");
  }
  if (pending.requesterId !== player.id) {
    throw new Error("只有申请悔棋的一方可以完成条件。");
  }
  if (pending.condition === "phrase" && String(proof || "").trim() !== pending.phrase) {
    throw new Error("输入的文字不一致。");
  }
  if (pending.condition === "phrase") {
    addChatBubble(room, player, String(proof || "").trim());
  }

  const lastMove = room.game.moves.pop();
  if (!lastMove || lastMove.playerId !== player.id) {
    room.game.pendingUndo = null;
    throw new Error("悔棋失败，最近一步已变化。");
  }
  room.game.board[lastMove.row][lastMove.col] = "";
  room.game.currentPlayerId = player.id;
  room.game.pendingUndo = null;
  room.game.cameraFrame = null;
  room.game.message = `${player.name} 已完成条件，成功悔棋。`;
}

function validatePayload(payload) {
  if (!/^\d{4}$/.test(payload.roomCode || "")) {
    throw new Error("房间号必须是 4 位数字");
  }
  if (!payload.playerId) {
    throw new Error("缺少玩家 ID");
  }
  return {
    roomCode: payload.roomCode,
    gameId: payload.gameId,
    playerId: String(payload.playerId),
    playerName: String(payload.playerName || "玩家").slice(0, 12),
    playerAvatar: validateAvatarData(payload.playerAvatar || ""),
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      rooms: rooms.size,
      dataDir,
      accountStore,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    const account = await registerAccount(await readBody(request));
    sendJson(response, 200, { account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const account = await loginAccount(await readBody(request));
    sendJson(response, 200, { account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/avatar") {
    const account = await updateAvatar(await readBody(request));
    sendJson(response, 200, { account });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rooms/create") {
    const payload = validatePayload(await readBody(request));
    if (!/^[1-5]$/.test(payload.gameId || "")) {
      sendJson(response, 400, { error: "游戏序号必须是 1 到 5" });
      return;
    }
    if (rooms.has(payload.roomCode)) {
      sendJson(response, 409, { error: "这个房间号已存在，请换一个。" });
      return;
    }
    const room = { roomCode: payload.roomCode, gameId: payload.gameId, players: [], clients: new Set(), game: createGameState() };
    upsertPlayer(room, payload.playerId, payload.playerName, payload.playerAvatar);
    rooms.set(payload.roomCode, room);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/rooms/join") {
    const payload = validatePayload(await readBody(request));
    const room = rooms.get(payload.roomCode);
    if (!room) {
      sendJson(response, 404, { error: "没有找到这个房间，请先创建。" });
      return;
    }
    if (payload.gameId && room.gameId !== payload.gameId) {
      sendJson(response, 409, { error: "游戏序号和房间不匹配。" });
      return;
    }
    upsertPlayer(room, payload.playerId, payload.playerName, payload.playerAvatar);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const readyMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/ready$/);
  if (request.method === "POST" && readyMatch) {
    const room = rooms.get(readyMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    player.ready = Boolean(payload.ready);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const startMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/start$/);
  if (request.method === "POST" && startMatch) {
    const room = rooms.get(startMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (!["1", "2"].includes(room.gameId)) {
      sendJson(response, 400, { error: "当前只接入了游戏 1 和游戏 2。" });
      return;
    }
    if (room.players.length !== 2 || !room.players.every((item) => item.ready)) {
      sendJson(response, 400, { error: "需要两位玩家都准备后才能开始。" });
      return;
    }
    if (room.gameId === "1") {
      startMathGame(room);
    } else {
      startGomokuGame(room);
    }
    sendJson(response, 200, publicRoom(room));
    return;
  }

  const moveMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/move$/);
  if (request.method === "POST" && moveMatch) {
    const room = rooms.get(moveMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前房间不是五子棋。" });
      return;
    }
    playGomokuMove(room, player, Number(payload.row), Number(payload.col));
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const undoRequestMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/undo\/request$/);
  if (request.method === "POST" && undoRequestMatch) {
    const room = rooms.get(undoRequestMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前房间不是五子棋。" });
      return;
    }
    requestUndo(room, player);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const undoChooseMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/undo\/choose$/);
  if (request.method === "POST" && undoChooseMatch) {
    const room = rooms.get(undoChooseMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前房间不是五子棋。" });
      return;
    }
    chooseUndoCondition(room, player, payload.condition, payload.phrase);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const undoCompleteMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/undo\/complete$/);
  if (request.method === "POST" && undoCompleteMatch) {
    const room = rooms.get(undoCompleteMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前房间不是五子棋。" });
      return;
    }
    completeUndo(room, player, payload.proof);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const chatMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/chat$/);
  if (request.method === "POST" && chatMatch) {
    const room = rooms.get(chatMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前只有五子棋支持聊天气泡。" });
      return;
    }
    addChatBubble(room, player, payload.text);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const cameraFrameMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/camera-frame$/);
  if (request.method === "POST" && cameraFrameMatch) {
    const room = rooms.get(cameraFrameMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "2") {
      sendJson(response, 400, { error: "当前房间不是五子棋。" });
      return;
    }
    updateCameraFrame(room, player, payload.frame);
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
    return;
  }

  const answerMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/answer$/);
  if (request.method === "POST" && answerMatch) {
    const room = rooms.get(answerMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "1" || !room.game?.question) {
      sendJson(response, 400, { error: "数学游戏还没有开始。" });
      return;
    }
    if (room.game.status !== "playing") {
      sendJson(response, 400, { error: "正在进入下一题，请稍等。" });
      return;
    }
    if (Date.now() > room.game.deadlineAt) {
      finishRound(room, {
        type: "timeout",
        message: "时间到，无人得分。",
        answer: room.game.question.answer,
      });
      sendJson(response, 200, publicRoom(room));
      return;
    }

    const opponent = room.players.find((item) => item.id !== player.id);
    const correct = isCorrectAnswer(payload.answer, room.game.question.answer);
    if (correct) {
      room.game.scores[player.id] = (room.game.scores[player.id] || 0) + 1;
      finishRound(room, {
        type: "correct",
        message: `${player.name} 答对了，获得 1 分。`,
        playerId: player.id,
        answer: room.game.question.answer,
      });
    } else {
      if (opponent) {
        room.game.scores[opponent.id] = (room.game.scores[opponent.id] || 0) + 1;
      }
      finishRound(room, {
        type: "wrong",
        message: opponent ? `${player.name} 答错了，${opponent.name} 获得 1 分。` : `${player.name} 答错了。`,
        playerId: player.id,
        answer: room.game.question.answer,
      });
    }
    sendJson(response, 200, publicRoom(room));
    return;
  }

  const leaveMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/leave$/);
  if (request.method === "POST" && leaveMatch) {
    const room = rooms.get(leaveMatch[1]);
    const payload = await readBody(request);
    if (room) {
      room.players = room.players.filter((player) => player.id !== payload.playerId);
      if (room.players.length === 0) {
        clearGameTimers(room.game);
        rooms.delete(room.roomCode);
      } else {
        broadcast(room);
      }
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const room = rooms.get(eventsMatch[1]);
    if (!room) {
      sendJson(response, 404, { error: "房间不存在。" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);
    room.clients.add(response);
    request.on("close", () => {
      room.clients.delete(response);
    });
    return;
  }

  sendJson(response, 404, { error: "接口不存在。" });
}

function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = normalize(join(root, requestedPath));
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || relativePath === "" || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url).catch((error) => {
      sendJson(response, 400, { error: error.message });
    });
    return;
  }
  serveStatic(request, response, url);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`刷双人小游戏房间框架已启动：http://localhost:${port}`);
});
