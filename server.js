// --- server.js (FINAL) ---
// This is the main "Game Arena" server that runs on Render.com
// This version matches game_logic.js (FINAL)

// --- Imports ---
const http = require('http'); // We use 'http' for the http fix
const { Server } = require("socket.io");
const axios = require('axios');
const { Game, init: initGameLogic } = require('./game_logic.js');

// --- Create HTTP Server ---
// We must create a basic HTTP server for Render's health checks
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is live and running.');
});

// --- Create Socket.io Server ---
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all connections
        methods: ["GET", "POST"]
    }
});

// --- Give socket.io instance to game_logic.js ---
// This is the fix for the `Game is not a constructor` error
initGameLogic(io);

// --- Get Secrets from Render Environment ---
// This is how we securely get your website URL and password
const HOSTINGER_URL = process.env.HOSTINGER_URL;
const SECRET_API_KEY = process.env.SECRET_API_KEY;

if (!HOSTINGER_URL || !SECRET_API_KEY) {
    console.error("FATAL ERROR: Environment variables HOSTINGER_URL or SECRET_API_KEY are not set.");
    console.error("Please set them in the Render.com Environment tab.");
    process.exit(1); // Stop the server
}

// --- Game Rooms ---
// We define the rooms here. This must match game.php.
const rooms = {
    'bronze': { name: 'Bronze Room', entryFee: 1 },
    'silver': { name: 'Silver Room', entryFee: 5 },
    'gold': { name: 'Gold Room', entryFee: 10 }
};

// This holds the "Game" object for each active room
const activeGames = {};

// --- Main Connection Handler ---
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    
    // Get user data from the connection
    const { userId, token } = socket.handshake.auth;

    if (!userId || !token) {
        console.log(`Connection from ${socket.id} rejected: Missing auth data.`);
        socket.emit('connect_error', 'Missing auth data. Please refresh.');
        socket.disconnect();
        return;
    }
    
    console.log(`Auth data received for UserID: ${userId}`);
    
    // 1. Send the list of rooms to the new player
    const roomList = Object.keys(rooms).map(id => ({
        id,
        name: rooms[id].name,
        entryFee: rooms[id].entryFee
    }));
    socket.emit('room-list', roomList);

    // 2. Handle player joining a room
    socket.on('join-room', async (roomId) => {
        console.log(`UserID ${userId} (Socket ${socket.id}) trying to join room: ${roomId}`);
        
        const room = rooms[roomId];
        if (!room) {
            socket.emit('join-error', 'Room does not exist.');
            return;
        }

        try {
            // --- Call the "Bank" (Hostinger) ---
            // We call your verify_token.php file to check the user.
            
            console.log(`Calling Hostinger API at ${HOSTINGER_URL}/verify_token.php`);
            
            // This is the "http" fix for the Hostinger SSL error
            const verifyResponse = await axios.post(
                `${HOSTINGER_URL}/verify_token.php`,
                {
                    api_key: SECRET_API_KEY,
                    userId: userId,
                    token: token,
                    entryFee: room.entryFee
                },
                {
                    // This is the "http" fix
                    // It tells axios to ignore the bad SSL certificate
                    httpAgent: new http.Agent({ rejectUnauthorized: false }),
                    httpsAgent: new http.Agent({ rejectUnauthorized: false })
                }
            );
            
            const userData = verifyResponse.data;
            
            if (!userData.success) {
                console.log(`Join failed for UserID ${userId}: ${userData.message}`);
                socket.emit('join-error', userData.message);
                return;
            }

            console.log(`User ${userId} (${userData.user.username}) verified!`);

            // --- Join Game ---
            // If the game room doesn't exist, create it
            if (!activeGames[roomId]) {
                activeGames[roomId] = new Game(roomId);
            }
            const game = activeGames[roomId];
            
            // Add the player to the game
            // We pass the full socket object here, as expected by game_logic.js
            const player = game.addPlayer(socket, userData.user, room.entryFee);
            socket.join(roomId);
            
            console.log(`Player ${player.username} joined room ${roomId} with balance ${player.balance}`);
            
            // Send join success message to the player
            socket.emit('join-success', game.getState());

        } catch (error) {
            let errorMsg = "Server error. Could not verify user.";
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                console.error("Hostinger API Error:", error.response.status, error.response.data);
                errorMsg = `API Error: ${error.response.data.message || error.response.status}`;
            } else if (error.request) {
                // The request was made but no response was received
                console.error("Hostinger No Response:", error.request);
                errorMsg = "No response from validation server.";
            } else {
                // Something happened in setting up the request
                console.error("Axios Error:", error.message);
                errorMsg = `Connection Error: ${error.message}`;
            }
            socket.emit('join-error', errorMsg);
        }
    });

    // 3. Handle player input
    socket.on('player-input', (input) => {
        // Find which game this player is in
        const game = findGameBySocketId(socket.id);
        if (game) {
            game.handlePlayerInput(socket.id, input);
        }
    });

    // 4. Handle player leaving (voluntarily)
    socket.on('leave-game', async () => {
        await handlePlayerLeave(socket, "You left the game.");
    });

    // 5. Handle player disconnecting (closing browser)
    socket.on('disconnect', async () => {
        console.log(`Socket disconnected: ${socket.id}`);
        await handlePlayerLeave(socket, "You were disconnected.");
    });
});

// --- Game Loop ---
// This runs 20 times per second
const TICK_RATE = 1000 / 20; 
setInterval(() => {
    // Update every active game
    for (const roomId in activeGames) {
        const game = activeGames[roomId];
        game.update();
        
        // Send the new game state to all players in that room
        io.to(roomId).emit('game-state', game.getState());
    }
}, TICK_RATE);


// --- Helper Functions ---
function findGameBySocketId(socketId) {
    for (const roomId in activeGames) {
        if (activeGames[roomId].players[socketId]) {
            return activeGames[roomId];
        }
    }
    return null;
}

async function handlePlayerLeave(socket, message) {
    const game = findGameBySocketId(socket.id);
    if (!game) {
        console.log(`handlePlayerLeave: Player ${socket.id} not in a game.`);
        return;
    }
    
    // Remove player from the game
    const player = game.removePlayer(socket.id);
    if (!player) {
        console.log(`handlePlayerLeave: Player ${socket.id} not found in game ${game.roomId}.`);
        return;
    }
    
    // We need the player's database ID, which we get from the auth token
    const { userId } = socket.handshake.auth;

    console.log(`Player ${player.username} (DB ID: ${userId}) left game ${game.roomId} with final balance $${player.balance}`);
    
    // --- Save Winnings to "Bank" (Hostinger) ---
    try {
        console.log(`Calling Hostinger update_balance.php for UserID ${userId}`);
        
        await axios.post(
            `${HOSTINGER_URL}/update_balance.php`,
            {
                user_id: userId, // Use the database ID
                new_balance: player.balance
            },
            {
                // This is the "http" fix
                httpAgent: new http.Agent({ rejectUnauthorized: false }),
                httpsAgent: new http.Agent({ rejectUnauthorized: false }),
                // We send the API key in the headers for this file
                headers: {
                    'X-API-Key': SECRET_API_KEY
                }
            }
        );
        
        console.log(`Balance for UserID ${userId} updated successfully.`);
        
        // Tell the player their final balance was saved
        socket.emit('game-over', {
            message: message,
            finalBalance: player.balance
        });

    } catch (error) {
        let errorMsg = "Server error. Could not save balance.";
        if (error.response) {
            console.error("Hostinger API Error (update_balance):", error.response.status, error.response.data);
            errorMsg = `API Error: ${error.response.data.message || error.response.status}`;
        } else if (error.request) {
            console.error("Hostinger No Response (update_balance):", error.request);
            errorMsg = "No response from balance server.";
        } else {
            console.error("Axios Error (update_balance):", error.message);
            errorMsg = `Connection Error: ${error.message}`;
        }
        
        // Tell the player we could not save their balance
        socket.emit('game-over', {
            message: `CRITICAL ERROR: ${errorMsg} Your final balance of $${player.balance} was NOT saved. Please contact support.`,
            finalBalance: player.balance
        });
    }
    
    // Make sure player leaves the socket.io room
    socket.leave(game.roomId);
}


// --- Start Server ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server is live and running on port ${PORT}`);
});
