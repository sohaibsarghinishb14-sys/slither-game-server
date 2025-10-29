// This file holds all the rules and classes for the game
// (Snake, Food, etc.)

class Snake {
    constructor(id, name, color, balance) {
        this.id = id;
        this.name = name;
        this.color = color;
        this.balance = balance; // This is the "money" this snake is worth
        
        this.x = Math.random() * GAME_WORLD_SIZE;
        this.y = Math.random() * GAME_WORLD_SIZE;
        this.size = 12; // Start size
        this.speed = 3;
        this.angle = Math.random() * Math.PI * 2;
        this.body = [];
        this.isBoosting = false;
        this.boostCounter = 0;
        this.score = 0; // This is now "length"
        
        this.MAX_LENGTH = 150;
        this.START_LENGTH = 10;
        this.BOOST_SPEED = 5;
        this.NORMAL_SPEED = 3;
        this.BOOST_SHRINK_RATE = 10; // Lose 1 segment every 10 frames

        for (let i = 0; i < this.START_LENGTH; i++) {
            this.body.push({ x: this.x, y: this.y });
        }
    }

    update() {
        // Handle boosting
        if (this.isBoosting) {
            this.speed = this.BOOST_SPEED;
            this.boostCounter++;
            if (this.boostCounter >= this.BOOST_SHRINK_RATE && this.body.length > this.START_LENGTH) {
                this.body.pop(); // Shrink while boosting
                this.score = this.body.length;
                this.boostCounter = 0;
            }
        } else {
            this.speed = this.NORMAL_SPEED;
            this.boostCounter = 0;
        }

        // --- Smoother Turning ---
        // The angle is set by the server from player input
        let head = { ...this.body[0] }; // Get a copy of the head
        head.x += Math.cos(this.angle) * this.speed;
        head.y += Math.sin(this.angle) * this.speed;

        // Wall collision
        if (head.x < 0 || head.x > GAME_WORLD_SIZE || head.y < 0 || head.y > GAME_WORLD_SIZE) {
            return 'dead'; // Snake died by hitting a wall
        }

        // Add new head
        this.body.unshift(head);

        // Keep snake at max length unless it eats
        if (this.body.length > this.MAX_LENGTH) {
            this.body.pop();
        }
        
        // Move tail segments
        for (let i = this.body.length - 1; i > 0; i--) {
            const leader = this.body[i-1];
            const follower = this.body[i];
            
            const dx = leader.x - follower.x;
            const dy = leader.y - follower.y;
            const dist = Math.hypot(dx, dy);
            const desiredDist = this.size * 0.5;

            if (dist > desiredDist) {
                const moveRatio = (dist - desiredDist) / dist;
                follower.x += dx * moveRatio;
                follower.y += dy * moveRatio;
            }
        }
        
        // Only keep the head, and update the body array
        // We trim the body back to the head
        while(this.body.length > 1) {
            this.body.pop();
        }
        
        // Now add new segments based on score
        for (let i = 0; i < this.score; i++) {
             this.body.push({ ...this.body[this.body.length - 1] });
        }


        this.x = this.body[0].x;
        this.y = this.body[0].y;
    }
    
    // Check collision with other snakes
    checkSnakeCollision(snakes) {
        let head = this.body[0];
        for (let snake of snakes) {
            if (snake.id === this.id) continue; // Don't check against self

            // Check collision with other snake's body
            for (let i = 1; i < snake.body.length; i++) {
                let segment = snake.body[i];
                const dist = Math.hypot(head.x - segment.x, head.y - segment.y);
                if (dist < this.size) {
                    return snake; // We hit this snake
                }
            }
        }
        return null; // No collision
    }

    // Check collision with food
    checkFoodCollision(food) {
        let head = this.body[0];
        for (let i = food.length - 1; i >= 0; i--) {
            let f = food[i];
            const dist = Math.hypot(head.x - f.x, head.y - f.y);
            if (dist < this.size + f.size) {
                food.splice(i, 1); // Eat food
                this.grow(f.value);
                return true; // Ate food
            }
        }
        return false;
    }
    
    grow(amount = 1) {
        this.score += amount;
        if(this.score > this.MAX_LENGTH) {
            this.score = this.MAX_LENGTH;
        }
    }

    // This is what other clients see
    getData() {
        return {
            id: this.id,
            name: this.name,
            color: this.color,
            body: this.body,
            balance: this.balance,
            score: this.score,
            size: this.size
        };
    }
}

class Food {
    constructor() {
        this.x = Math.random() * GAME_WORLD_SIZE;
        this.y = Math.random() * GAME_WORLD_SIZE;
        this.size = 5;
        this.color = `hsl(${Math.random() * 360}, 100%, 70%)`;
        this.value = 1; // Food from eating
    }
}

class MoneyFood extends Food {
    constructor(x, y, value) {
        super();
        this.x = x;
        this.y = y;
        this.size = 8 + Math.log(value + 1); // Bigger food for more money
        this.color = '#FFD700'; // Gold color
        this.value = Math.ceil(value / 5); // The "score" (length) you get
        this.moneyValue = value; // The "money" it's worth
    }
}

const GAME_WORLD_SIZE = 3000;
const MAX_FOOD = 250;

// This makes these classes available to server.js
module.exports = {
    Snake,
    Food,
    MoneyFood,
    GAME_WORLD_SIZE,
    MAX_FOOD
};
