#!/usr/bin/env python3
import os
import re
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
            page.get_by_role("heading", name="逻辑分析仪", exact=True).wait_for()
            page.get_by_role("combobox", name="设备编号").select_option("2")
            page.wait_for_timeout(120)
            if page.evaluate("JSON.parse(localStorage.getItem('ag32.deviceIndexByPort') || '{}').COM33") != 2:
                raise RuntimeError("Device LED identity was not persisted for COM33")

            canvas_stats = page.locator("canvas").evaluate(
                """canvas => {
                    const ctx = canvas.getContext('2d');
                    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let nonBackground = 0;
                    for (let i = 0; i < data.length; i += 16) {
                        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) nonBackground += 1;
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

            if page.evaluate("getComputedStyle(document.documentElement).backgroundColor") != "rgb(245, 246, 250)":
                raise RuntimeError("The light workspace background was not applied")
            page.get_by_role("button", name="边沿", exact=True).click()
            page.get_by_text("任一所选边沿成立即触发").wait_for()
            page.get_by_role("button", name="立即", exact=True).click()
            page.get_by_role("button", name="重复采集", exact=True).click()
            page.get_by_text("实时采集 · 20 FPS").wait_for()
            page.get_by_role("button", name="停止", exact=True).click()

            page.get_by_role("button", name="连接并点亮 LED3", exact=True).click()
            page.get_by_text("2 / 4 在线", exact=True).wait_for()
            page.get_by_role("button", name="联合采集", exact=True).click()
            page.get_by_text("2 台设备联合视图", exact=True).wait_for()
            group_canvas = page.locator(".group-waveform-wrap canvas").evaluate(
                """canvas => {
                    const ctx = canvas.getContext('2d');
                    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let nonBackground = 0;
                    for (let i = 0; i < data.length; i += 16) {
                        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) nonBackground += 1;
                    }
                    return {width: canvas.width, height: canvas.height, nonBackground};
                }
                """
            )
            if group_canvas["nonBackground"] < 100:
                raise RuntimeError(f"Joint waveform did not render: {group_canvas}")
            page.screenshot(path=str(OUT / "group-1440.png"), full_page=True)
            page.get_by_role("button", name="退出联合视图", exact=True).click()

            page.get_by_role("button", name="信号输出", exact=True).click()
            page.get_by_role("heading", name="数字输出 PIN_5").wait_for()
            page.get_by_role("button", name="应用数字方波").click()
            page.get_by_role("button", name="触发引擎", exact=True).click()
            page.get_by_role("button", name="布防", exact=True).click()
            page.get_by_role("button", name="三角", exact=True).click()
            page.get_by_role("button", name="应用模拟波形").click()
            page.screenshot(path=str(OUT / "outputs-1440.png"), full_page=True)

            page.get_by_role("button", name="历史记录").click()
            page.get_by_role("heading", name="历史记录").wait_for()
            page.locator(".history-table tbody tr").first.wait_for()
            page.get_by_role("textbox", name="搜索历史记录").fill("desktop")
            if page.locator(".history-table tbody tr").count() < 2:
                raise RuntimeError("History search did not filter the saved frame")
            page.get_by_role("textbox", name="搜索历史记录").fill("")
            page.get_by_role("button", name="收藏记录", exact=True).first.click()
            page.get_by_role("button", name="已收藏", exact=True).click()
            if page.locator(".history-table tbody tr").count() != 1:
                raise RuntimeError("Favorite history filter did not work")
            page.get_by_role("button", name=re.compile("全部记录")).click()
            page.screenshot(path=str(OUT / "history-1440.png"), full_page=True)

            page.set_viewport_size({"width": 1024, "height": 768})
            page.get_by_role("button", name="波形分析").click()
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT / "analyzer-1024.png"), full_page=True)

            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT / "analyzer-390.png"), full_page=True)
            if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
                overflow = page.evaluate("""[...document.querySelectorAll('*')]
                    .filter(e => e.getBoundingClientRect().right > innerWidth + 1)
                    .map(e => ({tag: e.tagName, cls: e.className, right: e.getBoundingClientRect().right}))""")
                raise RuntimeError(f"Mobile layout has horizontal page overflow: {overflow}")
            page.get_by_role("button", name="信号输出", exact=True).click()
            page.screenshot(path=str(OUT / "outputs-390.png"), full_page=True)
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
