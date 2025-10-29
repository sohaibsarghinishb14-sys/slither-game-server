// --- GAME SETTINGS ---
const WORLD_SIZE = 3000;
const PLAYER_START_SPEED = 2.5;
const PLAYER_BOOST_SPEED = 4;
const PLAYER_START_LENGTH = 15;
const MIN_PLAYER_LENGTH = 10;
const FOOD_COUNT = 250;
const FOOD_SIZE = 5;
const PLAYER_RADIUS = 10; // Snake segment radius
const BOOST_SHRINK_RATE = 10; // Frames per segment loss
const SEGMENT_DISTANCE = 5; // Distance between segments (PLAYER_RADIUS * 0.5)

// --- FOOD CLASS ---
class Food {
    constructor() {
        this.x = Math.random() * WORLD_SIZE;
        this.y = Math.random() * WORLD_SIZE;
        this.color = `hsl(${Math.random() * 360}, 100%, 70%)`;
        this.size = FOOD_SIZE;
    }
}

// --- SNAKE CLASS ---
class Snake {
    constructor(id, name, initialBalance) {
        this.id = id;
        this.name = name;
        this.x = WORLD_SIZE / 2 + Math.random() * 100 - 50;
        this.y = WORLD_SIZE / 2 + Math.random() * 100 - 50;
        this.size = PLAYER_RADIUS;
        this.speed = PLAYER_START_SPEED;
        this.angle = Math.random() * Math.PI * 2;
        this.body = [];
        this.color = `hsl(${Math.random() * 360}, 100%, 50%)`;
        this.isBoosting = false;
        this.boostCounter = 0;
        this.isDead = false;
        this.initialBalance = initialBalance; // The money they brought in

        // Initialize body
        for (let i = 0; i < PLAYER_START_LENGTH; i++) {
            this.body.push({
                x: this.x - Math.cos(this.angle) * i * SEGMENT_DISTANCE,
                y: this.y - Math.sin(this.angle) * i * SEGMENT_DISTANCE
            });
        }
    }

    update() {
        if (this.isDead) return;

        // Handle boosting
        if (this.isBoosting && this.body.length > MIN_PLAYER_LENGTH) {
            this.speed = PLAYER_BOOST_SPEED;
            this.boostCounter++;
            if (this.boostCounter >= BOOST_SHRINK_RATE) {
                this.body.pop(); // Shrink while boosting
                this.boostCounter = 0;
            }
        } else {
            this.speed = PLAYER_START_SPEED;
            this.boostCounter = 0;
        }

        // Move body segments (from tail to head)
        for (let i = this.body.length - 1; i > 0; i--) {
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

        // Move head
        const head = this.body[0];
        head.x += Math.cos(this.angle) * this.speed;
        head.y += Math.sin(this.angle) * this.speed;

        // Check Wall Collision
        if (head.x < 0 || head.x > WORLD_SIZE || head.y < 0 || head.y > WORLD_SIZE) {
            this.isDead = true;
        }
    }

    grow() {
        this.body.push({ ...this.body[this.body.length - 1] });
    }

    // Check collision with another snake's body
    // Returns true if this snake's head hits any part of the target snake's body
    checkCollision(targetSnake) {
        if (this.isDead || targetSnake.isDead || this.id === targetSnake.id) {
            return false;
        }

        const head = this.body[0];
        // We check from i=1 to skip the target's head
        for (let i = 1; i < targetSnake.body.length; i++) {
            const segment = targetSnake.body[i];
            const dist = Math.hypot(head.x - segment.x, head.y - segment.y);
            if (dist < this.size + targetSnake.size) { // Simple circle collision
                this.isDead = true;
                return true; // Collision detected
            }
        }
        return false;
    }

    // Get a simplified version of the snake for sending to clients
    getState() {
        return {
            id: this.id,
            name: this.name,
            body: this.body,
            color: this.color,
            isDead: this.isDead
            // We don't send balance here, that's handled per-player
        };
    }
}

// --- GAME CLASS ---
// This class manages the state of a single game room
class Game {
    constructor(roomId) {
        this.roomId = roomId;
        this.snakes = {}; // Key: socket.id, Value: Snake object
        this.food = [];
        this.killEvents = []; // To track who killed whom

        // Spawn initial food
        for (let i = 0; i < FOOD_COUNT; i++) {
            this.food.push(new Food());
        }
    }

    addPlayer(id, name, initialBalance) {
        const snake = new Snake(id, name, initialBalance);
        this.snakes[id] = snake;
        return snake;
    }

    removePlayer(id) {
        // When a player leaves, turn their body into food
        if (this.snakes[id]) {
            this.createFoodFromSnake(this.snakes[id]);
            delete this.snakes[id];
        }
    }

    updatePlayerAngle(id, angle) {
        if (this.snakes[id]) {
            this.snakes[id].angle = angle;
        }
    }

    updatePlayerBoost(id, isBoosting) {
        if (this.snakes[id]) {
            this.snakes[id].isBoosting = isBoosting;
        }
    }

    createFoodFromSnake(snake) {
        // Drop food pellets along the snake's body
        for (let i = 0; i < snake.body.length; i += 2) { // Drop food every 2 segments
            const segment = snake.body[i];
            const newFood = new Food();
            newFood.x = segment.x + Math.random() * 10 - 5;
            newFood.y = segment.y + Math.random() * 10 - 5;
            this.food.push(newFood);
        }
    }

    update() {
        this.killEvents = []; // Clear kill events for this tick

        // 1. Move all snakes
        for (let id in this.snakes) {
            this.snakes[id].update();
        }

        // 2. Check for collisions (snake vs snake, snake vs food)
        const snakeIds = Object.keys(this.snakes);

        for (let id of snakeIds) {
            const snake = this.snakes[id];
            if (!snake || snake.isDead) continue;

            // Check food collision
            for (let i = this.food.length - 1; i >= 0; i--) {
                const f = this.food[i];
                const head = snake.body[0];
                const dist = Math.hypot(head.x - f.x, head.y - f.y);
                if (dist < snake.size + f.size) {
                    this.food.splice(i, 1); // Eat food
                    snake.grow();
                    this.food.push(new Food()); // Respawn food
                }
            }

            // Check snake-on-snake collision
            for (let otherId of snakeIds) {
                const otherSnake = this.snakes[otherId];
                if (!otherSnake) continue;

                if (snake.checkCollision(otherSnake)) {
                    // `snake` (the one moving) just died by hitting `otherSnake`
                    this.createFoodFromSnake(snake);
                    this.killEvents.push({
                        killerId: otherSnake.id,
                        victimId: snake.id
                    });
                    break; // This snake is dead, no need to check more
                }
            }
        }

        // Return kill events so the server can handle money transfer
        return this.killEvents;
    }

    // Get a simplified state of the entire game for all clients
    getState() {
        const simpleSnakes = {};
        for (let id in this.snakes) {
            simpleSnakes[id] = this.snakes[id].getState();
        }

        return {
            snakes: simpleSnakes,
            food: this.food
        };
    }
}

// --- EXPORTS ---
// This is the CRITICAL fix. We export the classes so server.js can use them.
module.exports = { Game, Snake, Food };

