#!/usr/bin/env python3
import os
import re
import threading
from functools import partial
from pathlib import Path
from urllib.request import urlopen

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import Locator, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "ui"
PREFERRED_URL = os.environ.get("AG32_UI_URL", "http://127.0.0.1:4178/")


def canvas_stats(canvas: Locator) -> dict[str, int]:
    return canvas.evaluate(
        """canvas => {
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonBackground = 0;
            for (let i = 0; i < data.length; i += 16) {
                if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) nonBackground += 1;
            }
            return {width: canvas.width, height: canvas.height, nonBackground};
        }"""
    )


def assert_rendered(canvas: Locator, label: str) -> None:
    stats = canvas_stats(canvas)
    if stats["width"] < 300 or stats["nonBackground"] < 100:
        raise RuntimeError(f"{label} did not render waveform content: {stats}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    server, url = resolve_url()
    errors: list[str] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: errors.append(f"console: {message.text}")
                if message.type == "error"
                else None,
            )
            page.goto(url, wait_until="networkidle")
            page.get_by_role("heading", name="逻辑分析仪", exact=True).wait_for()

            device_index = page.get_by_role("combobox", name="设备编号")
            device_index.select_option("2")
            page.wait_for_timeout(120)
            if page.evaluate(
                "JSON.parse(localStorage.getItem('ag32.deviceIndexByPort') || '{}').COM33"
            ) != 2:
                raise RuntimeError("Device LED identity was not persisted for COM33")
            device_index.select_option("1")
            page.wait_for_timeout(120)

            assert_rendered(page.locator(".waveform-canvas").first, "Initial waveform")
            if page.evaluate("getComputedStyle(document.documentElement).backgroundColor") != "rgb(245, 246, 250)":
                raise RuntimeError("The light workspace background was not applied")

            page.get_by_role("button", name="边沿", exact=True).click()
            page.get_by_text("任一所选边沿成立即触发").wait_for()
            page.get_by_role("button", name="立即", exact=True).click()
            page.get_by_role("button", name="重复采集", exact=True).click()
            page.get_by_text("实时采集 · 20 FPS").wait_for()
            page.get_by_role("button", name="停止", exact=True).click()
            page.wait_for_timeout(120)

            page.get_by_role("button", name="连接并点亮 LED2", exact=True).click()
            page.get_by_text("2 / 4 在线", exact=True).wait_for()
            page.get_by_text("2 台并行 · 可独立采集", exact=True).wait_for()
            cards = page.locator('[data-testid="device-waveform"]')
            if cards.count() != 2:
                raise RuntimeError(f"Expected two simultaneous device waveforms, got {cards.count()}")
            device_1_id = page.locator(
                '[data-testid="device-waveform"][data-device-index="1"]'
            ).get_attribute("data-device-id")
            if not device_1_id:
                raise RuntimeError("Device #1 id was not exposed on the waveform card")

            page.get_by_role("button", name="采集 #2", exact=True).click()
            page.wait_for_timeout(500)
            for card in cards.all():
                assert_rendered(card.locator("canvas"), "Multi-device waveform")
            card_1 = page.locator('[data-testid="device-waveform"][data-device-index="1"]')
            card_2 = page.locator('[data-testid="device-waveform"][data-device-index="2"]')
            frame_2 = card_2.get_attribute("data-frame-id")
            page.get_by_role("button", name="采集 #1", exact=True).click()
            page.wait_for_timeout(500)
            frame_1 = card_1.get_attribute("data-frame-id")
            if not frame_1 or card_2.get_attribute("data-frame-id") != frame_2:
                raise RuntimeError("Capturing device #1 replaced device #2's displayed frame")
            page.get_by_role("button", name="采集 #2", exact=True).click()
            page.wait_for_timeout(500)
            if card_1.get_attribute("data-frame-id") != frame_1:
                raise RuntimeError("Capturing device #2 replaced device #1's displayed frame")
            if card_2.get_attribute("data-frame-id") == frame_2:
                raise RuntimeError("Device #2 frame did not advance after its own capture")
            page.get_by_role("button", name="开始重复采集 #2", exact=True).click()
            page.get_by_role("button", name="停止重复采集 #2", exact=True).wait_for()
            page.get_by_text("2 台并行 · 1 台采集中", exact=True).wait_for()
            page.get_by_role("button", name="停止重复采集 #2", exact=True).click()
            page.screenshot(path=str(OUT / "analyzer-multi-1440.png"), full_page=True)

            page.get_by_role("button", name="单设备", exact=True).click()
            page.get_by_role("button", name="采集一帧", exact=True).click()
            page.wait_for_timeout(500)
            if page.locator('[data-testid="device-waveform"]').count() != 0:
                raise RuntimeError("Single-device mode still rendered the multi-device grid")
            assert_rendered(page.locator(".waveform-canvas").first, "Single-device waveform")

            page.get_by_role("button", name="多设备", exact=True).click()
            page.get_by_role("button", name="联合采集", exact=True).click()
            page.get_by_text("2 台设备联合视图", exact=True).wait_for()
            page.get_by_text(re.compile("主机请求偏差")).first.wait_for()
            assert_rendered(page.locator(".group-waveform-wrap canvas"), "Joint waveform")
            page.screenshot(path=str(OUT / "group-1440.png"), full_page=True)
            page.get_by_role("button", name="多设备", exact=True).click()

            page.get_by_role("button", name="信号输出", exact=True).click()
            page.get_by_role("heading", name="数字输出 PIN_5").wait_for()
            page.get_by_role("button", name="输出设备 #1", exact=True).click()
            pin5_frequency = page.get_by_label("PIN_5 频率数值")
            pin5_frequency.fill("123")
            page.get_by_role("button", name="应用数字方波", exact=True).click()
            page.get_by_text("当前设备草稿与已应用参数一致", exact=True).wait_for()

            page.get_by_role("button", name="触发引擎", exact=True).click()
            page.get_by_label("PIN_5 延时").fill("2")
            page.get_by_label("PIN_5 脉宽").fill("3")
            page.get_by_text("未提交：PIN_5", exact=True).wait_for()
            page.get_by_role("button", name="数字方波", exact=True).click()
            page.get_by_role("button", name="应用数字方波", exact=True).click()
            page.wait_for_timeout(250)
            page.get_by_text("未提交：PIN_5", exact=True).wait_for()
            if page.get_by_text("当前设备草稿与已应用参数一致", exact=True).is_visible():
                raise RuntimeError("Applying PIN_5 square incorrectly committed dirty engine fields")
            page.get_by_role("button", name="触发引擎", exact=True).click()
            if not page.get_by_role("button", name="布防", exact=True).is_disabled():
                raise RuntimeError("Engine control was enabled while its configuration was uncommitted")

            page.get_by_role("button", name="输出设备 #2", exact=True).click()
            if pin5_frequency.input_value() != "100":
                raise RuntimeError("Device #2 inherited device #1 uncommitted PIN_5 frequency")
            page.get_by_text("当前设备草稿与已应用参数一致", exact=True).wait_for()
            pin5_frequency.fill("456")
            page.get_by_role("button", name="输出设备 #1", exact=True).click()
            page.get_by_role("button", name="数字方波", exact=True).click()
            pin5_frequency = page.get_by_label("PIN_5 频率数值")
            if pin5_frequency.input_value() != "123":
                raise RuntimeError("Device #1 draft was not preserved while viewing device #2")
            page.get_by_text("未提交：PIN_5", exact=True).wait_for()

            page.get_by_role("button", name="触发引擎", exact=True).click()
            page.locator(".digital-source").get_by_role("button", name="应用", exact=True).click()
            page.get_by_text("当前设备草稿与已应用参数一致", exact=True).wait_for()

            page.get_by_role("button", name="三角", exact=True).click()
            page.get_by_role("button", name="应用模拟波形", exact=True).click()
            page.get_by_text("当前设备草稿与已应用参数一致", exact=True).wait_for()
            pin11_frequency = page.get_by_label("PIN_11 频率数值")
            pin11_frequency.fill("222")
            page.get_by_text("未提交：PIN_11", exact=True).wait_for()
            page.get_by_role("button", name="输出设备 #2", exact=True).click()
            if pin11_frequency.input_value() != "100":
                raise RuntimeError("Device #2 inherited device #1 uncommitted PIN_11 frequency")
            page.get_by_role("button", name="输出设备 #1", exact=True).click()
            if pin11_frequency.input_value() != "222":
                raise RuntimeError("Device #1 PIN_11 draft was not preserved across device switches")

            page.evaluate(
                """async deviceId => {
                    await window.__ag32MockInvoke('configure_pin11', {
                        deviceId,
                        waveform: 'square',
                        frequencyHz: 777000,
                        amplitudePercent: 55,
                        enabled: false,
                    });
                }""",
                device_1_id,
            )
            page.get_by_text("硬件状态已由 MCP 或其他客户端更新", exact=True).first.wait_for()
            if pin11_frequency.input_value() != "222":
                raise RuntimeError("External MCP state update overwrote the PIN_11 draft")
            page.locator(".digital-source").get_by_role("button", name="应用", exact=True).click()
            page.wait_for_timeout(250)
            if not page.get_by_text("硬件状态已由 MCP 或其他客户端更新", exact=True).first.is_visible():
                raise RuntimeError("Applying PIN_5 incorrectly cleared the PIN_11 external-update warning")
            page.get_by_role("button", name="应用模拟波形", exact=True).click()
            page.wait_for_timeout(350)
            page.get_by_text("当前设备草稿与已应用参数一致", exact=True).wait_for()
            page.get_by_role("button", name="输出设备 #2", exact=True).click()
            if pin5_frequency.input_value() != "456":
                raise RuntimeError("Applying device #1 output changed device #2 draft")
            page.get_by_text("未提交：PIN_5", exact=True).wait_for()
            page.screenshot(path=str(OUT / "outputs-1440.png"), full_page=True)

            page.get_by_role("button", name="波形分析", exact=True).click()
            page.get_by_text("2 台并行 · 可独立采集", exact=True).wait_for()
            multi_cards = page.locator('[data-testid="device-waveform"]')
            desktop_boxes = [multi_cards.nth(index).bounding_box() for index in range(2)]
            if not all(desktop_boxes) or abs(desktop_boxes[0]["y"] - desktop_boxes[1]["y"]) > 2:
                raise RuntimeError(f"Desktop multi-device waveforms are not side by side: {desktop_boxes}")
            page.set_viewport_size({"width": 1024, "height": 768})
            page.wait_for_timeout(250)
            for index in range(2):
                box = multi_cards.nth(index).locator("canvas").bounding_box()
                if not box or box["width"] < 500 or box["height"] < 280:
                    raise RuntimeError(f"1024px multi-device canvas is not readable: {box}")
            page.screenshot(path=str(OUT / "analyzer-multi-1024.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(250)
            for index in range(2):
                box = multi_cards.nth(index).locator("canvas").bounding_box()
                if not box or box["width"] < 300 or box["height"] < 280:
                    raise RuntimeError(f"Mobile multi-device canvas is not readable: {box}")
            if page.evaluate("document.documentElement.scrollWidth > innerWidth"):
                raise RuntimeError("Mobile multi-device layout has horizontal page overflow")
            page.screenshot(path=str(OUT / "analyzer-multi-390.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 900})
            page.wait_for_timeout(250)
            page.get_by_role("button", name="采集 #1", exact=True).click()
            page.wait_for_timeout(500)
            page.get_by_title("断开设备 #1", exact=True).click()
            page.get_by_text("1 / 4 在线", exact=True).wait_for()
            active_slot = page.locator(".device-slot.active")
            if active_slot.get_attribute("data-device-index") != "2":
                raise RuntimeError("Disconnecting device #1 did not leave device #2 active")

            page.get_by_role("button", name="历史记录", exact=True).click()
            page.get_by_role("heading", name="历史记录").wait_for()
            offline_row = page.locator(
                f'.history-table tbody tr[data-device-id="{device_1_id}"]'
            ).first
            offline_row.wait_for()
            offline_row.get_by_title("打开波形", exact=True).click()
            page.get_by_role("heading", name="逻辑分析仪", exact=True).wait_for()
            page.get_by_text("历史波形 · #1", exact=True).wait_for()
            assert_rendered(page.locator(".waveform-canvas").first, "Offline history waveform")
            active_slot = page.locator(".device-slot.active")
            if active_slot.get_attribute("data-device-index") != "2":
                raise RuntimeError("Loading offline history changed the daemon active device")
            page.screenshot(path=str(OUT / "history-offline-1440.png"), full_page=True)

            page.get_by_role("button", name="历史记录", exact=True).click()
            page.get_by_role("heading", name="历史记录").wait_for()
            page.locator(".history-table tbody tr").first.wait_for()
            page.get_by_role("textbox", name="搜索历史记录").fill("desktop")
            if page.locator(".history-table tbody tr").count() < 1:
                raise RuntimeError("History search did not find desktop captures")
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
                overflow = page.evaluate(
                    """[...document.querySelectorAll('*')]
                    .filter(e => e.getBoundingClientRect().right > innerWidth + 1)
                    .map(e => ({
                        tag: e.tagName,
                        cls: e.className,
                        right: e.getBoundingClientRect().right,
                    }))"""
                )
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
