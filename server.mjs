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
const MATH_TARGET_SCORE = 10;
const MATH_REVIEW_AUTO_NEXT_MS = 30000;
const MATH_EXPLANATION_SHOW_MS = 10000;
const MATH_NO_EXPLANATION_DELAY_MS = 1600;
const MATH_SUBJECTS = {
  linear: "线性代数",
  calculus: "高等数学",
};
const MATH_DIFFICULTIES = {
  easy: { label: "简单", roundMs: 2 * 60 * 1000 },
  medium: { label: "中等", roundMs: 5 * 60 * 1000 },
  hard: { label: "难", roundMs: 10 * 60 * 1000 },
  contest: { label: "竞赛题", roundMs: 20 * 60 * 1000 },
};
const GOMOKU_SIZE = 25;
const GOMOKU_TURN_MS = 4 * 60 * 1000;
const RACE_TARGET_LAPS = 8;
const RACE_LIMIT_MS = 5 * 60 * 1000;
const CHAT_BUBBLE_MS = 6000;
const CAMERA_FRAME_MS = 1400;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
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
  if (room.gameId === "3" && room.game?.status === "playing") {
    updateRaceRoom(room);
  }
  const game = room.game
    ? {
        status: room.game.status,
        round: room.game.round,
        deadlineAt: room.game.deadlineAt,
        question: room.game.question
          ? {
              id: room.game.question.id,
              text: room.game.question.text,
              html: room.game.question.html,
              level: room.game.question.level,
              type: room.game.question.type || "input",
              choices: room.game.question.choices || [],
            }
          : null,
        scores: Object.fromEntries(room.players.map((player) => [player.id, room.game.scores[player.id] || 0])),
        targetScore: room.game.targetScore || null,
        mathSettings: room.game.mathSettings ? publicMathSettings(room.game.mathSettings) : null,
        roundMs: room.game.roundMs || null,
        explanationVotes: room.game.explanationVotes || {},
        showExplanation: Boolean(room.game.showExplanation),
        lastResult: room.game.lastResult,
        board: room.game.board || null,
        currentPlayerId: room.game.currentPlayerId || null,
        turnDeadlineAt: room.game.turnDeadlineAt || null,
        winnerId: room.game.winnerId || null,
        winnerName: room.game.winnerId ? room.players.find((player) => player.id === room.game.winnerId)?.name || "" : "",
        moves: room.game.moves || [],
        pendingUndo: room.game.pendingUndo || null,
        message: room.game.message || "",
        chatBubbles: room.game.chatBubbles || [],
        cameraFrame: room.game.cameraFrame || null,
        race: room.game.race || null,
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
    mathSettings: normalizeMathSettings(),
    roundMs: MATH_DIFFICULTIES.easy.roundMs,
    explanationVotes: {},
    showExplanation: false,
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

function signedTerm(value, variable = "") {
  const sign = value >= 0 ? "+" : "−";
  return `${sign} ${Math.abs(value)}${variable}`;
}

function signedTermHtml(value, variable = "") {
  const sign = value >= 0 ? "+" : "−";
  return `<span class="math-sign">${sign}</span> ${Math.abs(value)}${variable}`;
}

function fractionHtml(numerator, denominator) {
  return `<span class="math-frac"><span>${numerator}</span><span>${denominator}</span></span>`;
}

function mathHtml(content) {
  return `<span class="math-expression">${content}</span>`;
}

function normalizeMathSettings(settings = {}) {
  const subject = MATH_SUBJECTS[settings.subject] ? settings.subject : "calculus";
  const difficulty = MATH_DIFFICULTIES[settings.difficulty] ? settings.difficulty : "easy";
  return { subject, difficulty };
}

function publicMathSettings(settings = {}) {
  const normalized = normalizeMathSettings(settings);
  const difficulty = MATH_DIFFICULTIES[normalized.difficulty];
  return {
    ...normalized,
    subjectLabel: MATH_SUBJECTS[normalized.subject],
    difficultyLabel: difficulty.label,
    roundMs: difficulty.roundMs,
  };
}

function buildMathQuestion(round, settings, question) {
  const publicSettings = publicMathSettings(settings);
  return {
    id: `${Date.now()}-${round}-${randomInt(1000, 9999)}`,
    text: question.text,
    html: question.html || mathHtml(question.text),
    level: `${publicSettings.subjectLabel} · ${publicSettings.difficultyLabel}`,
    type: question.type || "input",
    choices: question.choices || [],
    answer: question.answer,
    answerLabel: question.answerLabel ?? String(question.answer),
    explanation: question.explanation || "本题解析待补充。",
  };
}

function generateMathQuestion(round, settings = {}) {
  const normalized = normalizeMathSettings(settings);
  const pools = {
    linear: {
      easy: [
        () => {
          const a = randomInt(1, 5);
          const b = randomInt(-4, 4);
          const c = randomInt(-4, 4);
          const d = randomInt(1, 5);
          const answer = a * d - b * c;
          return {
            text: `线性变换 T 的矩阵为 A = [[${a}, ${b}], [${c}, ${d}]]。单位正方形经 T 变换后的有向面积是多少？`,
            html: mathHtml(`线性变换 T 的矩阵为 A = ${matrixHtml([[a, b], [c, d]])}。单位正方形经 T 变换后的有向面积是多少？`),
            answer,
            explanation: `二维线性变换对有向面积的缩放倍数等于 det(A)，所以答案为 ${a}×${d} - ${b}×${c} = ${answer}。`,
          };
        },
        () => {
          const x = randomInt(-3, 5);
          const y = randomInt(-3, 5);
          const p = x + y;
          const q = x - y;
          return {
            text: `向量 v = (x,y) 同时满足 x + y = ${p}，x - y = ${q}。求 x 的值。`,
            html: mathHtml(`向量 v = (x,y) 同时满足 x + y = ${p}，x - y = ${q}。求 x 的值。`),
            answer: x,
            explanation: `两式相加得 2x = ${p + q}，因此 x = ${x}。`,
          };
        },
      ],
      medium: [
        () => {
          const a = randomInt(1, 4);
          const b = randomInt(1, 4);
          const answer = a * a + b * b;
          return {
            text: `设 A = diag(${a}, ${b})，一个系统先作用 A 再作用 A。求复合变换矩阵 A² 的迹。`,
            html: mathHtml(`设 A = diag(${a}, ${b})，一个系统先作用 A 再作用 A。求复合变换矩阵 A<sup>2</sup> 的迹。`),
            answer,
            explanation: `A² = diag(${a * a}, ${b * b})，迹为对角元之和 ${a * a} + ${b * b} = ${answer}。`,
          };
        },
        () => {
          const m = randomInt(1, 4);
          const n = randomInt(1, 4);
          return {
            text: `在基 B = {(1,1),(1,-1)} 下，向量 v = (${m + n}, ${m - n})。求 v 的第一坐标。`,
            html: mathHtml(`在基 B = {(1,1),(1,-1)} 下，向量 v = (${m + n}, ${m - n})。求 v 的第一坐标。`),
            answer: m,
            explanation: `若 v = α(1,1)+β(1,-1)，则 v = (α+β, α-β)。对照可得 α = ${m}。`,
          };
        },
      ],
      hard: [
        () => ({
          type: "choice",
          text: "设 A 为 3 阶矩阵，特征值为 1, 1, 2，且 dim E_1 = 1。下面哪项正确？",
          html: mathHtml("设 A 为 3 阶矩阵，特征值为 1, 1, 2，且 dim E<sub>1</sub> = 1。下面哪项正确？"),
          choices: [
            { value: "A", label: "A 一定可对角化" },
            { value: "B", label: "A 不可对角化" },
            { value: "C", label: "A 一定是对称矩阵" },
            { value: "D", label: "A 的行列式为 1" },
          ],
          answer: "B",
          answerLabel: "B",
          explanation: "特征值 1 的代数重数为 2，但对应特征空间维数只有 1，特征向量总数不足 3 个，因此不可对角化。",
        }),
        () => ({
          type: "choice",
          text: "设 A 是 n 阶实矩阵且 A² = 0。以下哪项必然成立？",
          html: mathHtml("设 A 是 n 阶实矩阵且 A<sup>2</sup> = 0。以下哪项必然成立？"),
          choices: [
            { value: "A", label: "A 的所有特征值都是 0" },
            { value: "B", label: "A 一定是零矩阵" },
            { value: "C", label: "A 一定可逆" },
            { value: "D", label: "det(A) = 1" },
          ],
          answer: "A",
          answerLabel: "A",
          explanation: "若 λ 是 A 的特征值，则 λ² 是 A² 的特征值。A² = 0，所以 λ² = 0，故 λ = 0。",
        }),
      ],
      contest: [
        () => ({
          type: "choice",
          text: "设 A 为 n 阶幂等矩阵 A² = A，rank(A)=r。以下哪项必然正确？",
          html: mathHtml("设 A 为 n 阶幂等矩阵 A<sup>2</sup> = A，rank(A)=r。以下哪项必然正确？"),
          choices: [
            { value: "A", label: "tr(A)=n-r" },
            { value: "B", label: "tr(A)=0" },
            { value: "C", label: "tr(A)=r" },
            { value: "D", label: "det(A)=r" },
          ],
          answer: "C",
          answerLabel: "C",
          explanation: "幂等矩阵的特征值只能是 0 或 1，rank(A) 等于非零特征值个数，因此 tr(A)=r。",
        }),
      ],
    },
    calculus: {
      easy: [
        () => {
          const a = randomInt(1, 4);
          const b = randomInt(1, 6);
          const x = randomInt(1, 4);
          const answer = 2 * a * x + b;
          return {
            text: `某曲线位置函数为 f(x) = ${a}x² + ${b}x。求 x = ${x} 时的瞬时变化率。`,
            html: mathHtml(`某曲线位置函数为 f(x) = ${a}x<sup>2</sup> + ${b}x。求 x = ${x} 时的瞬时变化率。`),
            answer,
            explanation: `瞬时变化率是导数。f′(x) = ${2 * a}x + ${b}，代入 x=${x} 得 ${answer}。`,
          };
        },
        () => {
          const upper = randomInt(2, 6);
          const answer = fractionText(upper * upper, 2 * upper);
          return {
            text: `函数 f(x)=x 在区间 [0, ${upper}] 上的平均值是多少？`,
            html: mathHtml(`函数 f(x)=x 在区间 [0, ${upper}] 上的平均值是多少？`),
            answer,
            answerLabel: answer,
            explanation: `平均值为 1/${upper} × ∫_0^${upper} x dx = 1/${upper} × ${upper * upper}/2 = ${answer}。`,
          };
        },
      ],
      medium: [
        () => ({
          text: "区域由 y = x 与 y = x² 在 [0,1] 上围成。求该区域面积。",
          html: mathHtml("区域由 y = x 与 y = x<sup>2</sup> 在 [0,1] 上围成。求该区域面积。"),
          answer: "1/6",
          answerLabel: "1/6",
          explanation: "面积为 ∫_0^1 (x - x²) dx = 1/2 - 1/3 = 1/6。",
        }),
        () => {
          const a = randomInt(2, 6);
          return {
            text: `若 f(x)=e^(${a}x)，其 Maclaurin 展开式中 x² 项系数是多少？`,
            html: mathHtml(`若 f(x)=e<sup>${a}x</sup>，其 Maclaurin 展开式中 x<sup>2</sup> 项系数是多少？`),
            answer: fractionText(a * a, 2),
            answerLabel: fractionText(a * a, 2),
            explanation: `e^(${a}x)=1+${a}x+(${a}x)²/2!+...，所以 x² 项系数为 ${a * a}/2。`,
          };
        },
      ],
      hard: [
        () => ({
          type: "choice",
          text: "关于广义积分 ∫_1^∞ 1/x^p dx，下列哪项正确？",
          html: mathHtml(`关于广义积分 ∫<sub>1</sub><sup>∞</sup> ${fractionHtml("1", "x<sup>p</sup>")} dx，下列哪项正确？`),
          choices: [
            { value: "A", label: "p > 1 时收敛" },
            { value: "B", label: "p ≥ 0 时收敛" },
            { value: "C", label: "p < 1 时收敛" },
            { value: "D", label: "所有 p 都发散" },
          ],
          answer: "A",
          answerLabel: "A",
          explanation: "p 积分判别法：∫_1^∞ 1/x^p dx 当且仅当 p > 1 时收敛。",
        }),
        () => ({
          type: "choice",
          text: "函数 f(x,y)=x²+y² 在约束 x+y=2 下的最小值是多少？",
          html: mathHtml("函数 f(x,y)=x<sup>2</sup>+y<sup>2</sup> 在约束 x+y=2 下的最小值是多少？"),
          choices: [
            { value: "A", label: "1" },
            { value: "B", label: "2" },
            { value: "C", label: "4" },
            { value: "D", label: "不存在" },
          ],
          answer: "B",
          answerLabel: "B",
          explanation: "由对称性或拉格朗日乘子可得 x=y=1，最小值为 1²+1²=2。",
        }),
      ],
      contest: [
        () => ({
          type: "choice",
          text: "设 f 在 0 附近二阶可导，且 f(0)=0, f′(0)=0, f″(0)=6。lim_{x→0} f(x)/x² 等于多少？",
          html: mathHtml(`设 f 在 0 附近二阶可导，且 f(0)=0, f′(0)=0, f″(0)=6。lim<sub>x→0</sub> ${fractionHtml("f(x)", "x<sup>2</sup>")} 等于多少？`),
          choices: [
            { value: "A", label: "0" },
            { value: "B", label: "3" },
            { value: "C", label: "6" },
            { value: "D", label: "不存在" },
          ],
          answer: "B",
          answerLabel: "B",
          explanation: "二阶 Taylor 展开：f(x)=f″(0)x²/2+o(x²)=3x²+o(x²)，极限为 3。",
        }),
      ],
    },
  };

  const pool = pools[normalized.subject][normalized.difficulty];
  return buildMathQuestion(round, normalized, choice(pool)());
}

function matrixHtml(rows) {
  return `<span class="math-matrix">${rows.map((row) => `<span>${row.join("&nbsp;&nbsp;")}</span>`).join("")}</span>`;
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

function isCorrectAnswer(input, question) {
  if (question?.type === "choice") {
    return String(input || "").trim().toUpperCase() === String(question.answer || "").trim().toUpperCase();
  }

  const answer = parseAnswer(input);
  const expected = parseAnswer(question?.answer ?? question);
  if (answer === null) {
    return false;
  }
  if (expected === null) {
    return false;
  }
  return Math.abs(answer - expected) <= 0.000001;
}

function withMathResultDetails(room, result) {
  const question = room.game.question || {};
  return {
    ...result,
    answer: question.answerLabel ?? question.answer,
    explanation: question.explanation || "",
  };
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
    });
  }, waitMs);
}

function startMathGame(room) {
  clearGameTimers(room.game);
  room.game.status = "playing";
  room.game.round = 0;
  room.game.lastResult = null;
  room.game.targetScore = MATH_TARGET_SCORE;
  room.game.winnerId = null;
  room.game.mathSettings = normalizeMathSettings(room.game.mathSettings);
  room.game.roundMs = publicMathSettings(room.game.mathSettings).roundMs;
  room.game.explanationVotes = {};
  room.game.showExplanation = false;
  room.game.scores = Object.fromEntries(room.players.map((player) => [player.id, 0]));
  nextQuestion(room);
}

function nextQuestion(room) {
  clearGameTimers(room.game);
  room.game.status = "playing";
  room.game.round += 1;
  room.game.mathSettings = normalizeMathSettings(room.game.mathSettings);
  room.game.roundMs = publicMathSettings(room.game.mathSettings).roundMs;
  room.game.question = generateMathQuestion(room.game.round, room.game.mathSettings);
  room.game.deadlineAt = Date.now() + room.game.roundMs;
  room.game.lastResult = null;
  room.game.explanationVotes = {};
  room.game.showExplanation = false;
  scheduleRoundTimeout(room);
  broadcast(room);
}

function finishRound(room, result) {
  clearGameTimers(room.game);
  room.game.status = "review";
  room.game.lastResult = withMathResultDetails(room, result);
  room.game.deadlineAt = null;
  room.game.explanationVotes = {};
  room.game.showExplanation = false;
  broadcast(room);
  room.game.nextTimer = setTimeout(() => nextQuestion(room), MATH_REVIEW_AUTO_NEXT_MS);
}

function finishMathGame(room, winner, result) {
  clearGameTimers(room.game);
  room.game.status = "finished";
  room.game.winnerId = winner.id;
  room.game.deadlineAt = null;
  room.game.lastResult = withMathResultDetails(room, {
    ...result,
    type: "finished",
    winnerId: winner.id,
    message: `${winner.name} 先得到 ${MATH_TARGET_SCORE} 分，获得本局胜利。`,
  });
  room.game.explanationVotes = {};
  room.game.showExplanation = false;
  broadcast(room);
}

function voteMathExplanation(room, player, vote) {
  if (room.gameId !== "1" || !["review", "finished"].includes(room.game.status) || !room.game.lastResult) {
    throw new Error("现在还不能选择是否查看解析。");
  }

  const normalizedVote = vote === "yes" ? "yes" : "no";
  room.game.explanationVotes = room.game.explanationVotes || {};
  room.game.explanationVotes[player.id] = normalizedVote;

  const eligiblePlayers = room.players.slice(0, 2);
  const allVoted = eligiblePlayers.length === 2 && eligiblePlayers.every((item) => room.game.explanationVotes[item.id]);
  if (!allVoted) {
    return;
  }

  if (room.game.nextTimer) {
    clearTimeout(room.game.nextTimer);
    room.game.nextTimer = null;
  }

  const bothYes = eligiblePlayers.every((item) => room.game.explanationVotes[item.id] === "yes");
  room.game.showExplanation = bothYes;
  if (room.game.status === "review") {
    const delay = bothYes ? MATH_EXPLANATION_SHOW_MS : MATH_NO_EXPLANATION_DELAY_MS;
    room.game.nextTimer = setTimeout(() => nextQuestion(room), delay);
  }
}

function createRaceCar(player, index) {
  return {
    playerId: player.id,
    name: player.name,
    lane: index === 0 ? -0.24 : 0.24,
    speed: 0,
    distance: 0,
    heading: 0,
    nitro: 1,
    controls: {},
    lastUpdateAt: Date.now(),
  };
}

function startRaceGame(room) {
  clearGameTimers(room.game);
  const now = Date.now();
  room.game.status = "playing";
  room.game.round = 0;
  room.game.question = null;
  room.game.deadlineAt = now + RACE_LIMIT_MS;
  room.game.raceDeadlineAt = now + RACE_LIMIT_MS;
  room.game.lastResult = null;
  room.game.winnerId = null;
  room.game.message = "红灯熄灭，比赛开始。";
  room.game.race = {
    targetLaps: RACE_TARGET_LAPS,
    startedAt: now,
    deadlineAt: now + RACE_LIMIT_MS,
    racers: Object.fromEntries(room.players.map((player, index) => [player.id, createRaceCar(player, index)])),
  };
  room.game.timer = setTimeout(() => finishRaceByTime(room), RACE_LIMIT_MS);
  broadcast(room);
}

function updateRaceRoom(room) {
  const race = room.game?.race;
  if (!race || room.game.status !== "playing") {
    return;
  }
  const now = Date.now();
  Object.values(race.racers).forEach((car) => {
    const dt = Math.min(0.28, Math.max(0, (now - (car.lastUpdateAt || now)) / 1000));
    car.lastUpdateAt = now;
    if (!dt) {
      return;
    }
    const controls = car.controls || {};
    const steer = (controls.d ? 1 : 0) - (controls.a ? 1 : 0);
    let acceleration = controls.w ? 0.023 : -0.006;
    if (controls.s) {
      acceleration -= 0.038;
    }
    if (controls.space) {
      acceleration -= 0.02;
    }
    if (controls.shift && car.nitro > 0.02 && car.speed > 0.006) {
      acceleration += 0.032;
      car.nitro = Math.max(0, car.nitro - dt * 0.26);
    } else {
      car.nitro = Math.min(1, car.nitro + dt * 0.055);
    }
    const maxSpeed = controls.shift && car.nitro > 0 ? 0.058 : 0.044;
    car.speed = Math.max(0, Math.min(maxSpeed, car.speed + acceleration * dt));
    car.speed *= controls.space ? 0.965 : 0.992;
    car.lane = Math.max(-1, Math.min(1, car.lane + steer * dt * (controls.space ? 1.7 : 0.82)));
    car.heading = steer * (controls.space ? 18 : 10) - car.lane * 4;
    car.distance += car.speed * dt * (1 - Math.abs(car.lane) * 0.025);
  });
  const winnerCar = Object.values(race.racers).find((car) => car.distance >= RACE_TARGET_LAPS);
  if (winnerCar) {
    finishRace(room, winnerCar.playerId, `${winnerCar.name} 率先完成 ${RACE_TARGET_LAPS} 圈，获得胜利。`);
    return;
  }
  if (Date.now() >= race.deadlineAt) {
    finishRaceByTime(room);
  }
}

function finishRace(room, winnerId, message) {
  clearGameTimers(room.game);
  room.game.status = "finished";
  room.game.winnerId = winnerId || null;
  room.game.deadlineAt = null;
  room.game.raceDeadlineAt = null;
  room.game.message = message;
  room.game.lastResult = {
    type: "race-finished",
    winnerId: winnerId || null,
    message,
  };
  broadcast(room);
}

function finishRaceByTime(room) {
  if (!room.game?.race || room.game.status !== "playing") {
    return;
  }
  const racers = Object.values(room.game.race.racers);
  racers.sort((a, b) => b.distance - a.distance);
  const leader = racers[0];
  const tied = racers[1] && Math.abs(leader.distance - racers[1].distance) < 0.0001;
  finishRace(
    room,
    tied ? null : leader.playerId,
    tied ? "规定时间结束，双方距离相同，本局平局。" : `规定时间结束，${leader.name} 距离领先，获得胜利。`,
  );
}

function updateRaceControls(room, player, controls) {
  if (room.gameId !== "3" || room.game?.status !== "playing" || !room.game.race?.racers?.[player.id]) {
    throw new Error("赛车比赛还没有开始。");
  }
  updateRaceRoom(room);
  room.game.race.racers[player.id].controls = {
    w: Boolean(controls.w),
    s: Boolean(controls.s),
    a: Boolean(controls.a),
    d: Boolean(controls.d),
    space: Boolean(controls.space),
    shift: Boolean(controls.shift),
  };
  updateRaceRoom(room);
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
  room.game.turnDeadlineAt = Date.now() + GOMOKU_TURN_MS;
  room.game.winnerId = null;
  room.game.pendingUndo = null;
  room.game.chatBubbles = [];
  room.game.cameraFrame = null;
  room.game.message = `${room.players[0].name} 执黑先手。`;
  scheduleGomokuTurnTimeout(room);
  broadcast(room);
}

function finishGomokuByTimeout(room, timeoutPlayerId) {
  clearGameTimers(room.game);
  const winner = room.players.find((player) => player.id !== timeoutPlayerId);
  const timeoutPlayer = room.players.find((player) => player.id === timeoutPlayerId);
  room.game.status = "finished";
  room.game.winnerId = winner?.id || null;
  room.game.turnDeadlineAt = null;
  room.game.pendingUndo = null;
  room.game.message = winner
    ? `${timeoutPlayer?.name || "当前玩家"} 思考超过 4 分钟，${winner.name} 获胜。`
    : `${timeoutPlayer?.name || "当前玩家"} 思考超过 4 分钟，本局结束。`;
}

function scheduleGomokuTurnTimeout(room) {
  if (room.game.timer) {
    clearTimeout(room.game.timer);
    room.game.timer = null;
  }
  const playerId = room.game.currentPlayerId;
  const deadlineAt = room.game.turnDeadlineAt;
  if (room.game.status !== "playing" || room.game.pendingUndo || !playerId || !deadlineAt) {
    return;
  }
  room.game.timer = setTimeout(() => {
    if (room.game.status !== "playing" || room.game.pendingUndo || room.game.currentPlayerId !== playerId || room.game.turnDeadlineAt !== deadlineAt) {
      return;
    }
    finishGomokuByTimeout(room, playerId);
    broadcast(room);
  }, Math.max(0, deadlineAt - Date.now()));
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
  if (room.game.turnDeadlineAt && Date.now() > room.game.turnDeadlineAt) {
    finishGomokuByTimeout(room, player.id);
    return;
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
    clearGameTimers(room.game);
    room.game.status = "finished";
    room.game.winnerId = player.id;
    room.game.turnDeadlineAt = null;
    room.game.message = `${player.name} 连成五子，获胜。`;
    return;
  }

  if (room.game.moves.length === GOMOKU_SIZE * GOMOKU_SIZE) {
    clearGameTimers(room.game);
    room.game.status = "finished";
    room.game.turnDeadlineAt = null;
    room.game.message = "棋盘已满，本局平局。";
    return;
  }

  room.game.currentPlayerId = nextGomokuPlayerId(room, player.id);
  room.game.turnDeadlineAt = Date.now() + GOMOKU_TURN_MS;
  const nextPlayer = room.players.find((item) => item.id === room.game.currentPlayerId);
  room.game.message = `轮到 ${nextPlayer?.name || "下一位玩家"} 落子。`;
  scheduleGomokuTurnTimeout(room);
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
  if (room.game.timer) {
    clearTimeout(room.game.timer);
    room.game.timer = null;
  }
  room.game.turnDeadlineAt = null;
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
  room.game.turnDeadlineAt = Date.now() + GOMOKU_TURN_MS;
  room.game.pendingUndo = null;
  room.game.cameraFrame = null;
  room.game.message = `${player.name} 已完成条件，成功悔棋。`;
  scheduleGomokuTurnTimeout(room);
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
    mathSettings: normalizeMathSettings(payload.mathSettings || {}),
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
    if (payload.gameId === "1") {
      room.game.mathSettings = payload.mathSettings;
      room.game.roundMs = publicMathSettings(payload.mathSettings).roundMs;
    }
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
    if (!["1", "2", "3"].includes(room.gameId)) {
      sendJson(response, 400, { error: "当前只接入了游戏 1、游戏 2 和游戏 3。" });
      return;
    }
    if (room.players.length !== 2 || !room.players.every((item) => item.ready)) {
      sendJson(response, 400, { error: "需要两位玩家都准备后才能开始。" });
      return;
    }
    if (room.gameId === "1") {
      startMathGame(room);
    } else if (room.gameId === "2") {
      startGomokuGame(room);
    } else {
      startRaceGame(room);
    }
    sendJson(response, 200, publicRoom(room));
    return;
  }

  const raceControlMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/race-control$/);
  if (request.method === "POST" && raceControlMatch) {
    const room = rooms.get(raceControlMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "3") {
      sendJson(response, 400, { error: "当前房间不是赛车竞速。" });
      return;
    }
    updateRaceControls(room, player, payload.controls || {});
    sendJson(response, 200, publicRoom(room));
    broadcast(room);
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

  const explanationVoteMatch = url.pathname.match(/^\/api\/rooms\/(\d{4})\/explanation-vote$/);
  if (request.method === "POST" && explanationVoteMatch) {
    const room = rooms.get(explanationVoteMatch[1]);
    const payload = await readBody(request);
    const player = room?.players.find((item) => item.id === payload.playerId);
    if (!room || !player) {
      sendJson(response, 404, { error: "玩家不在房间中。" });
      return;
    }
    if (room.gameId !== "1") {
      sendJson(response, 400, { error: "当前房间不是数学竞赛。" });
      return;
    }
    voteMathExplanation(room, player, payload.vote);
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
      });
      sendJson(response, 200, publicRoom(room));
      return;
    }

    const opponent = room.players.find((item) => item.id !== player.id);
    const correct = isCorrectAnswer(payload.answer, room.game.question);
    if (correct) {
      room.game.scores[player.id] = (room.game.scores[player.id] || 0) + 1;
      const result = {
        type: "correct",
        message: `${player.name} 答对了，获得 1 分。`,
        playerId: player.id,
      };
      if (room.game.scores[player.id] >= MATH_TARGET_SCORE) {
        finishMathGame(room, player, result);
      } else {
        finishRound(room, result);
      }
    } else {
      if (opponent) {
        room.game.scores[opponent.id] = (room.game.scores[opponent.id] || 0) + 1;
      }
      const result = {
        type: "wrong",
        message: opponent ? `${player.name} 答错了，${opponent.name} 获得 1 分。` : `${player.name} 答错了。`,
        playerId: player.id,
      };
      if (opponent && room.game.scores[opponent.id] >= MATH_TARGET_SCORE) {
        finishMathGame(room, opponent, result);
      } else {
        finishRound(room, result);
      }
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
  console.log(`双人小游戏房间框架已启动：http://localhost:${port}`);
});
