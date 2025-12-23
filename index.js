const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// Game constants
const MAP_SIZE = 5000;
const PELLET_COUNT = 500;
const PELLET_VALUE = 10;
const BASE_SPEED = 8;
const MIN_SPLIT_MASS = 40;
const MAX_CELLS = 8;
const MERGE_TIME = 15000; // 15 seconds
const SPLIT_VELOCITY = 20;
const EJECT_MASS = 15;
const EJECT_VELOCITY = 25;
const MASS_DECAY_THRESHOLD = 500;
const MASS_DECAY_RATE = 0.001;
const EAT_OVERLAP = 0.5;
const EAT_RATIO = 1.15;

// Game state
let players = new Map();
let pellets = [];
let ejectedMass = [];
let nextPlayerId = 1;
let nextPelletId = 1;

// Colors for pellets and players
const NEON_COLORS = [
  '#ff00ff', '#00ffff', '#ff0080', '#80ff00', '#8000ff',
  '#ff8000', '#00ff80', '#0080ff', '#ff0040', '#40ff00'
];

// Initialize pellets
function initPellets() {
  pellets = [];
  for (let i = 0; i < PELLET_COUNT; i++) {
    spawnPellet();
  }
}

function spawnPellet() {
  pellets.push({
    id: nextPelletId++,
    x: Math.random() * MAP_SIZE - MAP_SIZE / 2,
    y: Math.random() * MAP_SIZE - MAP_SIZE / 2,
    color: NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)],
    vx: (Math.random() - 0.5) * 0.5,
    vy: (Math.random() - 0.5) * 0.5
  });
}

function massToRadius(mass) {
  return Math.sqrt(mass) * 4;
}

function radiusToMass(radius) {
  return (radius / 4) ** 2;
}

function getSpeed(mass) {
  return BASE_SPEED * Math.pow(mass, -0.15);
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function getRandomSpawn() {
  // Find a spot away from large players
  for (let attempts = 0; attempts < 10; attempts++) {
    const x = Math.random() * MAP_SIZE - MAP_SIZE / 2;
    const y = Math.random() * MAP_SIZE - MAP_SIZE / 2;
    
    let safe = true;
    for (const [, player] of players) {
      for (const cell of player.cells) {
        if (distance(x, y, cell.x, cell.y) < massToRadius(cell.mass) + 200) {
          safe = false;
          break;
        }
      }
      if (!safe) break;
    }
    
    if (safe) return { x, y };
  }
  
  return {
    x: Math.random() * MAP_SIZE - MAP_SIZE / 2,
    y: Math.random() * MAP_SIZE - MAP_SIZE / 2
  };
}

function createPlayer(ws, name, color) {
  const id = nextPlayerId++;
  const spawn = getRandomSpawn();
  
  const player = {
    id,
    name: name.substring(0, 15) || 'Cell',
    color: color || NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)],
    cells: [{
      id: 0,
      x: spawn.x,
      y: spawn.y,
      mass: 20,
      vx: 0,
      vy: 0,
      mergeTime: 0
    }],
    inputX: 0,
    inputY: 0,
    score: 0,
    ws,
    alive: true
  };
  
  players.set(id, player);
  return player;
}

function respawnPlayer(player) {
  const spawn = getRandomSpawn();
  player.cells = [{
    id: 0,
    x: spawn.x,
    y: spawn.y,
    mass: 20,
    vx: 0,
    vy: 0,
    mergeTime: 0
  }];
  player.alive = true;
  player.score = 0;
}

function getPlayerCenter(player) {
  if (player.cells.length === 0) return { x: 0, y: 0 };
  
  let totalMass = 0;
  let cx = 0, cy = 0;
  
  for (const cell of player.cells) {
    cx += cell.x * cell.mass;
    cy += cell.y * cell.mass;
    totalMass += cell.mass;
  }
  
  return { x: cx / totalMass, y: cy / totalMass };
}

function getTotalMass(player) {
  return player.cells.reduce((sum, cell) => sum + cell.mass, 0);
}

function updateGame(deltaTime) {
  const dt = deltaTime / 1000;
  
  // Update pellets (slow drift)
  for (const pellet of pellets) {
    pellet.x += pellet.vx;
    pellet.y += pellet.vy;
    
    // Bounce off boundaries
    if (pellet.x < -MAP_SIZE / 2 || pellet.x > MAP_SIZE / 2) pellet.vx *= -1;
    if (pellet.y < -MAP_SIZE / 2 || pellet.y > MAP_SIZE / 2) pellet.vy *= -1;
  }
  
  // Update ejected mass
  for (let i = ejectedMass.length - 1; i >= 0; i--) {
    const em = ejectedMass[i];
    em.x += em.vx * dt;
    em.y += em.vy * dt;
    em.vx *= 0.9;
    em.vy *= 0.9;
    
    // Boundary
    em.x = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, em.x));
    em.y = Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, em.y));
  }
  
  // Update players
  for (const [, player] of players) {
    if (!player.alive) continue;
    
    const totalMass = getTotalMass(player);
    
    // Update each cell
    for (const cell of player.cells) {
      // Apply velocity decay
      cell.vx *= 0.95;
      cell.vy *= 0.95;
      
      // Movement toward input
      const speed = getSpeed(cell.mass);
      const dx = player.inputX;
      const dy = player.inputY;
      const inputDist = Math.sqrt(dx * dx + dy * dy);
      
      if (inputDist > 0.1) {
        const nx = dx / inputDist;
        const ny = dy / inputDist;
        cell.x += nx * speed + cell.vx * dt;
        cell.y += ny * speed + cell.vy * dt;
      } else {
        cell.x += cell.vx * dt;
        cell.y += cell.vy * dt;
      }
      
      // Boundary push
      const radius = massToRadius(cell.mass);
      if (cell.x - radius < -MAP_SIZE / 2) cell.x = -MAP_SIZE / 2 + radius;
      if (cell.x + radius > MAP_SIZE / 2) cell.x = MAP_SIZE / 2 - radius;
      if (cell.y - radius < -MAP_SIZE / 2) cell.y = -MAP_SIZE / 2 + radius;
      if (cell.y + radius > MAP_SIZE / 2) cell.y = MAP_SIZE / 2 - radius;
      
      // Mass decay for large cells
      if (cell.mass > MASS_DECAY_THRESHOLD) {
        cell.mass -= cell.mass * MASS_DECAY_RATE * dt;
      }
      
      // Update merge timer
      if (cell.mergeTime > 0) {
        cell.mergeTime -= deltaTime;
      }
    }
    
    // Cell collision with own cells (push apart or merge)
    for (let i = 0; i < player.cells.length; i++) {
      for (let j = i + 1; j < player.cells.length; j++) {
        const c1 = player.cells[i];
        const c2 = player.cells[j];
        const r1 = massToRadius(c1.mass);
        const r2 = massToRadius(c2.mass);
        const dist = distance(c1.x, c1.y, c2.x, c2.y);
        
        if (dist < r1 + r2) {
          // Can merge?
          if (c1.mergeTime <= 0 && c2.mergeTime <= 0) {
            // Merge smaller into larger
            if (c1.mass >= c2.mass) {
              c1.mass += c2.mass;
              player.cells.splice(j, 1);
              j--;
            } else {
              c2.mass += c1.mass;
              player.cells.splice(i, 1);
              i--;
              break;
            }
          } else {
            // Push apart
            const overlap = (r1 + r2 - dist) / 2;
            const angle = Math.atan2(c2.y - c1.y, c2.x - c1.x);
            c1.x -= Math.cos(angle) * overlap * 0.5;
            c1.y -= Math.sin(angle) * overlap * 0.5;
            c2.x += Math.cos(angle) * overlap * 0.5;
            c2.y += Math.sin(angle) * overlap * 0.5;
          }
        }
      }
    }
    
    player.score = Math.floor(totalMass);
  }
  
  // Check pellet collisions
  for (const [, player] of players) {
    if (!player.alive) continue;
    
    for (const cell of player.cells) {
      const cellRadius = massToRadius(cell.mass);
      
      // Eat pellets
      for (let i = pellets.length - 1; i >= 0; i--) {
        const pellet = pellets[i];
        const dist = distance(cell.x, cell.y, pellet.x, pellet.y);
        
        if (dist < cellRadius) {
          cell.mass += PELLET_VALUE;
          pellets.splice(i, 1);
          spawnPellet();
        }
      }
      
      // Eat ejected mass
      for (let i = ejectedMass.length - 1; i >= 0; i--) {
        const em = ejectedMass[i];
        if (em.ownerId === player.id && Date.now() - em.createdAt < 500) continue;
        
        const dist = distance(cell.x, cell.y, em.x, em.y);
        if (dist < cellRadius) {
          cell.mass += em.mass;
          ejectedMass.splice(i, 1);
        }
      }
    }
  }
  
  // Check player vs player collisions
  const playersArray = Array.from(players.values()).filter(p => p.alive);
  
  for (let i = 0; i < playersArray.length; i++) {
    for (let j = i + 1; j < playersArray.length; j++) {
      const p1 = playersArray[i];
      const p2 = playersArray[j];
      
      for (let ci = p1.cells.length - 1; ci >= 0; ci--) {
        for (let cj = p2.cells.length - 1; cj >= 0; cj--) {
          const c1 = p1.cells[ci];
          const c2 = p2.cells[cj];
          if (!c1 || !c2) continue;
          
          const r1 = massToRadius(c1.mass);
          const r2 = massToRadius(c2.mass);
          const dist = distance(c1.x, c1.y, c2.x, c2.y);
          
          // Check if one can eat the other
          if (c1.mass > c2.mass * EAT_RATIO && dist < r1 - r2 * EAT_OVERLAP) {
            c1.mass += c2.mass;
            p2.cells.splice(cj, 1);
            if (p2.cells.length === 0) {
              p2.alive = false;
              setTimeout(() => respawnPlayer(p2), 2000);
            }
          } else if (c2.mass > c1.mass * EAT_RATIO && dist < r2 - r1 * EAT_OVERLAP) {
            c2.mass += c1.mass;
            p1.cells.splice(ci, 1);
            if (p1.cells.length === 0) {
              p1.alive = false;
              setTimeout(() => respawnPlayer(p1), 2000);
            }
            break;
          }
        }
      }
    }
  }
}

function handleSplit(player) {
  if (!player.alive) return;
  
  const newCells = [];
  
  for (const cell of player.cells) {
    if (player.cells.length + newCells.length >= MAX_CELLS) break;
    if (cell.mass < MIN_SPLIT_MASS) continue;
    
    const newMass = cell.mass / 2;
    cell.mass = newMass;
    
    const angle = Math.atan2(player.inputY, player.inputX);
    
    newCells.push({
      id: Date.now() + Math.random(),
      x: cell.x,
      y: cell.y,
      mass: newMass,
      vx: Math.cos(angle) * SPLIT_VELOCITY * 50,
      vy: Math.sin(angle) * SPLIT_VELOCITY * 50,
      mergeTime: MERGE_TIME
    });
    
    cell.mergeTime = MERGE_TIME;
  }
  
  player.cells.push(...newCells);
}

function handleEject(player) {
  if (!player.alive) return;
  
  for (const cell of player.cells) {
    if (cell.mass < EJECT_MASS * 2) continue;
    
    cell.mass -= EJECT_MASS;
    
    const angle = Math.atan2(player.inputY, player.inputX);
    const radius = massToRadius(cell.mass);
    
    ejectedMass.push({
      id: Date.now() + Math.random(),
      x: cell.x + Math.cos(angle) * radius,
      y: cell.y + Math.sin(angle) * radius,
      mass: EJECT_MASS,
      vx: Math.cos(angle) * EJECT_VELOCITY * 50,
      vy: Math.sin(angle) * EJECT_VELOCITY * 50,
      color: player.color,
      ownerId: player.id,
      createdAt: Date.now()
    });
  }
}

function getLeaderboard() {
  return Array.from(players.values())
    .filter(p => p.alive)
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function getGameState(forPlayer) {
  const center = getPlayerCenter(forPlayer);
  const viewRadius = 1000 + getTotalMass(forPlayer) * 2;
  
  // Get visible players
  const visiblePlayers = [];
  for (const [, player] of players) {
    if (!player.alive) continue;
    
    const pCenter = getPlayerCenter(player);
    if (distance(center.x, center.y, pCenter.x, pCenter.y) < viewRadius + 500) {
      visiblePlayers.push({
        id: player.id,
        name: player.name,
        color: player.color,
        cells: player.cells.map(c => ({
          x: c.x,
          y: c.y,
          mass: c.mass,
          radius: massToRadius(c.mass)
        }))
      });
    }
  }
  
  // Get visible pellets
  const visiblePellets = pellets.filter(p => 
    distance(center.x, center.y, p.x, p.y) < viewRadius
  ).map(p => ({ x: p.x, y: p.y, color: p.color }));
  
  // Get visible ejected mass
  const visibleEjected = ejectedMass.filter(e =>
    distance(center.x, center.y, e.x, e.y) < viewRadius
  ).map(e => ({ x: e.x, y: e.y, mass: e.mass, color: e.color }));
  
  return {
    type: 'gameState',
    playerId: forPlayer.id,
    players: visiblePlayers,
    pellets: visiblePellets,
    ejectedMass: visibleEjected,
    leaderboard: getLeaderboard(),
    mapSize: MAP_SIZE,
    yourMass: getTotalMass(forPlayer)
  };
}

// WebSocket handling
wss.on('connection', (ws) => {
  let player = null;
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'join':
          player = createPlayer(ws, msg.name, msg.color);
          ws.send(JSON.stringify({
            type: 'joined',
            playerId: player.id,
            mapSize: MAP_SIZE
          }));
          break;
          
        case 'input':
          if (player && player.alive) {
            player.inputX = msg.x || 0;
            player.inputY = msg.y || 0;
          }
          break;
          
        case 'split':
          if (player) handleSplit(player);
          break;
          
        case 'eject':
          if (player) handleEject(player);
          break;
      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });
  
  ws.on('close', () => {
    if (player) {
      players.delete(player.id);
    }
  });
  
  ws.on('error', () => {
    if (player) {
      players.delete(player.id);
    }
  });
});

// Game loop
let lastUpdate = Date.now();
setInterval(() => {
  const now = Date.now();
  const deltaTime = now - lastUpdate;
  lastUpdate = now;
  
  updateGame(deltaTime);
}, 1000 / 60);

// Send game state to all players
setInterval(() => {
  for (const [, player] of players) {
    if (player.ws.readyState === WebSocket.OPEN) {
      const state = getGameState(player);
      player.ws.send(JSON.stringify(state));
    }
  }
}, 1000 / 20);

// Initialize
initPellets();

console.log(`🎮 Void Arena server running on port ${PORT}`);
console.log(`   Connect your client to ws://localhost:${PORT}`);
