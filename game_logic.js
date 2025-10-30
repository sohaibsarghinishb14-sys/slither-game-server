// This is the correct "FINAL" game_logic.js from your summary.
// It is compatible with your "FINAL" server.js.

// --- Game Settings ---
const WORLD_SIZE = 3000;
const PLAYER_START_SPEED = 2.5;
const PLAYER_BOOST_SPEED = 5;
const PLAYER_START_SIZE = 10;
const PLAYER_MIN_LENGTH = 10;
const FOOD_COUNT = 250;
const FOOD_SIZE = 5;
const FOOD_VALUE = 0.01; // How much balance each food pellet is worth
const BOOST_COST = 0.02; // How much balance is lost per tick when boosting
const SEGMENT_DISTANCE = 5; // Distance between body segments

// --- Helper Functions ---
function getRandomColor() {
    return `hsl(${Math.random() * 360}, 100%, 50%)`;
}
function getRandomPosition() {
    return {
        x: Math.random() * (WORLD_SIZE - 100) + 50,
        y: Math.random() * (WORLD_SIZE - 100) + 50
    };
}
function getDistance(obj1, obj2) {
    return Math.hypot(obj1.x - obj2.x, obj1.y - obj2.y);
}


// --- Snake Class ---
class Snake {
    constructor(id, username, startBalance) {
        this.id = id;
        this.username = username;
        this.balance = startBalance; // Balance is now our "score"
        this.size = PLAYER_START_SIZE;
        this.speed = PLAYER_START_SPEED;
        this.angle = Math.random() * Math.PI * 2;
        this.color = getRandomColor();
        this.isBoosting = false;
        
        const startPos = getRandomPosition();
        this.body = [];
        // Calculate length based on balance
        let length = PLAYER_MIN_LENGTH + Math.floor(this.balance / FOOD_VALUE);
        if (length < PLAYER_MIN_LENGTH) length = PLAYER_MIN_LENGTH;
        
        for (let i = 0; i < length; i++) {
            this.body.push({
                x: startPos.x - Math.cos(this.angle) * i * SEGMENT_DISTANCE,
                y: startPos.y - Math.sin(this.angle) * i * SEGMENT_DISTANCE
            });
        }
    }
    
    get head() {
        return this.body[0];
    }
    
    get length() {
        return this.body.length;
    }

    update() {
        // 1. Set speed based on boosting
        if (this.isBoosting && this.balance > BOOST_COST) {
            this.speed = PLAYER_BOOST_SPEED;
            // Cost of boosting
            this.balance -= BOOST_COST; 
            
            // Only shrink if we have more than min length
            if (this.length > PLAYER_MIN_LENGTH) {
                 this.body.pop(); // Remove tail segment
            }
           
        } else {
            this.speed = PLAYER_START_SPEED;
        }

        // 2. Move body segments (from tail to head)
        for (let i = this.length - 1; i > 0; i--) {
            const leader = this.body[i - 1];
            const follower = this.body[i];
            
            const dx = leader.x - follower.x;
            const dy = leader.y - follower.y;
            const dist = Math.hypot(dx, dy);

            if (dist > SEGMENT_DISTANCE) {
                const moveRatio = (dist - SEGMENT_DISTANCE) / dist;
                follower.x += dx * moveRatio;
                follower.y += dy * moveRatio;
            }
        }

        // 3. Move head
        this.head.x += Math.cos(this.angle) * this.speed;
        this.head.y += Math.sin(this.angle) * this.speed;
        
        // 4. Check wall collision
        if (this.head.x < 0 || this.head.x > WORLD_SIZE || this.head.y < 0 || this.head.y > WORLD_SIZE) {
            return 'dead'; // Player died
        }
        return 'alive';
    }
    
    // Add one segment to the tail
    grow() {
        this.body.push({ ...this.body[this.length - 1] });
    }

    // This returns a simplified object for sending to clients
    getState() {
        return {
            id: this.id,
            username: this.username,
            balance: this.balance,
            size: this.size,
            angle: this.angle,
            color: this.color,
            body: this.body
        };
    }
}


// --- Game Class ---
// This class manages an entire room (like "Bronze Room")
class Game {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {}; // Stores all Snake objects
        this.food = [];
        this.lastUpdateTime = Date.now();
        
        // Create initial food
        for (let i = 0; i < FOOD_COUNT; i++) {
            this.spawnFood();
        }
    }

    spawnFood(position = null) {
        const pos = position || getRandomPosition();
        this.food.push({
            x: pos.x,
            y: pos.y,
            size: FOOD_SIZE,
            color: `hsl(${Math.random() * 360}, 100%, 70%)`
        });
    }

    addPlayer(socket, userData, entryFee) {
        // This function expects the full `socket` object
        const player = new Snake(socket.id, userData.username, entryFee);
        this.players[socket.id] = player;
        return player;
    }

    removePlayer(id) {
        const player = this.players[id];
        delete this.players[id];
        return player; // Return the player who was removed
    }

    handlePlayerInput(id, input) {
        const player = this.players[id];
        if (player) {
            player.angle = input.angle;
            player.isBoosting = input.boost;
        }
    }
    
    // This is the main game loop, run by server.js
    update() {
        const now = Date.now();
        const deltaTime = (now - this.lastUpdateTime) / 1000; // Time in seconds
        this.lastUpdateTime = now;

        const deadPlayers = [];
        
        // 1. Update all players
        for (const id in this.players) {
            const player = this.players[id];
            const state = player.update();
            if (state === 'dead') {
                deadPlayers.push(id);
            }
        }
        
        // 2. Check collisions
        for (const id in this.players) {
            const player = this.players[id];
            if (!player) continue;

            // 2a. Check food collision
            for (let i = this.food.length - 1; i >= 0; i--) {
                const f = this.food[i];
                const dist = getDistance(player.head, f);
                if (dist < player.size + f.size) {
                    this.food.splice(i, 1); // Eat food
                    player.grow();
                    player.balance += FOOD_VALUE;
                    this.spawnFood(); // Spawn new food
                }
            }
            
            // 2b. Check snake-on-snake collision
            for (const otherId in this.players) {
                if (id === otherId) continue;
                const otherPlayer = this.players[otherId];
                
                // Check if player's head hit any part of otherPlayer's body
                for (let i = 0; i < otherPlayer.length; i++) {
                    const segment = otherPlayer.body[i];
                    const dist = getDistance(player.head, segment);
                    if (dist < player.size) { // Hit!
                        // The killer (otherPlayer) gets the victim's (player) balance
                        if (otherPlayer) {
                             otherPlayer.balance += player.balance;
                        }
                        deadPlayers.push(id);
                        break;
                    }
                }
                // Break outer loop if player is already marked dead
                if (deadPlayers.includes(id)) break;
            }
        }
        
        // 3. Remove dead players and drop their food
        for (const id of deadPlayers) {
            const deadPlayer = this.players[id];
            if (!deadPlayer) continue;

            // Drop all their balance as food pellets
            const foodToDrop = deadPlayer.length;
            for (let i = 0; i < foodToDrop; i++) {
                // Drop food pellets along the snake's body
                this.spawnFood(deadPlayer.body[i]);
            }
            
            // Tell the server this player is dead
            const socket = io.sockets.sockets.get(id);
            if (socket) {
                socket.emit('player-died', 'You were killed! Your balance was transferred.');
                this.removePlayer(id);
                socket.leave(this.roomId);
            }
        }
    }
    
    // Get a simplified state to send to all clients
    getState() {
        const simplePlayers = {};
        for (const id in this.players) {
            simplePlayers[id] = this.players[id].getState();
        }
        
        return {
            worldSize: WORLD_SIZE,
            food: this.food,
            players: simplePlayers
        };
    }
}

// --- This is the fix for the `Game is not a constructor` error ---
// We export the Game class so server.js can import it.
module.exports = { Game };

// We need a global `io` variable for the Game class to be able to
// emit messages to players. This is set by server.js.
let io;
module.exports.init = (socketIoInstance) => {
    io = socketIoInstance;
};
