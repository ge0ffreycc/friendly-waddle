const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 调试日志写入文件
const DEBUG_LOG = path.join(__dirname, 'app-debug.log');
function log(...args) {
  try {
    fs.appendFileSync(DEBUG_LOG, '[' + new Date().toISOString() + '] ' + args.join(' ') + '\n');
  } catch {}
}

// 兼容沙箱/权限受限环境：禁用 GPU 沙箱、使用本地 userData
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
try {
  const userDataDir = path.join(__dirname, 'appdata');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  log('userData set to', userDataDir);
} catch (e) {
  log('userData set failed', e.message);
}

log('main.js loaded, argv:', process.argv.join(' '));

// 窗口默认尺寸
const WIN_W = 360;
const WIN_H = 560;

// 边缘缩进配置
const EDGE_THRESHOLD = 16;         // 距离边缘多少像素视为"靠近"
const VISIBLE_STRIP = 12;          // 缩进后保留可见的像素宽度
const HIDE_DELAY = 700;            // 鼠标离开后多久开始缩进(毫秒)
const ANIM_STEP = 24;              // 每帧移动像素
const ANIM_INTERVAL = 10;          // 每帧间隔(毫秒)
const HOVER_MARGIN = 18;           // 展开后命中测试向外扩展像素（防边缘抖动）
const SLIDEIN_COOLDOWN = 400;      // 展开后至少保持多久才允许再次缩进

let win = null;
let isDocked = false;              // 是否已缩进
let dockSide = null;               // 'left' | 'right' | 'top'
let hideTimer = null;
let pollTimer = null;
let animating = false;             // 动画进行中，屏蔽move事件触发
let slideInUntil = 0;              // 展开冷却截止时间戳（毫秒）

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 默认停靠在桌面右侧
  const x = workArea.x + workArea.width - WIN_W;
  const y = workArea.y + Math.floor((workArea.height - WIN_H) / 2);

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => log('window ready-to-show'));
  win.webContents.on('did-finish-load', () => log('webcontents did-finish-load'));
  win.webContents.on('console-message', (e, level, msg) => log('renderer console:', msg));
  win.on('closed', () => log('window closed'));

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // 注意：不再监听 move 事件——因为 Electron 没有"拖动结束"事件，
  // move 会在每帧拖动时触发，会与用户拖动操作打架。
  // 边缘检测完全由 120ms 的 pollCursor 轮询承担，只有窗口真正停留在边缘 + 鼠标离开时才触发缩进。

  // 启动轮询：鼠标进入可见条时弹出 / 离开边缘贴边时缩进
  pollTimer = setInterval(pollCursor, 120);
}

// 计算窗口在屏幕上的工作区边界
function getWindowBoundsOnScreen() {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) ||
      !Number.isFinite(b.width) || !Number.isFinite(b.height) ||
      b.width <= 0 || b.height <= 0) return null;

  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  let disp;
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    try {
      disp = screen.getDisplayMatching({ x: cx, y: cy });
    } catch (_) { disp = null; }
  }
  if (!disp || !disp.workArea) {
    try { disp = screen.getPrimaryDisplay(); } catch (_) { disp = null; }
  }
  if (!disp || !disp.workArea) return null;
  return { win: b, screen: disp.workArea };
}

// 判断窗口是否靠近某条边缘
function detectEdge() {
  const info = getWindowBoundsOnScreen();
  if (!info) return null;
  const { win: b, screen: wa } = info;
  if (b.x <= wa.x + EDGE_THRESHOLD) return 'left';
  if (b.x + b.width >= wa.x + wa.width - EDGE_THRESHOLD) return 'right';
  if (b.y <= wa.y + EDGE_THRESHOLD) return 'top';
  return null;
}

// 处理边缘检测（由 move 事件触发）
function handleEdgeCheck(fromMove) {
  if (isDocked) return;
  if (animating) return;
  // 展开冷却期内，不允许重新缩进
  if (Date.now() < slideInUntil) return;
  const side = detectEdge();
  if (side) {
    dockSide = side;
    if (fromMove) {
      // 用户主动拖到边缘：先清掉旧定时，直接缩进
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      slideOff();
    } else {
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          slideOff();
        }, HIDE_DELAY);
      }
    }
  } else {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
}

// 缩进：把窗口移出屏幕，只留一条可见条
function slideOff() {
  if (isDocked) return;
  if (animating) return;
  if (!win || win.isDestroyed()) return;
  isDocked = true;
  dockSide = dockSide || detectEdge();
  if (!dockSide) {
    isDocked = false;
    return;
  }

  const b = win.getBounds();
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) { isDocked = false; return; }
  const target = computeDockedBounds(b, dockSide);
  animating = true;
  animateToBounds(b, target, () => {
    animating = false;
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false);
  });
}

function computeDockedBounds(b, side) {
  const info = getWindowBoundsOnScreen();
  const wa = info ? info.screen : screen.getPrimaryDisplay().workArea;
  const tb = { width: b.width, height: b.height };
  if (side === 'left') {
    tb.x = wa.x - b.width + VISIBLE_STRIP;
    tb.y = b.y;
  } else if (side === 'right') {
    tb.x = wa.x + wa.width - VISIBLE_STRIP;
    tb.y = b.y;
  } else if (side === 'top') {
    tb.x = b.x;
    tb.y = wa.y - b.height + VISIBLE_STRIP;
  }
  return tb;
}

// 展开：把窗口移回完全可见
function slideIn() {
  if (!isDocked) return;
  if (animating) return;
  if (!win || win.isDestroyed()) return;
  isDocked = false;
  // 展开冷却：一段时间内不允许重新缩进，防止边缘抖动
  slideInUntil = Date.now() + SLIDEIN_COOLDOWN;
  clearTimeout(hideTimer);
  const b = win.getBounds();
  const info = getWindowBoundsOnScreen();
  const wa = info ? info.screen : screen.getPrimaryDisplay().workArea;
  const target = { width: b.width, height: b.height };
  if (dockSide === 'left') {
    target.x = wa.x;
    target.y = b.y;
  } else if (dockSide === 'right') {
    target.x = wa.x + wa.width - b.width;
    target.y = b.y;
  } else if (dockSide === 'top') {
    target.x = b.x;
    target.y = wa.y;
  }
  animating = true;
  animateToBounds(b, target, () => {
    animating = false;
  });
}

function animateToBounds(from, to, done) {
  let cur = { ...from };
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const step = () => {
    let arrived = true;
    if (cur.x !== to.x) {
      cur.x = stepToward(cur.x, to.x, dx, ANIM_STEP);
      arrived = false;
    }
    if (cur.y !== to.y) {
      cur.y = stepToward(cur.y, to.y, dy, ANIM_STEP);
      arrived = false;
    }
    cur.width = to.width;
    cur.height = to.height;
    win.setBounds(cur);
    if (!arrived) {
      setTimeout(step, ANIM_INTERVAL);
    } else if (done) {
      done();
    }
  };
  step();
}

function stepToward(cur, target, dir, step) {
  const next = cur + dir * step;
  if (dir > 0 && next >= target) return target;
  if (dir < 0 && next <= target) return target;
  return next;
}

// 点是否在带边距的矩形内
function pointInRectWithMargin(pt, b, margin) {
  return pt.x >= b.x - margin && pt.x <= b.x + b.width + margin &&
         pt.y >= b.y - margin && pt.y <= b.y + b.height + margin;
}

// 轮询鼠标：缩进状态下，鼠标进入可见条则展开
function pollCursor() {
  if (!win || win.isDestroyed()) return;
  if (animating) return;
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;

  if (isDocked) {
    // 缩进态：命中可见条区域 → 展开（带小量边距容错）
    const inside = pointInRectWithMargin(pt, b, 6);
    if (inside) {
      slideIn();
    }
  } else {
    // 展开态：命中测试外扩 HOVER_MARGIN，避免鼠标刚到窗口边界就判"离开"
    const inExpandedZone = pointInRectWithMargin(pt, b, HOVER_MARGIN);
    const cooling = Date.now() < slideInUntil;
    const side = (!inExpandedZone && !cooling) ? detectEdge() : null;

    if (inExpandedZone || cooling || !side) {
      // 不满足缩进条件 → 取消待执行的缩进定时器
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    } else {
      // 满足缩进条件（鼠标离开+冷却结束+贴边）
      // 只在还没启动定时时才 set，避免每 120ms 重置导致永远触发不了
      dockSide = side;
      if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          slideOff();
        }, HIDE_DELAY);
      }
    }
  }
}

// IPC: 拖动窗口 (自定义标题栏)
ipcMain.on('win:drag', () => {
  if (win && !win.isDestroyed()) {
    // 用户开始拖动，先展开
    if (isDocked) slideIn();
  }
});

// IPC: 关闭
ipcMain.on('win:close', () => {
  if (win && !win.isDestroyed()) win.close();
});

// IPC: 切换置顶
ipcMain.on('win:toggle-top', () => {
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!win.isAlwaysOnTop());
  }
});

app.whenReady().then(() => {
  log('app ready, creating window');
  try {
    createWindow();
    log('createWindow returned, windows:', BrowserWindow.getAllWindows().length);
  } catch (e) {
    log('createWindow threw', e.stack);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(e => log('whenReady error', e.stack));

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  app.quit();
});
