import { execFile } from "node:child_process";

/**
 * macOS notification.
 *
 * The scheduler runs unattended and writes to a log nobody opens, so a silent
 * failure — expired cookies being the likely one — would look exactly like a
 * week with no changes needed. Anything worth knowing gets surfaced here.
 */
export function notify(title: string, message: string, subtitle?: string): Promise<void> {
  if (process.platform !== "darwin" || process.env.FFCC_NO_NOTIFY === "1") return Promise.resolve();

  // Escape for AppleScript string literals.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 220);
  const script =
    `display notification "${esc(message)}" with title "${esc(title)}"` +
    (subtitle ? ` subtitle "${esc(subtitle)}"` : "");

  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], () => resolve());
  });
}
