// --- IMPORTS ---
// This is a Node.js server. It uses Express and Socket.io.
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios'); // To talk to your PHP backend
const { Game } = require('./game_logic.js'); // Import our game classes

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000; // Render.com gives us the port

// --- ENVIRONMENT VARIABLES ---
// We get these from the Render.com "Environment" settings
// This is the secure way to store passwords.
const HOSTINGER_URL = process.env.HOSTINGER_URL;
const SECRET_API_KEY = process.env.SECRET_API_KEY;

if (!HOSTINGER_URL || !SECRET_API_KEY) {
    console.error("FATAL ERROR: Environment variables HOSTINGER_URL or SECRET_API_KEY are not set.");
    console.error("Please add them to your Render.com Environment settings.");
    process.exit(1); // Stop the server if config is missing
}

// --- ROOMS CONFIGURATION ---
// This defines your game rooms
const ROOMS = {
    'bronze': { name: 'Bronze Room', entryFee: 1 },
    'silver': { name: 'Silver Room', entryFee: 5 },
    'gold': { name: 'Gold Room', entryFee: 10 }
};

// --- SERVER SETUP ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow connections from any website
        methods: ["GET", "POST"]
    }
});

// --- GAME STATE ---
// This object will hold all our live game rooms
// e.g., games['bronze'] = new Game();
const games = {};

// Initialize game instances for each room
for (let roomId in ROOMS) {
    games[roomId] = new Game(roomId);
    console.log(`Game room '${roomId}' created.`);
}

// --- PLAYER MANAGEMENT ---
// This object holds all connected players
// Key: socket.id, Value: player's game data
const players = {};

// --- API FUNCTIONS ---
// These functions talk to your Hostinger "Bank"

/**
 * Asks your Hostinger PHP backend if a user is real and can play.
 * @param {string} token - The game_token from the user's session
 * @param {string} roomId - The ID of the room (e.g., 'bronze')
 * @returns {Promise<object>} - A promise that resolves with user data or rejects with an error
 */
async function verifyAndChargePlayer(token, roomId) {
    const room = ROOMS[roomId];
    if (!room) {
        throw new Error('Invalid room ID');
    }

    try {
        // This is the "secure phone call" to your Hostinger Bank
        const response = await axios.post(`${HOSTINGER_URL}/verify_token.php`, {
            api_key: SECRET_API_KEY,
            game_token: token,
            entry_fee: room.entryFee
        });

        if (response.data && response.data.success) {
            // Player is real and has been charged.
            return response.data;
        } else {
            // Player is real but failed (e.g., not enough money)
            throw new Error(response.data.message || 'Verification failed');
        }
    } catch (error) {
        // This catches network errors or 500 errors from PHP
        console.error('Error verifying token:', error.response ? error.response.data : error.message);
        throw new Error(error.response ? error.response.data.message : 'Could not contact verification server.');
    }
}

/**
 * Asks your Hostinger PHP backend to save the user's final balance.
 * @param {number} userId - The user's database ID
 * @param {number} newBalance - The user's final total balance
 * @returns {Promise<object>} - A promise that resolves with success or rejects
 */
async function savePlayerBalance(userId, newBalance) {
    try {
        // This is the "secure phone call" to save the money
        const response = await axios.post(`${HOSTINGER_URL}/update_balance.php`, {
            api_key: SECRET_API_KEY,
            user_id: userId,
            new_balance: newBalance
        });

        if (response.data && response.data.success) {
            return response.data;
        } else {
            throw new Error(response.data.message || 'Failed to save balance');
        }
    } catch (error) {
        console.error('Error saving balance:', error.response ? error.response.data : error.message);
        throw new Error(error.response ? error.response.data.message : 'Could not contact update server.');
    }
}


// --- REAL-TIME GAME LOGIC ---

// This runs when a new player connects to the server
io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    /**
     * Player wants to join a game
     * 1. Verify their token (calls PHP)
     * 2. If OK, charge their account (PHP does this)
     * 3. Add them to the game
     */
    socket.on('joinGame', async (data) => {
        const { token, roomId } = data;

        if (!games[roomId]) {
            return socket.emit('joinError', 'Invalid game room.');
        }

        try {
            // Step 1 & 2: Verify and Charge
            const { user, new_balance } = await verifyAndChargePlayer(token, roomId);
            const room = ROOMS[roomId];

            // Step 3: Add player to the game
            const game = games[roomId];
            const snake = game.addPlayer(socket.id, user.username, room.entryFee);

            // Store player data
            players[socket.id] = {
                id: socket.id,
                db_id: user.id, // The user's ID from the database
                username: user.username,
                balance: user.balance, // Their *total* site balance
                inGameBalance: room.entryFee, // The money they have in *this* game
                snake: snake,
                room: roomId,
                token: token
            };

            socket.join(roomId);
            console.log(`Player ${user.username} (Socket: ${socket.id}) joined room ${roomId}.`);

            // Tell the player they are in, and what the game state is
            socket.emit('gameJoined', {
                gameState: game.getState(),
                playerId: socket.id,
                inGameBalance: room.entryFee
            });

        } catch (error) {
            // This happens if PHP says "not enough money" or "invalid token"
            console.error(`Join game error for ${socket.id}: ${error.message}`);
            socket.emit('joinError', error.message);
        }
    });

    /**
     * Player moved their mouse
     * We get the angle and update their snake's direction
     */
    socket.on('playerInput', (data) => {
        const player = players[socket.id];
        if (player && player.snake && !player.snake.isDead) {
            const game = games[player.room];
            game.updatePlayerAngle(socket.id, data.angle);
        }
    });

    /**
     * Player is boosting (left-click)
     */
    socket.on('playerBoost', (isBoosting) => {
        const player = players[socket.id];
        if (player && player.snake && !player.snake.isDead) {
            const game = games[player.room];
            game.updatePlayerBoost(socket.id, isBoosting);
        }
    });

    /**
     * Player wants to leave the game
     * 1. Get their final in-game balance
     * 2. Tell Hostinger to save their new *total* balance
     * 3. Remove them from the game
     */
    socket.on('leaveGame', async () => {
        const player = players[socket.id];
        if (!player) {
            return; // Player already left or never joined
        }

        // Calculate their final total balance
        const inGameWinnings = player.inGameBalance - player.snake.initialBalance;
        const finalTotalBalance = player.balance + inGameWinnings;

        console.log(`Player ${player.username} leaving. In-game balance: ${player.inGameBalance}. Total balance to save: ${finalTotalBalance}`);

        try {
            // Save the new total balance to the main database
            await savePlayerBalance(player.db_id, finalTotalBalance);
            socket.emit('leaveSuccess', 'Your balance has been saved.');
        } catch (error) {
            console.error(`Failed to save balance for ${player.username}: ${error.message}`);
            socket.emit('leaveError', 'Could not save your balance. Please contact support.');
        }

        // Remove player from the game, regardless of save success
        const game = games[player.room];
        if (game) {
            game.removePlayer(socket.id);
        }
        delete players[socket.id];
        socket.leave(player.room);
    });

    /**
     * Player disconnected (closed browser)
     * This is like 'leaveGame', but we can't tell the user anything
     */
    socket.on('disconnect', async () => {
        console.log(`A user disconnected: ${socket.id}`);
        const player = players[socket.id];
        
        if (player) {
            // Player was in a game, we must save their balance
            const inGameWinnings = player.inGameBalance - player.snake.initialBalance;
            const finalTotalBalance = player.balance + inGameWinnings;
            
            console.log(`Player ${player.username} disconnected. Saving final balance: ${finalTotalBalance}`);

            try {
                // Save the new total balance to the main database
                await savePlayerBalance(player.db_id, finalTotalBalance);
            } catch (error) {
                console.error(`Failed to save balance on disconnect for ${player.username}: ${error.message}`);
                // We can't tell the user, they are already gone
            }

            // Remove player from the game
            const game = games[player.room];
            if (game) {
                game.removePlayer(socket.id);
            }
            delete players[socket.id];
        }
    });
});

// --- GAME LOOP ---
// This is the "heartbeat" of the game.
// 20 times per second, it updates the game and sends the new state to all players.
const TICK_RATE = 20; // 20 updates per second
const aTICK_TIME = 1000 / TICK_RATE;

setInterval(() => {
    // Loop through all active game rooms
    for (let roomId in games) {
        const game = games[roomId];
        
        // 1. Update the game state (move snakes, check collisions)
        const killEvents = game.update();

        // 2. Handle kill events (transfer money)
        for (const event of killEvents) {
            const killer = players[event.killerId];
            const victim = players[event.victimId];

            if (killer && victim) {
                const moneyStolen = victim.inGameBalance;
                killer.inGameBalance += moneyStolen;
                victim.inGameBalance = 0; // Victim loses all their money

                // Notify killer and victim of the balance change
                io.to(killer.id).emit('balanceUpdate', killer.inGameBalance);
                io.to(victim.id).emit('balanceUpdate', victim.inGameBalance);
                
                console.log(`Kill: ${killer.username} killed ${victim.username} and stole ${moneyStolen}`);
            }
        }

        // 3. Get the new, simplified game state
        const gameState = game.getState();

        // 4. Send the new state to all players in that room
        io.to(roomId).emit('gameState', gameState);
    }
}, aTICK_TIME);

// --- START THE SERVER ---
server.listen(PORT, () => {
    console.log(`--- Slither Game Server ---`);
    console.log(`Server is live and running on port ${PORT}`);
    console.log(`Connecting to Hostinger at: ${HOSTINGER_URL}`);
});

