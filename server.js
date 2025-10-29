// This is the main "Game Arena" server
// It runs 24/7 on Render.com

console.log("Starting server...");

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const axios = require('axios'); // Used to talk to your PHP "Bank"
const { Snake, Food, MoneyFood, GAME_WORLD_SIZE, MAX_FOOD } = require('./game_logic.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all websites to connect
        methods: ["GET", "POST"]
    }
});

// We will change this URL later to your real Hostinger website URL
const YOUR_HOSTINGER_URL = "https://your-website.com";

// --- GAME ROOMS ---
// This is the "DamnBruh" setup
const ROOMS = [
    { id: 'room1', name: 'Bronze Room', cost: 1 },
    { id: 'room2', name: 'Silver Room', cost: 5 },
    { id: 'room3', name: 'Gold Room', cost: 10 }
];

let gameInterval;
const TICK_RATE = 30; // 30 times per second

// All snakes and food, separated by room
let snakes = {};
let food = {};

// Initialize game state for all rooms
function initGame() {
    console.log("Initializing game rooms...");
    for (const room of ROOMS) {
        snakes[room.id] = [];
        food[room.id] = [];
        for (let i = 0; i < MAX_FOOD; i++) {
            food[room.id].push(new Food());
        }
    }
    
    // Start the game loop
    if (gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, 1000 / TICK_RATE);
    console.log("Game server is running!");
}

// --- GAME LOOP ---
// This runs 30 times every second
function gameLoop() {
    for (const room of ROOMS) {
        const roomSnakes = snakes[room.id];
        const roomFood = food[room.id];

        if (roomSnakes.length === 0) continue; // Skip empty rooms

        // 1. Update all snakes
        for (let i = roomSnakes.length - 1; i >= 0; i--) {
            const snake = roomSnakes[i];
            const state = snake.update();
            
            if (state === 'dead') {
                // Snake hit a wall
                console.log(`${snake.name} hit a wall.`);
                handlePlayerDeath(snake, null, room.id);
                roomSnakes.splice(i, 1);
                continue;
            }

            // 2. Check for snake-on-snake collisions
            const hitSnake = snake.checkSnakeCollision(roomSnakes);
            if (hitSnake) {
                console.log(`${snake.name} was killed by ${hitSnake.name}`);
                handlePlayerDeath(snake, hitSnake, room.id);
                roomSnakes.splice(i, 1);
                continue;
            }

            // 3. Check for food collisions
            if (snake.checkFoodCollision(roomFood)) {
                // Ate food, add a new one
                if (roomFood.length < MAX_FOOD) {
                    roomFood.push(new Food());
                }
            }
        }

        // 4. Send the new game state to all players in this room
        const gameState = {
            snakes: roomSnakes.map(s => s.getData()),
            food: roomFood
        };
        io.to(room.id).emit('gameState', gameState);
    }
}

// --- PLAYER DEATH ---
function handlePlayerDeath(deadSnake, killerSnake, roomId) {
    // 1. Tell the dead player they died
    io.to(deadSnake.id).emit('youDied', {
        killedBy: killerSnake ? killerSnake.name : 'The Wall'
    });

    // 2. Drop "Money Food"
    const roomFood = food[roomId];
    
    // Create one big "Money Food" pellet where the snake died
    const moneyPellet = new MoneyFood(
        deadSnake.x,
        deadSnake.y,
        deadSnake.balance // The pellet is worth the dead snake's balance
    );
    roomFood.push(moneyPellet);

    // 3. Update balances
    if (killerSnake) {
        killerSnake.balance += deadSnake.balance;
        // Tell the killer they earned money
        io.to(killerSnake.id).emit('kill', {
            victimName: deadSnake.name,
            amount: deadSnake.balance,
            newBalance: killerSnake.balance
        });
    }
    
    // The dead snake's balance is now 0
    deadSnake.balance = 0;
}


// --- PLAYER CONNECTIONS ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send the list of rooms to the new player
    socket.emit('roomList', ROOMS);

    // Player tries to join a room
    socket.on('joinRoom', async (data) => {
        try {
            const { roomId, token } = data;
            const room = ROOMS.find(r => r.id === roomId);
            if (!room) {
                return socket.emit('joinError', 'Room not found.');
            }

            console.log(`Player joining room ${roomId} with token ${token}`);

            // --- SECURITY CHECK ---
            // Ask your PHP "Bank" (Hostinger) if this token is real
            const response = await axios.post(`${YOUR_HOSTINGER_URL}/verify_token.php`, { token });

            if (response.data.success) {
                const user = response.data.user;
                
                // 1. Check if user has enough money
                if (user.balance < room.cost) {
                    return socket.emit('joinError', `You need $${room.cost} to join. You only have $${user.balance}.`);
                }

                // 2. Create the new snake
                const newSnake = new Snake(
                    socket.id,
                    user.username,
                    user.color || `hsl(${Math.random() * 360}, 100%, 50%)`,
                    room.cost // The snake's life is worth the room cost
                );
                
                snakes[roomId].push(newSnake);
                socket.join(roomId);
                
                // 3. Tell the player they are in
                socket.emit('joinSuccess', {
                    room: room.name,
                    balance: newSnake.balance
                });
                
                console.log(`${user.username} (Socket ${socket.id}) joined ${room.name}`);

            } else {
                return socket.emit('joinError', 'Invalid user token. Please log in again.');
            }
        } catch (error) {
            console.error("Join room error:", error.message);
            socket.emit('joinError', 'Server error. Could not verify user.');
        }
    });

    // Player sends their mouse movement
    socket.on('updateAngle', (angle) => {
        // Find the snake for this socket
        let snake = null;
        for (const roomId in snakes) {
            snake = snakes[roomId].find(s => s.id === socket.id);
            if (snake) break;
        }

        if (snake) {
            snake.angle = angle;
        }
    });

    // Player sends boost state
    socket.on('updateBoost', (isBoosting) => {
        let snake = null;
        for (const roomId in snakes) {
            snake = snakes[roomId].find(s => s.id === socket.id);
            if (snake) break;
        }
        
        if (snake) {
            snake.isBoosting = isBoosting;
        }
    });

    // Player leaves the game (disconnects or "Q" key)
    socket.on('leaveGame', () => {
        handleDisconnect();
    });
    
    socket.on('disconnect', () => {
        handleDisconnect();
        console.log('User disconnected:', socket.id);
    });

    async function handleDisconnect() {
        let snake = null;
        let roomId = null;
        
        // Find and remove snake from the game
        for (const rId in snakes) {
            const index = snakes[rId].findIndex(s => s.id === socket.id);
            if (index !== -1) {
                snake = snakes[rId][index];
                roomId = rId;
                snakes[rId].splice(index, 1); // Remove snake
                break;
            }
        }

        if (snake && snake.balance > 0) {
            // Player left with money! Save it to their "Bank" (Hostinger)
            console.log(`Saving balance for ${snake.name}: $${snake.balance}`);
            try {
                // We will update this URL later
                await axios.post(`${YOUR_HOSTINGER_URL}/update_balance.php`, {
                    user_id: snake.name, // We used username as the ID
                    new_balance: snake.balance
                });
                console.log(`Balance saved for ${snake.name}.`);
            } catch (error) {
                console.error(`Failed to save balance for ${snake.name}:`, error.message);
                // What to do here? Maybe email yourself?
            }
        } else if (snake) {
            // Player died and had 0 balance, just left
            console.log(`${snake.name} left the game with $0.`);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    initGame();
});
