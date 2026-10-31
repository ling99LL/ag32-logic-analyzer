#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"


def main() -> None:
    BUILD.mkdir(exist_ok=True)
    size = 1024
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (48, 48, size - 48, size - 48),
        radius=210,
        fill="#151a17",
        outline="#55d6be",
        width=28,
    )
    waves = [
        ((180, 340), (844, 340), "#55d6be"),
        ((180, 512), (844, 512), "#f3ba63"),
        ((180, 684), (844, 684), "#9ccf62"),
    ]
    for (start, end, color) in waves:
        points = []
        y = (start[1] + end[1]) / 2
        amplitude = 58 if color == "#55d6be" else 42
        for index in range(17):
            x = start[0] + (end[0] - start[0]) * index / 16
            direction = -1 if index % 4 in (0, 1) else 1
            points.append((x, y + direction * amplitude))
        draw.line(points, fill=color, width=44, joint="curve")
    image.save(BUILD / "icon.png")
    image.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
