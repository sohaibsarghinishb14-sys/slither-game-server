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

// --- CONFIGURATION ---
// This is your "Bank" (Hostinger) URL
const YOUR_HOSTINGER_URL = "https://lightblue-mosquito-533363.hostersite.com";
// This is your secret password from update_balance.php
const SECRET_API_KEY = "MoroccoGame_777";
// --- END CONFIGURATION ---


// --- GAME ROOMS ---
const ROOMS = [
    { id: 'room1', name: 'Bronze Room', cost: 1 },
    { id: 'room2', name: 'Silver Room', cost: 5 },
    { id: 'room3', name: 'Gold Room', cost: 10 }
];

let gameInterval;
const TICK_RATE = 30; // 30 times per second

let snakes = {};
let food = {};

function initGame() {
    console.log("Initializing game rooms...");
    for (const room of ROOMS) {
        snakes[room.id] = [];
        food[room.id] = [];
        for (let i = 0; i < MAX_FOOD; i++) {
            food[room.id].push(new Food());
        }
    }
    
    if (gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, 1000 / TICK_RATE);
    console.log("Game server is running!");
}

// --- GAME LOOP ---
function gameLoop() {
    for (const room of ROOMS) {
        const roomSnakes = snakes[room.id];
        const roomFood = food[room.id];

        if (roomSnakes.length === 0) continue; 

        for (let i = roomSnakes.length - 1; i >= 0; i--) {
            const snake = roomSnakes[i];
            const state = snake.update();
            
            if (state === 'dead') {
                console.log(`${snake.name} hit a wall.`);
                handlePlayerDeath(snake, null, room.id);
                roomSnakes.splice(i, 1);
                continue;
            }

            const hitSnake = snake.checkSnakeCollision(roomSnakes);
            if (hitSnake) {
                console.log(`${snake.name} was killed by ${hitSnake.name}`);
                handlePlayerDeath(snake, hitSnake, room.id);
                roomSnakes.splice(i, 1);
                continue;
            }

            if (snake.checkFoodCollision(roomFood)) {
                if (roomFood.length < MAX_FOOD) {
                    roomFood.push(new Food());
                }
            }
        }

        const gameState = {
            snakes: roomSnakes.map(s => s.getData()),
            food: roomFood
        };
        io.to(room.id).emit('gameState', gameState);
    }
}

// --- PLAYER DEATH ---
function handlePlayerDeath(deadSnake, killerSnake, roomId) {
    io.to(deadSnake.id).emit('youDied', {
        killedBy: killerSnake ? killerSnake.name : 'The Wall'
    });

    const roomFood = food[roomId];
    
    // Create one big "Money Food" pellet
    const moneyPellet = new MoneyFood(
        deadSnake.x,
        deadSnake.y,
        deadSnake.balance 
    );
    roomFood.push(moneyPellet);

    if (killerSnake) {
        killerSnake.balance += deadSnake.balance;
        io.to(killerSnake.id).emit('kill', {
            victimName: deadSnake.name,
            amount: deadSnake.balance,
            newBalance: killerSnake.balance
        });
    }
    
    deadSnake.balance = 0;
}


// --- PLAYER CONNECTIONS ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.emit('roomList', ROOMS);

    socket.on('joinRoom', async (data) => {
        try {
            const { roomId, token, cost } = data;
            const room = ROOMS.find(r => r.id === roomId);
            if (!room) {
                return socket.emit('joinError', 'Room not found.');
            }
            
            // --- SECURITY CHECK ---
            // Ask your PHP "Bank" (Hostinger) if this token is real
            const response = await axios.post(`${YOUR_HOSTINGER_URL}/verify_token.php`, { 
                token: token,
                cost: room.cost // Send the cost to be subtracted
            });

            if (response.data.success) {
                const user = response.data.user;
                
                // Check if user has enough money (PHP already checked, but we double-check)
                if (user.balance < room.cost) {
                    return socket.emit('joinError', `You need $${room.cost} to join. You only have $${user.balance}.`);
                }

                const newSnake = new Snake(
                    socket.id,
                    user.username,
                    `hsl(${Math.random() * 360}, 100%, 50%)`,
                    room.cost 
                );
                
                snakes[roomId].push(newSnake);
                socket.join(roomId);
                
                socket.emit('joinSuccess', {
                    room: room.name,
                    balance: newSnake.balance
                });
                
                console.log(`${user.username} (Socket ${socket.id}) joined ${room.name}`);

            } else {
                return socket.emit('joinError', response.data.message || 'Invalid user token.');
            }
        } catch (error) {
            console.error("Join room error:", error.message);
            socket.emit('joinError', 'Server error. Could not verify user.');
        }
    });

    socket.on('updateAngle', (angle) => {
        let snake = null;
        for (const roomId in snakes) {
            snake = snakes[roomId].find(s => s.id === socket.id);
            if (snake) break;
        }

        if (snake) {
            snake.angle = angle;
        }
    });

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
        
        for (const rId in snakes) {
            const index = snakes[rId].findIndex(s => s.id === socket.id);
            if (index !== -1) {
                snake = snakes[rId][index];
                roomId = rId;
                snakes[rId].splice(index, 1); 
                break;
            }
        }

        if (snake && snake.balance > 0) {
            console.log(`Saving balance for ${snake.name}: $${snake.balance}`);
            try {
                // Send the winnings back to the "Bank" (Hostinger)
                await axios.post(`${YOUR_HOSTINGER_URL}/update_balance.php`, {
                    api_key: SECRET_API_KEY,      // The secret password
                    username: snake.name,         // The player's username
                    winnings: snake.balance       // The money they won
                });
                console.log(`Balance saved for ${snake.name}.`);
            } catch (error) {
                console.error(`Failed to save balance for ${snake.name}:`, error.message);
            }
        } else if (snake) {
            console.log(`${snake.name} left the game with $0.`);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    initGame();
});

