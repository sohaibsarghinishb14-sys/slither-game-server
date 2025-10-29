// --- GAME SETTINGS ---
const WORLD_SIZE = 3000;
const PLAYER_START_SPEED = 3;
const PLAYER_BOOST_SPEED = 6;
const PLAYER_BOOST_COST = 1; // Cost per game tick (not frame)
const PLAYER_START_LENGTH = 15;
const MIN_PLAYER_LENGTH = 10;
const FOOD_COUNT = 300;
const FOOD_SIZE = 5;
const SNAKE_TURN_SPEED = 0.07;
const SNAKE_SIZE = 12; // Radius of segments

// --- Helper: Point Class ---
class Point {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }
}

// --- Food Class ---
class Food {
    constructor() {
        this.x = Math.random() * WORLD_SIZE;
        this.y = Math.random() * WORLD_SIZE;
        this.size = FOOD_SIZE;
        this.color = `hsl(${Math.random() * 360}, 100%, 70%)`;
        this.id = Math.random().toString(36).substr(2, 9);
    }
}

// --- Snake Class ---
class Snake {
    constructor(id, username, startBalance) {
        this.id = id;
        this.username = username;
        this.x = WORLD_SIZE / 2 + (Math.random() - 0.5) * 500;
        this.y = WORLD_SIZE / 2 + (Math.random() - 0.5) * 500;
        this.size = SNAKE_SIZE;
        this.speed = PLAYER_START_SPEED;
        this.angle = Math.random() * Math.PI * 2;
        this.targetAngle = this.angle;
        this.body = [];
        this.color = `hsl(${Math.random() * 360}, 100%, 50%)`;
        this.isBoosting = false;
        
        // This is the player's "game money"
        this.balance = startBalance;
        
        // Length is derived from balance. 1 balance = 1 length
        // We add PLAYER_START_LENGTH as a "base" length
        let startLength = PLAYER_START_LENGTH + this.balance;

        for (let i = 0; i < startLength; i++) {
            this.body.push({ x: this.x - i * 5, y: this.y });
        }
    }

    update() {
        // --- Boosting ---
        if (this.isBoosting && this.balance > MIN_PLAYER_LENGTH) {
            this.speed = PLAYER_BOOST_SPEED;
            this.balance -= PLAYER_BOOST_COST; // Decrease "money"
            if (this.body.length > PLAYER_START_LENGTH) {
                 this.body.pop(); // Remove from tail
            }
        } else {
            this.speed = PLAYER_START_SPEED;
        }

        // --- Turning ---
        let angleDiff = this.targetAngle - this.angle;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        this.angle += angleDiff * SNAKE_TURN_SPEED;

        // --- Move Head ---
        const head = this.body[0];
        const newHeadX = head.x + Math.cos(this.angle) * this.speed;
        const newHeadY = head.y + Math.sin(this.angle) * this.speed;
        
        // Add new head
        this.body.unshift({ x: newHeadX, y: newHeadY });
        
        // Keep length correct (remove tail)
        // We add +1 because the "balance" is the *extra* length
        while (this.body.length > this.balance + PLAYER_START_LENGTH + 1) {
            this.body.pop();
        }

        // Update main position
        this.x = newHeadX;
        this.y = newHeadY;
    }
    
    // Grow by eating food
    eatFood(food) {
        this.balance += 1; // 1 food = 1 balance
        // The body will naturally grow on the next update because we don't pop()
    }

    // Called when this snake kills another
    killSnake(otherSnake) {
        // Gain 90% of the other snake's balance
        this.balance += Math.floor(otherSnake.balance * 0.90);
    }
    
    // Check for collision with world boundaries
    checkWallCollision() {
        const head = this.body[0];
        return (head.x < 0 || head.x > WORLD_SIZE || head.y < 0 || head.y > WORLD_SIZE);
    }
    
    // Check for collision with another snake's body
    checkSnakeCollision(otherSnake) {
        const head = this.body[0];
        // Check collision with all segments except the head
        for (let i = 1; i < otherSnake.body.length; i++) {
            const segment = otherSnake.body[i];
            const dist = Math.hypot(head.x - segment.x, head.y - segment.y);
            if (dist < this.size) { // Simple circle collision
                return true;
            }
        }
        return false;
    }
    
    // Check for collision with food
    checkFoodCollision(foodList) {
        const head = this.body[0];
        for (let i = foodList.length - 1; i >= 0; i--) {
            const food = foodList[i];
            const dist = Math.hypot(head.x - food.x, head.y - food.y);
            if (dist < this.size + food.size) {
                return foodList.splice(i, 1)[0]; // Return the food that was eaten
            }
        }
        return null;
    }

    // Create a simplified version of the snake to send to clients
    getPublicData() {
        return {
            id: this.id,
            username: this.username,
            color: this.color,
            body: this.body,
            balance: Math.floor(this.balance)
        };
    }
}

// --- Game Class ---
// This class runs the game logic for one "Room"
class Game {
    constructor(roomId) {
        this.roomId = roomId;
        this.snakes = {}; // Use an object for quick lookup
        this.food = [];
        this.lastUpdateTime = Date.now();
        this.gameInterval = null;

        // Spawn initial food
        for (let i = 0; i < FOOD_COUNT; i++) {
            this.food.push(new Food());
        }
    }

    // Start the game loop
    start() {
        this.lastUpdateTime = Date.now();
        // Run the game loop at 25 ticks per second (40ms)
        this.gameInterval = setInterval(() => this.tick(), 1000 / 25);
        console.log(`Game room ${this.roomId} started.`);
    }

    // Stop the game loop
    stop() {
        if (this.gameInterval) {
            clearInterval(this.gameInterval);
        }
        console.log(`Game room ${this.roomId} stopped.`);
    }
    
    // Add a new player to the game
    addSnake(socket, username, startBalance) {
        const snake = new Snake(socket.id, username, startBalance);
        this.snakes[socket.id] = snake;
        return snake;
    }
    
    // Remove a player from the game
    removeSnake(socketId) {
        const snake = this.snakes[socketId];
        if (snake) {
            // Drop food where the snake died
            this.dropFood(snake);
            delete this.snakes[socketId];
            return snake;
        }
        return null;
    }
    
    // Handle player input
    handleInput(socketId, data) {
        const snake = this.snakes[socketId];
        if (snake) {
            if (data.angle !== undefined) {
                snake.targetAngle = data.angle;
            }
            if (data.boosting !== undefined) {
                snake.isBoosting = data.boosting;
            }
        }
    }
    
    // Create food where a snake died
    dropFood(snake) {
        // Drop food based on the snake's balance
        const foodToDrop = Math.floor(snake.balance / 2);
        for (let i = 0; i < foodToDrop; i++) {
            const newFood = new Food();
            // Scatter food around the snake's head
            newFood.x = snake.x + (Math.random() - 0.5) * snake.body.length * 0.5;
            newFood.y = snake.y + (Math.random() - 0.5) * snake.body.length * 0.5;
            // Clamp to world boundaries
            newFood.x = Math.max(0, Math.min(WORLD_SIZE, newFood.x));
            newFood.y = Math.max(0, Math.min(WORLD_SIZE, newFood.y));
            this.food.push(newFood);
        }
    }

    // The main game loop tick
    tick() {
        const now = Date.now();
        const deltaTime = (now - this.lastUpdateTime) / 1000; // Time in seconds
        this.lastUpdateTime = now;
        
        const snakeIds = Object.keys(this.snakes);
        const allSnakes = Object.values(this.snakes);
        
        let eatenFoodIds = [];
        let deadSnakeIds = [];
        let killEvents = []; // To track who killed whom

        // 1. Update all snake positions
        for (const snake of allSnakes) {
            snake.update();
        }

        // 2. Check for collisions
        for (const snakeId of snakeIds) {
            const snake = this.snakes[snakeId];
            if (!snake) continue; // Snake might have been killed already

            // 2a. Check wall collision
            if (snake.checkWallCollision()) {
                deadSnakeIds.push(snakeId);
                continue; // Move to next snake
            }
            
            // 2b. Check snake-on-snake collision
            for (const otherSnake of allSnakes) {
                if (snake.id === otherSnake.id) continue; // Can't collide with self
                
                if (snake.checkSnakeCollision(otherSnake)) {
                    deadSnakeIds.push(snakeId);
                    // The otherSnake gets the "kill"
                    killEvents.push({ killer: otherSnake, victim: snake });
                    break; // This snake is dead, stop checking
                }
            }
            if (deadSnakeIds.includes(snakeId)) continue; // Snake is dead, no need to check food

            // 2c. Check food collision
            const eatenFood = snake.checkFoodCollision(this.food);
            if (eatenFood) {
                snake.eatFood(eatenFood);
                eatenFoodIds.push(eatenFood.id);
            }
        }
        
        // 3. Process kills
        for (const event of killEvents) {
            event.killer.killSnake(event.victim);
        }

        // 4. Spawn new food to replace eaten ones
        for (let i = 0; i < eatenFoodIds.length; i++) {
            this.food.push(new Food());
        }

        // 5. Get state for all players
        const gameState = {
            snakes: allSnakes.map(s => s.getPublicData()),
            food: this.food.map(f => ({ id: f.id, x: f.x, y: f.y, color: f.color })),
            eatenFood: eatenFoodIds,
            deadSnakes: deadSnakeIds.map(id => {
                const deadSnake = this.removeSnake(id); // Remove from game
                return { id: id, balance: deadSnake ? deadSnake.balance : 0 };
            })
        };
        
        return gameState;
    }
}

// --- This is the fix for the "Game is not a constructor" error ---
// We "export" the Game class so server.js can import it.
module.exports = { Game };

