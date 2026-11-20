"""Render the two crate concepts without external assets."""

from itertools import product
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = (1024, 768)
SS = 2
SCALE = 219 * SS
ORIGIN = np.array((510, 587)) * SS
EYE = np.array((0.52, 0.39, 0.78))
EYE /= np.linalg.norm(EYE)
RIGHT = np.cross((0, 1, 0), EYE)
RIGHT /= np.linalg.norm(RIGHT)
SCREEN = np.array((RIGHT, -np.cross(EYE, RIGHT)))
KEY = np.array((-0.52, 0.72, 0.46))
AXES = np.eye(3)
PLATE_Z = 1.010
WIDTH, HEIGHT = 2.06, 1.80


def project(points):
    return points @ SCREEN.T * SCALE + ORIGIN


def stage():
    """D2 charcoal sweep with cast shadow and tighter contact shadow."""
    w, h = (n * SS for n in SIZE)
    y, x = np.ogrid[:h, :w]
    halo = np.exp(-(((x / SS - 477) / 365) ** 2) - ((y / SS - 395) / 293) ** 2)
    floor = np.exp(-(((x / SS - 559) / 387) ** 2) - ((y / SS - 613) / 128) ** 2)
    rgb = np.array((9, 10, 12)) + halo[..., None] * (26, 28, 31)
    rgb += floor[..., None] * (21, 22, 24)

    footprint = np.array(
        [(-1.04, 0, 0.91), (1.04, 0, 0.91), (1.04, 0, -0.92), (-1.04, 0, -0.92)]
    )
    for offset, radius, strength in (
        ((0.49, 0, -0.39), 28, 0.60),
        ((0.07, 0, -0.02), 7, 0.74),
    ):
        mask = Image.new("L", (w, h))
        outline = project(footprint + offset)
        ImageDraw.Draw(mask).polygon([tuple(p) for p in outline], fill=255)
        opacity = np.asarray(mask.filter(ImageFilter.GaussianBlur(radius * SS)))
        rgb *= 1 - strength / 255 * opacity[..., None]
    return np.uint8(rgb)


def wood(p, normal, base, salt):
    """Grain along local X: growth bands, warped knots and fine torn fibers."""
    u, v, w = p.T
    q = v + 0.67 * w
    bend = 0.010 * np.sin(4.6 * u + salt) + 0.003 * np.sin(12 * u - 18 * q + salt)
    ku = u + 0.40 * np.sin(salt * 2.7)
    kq = q + 0.10 * np.sin(salt * 1.9)
    knot = (ku / 0.20) ** 2 + (kq / 0.09) ** 2
    bend += 0.041 * np.tanh(kq * 34) * np.exp(-0.6 * knot)
    grain = (116 + 21 * np.sin(salt)) * (q + bend) + 1.8 * np.sin(28 * q + salt)
    if abs(normal[0]) == 1:
        grain = 122 * np.hypot(v + 0.09, w - 0.23) + 0.57 * np.sin(47 * v)
    band = np.sin(grain)
    fiber = np.sin(415 * (q + bend) + 2.7 * np.sin(23 * u + 81 * q))
    mill = np.sin(51 * q + 1.9 * np.sin(6 * u + salt)) * np.sin(10 * u + salt)
    grooves = np.maximum(0, -band) ** 9 * (0.4 + 0.6 * np.sin(9 * u + salt) ** 2)
    patina = 0.047 * np.sin(6 * u + 19 * q + salt)
    wear = 0
    if np.count_nonzero(normal) > 1:
        chipped = np.maximum(0, np.sin(39 * u + 21 * q + salt)) ** 6
        wear = 0.035 + 0.16 * chipped
    tone = 1 + 0.048 * band + 0.031 * fiber + 0.032 * mill + patina + wear
    tone -= 0.11 * grooves + 0.27 * np.exp(-3.1 * knot)
    return tone[:, None] * np.array(base)


def steel(p, _normal, base, salt):
    u, v, _ = p.T
    brushed = np.sin(440 * (v + 0.12 * u) + 0.7 * np.sin(65 * u))
    flecks = np.sin(310 * u + 420 * v) * np.sin(510 * u - 350 * v)
    return (1 + 0.035 * brushed + 0.045 * flecks + 0.04 * np.sin(47 * u + salt))[
        :, None
    ] * base


class Render:
    def __init__(self):
        self.rgb = stage()
        self.depth = np.full(self.rgb.shape[:2], -np.inf, dtype=np.float32)

    def face(self, local, normal, center, axes, color, material, salt, *, opening=None):
        world_normal = normal @ axes
        if world_normal @ EYE <= 1e-6:
            return
        local = np.array(local)
        world = local @ axes + center
        xy = project(world)
        x0, y0 = np.maximum(0, np.floor(xy.min(axis=0)).astype(int))
        x1, y1 = np.minimum(np.array(SIZE) * SS, np.ceil(xy.max(axis=0)).astype(int))
        yy, xx = np.ogrid[y0:y1, x0:x1]
        # Crossing test also handles the concave L-shaped plate.
        inside = np.zeros((y1 - y0, x1 - x0), dtype=bool)
        for (a, b), (c, d) in zip(xy, np.roll(xy, -1, axis=0)):
            if b != d:
                inside ^= ((b > yy) != (d > yy)) & (
                    xx < a + (yy - b) * ((c - a) / (d - b))
                )
        iy, ix = np.nonzero(inside)
        if not len(ix):
            return
        ix, iy = ix + x0, iy + y0
        screen = np.column_stack((ix, iy)) - xy[0]
        plane = screen @ SCREEN / SCALE
        depth_delta = -(plane @ world_normal) / (EYE @ world_normal)
        z = depth_delta + world[0] @ EYE
        show = z > self.depth[iy, ix]
        iy, ix, z = iy[show], ix[show], z[show]
        if not len(ix):
            return
        p = (plane[show] + depth_delta[show, None] * EYE) @ axes.T + local[0]
        if opening is not None:
            clipped = np.all(np.abs((p @ axes)[:, :2]) <= opening, axis=1)
            iy, ix, z, p = iy[clipped], ix[clipped], z[clipped], p[clipped]
        self.depth[iy, ix] = z
        diffuse = max(0, world_normal @ KEY)
        light = np.array((0.46, 0.50, 0.61)) + diffuse * np.array((0.70, 0.63, 0.52))
        surface = material(p, normal, np.array(color), salt)
        self.rgb[iy, ix] = np.clip(surface * light, 0, 255).astype(np.uint8)

    def box(self, center, size, color, salt, *, bevel=0.02, axes=AXES, opening=None):
        h = np.array(size) / 2
        inner = h - bevel
        center = np.array(center)

        def face(points, n):
            self.face(
                points,
                n / np.linalg.norm(n),
                center,
                axes,
                color,
                wood,
                salt,
                opening=opening,
            )

        for a, b, c in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
            for sign in (-1, 1):
                points = [
                    sign * h[a] * AXES[a]
                    + sb * inner[b] * AXES[b]
                    + sc * inner[c] * AXES[c]
                    for sb, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1))
                ]
                face(points, sign * AXES[a])
            for sb, sc in product((-1, 1), repeat=2):
                f = sb * h[b] * AXES[b] + sc * inner[c] * AXES[c]
                g = sb * inner[b] * AXES[b] + sc * h[c] * AXES[c]
                along = inner[a] * AXES[a]
                face(
                    (f - along, g - along, g + along, f + along),
                    sb * AXES[b] + sc * AXES[c],
                )
        for signs in product((-1, 1), repeat=3):
            n = np.array(signs)
            face([n * inner + n[a] * bevel * AXES[a] for a in range(3)], n)

    def brace_shadow(self, center, across, opening):
        # Reconstruct the visible plank surface so the shadow stays off the frame.
        iy, ix = np.nonzero(np.isfinite(self.depth))
        screen = np.column_stack((ix, iy)) - ORIGIN
        p = screen @ SCREEN / SCALE + self.depth[iy, ix, None] * EYE
        in_opening = np.all(np.abs(p[:, :2] - center[:2]) <= opening, axis=1)
        on_planks = in_opening & (p[:, 2] >= 0.880) & (p[:, 2] <= 0.921)
        iy, ix = iy[on_planks], ix[on_planks]
        shadow_center = center[:2] - KEY[:2] * 0.060
        distance = np.abs((p[on_planks, :2] - shadow_center) @ across[:2])
        shade = 0.29 * np.clip((0.145 - distance) / 0.038, 0, 1)
        self.rgb[iy, ix] = self.rgb[iy, ix] * (1 - shade[:, None])

    def metal(self, points, z, color, salt=0):
        self.face(
            [(x, y, z) for x, y in points],
            AXES[2],
            np.zeros(3),
            AXES,
            color,
            steel,
            salt,
        )

    def bolt(self, x, y, z, radius, body, top):
        angles = np.arange(6) * np.pi / 3
        for r, dz, color in (
            (1.25, 0, (36, 34, 34)),
            (1, 0.004, body),
            (0.73, 0.008, top),
        ):
            points = np.column_stack(
                (x + r * radius * np.cos(angles), y + r * radius * np.sin(angles))
            )
            self.metal(points, z + dz, color, x + y)

    def image(self):
        return Image.fromarray(self.rgb).resize(SIZE, Image.Resampling.LANCZOS)


def build_crate(r):
    side = np.array(((0, 0, 1), (0, 1, 0), (-1, 0, 0)))
    upright = np.array(((0, 1, 0), (-1, 0, 0), (0, 0, 1)))
    r.box((0, 0.90, 0), (1.98, 1.75, 1.79), (65, 42, 30), 1)
    boards = ((143, 90, 54), (169, 111, 67), (157, 99, 58), (180, 122, 75))
    for i, color in enumerate(boards):
        y = 0.27 + 0.415 * i
        r.box((0, y, 0.89), (2.01, 0.399, 0.061), color, i + 3, bevel=0.014)
        r.box(
            (0.995, y, -0.02),
            (1.80, 0.399, 0.065),
            color,
            i + 12,
            bevel=0.014,
            axes=side,
        )
        r.box(
            (0, 1.754, (i - 1.5) * 0.455),
            (2.02, 0.09, 0.442),
            color,
            i + 25,
            bevel=0.016,
        )

    for i, y in enumerate((0.128, HEIGHT - 0.128)):
        r.box((0, y, 0.943), (WIDTH, 0.256, 0.122), (179, 121, 73), i + 8, bevel=0.027)
        r.box(
            (1.02, y, -0.02),
            (1.84, 0.256, 0.096),
            (146, 93, 56),
            i + 19,
            bevel=0.023,
            axes=side,
        )
    for i, x in enumerate((-0.885, 0.885)):
        r.box(
            (x, 0.90, 0.94),
            (1.286, 0.258, 0.114),
            (178, 117, 69),
            i + 10,
            bevel=0.022,
            axes=upright,
        )
        r.box(
            (x, 1.798, -0.014),
            (1.82, 0.068, 0.205),
            (176, 116, 68),
            i + 17,
            bevel=0.025,
            axes=side,
        )
    for i, z in enumerate((-0.805, 0.784)):
        r.box(
            (1.024, 0.90, z),
            (1.286, 0.218, 0.097),
            (155, 100, 61),
            i + 21,
            bevel=0.020,
            axes=upright,
        )

    opening = np.array((0.885 - 0.258 / 2, HEIGHT / 2 - 0.256))
    half_span = np.linalg.norm(opening)
    along = np.array((*opening, 0)) / half_span
    across = np.array((-along[1], along[0], 0))
    diagonal = np.array((along, across, (0, 0, 1)))
    center = np.array((0, HEIGHT / 2, 0.935))
    r.brace_shadow(center, across, opening)
    r.box(
        center,
        (2 * half_span + 0.26, 0.235, 0.12),
        (192, 131, 78),
        14,
        bevel=0.025,
        axes=diagonal,
        opening=opening + 0.022,  # The ends tuck under the inner frame bevel.
    )
    for x in (-0.61, 0.61):
        for dy in (-0.047, 0.047):
            y = center[1] + along[1] / along[0] * x + dy
            r.bolt(x, y, center[2] + 0.06, 0.015, (57, 52, 47), (114, 107, 95))
    for x in (-0.78, 0.78):
        for y in (0.50, 0.91, 1.32):
            r.bolt(x, y, 0.997, 0.010, (69, 56, 43), (130, 111, 88))


def brackets(r):
    outer = (
        (0.017, 0.048),
        (0.048, 0.017),
        (0.438, 0.017),
        (0.466, 0.045),
        (0.466, 0.146),
        (0.438, 0.177),
        (0.205, 0.177),
        (0.177, 0.205),
        (0.177, 0.438),
        (0.146, 0.466),
        (0.045, 0.466),
        (0.017, 0.438),
    )
    inset = (
        (0.035, 0.057),
        (0.057, 0.035),
        (0.428, 0.035),
        (0.448, 0.055),
        (0.448, 0.137),
        (0.429, 0.157),
        (0.197, 0.157),
        (0.157, 0.197),
        (0.157, 0.429),
        (0.137, 0.448),
        (0.055, 0.448),
        (0.035, 0.428),
    )
    for sx, sy in product((-1, 1), repeat=2):
        x0 = -sx * WIDTH / 2
        y0 = 0 if sy == 1 else HEIGHT
        edge = [(x0 + sx * x, y0 + sy * y) for x, y in outer]
        flat = [(x0 + sx * x, y0 + sy * y) for x, y in inset]
        r.metal(edge, PLATE_Z, (34, 38, 46))
        for i in range(len(edge)):
            j = (i + 1) % len(edge)
            dx, dy = np.subtract(edge[j], edge[i]) * sx * sy
            glint = (-dy * KEY[0] + dx * KEY[1]) / np.hypot(dx, dy)
            tint = 34 * (1 + glint)
            r.metal(
                (edge[i], edge[j], flat[j], flat[i]),
                PLATE_Z + 0.009,
                (90 + tint, 99 + tint, 112 + tint),
                i,
            )
        r.metal(flat, PLATE_Z + 0.019, (93, 111, 129), sx + sy)
        for x, y in ((0.095, 0.095), (0.374, 0.096), (0.096, 0.374)):
            r.bolt(
                x0 + sx * x,
                y0 + sy * y,
                PLATE_Z + 0.022,
                0.026,
                (108, 121, 133),
                (163, 174, 175),
            )


def main():
    r = Render()
    build_crate(r)

    def save(filename):
        out = Path(__file__).with_name(filename)
        r.image().save(out, optimize=True)
        print(out)

    save("crate-concept.png")
    brackets(r)
    save("crate-concept-v2.png")


if __name__ == "__main__":
    main()
