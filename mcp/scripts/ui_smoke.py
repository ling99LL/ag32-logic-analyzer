#!/usr/bin/env python3
import os
import threading
from functools import partial
from pathlib import Path
from urllib.request import urlopen

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "ui"
PREFERRED_URL = os.environ.get("AG32_UI_URL", "http://127.0.0.1:4178/")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    server, url = resolve_url()
    errors: list[str] = [ ]
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.on("console", lambda message: errors.append(f"console: {message.text}") if message.type == "error" else None)
            page.goto(url, wait_until="networkidle")
            page.get_by_role("heading", name="采样与触发").wait_for()

            canvas_stats = page.locator("canvas").evaluate(
                """canvas => {
                    const ctx = canvas.getContext('2d');
                    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let nonBackground = 0;
                    for (let i = 0; i < data.length; i += 16) {
                        if (data[i] > 28 || data[i + 1] > 32 || data[i + 2] > 28) nonBackground += 1;
                    }
                    return {width: canvas.width, height: canvas.height, nonBackground};
                }
                """
            )
            if canvas_stats["width"] < 300 or canvas_stats["nonBackground"] < 100:
                raise RuntimeError(f"Canvas did not render waveform content: {canvas_stats}")

            page.get_by_role("button", name="采集一帧").click()
            page.wait_for_timeout(500)
            page.screenshot(path=str(OUT / "analyzer-1440.png"), full_page=True)

            page.get_by_role("button", name="历史记录").click()
            page.get_by_role("heading", name="历史记录").wait_for()
            page.screenshot(path=str(OUT / "history-1440.png"), full_page=True)

            page.set_viewport_size({"width": 1024, "height": 768})
            page.get_by_role("button", name="波形分析").click()
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT / "analyzer-1024.png"), full_page=True)

            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT / "analyzer-390.png"), full_page=True)
            browser.close()
    finally:
        if server:
            server.shutdown()
            server.server_close()

    if errors:
        raise RuntimeError("\n".join(errors))
    print(f"UI smoke PASS via {url}; screenshots: {OUT}")


def resolve_url():
    try:
        with urlopen(PREFERRED_URL, timeout=1):
            return None, PREFERRED_URL
    except Exception:
        handler = partial(QuietHandler, directory=str(ROOT / "dist" / "renderer"))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, f"http://127.0.0.1:{server.server_port}/"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    main()
