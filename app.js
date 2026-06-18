const gameNames = {
  1: "游戏 1：数学计算能力",
  2: "游戏 2：五子棋对决",
  3: "游戏 3：待接入",
  4: "游戏 4：待接入",
  5: "游戏 5：待接入",
};

const params = new URLSearchParams(location.search);
const storedAccount = JSON.parse(sessionStorage.getItem("twoPlayer.account") || "null");
const rootStyle = document.documentElement.style;

const state = {
  account: storedAccount,
  playerId: storedAccount?.id || "",
  roomCode: "",
  gameId: "1",
  ready: false,
  events: null,
  currentQuestionId: null,
  countdown: null,
  cameraStream: null,
  transientTimer: null,
  lastRoom: null,
};

const authPanel = document.querySelector("#authPanel");
const authForm = document.querySelector("#authForm");
const accountId = document.querySelector("#accountId");
const accountPassword = document.querySelector("#accountPassword");
const authStatus = document.querySelector("#authStatus");
const setupPanel = document.querySelector("#setupPanel");
const lobbyPanel = document.querySelector("#lobbyPanel");
const roomForm = document.querySelector("#roomForm");
const gameId = document.querySelector("#gameId");
const gameTiles = document.querySelectorAll(".game-slice");
const roomCode = document.querySelector("#roomCode");
const setupStatus = document.querySelector("#setupStatus");
const accountLabel = document.querySelector("#accountLabel");
const accountAvatar = document.querySelector("#accountAvatar");
const avatarFile = document.querySelector("#avatarFile");
const chooseAvatar = document.querySelector("#chooseAvatar");
const logoutAccount = document.querySelector("#logoutAccount");
const lobbyStatus = document.querySelector("#lobbyStatus");
const activeRoomCode = document.querySelector("#activeRoomCode");
const activeGameName = document.querySelector("#activeGameName");
const playerList = document.querySelector("#playerList");
const inviteLink = document.querySelector("#inviteLink");
const copyInvite = document.querySelector("#copyInvite");
const readyToggle = document.querySelector("#readyToggle");
const startGame = document.querySelector("#startGame");
const leaveRoom = document.querySelector("#leaveRoom");
const gameStage = document.querySelector("#gameStage");

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function cleanRoomCode(value) {
  return value.replace(/\D/g, "").slice(0, 4);
}

function setStatus(target, message, isError = false) {
  target.textContent = message;
  target.style.color = isError ? "#a43e27" : "";
}

function syncSelectedGame() {
  gameTiles.forEach((tile) => {
    tile.classList.toggle("active", tile.dataset.game === gameId.value);
  });
}

function updateVisualMotion() {
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  rootStyle.setProperty("--scroll-shift", `${scrollTop}px`);
  rootStyle.setProperty("--scroll-progress", `${Math.min(100, (scrollTop / maxScroll) * 100)}%`);
}

window.addEventListener("scroll", updateVisualMotion, { passive: true });
window.addEventListener("resize", updateVisualMotion);
window.addEventListener("pointermove", (event) => {
  const x = (event.clientX / window.innerWidth - 0.5) * 18;
  const y = (event.clientY / window.innerHeight - 0.5) * 12;
  rootStyle.setProperty("--move-x", `${x.toFixed(2)}px`);
  rootStyle.setProperty("--move-y", `${y.toFixed(2)}px`);
}, { passive: true });

function api(path, options = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "请求失败");
    }
    return payload;
  }).catch((error) => {
    if (error instanceof TypeError) {
      if (location.protocol === "file:") {
        throw new Error("请先双击 start.bat，再从 http://localhost:5177 打开页面。");
      }
      throw new Error("连接不到房间服务，请确认 start.bat 的黑色窗口还开着。");
    }
    throw error;
  });
}

function getPlayerName() {
  return state.account?.id || state.playerId;
}

function getPlayerAvatar() {
  return state.account?.avatar || "";
}

function showAuth() {
  document.body.dataset.view = "auth";
  authPanel.classList.remove("hidden");
  setupPanel.classList.add("hidden");
  lobbyPanel.classList.add("hidden");
  accountPassword.value = "";
  updateVisualMotion();
}

function showSetup() {
  document.body.dataset.view = "setup";
  authPanel.classList.add("hidden");
  setupPanel.classList.remove("hidden");
  lobbyPanel.classList.add("hidden");
  accountLabel.textContent = state.account.id;
  renderAvatar(accountAvatar, state.account.id, state.account.avatar);
  syncSelectedGame();
  updateVisualMotion();
}

function setAccount(account) {
  state.account = account;
  state.playerId = account.id;
  sessionStorage.setItem("twoPlayer.account", JSON.stringify(account));
  showSetup();
}

async function enterRoom(action) {
  if (!state.account) {
    showAuth();
    return;
  }

  const code = action === "create" ? randomCode() : cleanRoomCode(roomCode.value);
  if (code.length !== 4) {
    setStatus(setupStatus, "请输入 4 位数字房间号。", true);
    return;
  }

  const payload = {
    playerId: state.playerId,
    playerName: getPlayerName(),
    playerAvatar: getPlayerAvatar(),
    gameId: gameId.value,
    roomCode: code,
  };

  try {
    setStatus(setupStatus, action === "create" ? `正在创建房间 ${code}...` : "正在加入房间...");
    const room = await api(`/api/rooms/${action}`, {
      method: "POST",
      body: payload,
    });
    openLobby(room);
  } catch (error) {
    setStatus(setupStatus, error.message, true);
  }
}

function openLobby(room) {
  state.roomCode = room.roomCode;
  state.gameId = room.gameId;
  state.ready = Boolean(room.players.find((player) => player.id === state.playerId)?.ready);

  setupPanel.classList.add("hidden");
  lobbyPanel.classList.remove("hidden");
  document.body.dataset.view = "lobby";
  activeRoomCode.textContent = room.roomCode;
  activeGameName.textContent = gameNames[room.gameId] || `游戏 ${room.gameId}`;
  inviteLink.value = `${location.origin}${location.pathname}?room=${room.roomCode}&game=${room.gameId}&guest=1`;
  renderRoom(room);
  connectEvents();
  updateVisualMotion();
}

function renderRoom(room) {
  state.lastRoom = room;
  state.gameId = room.gameId;
  playerList.innerHTML = "";

  room.players.forEach((player, index) => {
    const score = room.game?.scores?.[player.id] || 0;
    const detail = room.gameId === "2" ? `${index === 0 ? "黑棋" : "白棋"}${room.game?.currentPlayerId === player.id ? " · 当前回合" : ""}` : `${score} 分`;
    const badgeText = room.gameId === "2"
      ? room.game?.winnerId === player.id
        ? "获胜"
        : room.game?.status === "playing"
          ? "对局中"
          : player.ready
            ? "已准备"
            : "未准备"
      : room.game?.status === "playing"
        ? "答题中"
        : player.ready
          ? "已准备"
          : "未准备";
    const card = document.createElement("div");
    card.className = "player-card";
    card.innerHTML = `
      <div class="player-avatar">${avatarMarkup(player.name, player.avatar)}</div>
      <div class="player-main">
        <strong>${index + 1}P ${escapeHtml(player.name)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
      <span class="badge ${player.ready ? "ready" : ""}">${badgeText}</span>
    `;
    playerList.appendChild(card);
  });

  const allReady = room.players.length === 2 && room.players.every((player) => player.ready);
  const gameStarted = room.gameId === "1"
    ? room.game?.status === "playing" || room.game?.status === "between"
    : room.gameId === "2"
      ? room.game?.status === "playing"
      : false;
  readyToggle.disabled = gameStarted;
  readyToggle.textContent = state.ready ? "取消准备" : "准备";
  startGame.disabled = !allReady || gameStarted || !["1", "2"].includes(room.gameId);
  startGame.textContent = gameStarted ? "游戏进行中" : room.gameId === "2" && room.game?.status === "finished" ? "重新开始" : "开始游戏";
  renderGameArea(room, allReady);
  scheduleTransientCleanup(room);
  setStatus(lobbyStatus, room.players.length < 2 ? `把房间号 ${room.roomCode} 告诉玩家二即可加入。` : "房间已满员，可以确认准备状态。");
}

function scheduleTransientCleanup(room) {
  if (state.transientTimer) {
    clearTimeout(state.transientTimer);
    state.transientTimer = null;
  }
  const now = Date.now();
  const expirations = [
    ...(room.game?.chatBubbles || []).map((bubble) => bubble.expiresAt),
    room.game?.cameraFrame?.expiresAt,
  ].filter((expiresAt) => expiresAt && expiresAt > now);
  if (!expirations.length) {
    return;
  }
  const waitMs = Math.max(200, Math.min(...expirations) - Date.now() + 80);
  state.transientTimer = setTimeout(() => {
    if (state.lastRoom) {
      renderRoom(state.lastRoom);
    }
  }, waitMs);
}

function renderGameArea(room, allReady) {
  clearCountdown();

  if (room.gameId === "2") {
    renderGomokuArea(room, allReady);
    return;
  }

  if (room.gameId !== "1") {
    gameStage.innerHTML = `
      <div class="stage-card">
        <strong>这个游戏还没接入</strong>
        <span>当前只完成了游戏 1 和游戏 2。</span>
      </div>
    `;
    return;
  }

  if (!room.game || room.game.status === "lobby") {
    gameStage.innerHTML = `
      <div class="stage-card">
        <strong>${allReady ? "两位玩家已准备" : "等待两位玩家进入并准备"}</strong>
        <span>${allReady ? "房主点击开始游戏后会出现第一题。" : `当前 ${room.players.length}/2 人在线`}</span>
      </div>
    `;
    return;
  }

  if (room.game.status === "between") {
    gameStage.innerHTML = `
      <div class="math-game result-view">
        <p class="math-label">第 ${room.game.round} 题结果</p>
        <h3>${escapeHtml(room.game.lastResult?.message || "进入下一题")}</h3>
        <p>正确答案：${formatAnswer(room.game.lastResult?.answer)}</p>
      </div>
    `;
    return;
  }

  const questionChanged = state.currentQuestionId !== room.game.question?.id;
  if (questionChanged) {
    state.currentQuestionId = room.game.question?.id;
    gameStage.innerHTML = `
      <form class="math-game" id="answerForm">
        <div class="math-topline">
          <span>${escapeHtml(room.game.question.level)}</span>
          <strong id="roundTimer">01:00</strong>
        </div>
        <p class="math-label">第 ${room.game.round} 题</p>
        <h3>${escapeHtml(room.game.question.text)}</h3>
        <div class="answer-row">
          <input id="answerInput" name="answer" autocomplete="off" inputmode="decimal" placeholder="填写答案" />
          <button type="submit">提交</button>
        </div>
        <p class="math-tip">可填整数、小数或分数，例如 3/4。</p>
      </form>
    `;
    document.querySelector("#answerInput")?.focus();
  }

  startCountdown(room.game.deadlineAt);
}

function clearCountdown() {
  if (state.countdown) {
    clearInterval(state.countdown);
    state.countdown = null;
  }
}

function clearTransientTimer() {
  if (state.transientTimer) {
    clearTimeout(state.transientTimer);
    state.transientTimer = null;
  }
}

function startCountdown(deadlineAt) {
  const timer = document.querySelector("#roundTimer");
  if (!timer || !deadlineAt) {
    return;
  }

  const update = () => {
    const remaining = Math.max(0, deadlineAt - Date.now());
    const minutes = String(Math.floor(remaining / 60000)).padStart(2, "0");
    const seconds = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    timer.textContent = `${minutes}:${seconds}`;
  };

  update();
  state.countdown = setInterval(update, 250);
}

function formatAnswer(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : "--";
}

function renderGomokuArea(room, allReady) {
  if (!room.game || room.game.status === "lobby") {
    gameStage.innerHTML = `
      <div class="stage-card">
        <strong>${allReady ? "两位玩家已准备" : "等待两位玩家进入并准备"}</strong>
        <span>${allReady ? "点击开始游戏后，黑棋先手。" : `当前 ${room.players.length}/2 人在线`}</span>
      </div>
    `;
    return;
  }

  const me = room.players.find((player) => player.id === state.playerId);
  const currentPlayer = room.players.find((player) => player.id === room.game.currentPlayerId);
  const myTurn = room.game.currentPlayerId === state.playerId && room.game.status === "playing" && !room.game.winnerId && !room.game.pendingUndo;
  const board = room.game.board || [];
  const leftPlayer = room.players[0];
  const rightPlayer = room.players[1];

  gameStage.innerHTML = `
    <div class="gomoku-game">
      <div class="gomoku-topline">
        <div>
          <p class="math-label">传统五子棋</p>
          <h3>${gomokuTitle(room, currentPlayer)}</h3>
        </div>
        <button type="button" class="secondary" id="undoRequest" ${canRequestUndo(room) ? "" : "disabled"}>申请悔棋</button>
      </div>
      <div class="gomoku-arena">
        ${renderGomokuPlayerPanel(room, leftPlayer, "left")}
        <div class="gomoku-board-wrap">
          <div class="gomoku-board" role="grid" aria-label="五子棋棋盘">
            ${board.map((row, rowIndex) => row.map((cell, colIndex) => `
              <button
                type="button"
                class="gomoku-cell"
                data-row="${rowIndex}"
                data-col="${colIndex}"
                ${myTurn && !cell ? "" : "disabled"}
                aria-label="第 ${rowIndex + 1} 行第 ${colIndex + 1} 列"
              >
                ${cell ? `<span class="stone ${cell}"></span>` : ""}
              </button>
            `).join("")).join("")}
          </div>
        </div>
        ${renderGomokuPlayerPanel(room, rightPlayer, "right")}
      </div>
      <p class="gomoku-message">${escapeHtml(room.game.message || "")}</p>
      ${renderUndoPanel(room, me)}
      <form id="chatForm" class="chat-form">
        <input id="chatInput" maxlength="80" placeholder="输入聊天内容，气泡显示 6 秒" />
        <button type="submit">发送</button>
      </form>
    </div>
  `;
}

function renderGomokuPlayerPanel(room, player, side) {
  if (!player) {
    return `<div class="gomoku-player-panel ${side} empty">等待玩家</div>`;
  }
  const index = room.players.findIndex((item) => item.id === player.id);
  const stone = index === 0 ? "black" : "white";
  const active = room.game.currentPlayerId === player.id && room.game.status === "playing" && !room.game.pendingUndo;
  const bubbles = (room.game.chatBubbles || []).filter((bubble) => bubble.playerId === player.id && bubble.expiresAt > Date.now());
  const cameraFrame = room.game.cameraFrame?.viewerId === state.playerId && room.game.cameraFrame.playerId === player.id && room.game.cameraFrame.expiresAt > Date.now()
    ? room.game.cameraFrame.frame
    : "";

  return `
    <div class="gomoku-player-panel ${side} ${active ? "active" : ""}">
      <div class="gomoku-avatar-wrap">
        <div class="gomoku-avatar">${avatarMarkup(player.name, player.avatar)}</div>
        <span class="stone-label ${stone}">${stone === "black" ? "黑棋" : "白棋"}</span>
      </div>
      <strong>${escapeHtml(player.name)}</strong>
      <div class="bubble-stack">
        ${bubbles.map((bubble) => `<div class="chat-bubble">${escapeHtml(bubble.text)}</div>`).join("")}
      </div>
      ${cameraFrame ? `<div class="remote-camera"><img src="${escapeHtml(cameraFrame)}" alt="${escapeHtml(player.name)} 的摄像头画面" /><span>摄像头同步中</span></div>` : ""}
    </div>
  `;
}

function gomokuTitle(room, currentPlayer) {
  if (room.game.status === "finished") {
    return room.game.winnerName ? `${escapeHtml(room.game.winnerName)} 获胜` : "本局平局";
  }
  if (room.game.pendingUndo) {
    return "悔棋处理中";
  }
  return currentPlayer ? `轮到 ${escapeHtml(currentPlayer.name)} 落子` : "对局中";
}

function canRequestUndo(room) {
  const lastMove = room.game?.moves?.at(-1);
  return room.gameId === "2" && room.game?.status === "playing" && lastMove?.playerId === state.playerId && !room.game.pendingUndo;
}

function renderUndoPanel(room, me) {
  const pending = room.game.pendingUndo;
  if (!pending) {
    return `<div class="undo-panel muted-panel">刚落子的一方可以申请悔棋，由对方选择条件。</div>`;
  }

  if (pending.status === "choosing" && pending.opponentId === state.playerId) {
    return `
      <div class="undo-panel">
        <strong>对方申请悔棋，请选择条件</strong>
        <div class="undo-actions">
          <button type="button" id="chooseCamera">打开摄像头 10 秒</button>
        </div>
        <form id="phraseConditionForm" class="phrase-form">
          <input id="phraseConditionInput" maxlength="40" placeholder="你想让对方说什么" />
          <button type="submit" class="secondary">发送文字挑战</button>
        </form>
      </div>
    `;
  }

  if (pending.status === "choosing" && pending.requesterId === state.playerId) {
    return `<div class="undo-panel">已申请悔棋，等待对方选择条件。</div>`;
  }

  if (pending.status === "waiting-camera" && pending.requesterId === state.playerId) {
    return `
      <div class="undo-panel">
        <strong>对方要求你打开摄像头 10 秒</strong>
        <button type="button" id="startCameraChallenge">开始摄像头挑战</button>
      </div>
    `;
  }

  if (pending.status === "waiting-camera") {
    return `<div class="undo-panel">等待申请者完成摄像头 10 秒挑战。</div>`;
  }

  if (pending.status === "waiting-phrase" && pending.requesterId === state.playerId) {
    return `
      <form id="phraseProofForm" class="undo-panel phrase-form">
        <strong>请完整输入这几个字：${escapeHtml(pending.phrase)}</strong>
        <input id="phraseProofInput" maxlength="40" placeholder="照着输入" />
        <button type="submit">完成悔棋</button>
      </form>
    `;
  }

  if (pending.status === "waiting-phrase") {
    return `<div class="undo-panel">等待申请者输入指定文字。</div>`;
  }

  return "";
}

function connectEvents() {
  if (state.events) {
    state.events.close();
  }

  state.events = new EventSource(`/api/rooms/${state.roomCode}/events?playerId=${state.playerId}`);
  state.events.onmessage = (event) => {
    const room = JSON.parse(event.data);
    const me = room.players.find((player) => player.id === state.playerId);
    state.ready = Boolean(me?.ready);
    renderRoom(room);
  };
  state.events.onerror = () => {
    setStatus(lobbyStatus, "连接暂时中断，正在等待恢复...", true);
  };
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function avatarInitial(name) {
  return String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function avatarMarkup(name, avatar) {
  if (avatar) {
    return `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)} 的头像" />`;
  }
  return `<span>${escapeHtml(avatarInitial(name))}</span>`;
}

function renderAvatar(target, name, avatar) {
  target.innerHTML = avatarMarkup(name, avatar);
}

function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件。"));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("图片不能超过 5MB。"));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("图片格式无法识别。"));
      image.onload = () => {
        const size = 160;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const sourceSize = Math.min(image.width, image.height);
        const sourceX = (image.width - sourceSize) / 2;
        const sourceY = (image.height - sourceSize) / 2;
        canvas.width = size;
        canvas.height = size;
        context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function stopCameraStream() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
}

async function runCameraChallenge() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持摄像头调用。");
  }

  const overlay = document.createElement("div");
  overlay.className = "camera-overlay";
  overlay.innerHTML = `
    <div class="camera-card">
      <video autoplay muted playsinline></video>
      <strong id="cameraTimer">10</strong>
      <span>摄像头挑战进行中</span>
    </div>
  `;
  document.body.appendChild(overlay);

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const video = overlay.querySelector("video");
    video.srcObject = state.cameraStream;
    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 240;
    canvas.height = 180;
    let nextFrameAt = 0;
    const endAt = Date.now() + 10000;

    while (Date.now() < endAt) {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      overlay.querySelector("#cameraTimer").textContent = String(remaining);
      if (Date.now() >= nextFrameAt && video.videoWidth && video.videoHeight) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = canvas.toDataURL("image/jpeg", 0.58);
        await api(`/api/rooms/${state.roomCode}/camera-frame`, {
          method: "POST",
          body: { playerId: state.playerId, frame },
        }).catch(() => {});
        nextFrameAt = Date.now() + 330;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } finally {
    stopCameraStream();
    overlay.remove();
  }
}

roomCode.addEventListener("input", () => {
  roomCode.value = cleanRoomCode(roomCode.value);
});

gameTiles.forEach((tile) => {
  tile.addEventListener("click", () => {
    gameId.value = tile.dataset.game;
    syncSelectedGame();
  });
});

gameId.addEventListener("change", syncSelectedGame);

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.action || "login";
  const payload = {
    accountId: accountId.value.trim(),
    password: accountPassword.value,
  };

  try {
    setStatus(authStatus, action === "register" ? "正在注册..." : "正在登录...");
    const result = await api(`/api/auth/${action}`, {
      method: "POST",
      body: payload,
    });
    setAccount(result.account);
    setStatus(setupStatus, action === "register" ? "注册成功，已登录。" : "登录成功。");
    setStatus(authStatus, "");
  } catch (error) {
    setStatus(authStatus, error.message, true);
  }
});

logoutAccount.addEventListener("click", async () => {
  if (state.roomCode) {
    await api(`/api/rooms/${state.roomCode}/leave`, {
      method: "POST",
      body: { playerId: state.playerId },
    }).catch(() => {});
  }
  if (state.events) {
    state.events.close();
  }
  clearCountdown();
  clearTransientTimer();
  stopCameraStream();
  state.account = null;
  state.playerId = "";
  state.roomCode = "";
  sessionStorage.removeItem("twoPlayer.account");
  showAuth();
});

chooseAvatar.addEventListener("click", () => {
  avatarFile.click();
});

avatarFile.addEventListener("change", async () => {
  const file = avatarFile.files?.[0];
  if (!file || !state.account) {
    return;
  }

  try {
    setStatus(setupStatus, "正在保存头像...");
    const avatar = await fileToAvatarDataUrl(file);
    const result = await api("/api/auth/avatar", {
      method: "POST",
      body: {
        accountId: state.account.id,
        avatar,
      },
    });
    setAccount(result.account);
    setStatus(setupStatus, "头像已保存。");
  } catch (error) {
    setStatus(setupStatus, error.message, true);
  } finally {
    avatarFile.value = "";
  }
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.action || "create";
  enterRoom(action);
});

copyInvite.addEventListener("click", async () => {
  await navigator.clipboard.writeText(inviteLink.value);
  setStatus(lobbyStatus, "邀请链接已复制。");
});

readyToggle.addEventListener("click", async () => {
  const room = await api(`/api/rooms/${state.roomCode}/ready`, {
    method: "POST",
    body: { playerId: state.playerId, ready: !state.ready },
  });
  state.ready = !state.ready;
  renderRoom(room);
});

gameStage.addEventListener("click", async (event) => {
  const cell = event.target.closest(".gomoku-cell");
  if (cell) {
    try {
      const room = await api(`/api/rooms/${state.roomCode}/move`, {
        method: "POST",
        body: {
          playerId: state.playerId,
          row: Number(cell.dataset.row),
          col: Number(cell.dataset.col),
        },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (event.target.matches("#undoRequest")) {
    try {
      const room = await api(`/api/rooms/${state.roomCode}/undo/request`, {
        method: "POST",
        body: { playerId: state.playerId },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (event.target.matches("#chooseCamera")) {
    try {
      const room = await api(`/api/rooms/${state.roomCode}/undo/choose`, {
        method: "POST",
        body: { playerId: state.playerId, condition: "camera" },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (event.target.matches("#startCameraChallenge")) {
    event.target.disabled = true;
    try {
      await runCameraChallenge();
      const room = await api(`/api/rooms/${state.roomCode}/undo/complete`, {
        method: "POST",
        body: { playerId: state.playerId, proof: "camera" },
      });
      renderRoom(room);
    } catch (error) {
      event.target.disabled = false;
      setStatus(lobbyStatus, error.message, true);
    }
  }
});

gameStage.addEventListener("submit", async (event) => {
  if (event.target.matches("#chatForm")) {
    event.preventDefault();
    const text = document.querySelector("#chatInput")?.value.trim() || "";
    try {
      const room = await api(`/api/rooms/${state.roomCode}/chat`, {
        method: "POST",
        body: { playerId: state.playerId, text },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (event.target.matches("#phraseConditionForm")) {
    event.preventDefault();
    const phrase = document.querySelector("#phraseConditionInput")?.value.trim() || "";
    try {
      const room = await api(`/api/rooms/${state.roomCode}/undo/choose`, {
        method: "POST",
        body: { playerId: state.playerId, condition: "phrase", phrase },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (event.target.matches("#phraseProofForm")) {
    event.preventDefault();
    const proof = document.querySelector("#phraseProofInput")?.value.trim() || "";
    try {
      const room = await api(`/api/rooms/${state.roomCode}/undo/complete`, {
        method: "POST",
        body: { playerId: state.playerId, proof },
      });
      renderRoom(room);
    } catch (error) {
      setStatus(lobbyStatus, error.message, true);
    }
    return;
  }

  if (!event.target.matches("#answerForm")) {
    return;
  }
  event.preventDefault();
  const answerInput = document.querySelector("#answerInput");
  const answer = answerInput?.value.trim() || "";
  if (!answer) {
    setStatus(lobbyStatus, "请先填写答案。", true);
    return;
  }

  const submitButton = event.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  try {
    const room = await api(`/api/rooms/${state.roomCode}/answer`, {
      method: "POST",
      body: { playerId: state.playerId, answer },
    });
    renderRoom(room);
  } catch (error) {
    submitButton.disabled = false;
    setStatus(lobbyStatus, error.message, true);
  }
});

leaveRoom.addEventListener("click", async () => {
  if (state.roomCode) {
    await api(`/api/rooms/${state.roomCode}/leave`, {
      method: "POST",
      body: { playerId: state.playerId },
    }).catch(() => {});
  }
  if (state.events) {
    state.events.close();
  }
  clearCountdown();
  clearTransientTimer();
  stopCameraStream();
  state.roomCode = "";
  lobbyPanel.classList.add("hidden");
  setupPanel.classList.remove("hidden");
  setStatus(setupStatus, "已离开房间。");
});

startGame.addEventListener("click", async () => {
  try {
    const room = await api(`/api/rooms/${state.roomCode}/start`, {
      method: "POST",
      body: { playerId: state.playerId },
    });
    renderRoom(room);
  } catch (error) {
    setStatus(lobbyStatus, error.message, true);
  }
});

const roomFromUrl = cleanRoomCode(params.get("room") || "");
const gameFromUrl = params.get("game");
roomCode.value = roomFromUrl;
if (gameNames[gameFromUrl]) {
  gameId.value = gameFromUrl;
}

if (state.account) {
  showSetup();
} else {
  showAuth();
}

updateVisualMotion();
