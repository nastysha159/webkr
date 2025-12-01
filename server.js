const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const server = http.createServer((req, res) => {
  // Обслуживаем HTML страницу
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

const rooms = new Map();
const MAX_ROOMS = 5;
const BOARD_SIZE = 10;

// Инициализация комнат
for (let i = 1; i <= MAX_ROOMS; i++) {
  rooms.set(i, {
    id: i,
    players: [],
    boards: new Map(),
    currentPlayer: null,
    gameStarted: false,
    shipsPlaced: 0,
  });
}

function createEmptyBoard() {
  return Array(BOARD_SIZE)
    .fill()
    .map(() => Array(BOARD_SIZE).fill(0));
}

function isValidShipPlacement(board, ship, x, y, isHorizontal) {
  const size = ship.size;

  // Проверка выхода за границы
  if (isHorizontal) {
    if (x + size > BOARD_SIZE) return false;
  } else {
    if (y + size > BOARD_SIZE) return false;
  }

  // Проверка соседних клеток
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

wss.on("connection", (ws) => {
  console.log("Новое подключение");

  ws.player = {
    id: Math.random().toString(36).substr(2, 9),
    room: null,
    ready: false,
  };

  // Отправляем список комнат при подключении
  sendRoomsList(ws);

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (error) {
      console.error("Ошибка парсинга сообщения:", error);
    }
  });

  ws.on("close", () => {
    console.log("Отключение клиента");
    if (ws.player.room) {
      handleDisconnect(ws);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket ошибка:", error);
  });
});

function handleMessage(ws, message) {
  console.log(`Получено сообщение типа ${message.type} от ${ws.player.id}`);

  switch (message.type) {
    case "join_room":
      joinRoom(ws, message.roomId);
      break;
    case "leave_room":
      leaveRoom(ws);
      break;
    case "place_ships":
      placeShips(ws, message.ships);
      break;
    case "shoot":
      handleShoot(ws, message.x, message.y);
      break;
    case "chat_message":
      handleChatMessage(ws, message.text);
      break;
    default:
      console.log("Неизвестный тип сообщения:", message.type);
  }
}

function joinRoom(ws, roomId) {
  const room = rooms.get(parseInt(roomId));

  if (!room) {
    sendToClient(ws, { type: "error", message: "Комната не найдена" });
    return;
  }

  if (room.players.length >= 2) {
    sendToClient(ws, { type: "error", message: "Комната заполнена" });
    return;
  }

  if (room.gameStarted) {
    sendToClient(ws, { type: "error", message: "Игра уже началась" });
    return;
  }

  // Выход из предыдущей комнаты
  if (ws.player.room) {
    leaveRoom(ws);
  }

  room.players.push(ws);
  ws.player.room = roomId;

  // Создаем пустую доску для игрока
  room.boards.set(ws.player.id, {
    board: createEmptyBoard(),
    ships: [],
  });

  console.log(`Игрок ${ws.player.id} присоединился к комнате ${roomId}`);

  // Уведомляем всех в комнате
  broadcastToRoom(room, {
    type: "player_joined",
    playerId: ws.player.id,
    playersCount: room.players.length,
  });

  // Отправляем обновленную информацию о комнате
  updateRoomInfo();

  // Если комната заполнена, начинаем игру
  if (room.players.length === 2 && !room.gameStarted) {
    startGame(room);
  }
}

function leaveRoom(ws) {
  const roomId = ws.player.room;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  // Удаляем игрока из комнаты
  room.players = room.players.filter((player) => player !== ws);
  room.boards.delete(ws.player.id);

  console.log(`Игрок ${ws.player.id} покинул комнату ${roomId}`);

  // Уведомляем остальных игроков
  if (room.players.length > 0) {
    broadcastToRoom(room, {
      type: "player_left",
      playerId: ws.player.id,
      playersCount: room.players.length,
    });
  }

  // Сбрасываем игру если она была начата
  if (room.gameStarted) {
    resetGame(room);
  }

  ws.player.room = null;
  updateRoomInfo();
}

function placeShips(ws, ships) {
  const roomId = ws.player.room;
  if (!roomId) {
    sendToClient(ws, { type: "error", message: "Вы не в комнате" });
    return;
  }

  const room = rooms.get(roomId);
  if (!room || !room.gameStarted) {
    sendToClient(ws, { type: "error", message: "Игра не началась" });
    return;
  }

  const playerBoard = room.boards.get(ws.player.id);
  if (!playerBoard) return;

  // Проверяем расстановку кораблей
  const validShips = [
    { size: 4, count: 1 }, // 1 четырехпалубный
    { size: 3, count: 2 }, // 2 трехпалубных
    { size: 2, count: 3 }, // 3 двухпалубных
    { size: 1, count: 4 }, // 4 однопалубных
  ];

  // Создаем временную доску для проверки
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

      // Размещаем корабль на временной доске
      for (let i = 0; i < ship.size; i++) {
        const x = ship.isHorizontal ? ship.x + i : ship.x;
        const y = ship.isHorizontal ? ship.y : ship.y + i;
        tempBoard[y][x] = 1;
      }

      placedShips.push(ship);
    }

    // Проверяем количество кораблей
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
  playerBoard.ships = ships;
  playerBoard.board = tempBoard;
  room.shipsPlaced++;

  sendToClient(ws, { type: "ships_placed" });

  broadcastToRoom(room, {
    type: "ships_placed_update",
    playerId: ws.player.id,
    shipsPlaced: room.shipsPlaced,
  });

  // Если оба игрока расставили корабли, начинаем ход
  if (room.shipsPlaced === 2) {
    room.currentPlayer = room.players[Math.floor(Math.random() * 2)];
    broadcastToRoom(room, {
      type: "game_start",
      currentPlayer: room.currentPlayer.player.id,
    });
  }
}

function handleShoot(ws, x, y) {
  const roomId = ws.player.room;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.currentPlayer !== ws) return;

  const opponent = room.players.find((p) => p !== ws);
  if (!opponent) return;

  const opponentBoard = room.boards.get(opponent.player.id);
  if (!opponentBoard) return;

  // Проверяем выстрел
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    sendToClient(ws, { type: "error", message: "Неверные координаты" });
    return;
  }

  const cell = opponentBoard.board[y][x];

  if (cell === 2 || cell === 3) {
    // Уже стреляли сюда
    return;
  }

  let hit = false;
  let shipSunk = false;
  let gameOver = false;

  if (cell === 1) {
    // Попадание
    hit = true;
    opponentBoard.board[y][x] = 2;

    // Проверяем потоплен ли корабль
    const hitShip = opponentBoard.ships.find((ship) => {
      for (let i = 0; i < ship.size; i++) {
        const shipX = ship.isHorizontal ? ship.x + i : ship.x;
        const shipY = ship.isHorizontal ? ship.y : ship.y + i;

        if (shipX === x && shipY === y) {
          return ship;
        }
      }
      return null;
    });

    if (hitShip) {
      // Проверяем все ли клетки корабля подбиты
      let allHit = true;
      for (let i = 0; i < hitShip.size; i++) {
        const shipX = hitShip.isHorizontal ? hitShip.x + i : hitShip.x;
        const shipY = hitShip.isHorizontal ? hitShip.y : hitShip.y + i;

        if (opponentBoard.board[shipY][shipX] !== 2) {
          allHit = false;
          break;
        }
      }

      shipSunk = allHit;

      // Проверяем конец игры
      if (shipSunk) {
        const allShipsSunk = opponentBoard.ships.every((ship) => {
          for (let i = 0; i < ship.size; i++) {
            const shipX = ship.isHorizontal ? ship.x + i : ship.x;
            const shipY = ship.isHorizontal ? ship.y : ship.y + i;

            if (opponentBoard.board[shipY][shipX] !== 2) {
              return false;
            }
          }
          return true;
        });

        if (allShipsSunk) {
          gameOver = true;
        }
      }
    }
  } else {
    opponentBoard.board[y][x] = 3; // Промах
  }

  // Отправляем результат выстрела
  broadcastToRoom(room, {
    type: "shot_result",
    x,
    y,
    hit,
    shipSunk,
    gameOver,
    playerId: ws.player.id,
  });

  if (gameOver) {
    broadcastToRoom(room, {
      type: "game_over",
      winner: ws.player.id,
    });
    resetGame(room);
  } else if (!hit) {
    // Передаем ход другому игроку
    room.currentPlayer = opponent;
    broadcastToRoom(room, {
      type: "turn_change",
      currentPlayer: opponent.player.id,
    });
  }
}

function handleChatMessage(ws, text) {
  const roomId = ws.player.room;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  broadcastToRoom(room, {
    type: "chat_message",
    playerId: ws.player.id,
    text: text,
  });
}

function handleDisconnect(ws) {
  if (ws.player.room) {
    leaveRoom(ws);
  }
}

function startGame(room) {
  room.gameStarted = true;
  room.shipsPlaced = 0;

  broadcastToRoom(room, {
    type: "game_starting",
  });

  // Обновляем список комнат для всех
  updateRoomInfo();
}

function resetGame(room) {
  room.gameStarted = false;
  room.shipsPlaced = 0;
  room.currentPlayer = null;

  // Очищаем доски
  room.boards.forEach((board, playerId) => {
    board.board = createEmptyBoard();
    board.ships = [];
  });

  // Обновляем список комнат для всех
  updateRoomInfo();
}

function broadcastToRoom(room, message) {
  room.players.forEach((player) => {
    if (player.readyState === WebSocket.OPEN) {
      player.send(JSON.stringify(message));
    }
  });
}

function sendToClient(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendRoomsList(ws) {
  const roomsList = Array.from(rooms.values()).map((room) => ({
    id: room.id,
    playersCount: room.players.length,
    gameStarted: room.gameStarted,
  }));

  sendToClient(ws, {
    type: "rooms_list",
    rooms: roomsList,
  });
}

function updateRoomInfo() {
  const roomsList = Array.from(rooms.values()).map((room) => ({
    id: room.id,
    playersCount: room.players.length,
    gameStarted: room.gameStarted,
  }));

  // Отправляем обновленный список комнат всем подключенным клиентам
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
