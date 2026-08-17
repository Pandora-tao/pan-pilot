/**
 * 防止移动端浏览器在 Agent 处理长任务期间锁屏/挂起——iOS Safari 后台挂起会
 * 回收 SSE 长连接，导致任务被服务端以 USER_ABORTED 中止。
 *
 * 双方案：优先 Screen Wake Lock API（iOS 16.4+ / 现代浏览器）；老设备
 * （如停在 iOS 15.8 的 iPhone）降级为循环播放静音视频（NoSleep 原理，
 * 播放中的视频让 iOS 不自动锁屏）。
 */

const KEEP_AWAKE_VIDEO =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMobW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHLbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABdm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAATZzdGJsAAAAtnN0c2QAAAAAAAAAAQAAAKZhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALGF2Y0MBQsAK/+EAFWdCwAraewEQAAADABAAAAMAIPEiagEABGjOD8gAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAJuAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAgAAQAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAmUAAAAJAAAAFHN0Y28AAAAAAAAAAQAAA1gAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYyLjMuMTAwAAAACGZyZWUAAAJ2bWRhdAAAAlMGBf//T9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACAAAAACmWIhDomKAAJAuAAAAAFQZogFKU=";

interface WakeLockSentinel {
  release: () => Promise<void>;
}

let wakeLock: WakeLockSentinel | null = null;
let video: HTMLVideoElement | null = null;

/** 在 Agent 处理期间调用：请求屏幕常亮。 */
export async function keepAwake(): Promise<void> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
  };
  if (nav.wakeLock?.request !== undefined) {
    try {
      wakeLock = await nav.wakeLock.request("screen");
      // Safari 切回前台会自动释放 wake lock，重新可见时恢复。
      document.addEventListener("visibilitychange", restoreWakeLock);
      return;
    } catch {
      // 无权限/被拒时降级到视频方案。
    }
  }
  startNoSleepVideo();
}

/** 处理结束（成功/失败/停止）后调用：释放常亮。 */
export function stopAwake(): void {
  if (wakeLock !== null) {
    void wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  document.removeEventListener("visibilitychange", restoreWakeLock);
  if (video !== null) {
    video.pause();
    video.remove();
    video = null;
  }
}

function restoreWakeLock(): void {
  if (document.visibilityState !== "visible" || wakeLock === null) return;
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
  };
  void nav.wakeLock?.request("screen")
    .then((lock) => { wakeLock = lock; })
    .catch(() => {});
}

/** 老 iOS 降级：循环播放 1×1 静音视频，阻止自动锁屏。 */
function startNoSleepVideo(): void {
  if (video !== null) return;
  const element = document.createElement("video");
  element.muted = true;
  element.loop = true;
  element.playsInline = true;
  element.src = KEEP_AWAKE_VIDEO;
  element.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;"
    + "opacity:0;pointer-events:none;";
  document.body.appendChild(element);
  video = element;
  // iOS 上需要用户手势后才允许 autoplay；调用方（点击发送）本身就在手势中。
  void element.play().catch(() => {});
}
