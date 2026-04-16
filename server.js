// ═══════════════════════════════════════════════════════
//  Pixel_Polis — WebSocket multiplayer server  (v3)
//  New in v3: player names, leaderboard, world chat, city raids
//
//  Protocol  Client → Server:
//    { type:"build",    x, z, zone }
//    { type:"demolish", x, z }
//    { type:"upgrade",  x, z }
//    { type:"setName",  name }           ← NEW
//    { type:"chat",     text }           ← NEW
//    { type:"raid",     regionKey }      ← NEW
//    { type:"score",    pop, money }     ← NEW (client reports own stats)
//    { type:"ping" }
//
//  Protocol  Server → Client:
//    { type:"welcome",  playerId, playerColor }
//    { type:"init",     world, players, econ }
//    { type:"build",    x, z, zone, playerId }
//    { type:"demolish", x, z, playerId }
//    { type:"upgrade",  x, z, newLevel, playerId }
//    { type:"players",  players }
//    { type:"economy",  ... }
//    { type:"chat",     playerId, name, color, text, ts }  ← NEW
//    { type:"raided",   by, byName, byColor }              ← NEW
//    { type:"leaderboard", scores:[{name,color,pop,money}] } ← NEW
// ═══════════════════════════════════════════════════════

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── Shared constants ──────────────────────────────────
const SIZE           = 20;
const DIRS           = [{dx:1,dz:0},{dx:-1,dz:0},{dx:0,dz:1},{dx:0,dz:-1}];
const POWER_RADIUS   = 5;
const POWER_SUPPLY   = 20;
const POP_PER_LEVEL  = [4, 9, 16];
const UPGRADE_COSTS  = [150, 400];
const LV_UPGRADE_MIN = [0, 30, 60];
const GROWTH_THRESHOLD = 5;
const GOODS_MAX      = 100;
const GOODS_REGEN    = 3;
const BLDG_MONEY_REGEN = 4;
const BLDG_MONEY_MAX = 200;
const IND_CAPACITY   = 80;
const IND_PROD_RATE  = 6;
const IND_PROD_UNPOW = 1;
const IND_DELIVER_AMT= 20;
const CITIZEN_SALARY = 3;
const SALE_PRICE     = 5;
const WORK_WALLET_THRESHOLD = 6;
// ── World regions (shared across all players) ─────────
// regions["x_z"] = { owner, name, cityData, thumb }
const regions = {};

function broadcastRegions() {
  // Strip thumb to keep payload small — clients re-attach their own thumb
  const slim = {};
  for (const [k,r] of Object.entries(regions)) {
    slim[k] = { owner:r.owner, name:r.name,
      pop: r.cityData?.population||0, money: r.cityData?.money||0 };
  }
  broadcastAll({ type:'worldRegions', regions: slim });
}

const RAID_COST = 200;
const CHAT_MAX  = 80;

// ── World tile grid ───────────────────────────────────
const tiles = Array.from({length:SIZE},()=>Array.from({length:SIZE},()=>({type:'empty',level:0})));
const world  = {};

// ── Economy state ─────────────────────────────────────
let money=200, population=0, cityHappiness=60, citizenEarningsTotal=0;
const demand    = { res:50, com:50 };
const landValue = Array.from({length:SIZE},()=>Array(SIZE).fill(0));
const comStore  = {};
const indStore  = {};
const growthTimers = {};

// ── Player registry ───────────────────────────────────
let nextId = 1;
const PLAYER_COLORS = [
  '#ff6b6b','#ffd93d','#6bcb77','#4d96ff',
  '#ff922b','#cc5de8','#74c0fc','#f06595',
  '#a9e34b','#ff8787','#99e9f2','#e599f7',
];
const players = {};     // playerId → { color, name, ws, pop, money }
const chatLog = [];     // last 50 messages, sent to new joiners

// ── Helpers ───────────────────────────────────────────
const inBounds   = (x,z) => x>=0&&x<SIZE&&z>=0&&z<SIZE;
const neighbours = (x,z) => {
  const out=[];
  for (const {dx,dz} of DIRS) { const nx=x+dx,nz=z+dz; if(inBounds(nx,nz)) out.push({x:nx,z:nz}); }
  return out;
};
const hasAdjacentRoad = (x,z) => neighbours(x,z).some(p=>tiles[p.x][p.z].type==='road');

// ── Power ─────────────────────────────────────────────
const poweredTiles = new Set();
function rebuildPowerMap() {
  poweredTiles.clear();
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    if (tiles[x][z].type!=='power') continue;
    for (let dx=-POWER_RADIUS;dx<=POWER_RADIUS;dx++)
      for (let dz=-POWER_RADIUS;dz<=POWER_RADIUS;dz++) {
        if (Math.abs(dx)+Math.abs(dz)>POWER_RADIUS) continue;
        const nx=x+dx,nz=z+dz;
        if (inBounds(nx,nz)) poweredTiles.add(`${nx}_${nz}`);
      }
  }
}
const hasPower = (x,z) => poweredTiles.has(`${x}_${z}`);

// ── Store helpers ─────────────────────────────────────
function ensureComStore(x,z) {
  const k=`${x}_${z}`;
  if (!comStore[k]) comStore[k]={goods:GOODS_MAX,revenue:0,buildingMoney:50};
  return comStore[k];
}
function ensureIndStore(x,z) {
  const k=`${x}_${z}`;
  if (!indStore[k]) indStore[k]={goods:0,capacity:IND_CAPACITY};
  return indStore[k];
}

// ── Land value ────────────────────────────────────────
function recomputeLandValues() {
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    let score=0; const t=tiles[x][z];
    if (hasPower(x,z)) score+=25;
    for (const nb of neighbours(x,z)) {
      const nt=tiles[nb.x][nb.z];
      if (nt.type==='road') score+=20;
      if (nt.type==='res'&&hasPower(nb.x,nb.z)) score+=15;
      if (nt.type==='com'&&hasPower(nb.x,nb.z)) score+=10;
      if (nt.type==='empty') score-=5;
    }
    if (t.type==='road') score+=5;
    landValue[x][z]=Math.max(0,Math.min(100,score));
  }
}

// ── Happiness ─────────────────────────────────────────
function recomputeHappiness() {
  let score=50, powered=0, unpowered=0, indAdjRes=0, totalGoods=0, maxGoods=0;
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    const t=tiles[x][z];
    if (t.type==='res') {
      indAdjRes+=neighbours(x,z).filter(nb=>tiles[nb.x][nb.z].type==='ind').length;
      if (hasPower(x,z)) powered++; else unpowered++;
    }
    if (t.type==='com') {
      if (hasPower(x,z)) powered++; else unpowered++;
      const st=comStore[`${x}_${z}`];
      if (st){totalGoods+=st.goods;maxGoods+=GOODS_MAX;}
    }
  }
  if (maxGoods>0) score+=20*(totalGoods/maxGoods);
  score-=Math.min(25,indAdjRes*3);
  if (powered+unpowered>0) score-=20*(unpowered/(powered+unpowered));
  const totalBM=Object.values(comStore).reduce((s,st)=>s+st.buildingMoney,0);
  const maxBM=Object.keys(comStore).length*BLDG_MONEY_MAX;
  if (maxBM>0) score+=15*(totalBM/maxBM);
  cityHappiness=Math.max(0,Math.min(100,cityHappiness*0.75+score*0.25));
}
const happinessMult=()=>0.5+cityHappiness/100;

// ── Demand ────────────────────────────────────────────
function tickDemand() {
  let res=0,com=0;
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    if (tiles[x][z].type==='res') res++;
    if (tiles[x][z].type==='com') com++;
  }
  demand.res=Math.max(0,Math.min(100,demand.res*0.8+(100-res*5+com*3)*0.2+(Math.random()*4-2)));
  demand.com=Math.max(0,Math.min(100,demand.com*0.8+(100-com*5+res*3)*0.2+(Math.random()*4-2)));
}

// ── Income ────────────────────────────────────────────
function calcIncome() {
  let inc=0; const rd=demand.res/100,hm=happinessMult();
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    const t=tiles[x][z];
    if (t.type!=='res'||!hasPower(x,z)) continue;
    inc+=Math.ceil(t.level*(0.5+rd)*(0.5+landValue[x][z]/100)*hm);
  }
  return inc;
}

// ── Building growth ───────────────────────────────────
let autoUpgradesThisTick=[];
function tickBuildingGrowth() {
  autoUpgradesThisTick=[];
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    const t=tiles[x][z];
    if (!['res','com','ind'].includes(t.type)||t.level>=3) continue;
    if (!hasAdjacentRoad(x,z)||!hasPower(x,z)) continue;
    const k=`${x}_${z}`;
    if (!growthTimers[k]) growthTimers[k]=0;
    let boost=1+(t.type==='res'?demand.com/50:t.type==='com'?demand.res/50:(demand.res+demand.com)/100);
    boost*=(0.5+landValue[x][z]/100)*happinessMult();
    growthTimers[k]+=boost;
    if (growthTimers[k]>=GROWTH_THRESHOLD) {
      growthTimers[k]=0;
      const cost=Math.floor(UPGRADE_COSTS[t.level-1]/2);
      if (money<cost) continue;
      money-=cost;
      if (t.type==='res'){population-=POP_PER_LEVEL[t.level-1];t.level++;population+=POP_PER_LEVEL[t.level-1];}
      else t.level++;
      if (t.type==='ind'){const ist=ensureIndStore(x,z);ist.capacity=IND_CAPACITY+(t.level-1)*30;}
      if (world[k]) world[k].level=t.level;
      autoUpgradesThisTick.push({x,z,newLevel:t.level});
    }
  }
}

// ── Goods ─────────────────────────────────────────────
function tickGoods() {
  const hm=happinessMult();
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++) {
    const t=tiles[x][z];
    if (t.type==='com') {
      const st=ensureComStore(x,z);const pw=hasPower(x,z);
      st.goods=Math.min(GOODS_MAX,st.goods+(pw?Math.ceil(GOODS_REGEN*t.level*0.4):1));
      st.buildingMoney=Math.min(BLDG_MONEY_MAX,st.buildingMoney+(pw?BLDG_MONEY_REGEN*t.level:1));
      const vr=neighbours(x,z).filter(nb=>tiles[nb.x][nb.z].type==='res').length;
      if (pw&&st.goods>0&&vr>0) {
        const p=Math.min(vr,Math.floor(st.goods/8));
        const rev=Math.ceil(p*SALE_PRICE*hm);
        st.goods=Math.max(0,st.goods-p*8);
        st.revenue+=rev; st.buildingMoney=Math.min(BLDG_MONEY_MAX,st.buildingMoney+rev);
        money+=rev; citizenEarningsTotal+=rev;
      }
    }
    if (t.type==='ind') {
      const ist=ensureIndStore(x,z);const pw=hasPower(x,z);
      ist.goods=Math.min(ist.capacity,ist.goods+(pw?IND_PROD_RATE*t.level:IND_PROD_UNPOW));
      if (ist.goods>=IND_DELIVER_AMT) {
        for (let cx=0;cx<SIZE;cx++) for (let cz=0;cz<SIZE;cz++) {
          if (tiles[cx][cz].type!=='com') continue;
          const st=comStore[`${cx}_${cz}`];
          if (!st||st.goods>=GOODS_MAX*0.9) continue;
          ist.goods-=IND_DELIVER_AMT; st.goods=Math.min(GOODS_MAX,st.goods+IND_DELIVER_AMT); break;
        }
      }
    }
  }
}

function tickSalaries() {
  const hm=happinessMult();let sal=0;
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++)
    if (tiles[x][z].type==='res') sal+=CITIZEN_SALARY*tiles[x][z].level*hm;
  const coms=Object.keys(comStore);
  if (coms.length>0) { const pc=sal/coms.length; coms.forEach(k=>{comStore[k].buildingMoney=Math.max(0,comStore[k].buildingMoney-pc);}); }
}

// ── Leaderboard helpers ───────────────────────────────
function buildLeaderboard() {
  return Object.values(players)
    .map(p=>({ name:p.name, color:p.color, pop:p.pop||0, money:p.money||0 }))
    .sort((a,b)=>b.pop-a.pop||b.money-a.money);
}

// ── Master economy tick ───────────────────────────────
function runEconomyTick() {
  recomputeLandValues(); recomputeHappiness(); tickDemand();
  tickGoods(); tickSalaries(); tickBuildingGrowth();
  const inc=calcIncome(); money+=inc;
  population=0;
  for (let x=0;x<SIZE;x++) for (let z=0;z<SIZE;z++)
    if (tiles[x][z].type==='res') population+=POP_PER_LEVEL[tiles[x][z].level-1];

  broadcastAll({ type:'economy', money, population,
    happiness:Math.round(cityHappiness), citizenEarningsTotal,
    incomeThisTick:inc,
    demand:{res:Math.round(demand.res),com:Math.round(demand.com)},
    landValues:landValue.map(r=>[...r]),
    comStores:comStore, indStores:indStore });

  for (const up of autoUpgradesThisTick)
    broadcastAll({type:'upgrade',x:up.x,z:up.z,newLevel:up.newLevel,playerId:0});

  // Broadcast leaderboard every tick
  broadcastAll({ type:'leaderboard', scores:buildLeaderboard() });
}
setInterval(runEconomyTick, 2000);

// ── HTTP ──────────────────────────────────────────────
const httpServer = http.createServer((req,res)=>{
  const filePath=path.join(__dirname,'pixel_polis.html');
  fs.readFile(filePath,(err,data)=>{
    if (err){res.writeHead(404);res.end('pixel_polis.html not found');return;}
    res.writeHead(200,{'Content-Type':'text/html'}); res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────
const wss = new WebSocket.Server({ server:httpServer });

function broadcastAll(msg) {
  const raw=JSON.stringify(msg);
  wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)c.send(raw);});
}
function broadcastExcept(msg,except) {
  const raw=JSON.stringify(msg);
  wss.clients.forEach(c=>{if(c!==except&&c.readyState===WebSocket.OPEN)c.send(raw);});
}
function sendTo(ws,msg) { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

wss.on('connection', ws=>{
  const playerId=nextId++;
  const playerColor=PLAYER_COLORS[(playerId-1)%PLAYER_COLORS.length];
  players[playerId]={color:playerColor,name:`Player ${playerId}`,ws,pop:0,money:0};
  console.log(`[+] Player ${playerId} connected (${wss.clients.size} online)`);

  // 1. Welcome + identity
  sendTo(ws,{type:'welcome',playerId,playerColor});
  // 2. Full world state
  sendTo(ws,{type:'init',world,players:sanitizePlayers(),econ:{
    money,population,happiness:Math.round(cityHappiness),
    citizenEarningsTotal,incomeThisTick:0,
    demand:{res:Math.round(demand.res),com:Math.round(demand.com)},
    landValues:landValue.map(r=>[...r]),comStores:comStore,indStores:indStore
  }});
  // 3. Chat history
  sendTo(ws,{type:'chatHistory',messages:chatLog});
  // 4. Current leaderboard
  sendTo(ws,{type:'leaderboard',scores:buildLeaderboard()});
  // 5. World regions map
  sendTo(ws,{type:'worldRegions',regions});
  // 6. Notify others
  broadcastExcept({type:'players',players:sanitizePlayers()},ws);

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    if (msg.type==='ping'){sendTo(ws,{type:'pong'});return;}
    msg.playerId=playerId;

    // ── Region ownership & city data sync ────────────
    if (msg.type==='claimRegion') {
      const { key, name } = msg;
      if (!key || regions[key]) return; // already claimed
      regions[key] = { owner: players[playerId]?.name||`Player ${playerId}`,
                       name:  name||'New City',
                       cityData: { tiles:[], money:200, population:0 } };
      broadcastAll({ type:'worldRegions', regions });
      console.log(`[region] ${regions[key].owner} claimed ${key}`);
    }

    if (msg.type==='updateRegion') {
      const { key, region } = msg;
      if (!key || !region) return;
      const existing = regions[key];
      const ownerName = players[playerId]?.name || `Player ${playerId}`;
      // Only owner can update — compare by name since playerId changes per session
      if (existing && existing.owner !== ownerName) return;
      // Persist city data (strip thumb — too large to broadcast)
      regions[key] = {
        owner:    ownerName,
        name:     (region.name||'City').slice(0,30),
        cityData: {
          tiles:      region.cityData?.tiles      || [],
          money:      region.cityData?.money      || 0,
          population: region.cityData?.population || 0,
          dayTime:    region.cityData?.dayTime     || 0.3,
          comStore:   region.cityData?.comStore    || {},
          indStore:   region.cityData?.indStore    || {},
        }
      };
      // Broadcast slim version (no thumb)
      broadcastRegions();
    }

    // ── Set player name ──────────────────────────────
    if (msg.type==='setName') {
      const name=(msg.name||'').toString().trim().slice(0,20)||`Player ${playerId}`;
      players[playerId].name=name;
      broadcastAll({type:'players',players:sanitizePlayers()});
      broadcastAll({type:'leaderboard',scores:buildLeaderboard()});
    }

    // ── Report own city stats (for leaderboard) ──────
    if (msg.type==='score') {
      players[playerId].pop   = Math.max(0, parseInt(msg.pop)||0);
      players[playerId].money = Math.max(0, parseInt(msg.money)||0);
      // No broadcast needed — leaderboard is sent every economy tick
    }

    // ── World chat ───────────────────────────────────
    if (msg.type==='chat') {
      const text=(msg.text||'').toString().trim().slice(0,CHAT_MAX);
      if (!text) return;
      const p=players[playerId];
      const chatMsg={type:'chat',playerId,name:p.name,color:p.color,text,ts:Date.now()};
      chatLog.push(chatMsg);
      if (chatLog.length>50) chatLog.shift();
      broadcastAll(chatMsg);
    }

    // ── City raid ────────────────────────────────────
    if (msg.type==='raid') {
      const targetId=parseInt(msg.targetPlayerId);
      const raider=players[playerId];
      if (!raider||!targetId||targetId===playerId) return;
      const target=players[targetId];
      if (!target||!target.ws) return;
      if ((raider.money||0)<RAID_COST) {
        sendTo(ws,{type:'chat',playerId:0,name:'System',color:'#ff6b6b',
          text:`Raid failed — need $${RAID_COST} to raid.`,ts:Date.now()});
        return;
      }
      raider.money=Math.max(0,(raider.money||0)-RAID_COST);
      // Send raid event to target
      sendTo(target.ws,{type:'raided',by:playerId,byName:raider.name,byColor:raider.color});
      // Notify raider
      sendTo(ws,{type:'chat',playerId:0,name:'System',color:'#ff922b',
        text:`⚔️ Raid launched on ${target.name}! -$${RAID_COST}`,ts:Date.now()});
      // Announce in chat
      const ann={type:'chat',playerId:0,name:'System',color:'#ff6b6b',
        text:`⚔️ ${raider.name} raided ${target.name}'s city!`,ts:Date.now()};
      chatLog.push(ann); if(chatLog.length>50) chatLog.shift();
      broadcastAll(ann);
    }

    // ── Build / demolish / upgrade ───────────────────
    if (msg.type==='build') {
      const {x,z,zone}=msg;
      if (!inBounds(x,z)||tiles[x][z].type!=='empty') return;
      const key=`${x}_${z}`;
      tiles[x][z]={type:zone,level:1}; world[key]={x,z,zone,level:1,playerId};
      if (zone==='com')   ensureComStore(x,z);
      if (zone==='ind')   ensureIndStore(x,z);
      if (zone==='power') rebuildPowerMap();
      if (zone==='res')   population+=POP_PER_LEVEL[0];
      broadcastAll(msg);
    }
    if (msg.type==='demolish') {
      const {x,z}=msg; if (!inBounds(x,z)) return;
      const t=tiles[x][z]; const key=`${x}_${z}`;
      if (t.type==='res')   population-=POP_PER_LEVEL[(t.level||1)-1];
      if (t.type==='com')   delete comStore[key];
      if (t.type==='ind')   delete indStore[key];
      if (t.type==='power') rebuildPowerMap();
      delete growthTimers[key]; tiles[x][z]={type:'empty',level:0}; delete world[key];
      broadcastAll(msg);
    }
    if (msg.type==='upgrade') {
      const {x,z}=msg; if (!inBounds(x,z)) return;
      const t=tiles[x][z]; const key=`${x}_${z}`;
      if (!t||t.level>=3||!hasPower(x,z)) return;
      const cost=UPGRADE_COSTS[t.level-1]; if (money<cost) return;
      money-=cost;
      if (t.type==='res'){population-=POP_PER_LEVEL[t.level-1];t.level++;population+=POP_PER_LEVEL[t.level-1];}
      else t.level++;
      if (t.type==='ind'){const ist=ensureIndStore(x,z);ist.capacity=IND_CAPACITY+(t.level-1)*30;}
      if (world[key]) world[key].level=t.level;
      msg.newLevel=t.level; broadcastAll(msg);
    }
  });

  ws.on('close',()=>{
    delete players[playerId];
    console.log(`[-] Player ${playerId} disconnected (${wss.clients.size} online)`);
    broadcastAll({type:'players',players:sanitizePlayers()});
    broadcastAll({type:'leaderboard',scores:buildLeaderboard()});
  });
  ws.on('error',err=>console.error(`[!] Player ${playerId}:`,err.message));
});

// Strip ws reference before sending to clients
function sanitizePlayers() {
  const out={};
  for (const [id,p] of Object.entries(players)) out[id]={color:p.color,name:p.name};
  return out;
}

httpServer.listen(PORT,()=>{
  console.log(`Pixel_Polis v3 server → http://localhost:${PORT}`);
  console.log(`npm install ws  then  node server.js`);
});
