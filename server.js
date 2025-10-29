// --- IMPORTS ---
// This is a Node.js server. It uses Express and Socket.io.
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios'); // To talk to your PHP backend
const https = require('https'); // Import the HTTPS module

// THIS IS THE FIX: We now correctly import the Game class
const { Game } = require('./game_logic.js');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000; // Render.com gives us the port

// --- ENVIRONMENT VARIABLES ---
// We get these from the Render.com "Environment" settings
const HOSTINGER_URL = process.env.HOSTINGER_URL;
const SECRET_API_KEY = process.env.SECRET_API_KEY;

if (!HOSTINGER_URL || !SECRET_API_KEY) {
    console.error("FATAL ERROR: Environment variables HOSTINGER_URL or SECRET_API_KEY are not set.");
    console.error("Please add them to your Render.com Environment settings.");
    process.exit(1); // Stop the server if config is missing
}

// --- HTTPS AGENT (THE FIX for Hostinger SSL) ---
const httpsAgent = new https.Agent({
    rejectUnauthorized: false // This tells Node.js to trust the self-signed/mismatched certificate
});

// --- ROOMS CONFIGURATION ---
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
const games = {};
for (let roomId in ROOMS) {
    // THIS IS THE FIX: We can now correctly create a new Game
    games[roomId] = new Game(roomId);
    console.log(`Game room '${roomId}' created.`);
}

// --- PLAYER MANAGEMENT ---
const players = {};

// --- API FUNCTIONS (Talking to Hostinger) ---
async function verifyAndChargePlayer(token, roomId) {
    const room = ROOMS[roomId];
    if (!room) {
        throw new Error('Invalid room ID');
    }

    try {
        const response = await axios.post(`${HOSTINGER_URL}/verify_token.php`, {
            api_key: SECRET_API_KEY,
            game_token: token,
            entry_fee: room.entryFee
        }, {
            httpsAgent: httpsAgent // Use the fix for Hostinger SSL
        });

        if (response.data && response.data.success) {
            return response.data; // { success: true, user: {...}, new_balance: ... }
        } else {
            throw new Error(response.data.message || 'Verification failed');
        }
    } catch (error) {
        console.error('Error verifying token:', error.response ? error.response.data : error.message);
        throw new Error(error.response ? error.response.data.message : 'Could not contact verification server.');
    }
}

async function savePlayerBalance(userId, newBalance) {
    try {
        const response = await axios.post(`${HOSTINGER_URL}/update_balance.php`, {
            api_key: SECRET_API_KEY,
            user_id: userId,
            new_balance: newBalance
        }, {
            httpsAgent: httpsAgent // Use the fix for Hostinger SSL
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


// --- REAL-TIME GAME LOGIC (Socket.io) ---
io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    /**
     * Player wants to join a game
     */
    socket.on('joinGame', async (data) => {
        const { token, roomId } = data;

        if (!games[roomId]) {
            return socket.emit('joinError', 'Invalid game room.');
        }

        try {
            // Step 1 & 2: Verify and Charge (Talk to Hostinger)
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
                balance: new_balance, // Their *new total* site balance (after paying fee)
                inGameBalance: room.entryFee, // The money they have in *this* game
                snake: snake,
                room: roomId,
                token: token
            };

            socket.join(roomId);
            console.log(`Player ${user.username} (Socket: ${socket.id}) joined room ${roomId}.`);

            // Tell the player they are in
            socket.emit('gameJoined', {
                gameState: game.getState(),
                playerId: socket.id,
                inGameBalance: room.entryFee
            });

        } catch (error) {
            console.error(`Join game error for ${socket.id}: ${error.message}`);
            socket.emit('joinError', error.message);
        }
    });

    /**
     * Player moved their mouse
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
     */
    socket.on('leaveGame', async () => {
        const player = players[socket.id];
        if (!player) {
            return;
        }
        
        // This is the money they have in the game right now
        const finalInGameBalance = player.inGameBalance;
        // This is the *new total* they will have on the site
        const finalTotalBalance = player.balance + finalInGameBalance;

        console.log(`Player ${player.username} leaving. In-game: ${finalInGameBalance}. Saving new total: ${finalTotalBalance}`);

        try {
            // Save the new total balance to the main database
            await savePlayerBalance(player.db_id, finalTotalBalance);
            socket.emit('leaveSuccess', 'Your balance has been saved.');
        } catch (error) {
            console.error(`Failed to save balance for ${player.username}: ${error.message}`);
            socket.emit('leaveError', 'Could not save your balance. Please contact support.');
        }

        // Remove player from the game
        const game = games[player.room];
        if (game) {
            game.removePlayer(socket.id);
        }
        delete players[socket.id];
        socket.leave(player.room);
    });

    /**
     * Player disconnected (closed browser)
     */
    socket.on('disconnect', async () => {
        console.log(`A user disconnected: ${socket.id}`);
        const player = players[socket.id];
        
        if (player) {
            // Player was in a game, we must save their balance
            const finalInGameBalance = player.inGameBalance;
            const finalTotalBalance = player.balance + finalInGameBalance;
            
            console.log(`Player ${player.username} disconnected. Saving final balance: ${finalTotalBalance}`);

            try {
                await savePlayerBalance(player.db_id, finalTotalBalance);
            } catch (error) {
                console.error(`Failed to save balance on disconnect for ${player.username}: ${error.message}`);
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
    if (httpsAgent.options.rejectUnauthorized === false) {
        console.log("WARNING: Ignoring SSL certificate errors. (This is the fix for Hostinger free domain).");
    }
});

