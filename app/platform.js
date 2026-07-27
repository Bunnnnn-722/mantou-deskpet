'use strict';
/* ================= 跨平台系统集成 =================
 * 把三个原本 macOS 专属的旁路收拢到一处，按 process.platform 分派：
 *   nowPlaying()      — 正在播放的歌名（听歌点评用）
 *   musicAppRunning() — 音乐播放器进程门禁（防语音输入误触发点头）
 *   getAutostart() / setAutostart() — 开机自启
 * macOS 现实现原样保留；Windows 用 powershell / tasklist 等价实现；
 * 其它平台（linux 等）走安全兜底（空串 / false），不炸。
 * 出处与替代方案见 docs/Windows兼容排查_2026-07-19.md。 */
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// ---------- 音乐播放器进程门禁 ----------
// mac：comm 路径/名称特征（含中文进程名）。
const MUSIC_COMM_MAC = [
  'neteasemusic', 'qqmusic', 'spotify', '/music.app/contents/macos/music',
  'kugou', 'kuwo', 'cloudmusic', 'foobar2000',
  '网易云音乐', 'qq音乐', '酷狗', '酷我', '汽水音乐',
];
// win：进程 exe 名（全 ASCII，绕开 tasklist 在中文系统上的 cp936 乱码——
// 只要匹配 exe 名就够，不去碰会乱码的中文进程/窗口标题字段）。
const MUSIC_EXE_WIN = [
  'cloudmusic.exe', 'qqmusic.exe', 'spotify.exe', 'kugou.exe',
  'kwmusic.exe', 'foobar2000.exe', 'aimp.exe', 'musicbee.exe', 'wemusic.exe',
];

function musicAppRunning() {
  return new Promise((res) => {
    if (IS_MAC) {
      exec('ps -A -o comm=', (err, stdout) => {
        if (err) return res(false);
        const s = stdout.toLowerCase();
        res(MUSIC_COMM_MAC.some((k) => s.includes(k)));
      });
    } else if (IS_WIN) {
      // /fo csv /nh：镜像名在第一列且带引号，ASCII 匹配不受编码影响
      exec('tasklist /fo csv /nh', { windowsHide: true }, (err, stdout) => {
        if (err) return res(false);
        const s = (stdout || '').toLowerCase();
        res(MUSIC_EXE_WIN.some((k) => s.includes(k)));
      });
    } else {
      res(false);
    }
  });
}

// ---------- 正在播放（歌名 - 歌手） ----------
// mac：官方 AppleScript(Spotify/Music) → 播放器窗口标题 → 网易云历史库兜底。
const NOW_PLAYING_SCRIPT = `
set out to ""
-- Spotify/Music 官方接口必须走 run script(运行期才解析词汇表):
-- 直接写 tell 的话，应用没安装会让整段脚本编译失败，try 都救不了，
-- "正在播放"就永远返回空(踩过坑)
repeat with ap in {"Spotify", "Music"}
  set a to ap as string
  try
    tell application "System Events" to set ok to exists process a
    if ok then
      set s to "tell application \\"" & a & "\\"" & linefeed & "if player state is playing then return (name of current track) & \\" - \\" & (artist of current track)" & linefeed & "end tell" & linefeed & "return \\"\\""
      set out to run script s
    end if
  end try
  if out is not "" then exit repeat
end repeat
if out is "" then
  repeat with pname in {"NeteaseMusic", "网易云音乐", "QQMusic", "QQ音乐", "Kugou", "酷狗音乐"}
    try
      tell application "System Events"
        if exists process pname then
          set t to name of front window of process pname
          if t is not equal to (pname as string) then set out to t
        end if
      end tell
    end try
    if out is not "" then exit repeat
  end repeat
end if
return out`;

// 网易云 mac 兜底:窗口标题不含歌名(实测全空),但网易云把播放历史秒级写本地 sqlite
const NETEASE_DB_MAC = path.join(require('os').homedir(),
  'Library/Application Support/com.netease.163music/Documents/storage/sqlite_storage.sqlite3');
function neteaseNowPlayingMac() {
  return new Promise((res) => {
    if (!fs.existsSync(NETEASE_DB_MAC)) return res('');
    execFile('/usr/bin/sqlite3',
      ['-readonly', '-separator', '\x1f', NETEASE_DB_MAC,
        'SELECT playtime, jsonStr FROM historyTracks ORDER BY playtime DESC LIMIT 1;'],
      { timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return res('');
        try {
          const i = stdout.indexOf('\x1f');
          const pt = Number(stdout.slice(0, i));
          if (Date.now() - pt > 30 * 60 * 1000) return res(''); // 半小时无新记录=大概率已停
          const j = JSON.parse(stdout.slice(i + 1));
          const artists = (j.artists || []).map((a) => a.name).join('/');
          res(j.name ? `${j.name}${artists ? ' - ' + artists : ''}` : '');
        } catch { res(''); }
      });
  });
}

function nowPlayingMac() {
  return new Promise((res) => {
    execFile('osascript', ['-e', NOW_PLAYING_SCRIPT], { timeout: 5000 }, (err, stdout) => {
      const out = err ? '' : (stdout || '').trim();
      if (out) return res(out);
      neteaseNowPlayingMac().then(res); // 官方接口/窗口标题都空 → 读网易云历史库
    });
  });
}

// win：读音乐播放器进程的主窗口标题（播放时就是"歌名 - 歌手"）。
// PowerShell 强制 UTF-8 输出，中文歌名不乱码；空闲态标题（=应用名/广告）过滤掉。
const WIN_NP_PROCS = ['cloudmusic', 'QQMusic', 'Spotify', 'Kugou', 'KwMusic', 'foobar2000', 'AIMP', 'MusicBee'];
const WIN_IDLE_TITLES = new Set([
  '网易云音乐', 'qq音乐', 'qqmusic', 'spotify', 'spotify free', 'spotify premium',
  'advertisement', '酷狗音乐', '酷我音乐', 'foobar2000', 'aimp', 'musicbee', 'wemusic',
]);
function nowPlayingWin() {
  return new Promise((res) => {
    const names = WIN_NP_PROCS.map((n) => `'${n}'`).join(',');
    const ps =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
      `$ns=@(${names});foreach($n in $ns){` +
      "$p=Get-Process -Name $n -ErrorAction SilentlyContinue|" +
      "Where-Object{$_.MainWindowTitle}|Select-Object -First 1;" +
      "if($p){$t=$p.MainWindowTitle;if($t){Write-Output $t;break}}}";
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return res('');
        const t = (stdout || '').trim();
        if (!t || WIN_IDLE_TITLES.has(t.toLowerCase())) return res('');
        res(t);
      });
  });
}

function nowPlaying() {
  if (IS_MAC) return nowPlayingMac();
  if (IS_WIN) return nowPlayingWin();
  return Promise.resolve('');
}

// ---------- 开机自启 ----------
// 统一走 Electron 内置的 app.setLoginItemSettings（mac=登录项 / win=注册表 Run 键），
// 跨平台且打包后稳定。mac 旧版曾写 LaunchAgent plist（绑定开发期 Electron 二进制），
// 这里读到旧 plist 仍算"已开启"，关闭时顺手清理，平滑迁移。
const LEGACY_PLIST_MAC = path.join(require('os').homedir(),
  'Library', 'LaunchAgents', 'local.mantou.deskpet.plist');

function getAutostart() {
  try {
    const { app } = require('electron');
    if (app.getLoginItemSettings().openAtLogin) return true;
  } catch { /* 忽略 */ }
  if (IS_MAC) { try { return fs.existsSync(LEGACY_PLIST_MAC); } catch { return false; } }
  return false;
}

function setAutostart(on) {
  try {
    const { app } = require('electron');
    app.setLoginItemSettings({ openAtLogin: !!on });
    if (IS_MAC && !on && fs.existsSync(LEGACY_PLIST_MAC)) {
      try { fs.unlinkSync(LEGACY_PLIST_MAC); } catch { /* 忽略 */ }
    }
    return true;
  } catch { return false; }
}

module.exports = { IS_MAC, IS_WIN, nowPlaying, musicAppRunning, getAutostart, setAutostart };
