// OS-level foreground-window capture/restore (Windows only).
//
// Node has no built-in access to user32, and the alternatives are all native
// modules (koffi, ffi-napi, node-window-manager) that need a toolchain and a
// rebuild per Node version. This avoids that entirely by keeping ONE
// long-lived PowerShell helper alive and talking to it over stdin/stdout in
// newline-delimited JSON. Add-Type compiles the P/Invoke signatures once at
// startup (~400ms) instead of once per call, so individual calls are ~1-3ms.
//
// Zero new npm dependencies.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENABLED =
  process.platform === "win32" && process.env.PROXI_RESTORE_FOCUS !== "0";

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool fAltTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

function Get-Fg {
  $h = [Fg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][Fg]::GetWindowText($h, $sb, 512)
  $wpid = 0
  [void][Fg]::GetWindowThreadProcessId($h, [ref]$wpid)
  return [pscustomobject]@{ hwnd = [int64]$h; pid = [int]$wpid; title = $sb.ToString() }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
    $rid = $req.id
    if ($req.op -eq 'get') {
      $r = Get-Fg
      [Console]::Out.WriteLine((@{ id = $rid; ok = $true; hwnd = $r.hwnd; pid = $r.pid; title = $r.title } | ConvertTo-Json -Compress))
    }
    elseif ($req.op -eq 'set') {
      $target = [IntPtr][int64]$req.hwnd
      if (-not [Fg]::IsWindow($target)) {
        [Console]::Out.WriteLine((@{ id = $rid; ok = $false; error = 'window no longer exists' } | ConvertTo-Json -Compress))
        continue
      }
      # A background process normally cannot call SetForegroundWindow. The
      # documented workaround is to attach our input queue to the thread that
      # currently owns the foreground, which grants the right for the call.
      $cur = [Fg]::GetForegroundWindow()
      $curTid = 0
      $null = [Fg]::GetWindowThreadProcessId($cur, [ref]$curTid)
      $me = [Fg]::GetCurrentThreadId()
      $attached = $false
      if ($curTid -ne 0 -and $curTid -ne $me) { $attached = [Fg]::AttachThreadInput($me, $curTid, $true) }
      if ([Fg]::IsIconic($target)) { [void][Fg]::ShowWindow($target, 9) }  # SW_RESTORE
      $ok = [Fg]::SetForegroundWindow($target)
      $method = 'SetForegroundWindow'

      # Windows' foreground lock refuses SetForegroundWindow from a process
      # that does not own the foreground. Escape hatch 1: synthesise an ALT
      # keypress, which resets the lock for this thread, then retry.
      if (-not $ok -or ([Fg]::GetForegroundWindow() -ne $target)) {
        [Fg]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)        # ALT down
        [Fg]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)        # ALT up
        $ok = [Fg]::SetForegroundWindow($target)
        $method = 'alt-key + SetForegroundWindow'
      }

      # Escape hatch 2: SwitchToThisWindow, which the shell itself uses and
      # which is not subject to the same restriction.
      if ([Fg]::GetForegroundWindow() -ne $target) {
        [Fg]::SwitchToThisWindow($target, $true)
        $method = 'SwitchToThisWindow'
      }

      if ($attached) { [void][Fg]::AttachThreadInput($me, $curTid, $false) }
      $after = Get-Fg
      $ok = ($after.hwnd -eq $req.hwnd)
      [Console]::Out.WriteLine((@{ id = $rid; ok = $ok; restored = ($after.hwnd -eq $req.hwnd); method = $method; nowPid = $after.pid; nowTitle = $after.title } | ConvertTo-Json -Compress))
    }
    elseif ($req.op -eq 'chromepids') {
      # Which chrome.exe processes belong to OUR debug instance, so a restore
      # only ever fires for that window and never for the user's own Chrome.
      $pat = '*--remote-debugging-port=' + $req.port + '*'
      $ids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
               Where-Object { $_.CommandLine -like $pat } |
               ForEach-Object { [int]$_.ProcessId })
      [Console]::Out.WriteLine((@{ id = $rid; ok = $true; pids = $ids } | ConvertTo-Json -Compress))
    }
    else {
      [Console]::Out.WriteLine((@{ id = $rid; ok = $false; error = 'unknown op' } | ConvertTo-Json -Compress))
    }
  } catch {
    [Console]::Out.WriteLine((@{ id = $rid; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

let helper = null;
// Responses are matched by request id, not arrival order: the first call has
// to wait for Add-Type to compile (several seconds), and a FIFO queue would
// desync permanently if that call ever timed out.
const pending = new Map();
let nextId = 1;
let buffer = "";

function ensureHelper() {
  if (helper || !ENABLED) return helper;

  // -File, not "-Command -": with -Command - PowerShell treats stdin as its
  // own command stream and swallows the first request line before the script's
  // ReadLine() loop ever starts. Writing the helper to a file keeps stdin
  // exclusively ours.
  const scriptPath = path.join(os.tmpdir(), "proxi-focus-helper.ps1");
  try {
    fs.writeFileSync(scriptPath, HELPER_SCRIPT, "utf8");
  } catch (err) {
    console.warn("focus: could not write helper script:", err.message);
    helper = null;
    return null;
  }

  helper = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );

  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray PowerShell chatter, not a response
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  const fail = (err) => {
    for (const [, p] of pending) p.resolve({ ok: false, error: String(err) });
    pending.clear();
    helper = null;
  };
  helper.on("error", fail);
  helper.on("exit", () => fail("focus helper exited"));
  helper.stdin.on("error", () => {});

  // No stdin priming: the script comes from -File, and stdin carries only
  // requests.
  helper.unref();

  return helper;
}

// Generous by default: the very first request also pays for Add-Type
// compiling the P/Invoke signatures inside the freshly spawned PowerShell.
function send(req, timeoutMs = 20_000) {
  if (!ENABLED) return Promise.resolve({ ok: false, error: "disabled" });
  const h = ensureHelper();
  if (!h) return Promise.resolve({ ok: false, error: "helper unavailable" });

  const id = nextId++;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "focus helper timeout" });
    }, timeoutMs);

    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
    });

    try {
      h.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: String(err) });
    }
  });
}

/** @returns {Promise<{hwnd:number,pid:number,title:string}|null>} */
async function getForegroundWindow() {
  const r = await send({ op: "get" });
  return r.ok ? { hwnd: r.hwnd, pid: r.pid, title: r.title } : null;
}

/** @returns {Promise<{ok:boolean,restored?:boolean,nowTitle?:string,error?:string}>} */
async function setForegroundWindow(hwnd) {
  return send({ op: "set", hwnd });
}

// pids are stable while Chrome runs; re-check occasionally in case it restarts.
let pidCache = { at: 0, pids: new Set() };

async function debugChromePids() {
  if (Date.now() - pidCache.at < 60_000) return pidCache.pids;
  const r = await send({ op: "chromepids", port: process.env.CHROME_DEBUG_PORT });
  const pids = new Set(r.ok && Array.isArray(r.pids) ? r.pids : []);
  // Don't cache an empty result — it usually means the lookup failed.
  if (pids.size) pidCache = { at: Date.now(), pids };
  return pids;
}

/**
 * Runs `fn`, and if the OS foreground window ends up on the debug Chrome when
 * it did not start there, puts the user's original window back.
 *
 * This is a defensive net, not a fix for a known cause: a foreground steal
 * could not be reproduced deterministically (see scripts/_focus_actions2.js —
 * 0 steals across 36 action-observations on an idle desktop), but the symptom
 * is reported in real use, so every Proxi entry point is wrapped.
 *
 * It deliberately restores ONLY when the new foreground belongs to our debug
 * Chrome instance (matched by pid via --remote-debugging-port), so it can
 * never yank the user out of their own separate Chrome.
 *
 * @template T
 * @param {string} label - for logging
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFocusGuard(label, fn) {
  if (!ENABLED) return fn();

  const before = await getForegroundWindow();

  try {
    return await fn();
  } finally {
    try {
      if (before?.hwnd) {
        const after = await getForegroundWindow();
        if (after && after.hwnd !== before.hwnd) {
          const pids = await debugChromePids();
          if (pids.has(after.pid)) {
            const r = await setForegroundWindow(before.hwnd);
            console.log(
              `[focus] ${label}: debug Chrome took foreground (${JSON.stringify(
                after.title
              )}); restoring ${JSON.stringify(before.title)} -> ${
                r.restored ? "restored" : `FAILED (${r.error || "denied by OS"})`
              }`
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[focus] ${label}: guard failed:`, err.message);
    }
  }
}

function dispose() {
  if (helper) {
    try {
      helper.stdin.end();
    } catch {}
    helper = null;
  }
}

module.exports = {
  getForegroundWindow,
  setForegroundWindow,
  withFocusGuard,
  dispose,
  ENABLED,
};
