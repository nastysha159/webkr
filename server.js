const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");
require("dotenv").config();

const server = http.createServer((req, res) => {
  if (
    req.url === "/" ||
    req.url === "/index.html" ||
    req.url === "/battleship"
  ) {
    fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

// Redis клиент
let redisClient;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const MAX_ROOMS = 5;
const BOARD_SIZE = 10;

// Инициализация Redis
async function initRedis() {
  redisClient = createClient({
    url: REDIS_URL,
  });

  redisClient.on("error", (err) => console.log("Redis Client Error", err));
  redisClient.on("connect", () => console.log("Connected to Redis"));

  await redisClient.connect();

  // Инициализируем комнаты если их нет
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const roomKey = `room:${i}`;
    const exists = await redisClient.exists(roomKey);
    if (!exists) {
      await redisClient.hSet(roomKey, {
        id: i,
        playersCount: 0,
        gameStarted: false,
        shipsPlaced: 0,
        currentPlayer: "",
        createdAt: Date.now(),
      });
    }
  }
}

// Redis функции
async function getRoom(roomId) {
  const roomKey = `room:${roomId}`;
  const roomData = await redisClient.hGetAll(roomKey);
  return roomData.id
    ? {
        ...roomData,
        id: parseInt(roomData.id),
        playersCount: parseInt(roomData.playersCount),
        gameStarted: roomData.gameStarted === "true",
        shipsPlaced: parseInt(roomData.shipsPlaced),
      }
    : null;
}

async function updateRoom(roomId, data) {
  const roomKey = `room:${roomId}`;
  await redisClient.hSet(roomKey, data);
}

async function getAllRooms() {
  const rooms = [];
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const room = await getRoom(i);
    if (room) {
      rooms.push(room);
    }
  }
  return rooms;
}

async function getPlayerRoom(playerId) {
  return await redisClient.get(`player:${playerId}:room`);
}

async function setPlayerRoom(playerId, roomId) {
  await redisClient.set(`player:${playerId}:room`, roomId || "");
  if (roomId) {
    await redisClient.expire(`player:${playerId}:room`, 3600); // 1 час TTL
  }
}

async function getPlayerBoard(playerId) {
  const boardData = await redisClient.get(`player:${playerId}:board`);
  return boardData ? JSON.parse(boardData) : null;
}

async function setPlayerBoard(playerId, board) {
  await redisClient.set(`player:${playerId}:board`, JSON.stringify(board));
  await redisClient.expire(`player:${playerId}:board`, 7200); // 2 часа TTL
}

async function addPlayerToRoom(playerId, roomId) {
  const roomKey = `room:${roomId}`;
  const playerRoomKey = `room:${roomId}:players`;

  await redisClient.sAdd(playerRoomKey, playerId);
  const playersCount = await redisClient.sCard(playerRoomKey);
  await redisClient.hSet(roomKey, { playersCount });

  return playersCount;
}

async function removePlayerFromRoom(playerId, roomId) {
  const roomKey = `room:${roomId}`;
  const playerRoomKey = `room:${roomId}:players`;

  await redisClient.sRem(playerRoomKey, playerId);
  const playersCount = await redisClient.sCard(playerRoomKey);
  await redisClient.hSet(roomKey, { playersCount });

  return playersCount;
}

async function getRoomPlayers(roomId) {
  const playerRoomKey = `room:${roomId}:players`;
  return await redisClient.sMembers(playerRoomKey);
}

async function addChatMessage(roomId, playerId, message) {
  const chatKey = `room:${roomId}:chat`;
  const chatMessage = {
    playerId,
    message,
    timestamp: Date.now(),
  };

  await redisClient.lPush(chatKey, JSON.stringify(chatMessage));
  await redisClient.lTrim(chatKey, 0, 49); // Храним последние 50 сообщений
  await redisClient.expire(chatKey, 86400); // 24 часа TTL
}

async function getChatMessages(roomId, count = 20) {
  const chatKey = `room:${roomId}:chat`;
  const messages = await redisClient.lRange(chatKey, 0, count - 1);
  return messages.map((msg) => JSON.parse(msg));
}

function createEmptyBoard() {
  return Array(BOARD_SIZE)
    .fill()
    .map(() => Array(BOARD_SIZE).fill(0));
}

function isValidShipPlacement(board, ship, x, y, isHorizontal) {
  const size = ship.size;

  if (isHorizontal) {
    if (x + size > BOARD_SIZE) return false;
  } else {
    if (y + size > BOARD_SIZE) return false;
  }

  for (let i = -1; i <= size; i++) {
    for (let j = -1; j <= 1; j++) {
      let checkX, checkY;

      if (isHorizontal) {
        checkX = x + i;
        checkY = y + j;
      } else {
        checkX = x + j;
        checkY = y + i;
      }

      if (
        checkX >= 0 &&
        checkX < BOARD_SIZE &&
        checkY >= 0 &&
        checkY < BOARD_SIZE
      ) {
        if (board[checkY][checkX] === 1) return false;
      }
    }
  }

  return true;
}

// Основная логика
wss.on("connection", async (ws) => {
  console.log("Новое подключение");

  ws.player = {
    id: `player_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    room: null,
    ready: false,
  };

  // Отправляем список комнат при подключении
  const rooms = await getAllRooms();
  sendToClient(ws, {
    type: "rooms_list",
    rooms: rooms.map((room) => ({
      id: room.id,
      playersCount: room.playersCount,
      gameStarted: room.gameStarted,
    })),
  });

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data);
      await handleMessage(ws, message);
    } catch (error) {
      console.error("Ошибка парсинга сообщения:", error);
    }
  });

  ws.on("close", async () => {
    console.log("Отключение клиента:", ws.player.id);
    if (ws.player.room) {
      await handleDisconnect(ws);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket ошибка:", error);
  });
});

async function handleMessage(ws, message) {
  console.log(`Сообщение от ${ws.player.id}:`, message.type);

  switch (message.type) {
    case "join_room":
      await joinRoom(ws, message.roomId);
      break;
    case "leave_room":
      await leaveRoom(ws);
      break;
    case "place_ships":
      await placeShips(ws, message.ships);
      break;
    case "shoot":
      await handleShoot(ws, message.x, message.y);
      break;
    case "chat_message":
      await handleChatMessage(ws, message.text);
      break;
    case "get_chat_history":
      await sendChatHistory(ws);
      break;
  }
}

async function joinRoom(ws, roomId) {
  const room = await getRoom(roomId);

  if (!room) {
    sendToClient(ws, { type: "error", message: "Комната не найдена" });
    return;
  }

  if (room.playersCount >= 2) {
    sendToClient(ws, { type: "error", message: "Комната заполнена" });
    return;
  }

  if (room.gameStarted) {
    sendToClient(ws, { type: "error", message: "Игра уже началась" });
    return;
  }

  // Выход из предыдущей комнаты
  if (ws.player.room) {
    await leaveRoom(ws);
  }

  // Добавляем игрока в комнату
  const playersCount = await addPlayerToRoom(ws.player.id, roomId);
  await setPlayerRoom(ws.player.id, roomId);
  ws.player.room = roomId;

  // Создаем пустую доску для игрока
  await setPlayerBoard(ws.player.id, {
    board: createEmptyBoard(),
    ships: [],
  });

  console.log(`Игрок ${ws.player.id} присоединился к комнате ${roomId}`);

  // Уведомляем всех в комнате
  await broadcastToRoom(roomId, {
    type: "player_joined",
    playerId: ws.player.id,
    playersCount: playersCount,
  });

  // Отправляем историю чата
  await sendChatHistoryToPlayer(ws, roomId);

  // Обновляем список комнат для всех
  await broadcastRoomsList();

  // Если комната заполнена, начинаем игру
  if (playersCount === 2) {
    await startGame(roomId);
  }
}

async function leaveRoom(ws) {
  const roomId = ws.player.room;
  if (!roomId) return;

  const playersCount = await removePlayerFromRoom(ws.player.id, roomId);
  await setPlayerRoom(ws.player.id, null);

  console.log(`Игрок ${ws.player.id} покинул комнату ${roomId}`);

  // Уведомляем остальных игроков
  if (playersCount > 0) {
    await broadcastToRoom(roomId, {
      type: "player_left",
      playerId: ws.player.id,
      playersCount: playersCount,
    });
  } else {
    // Если комната пуста, сбрасываем игру
    await resetGame(roomId);
  }

  ws.player.room = null;
  await broadcastRoomsList();
}

async function placeShips(ws, ships) {
  const roomId = ws.player.room;
  if (!roomId) {
    sendToClient(ws, { type: "error", message: "Вы не в комнате" });
    return;
  }

  const room = await getRoom(roomId);
  if (!room || !room.gameStarted) {
    sendToClient(ws, { type: "error", message: "Игра не началась" });
    return;
  }

  // Проверяем расстановку кораблей
  const validShips = [
    { size: 4, count: 1 },
    { size: 3, count: 2 },
    { size: 2, count: 3 },
    { size: 1, count: 4 },
  ];

  const tempBoard = createEmptyBoard();
  const placedShips = [];

  try {
    for (const ship of ships) {
      const shipConfig = validShips.find((s) => s.size === ship.size);
      if (!shipConfig) throw new Error(`Неверный размер корабля: ${ship.size}`);

      if (
        !isValidShipPlacement(
          tempBoard,
          ship,
          ship.x,
          ship.y,
          ship.isHorizontal
        )
      ) {
        throw new Error("Некорректная расстановка кораблей");
      }

      for (let i = 0; i < ship.size; i++) {
        const x = ship.isHorizontal ? ship.x + i : ship.x;
        const y = ship.isHorizontal ? ship.y : ship.y + i;
        tempBoard[y][x] = 1;
      }

      placedShips.push(ship);
    }

    const shipCounts = {};
    placedShips.forEach((ship) => {
      shipCounts[ship.size] = (shipCounts[ship.size] || 0) + 1;
    });

    for (const config of validShips) {
      if (shipCounts[config.size] !== config.count) {
        throw new Error(`Неверное количество ${config.size}-палубных кораблей`);
      }
    }
  } catch (error) {
    sendToClient(ws, { type: "error", message: error.message });
    return;
  }

  // Сохраняем расстановку
  await setPlayerBoard(ws.player.id, {
    board: tempBoard,
    ships: placedShips,
  });

  // Обновляем счетчик размещенных кораблей
  const newShipsPlaced = room.shipsPlaced + 1;
  await updateRoom(roomId, { shipsPlaced: newShipsPlaced });

  sendToClient(ws, { type: "ships_placed" });

  await broadcastToRoom(roomId, {
    type: "ships_placed_update",
    playerId: ws.player.id,
    shipsPlaced: newShipsPlaced,
  });

  // Если оба игрока расставили корабли, начинаем ход
  if (newShipsPlaced === 2) {
    const players = await getRoomPlayers(roomId);
    const randomPlayerId = players[Math.floor(Math.random() * players.length)];
    await updateRoom(roomId, { currentPlayer: randomPlayerId });

    await broadcastToRoom(roomId, {
      type: "game_start",
      currentPlayer: randomPlayerId,
    });
  }
}

async function handleShoot(ws, x, y) {
  const roomId = ws.player.room;
  if (!roomId) return;

  const room = await getRoom(roomId);
  if (!room || room.currentPlayer !== ws.player.id) return;

  const players = await getRoomPlayers(roomId);
  const opponentId = players.find((id) => id !== ws.player.id);
  if (!opponentId) return;

  const opponentBoardData = await getPlayerBoard(opponentId);
  if (!opponentBoardData) return;

  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    sendToClient(ws, { type: "error", message: "Неверные координаты" });
    return;
  }

  const cell = opponentBoardData.board[y][x];
  let hit = false;
  let shipSunk = false;
  let gameOver = false;

  if (cell === 2 || cell === 3) {
    return;
  }

  if (cell === 1) {
    hit = true;
    opponentBoardData.board[y][x] = 2;

    // Проверяем попадание в корабль
    const hitShip = opponentBoardData.ships.find((ship) => {
      for (let i = 0; i < ship.size; i++) {
        const shipX = ship.isHorizontal ? ship.x + i : ship.x;
        const shipY = ship.isHorizontal ? ship.y : ship.y + i;
        if (shipX === x && shipY === y) return true;
      }
      return false;
    });

    if (hitShip) {
      let allHit = true;
      for (let i = 0; i < hitShip.size; i++) {
        const shipX = hitShip.isHorizontal ? hitShip.x + i : hitShip.x;
        const shipY = hitShip.isHorizontal ? hitShip.y : hitShip.y + i;
        if (opponentBoardData.board[shipY][shipX] !== 2) {
          allHit = false;
          break;
        }
      }

      shipSunk = allHit;

      if (shipSunk) {
        const allShipsSunk = opponentBoardData.ships.every((ship) => {
          for (let i = 0; i < ship.size; i++) {
            const shipX = ship.isHorizontal ? ship.x + i : ship.x;
            const shipY = ship.isHorizontal ? ship.y : ship.y + i;
            if (opponentBoardData.board[shipY][shipX] !== 2) {
              return false;
            }
          }
          return true;
        });

        gameOver = allShipsSunk;
      }
    }
  } else {
    opponentBoardData.board[y][x] = 3;
  }

  // Сохраняем обновленную доску
  await setPlayerBoard(opponentId, opponentBoardData);

  await broadcastToRoom(roomId, {
    type: "shot_result",
    x,
    y,
    hit,
    shipSunk,
    gameOver,
    playerId: ws.player.id,
  });

  if (gameOver) {
    await broadcastToRoom(roomId, {
      type: "game_over",
      winner: ws.player.id,
    });
    await resetGame(roomId);
  } else if (!hit) {
    // Передаем ход
    await updateRoom(roomId, { currentPlayer: opponentId });
    await broadcastToRoom(roomId, {
      type: "turn_change",
      currentPlayer: opponentId,
    });
  }
}

async function handleChatMessage(ws, text) {
  const roomId = ws.player.room;
  if (!roomId) return;

  await addChatMessage(roomId, ws.player.id, text);

  await broadcastToRoom(roomId, {
    type: "chat_message",
    playerId: ws.player.id,
    text: text,
    timestamp: Date.now(),
  });
}

async function sendChatHistoryToPlayer(ws, roomId) {
  const messages = await getChatMessages(roomId, 20);
  messages.reverse().forEach((msg) => {
    sendToClient(ws, {
      type: "chat_message",
      playerId: msg.playerId,
      text: msg.message,
      timestamp: msg.timestamp,
    });
  });
}

async function handleDisconnect(ws) {
  if (ws.player.room) {
    await leaveRoom(ws);
  }
}

async function startGame(roomId) {
  await updateRoom(roomId, {
    gameStarted: true,
    shipsPlaced: 0,
  });

  await broadcastToRoom(roomId, {
    type: "game_starting",
  });

  await broadcastRoomsList();
}

async function resetGame(roomId) {
  const players = await getRoomPlayers(roomId);

  // Очищаем доски всех игроков
  for (const playerId of players) {
    await setPlayerBoard(playerId, {
      board: createEmptyBoard(),
      ships: [],
    });
  }

  await updateRoom(roomId, {
    gameStarted: false,
    shipsPlaced: 0,
    currentPlayer: "",
  });

  await broadcastRoomsList();
}

async function broadcastToRoom(roomId, message) {
  const players = await getRoomPlayers(roomId);

  wss.clients.forEach((client) => {
    if (
      client.readyState === WebSocket.OPEN &&
      players.includes(client.player.id)
    ) {
      client.send(JSON.stringify(message));
    }
  });
}

async function broadcastRoomsList() {
  const rooms = await getAllRooms();
  const roomsList = rooms.map((room) => ({
    id: room.id,
    playersCount: room.playersCount,
    gameStarted: room.gameStarted,
  }));

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "rooms_list",
          rooms: roomsList,
        })
      );
    }
  });
}

function sendToClient(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;

initRedis()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен на порту ${PORT}`);
      console.log(`Redis подключен: ${REDIS_URL}`);
    });
  })
  .catch((err) => {
    console.error("Ошибка инициализации Redis:", err);
    process.exit(1);
  });
