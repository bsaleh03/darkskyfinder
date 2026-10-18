import numpy as np

from darksky_pipeline.tiles import RED_STOPS, basemap_extract_commands, sqm_to_rgba


def test_basemap_commands(tmp_path):
    cmds = basemap_extract_commands("2026-09-17", (-84.6, 41.65, -82.4, 44.1), tmp_path, "se_mi")
    assert len(cmds) == 4
    first = cmds[0]
    assert first[:2] == ["pmtiles", "extract"]
    assert first[2].endswith("/2026-09-17/base.pmtiles")
    assert first[3] == str(tmp_path / "basemap_se_mi_base.pmtiles")
    assert "--bbox=-84.6,41.65,-82.4,44.1" in first and "--maxzoom=14" in first


def test_sqm_to_rgba_endpoints_and_monotonic_alpha():
    rgba = sqm_to_rgba(np.array([22.0, 21.0, 19.0, 17.0, 15.0, np.nan]))
    assert rgba.dtype == np.uint8 and rgba.shape == (6, 4)
    assert rgba[0, 3] == 0 and rgba[5, 3] == 0  # natural sky / no data: fully transparent
    assert tuple(rgba[3]) == (255, 244, 214, 220) == tuple(rgba[4])
    assert rgba[0, 3] < rgba[1, 3] < rgba[2, 3] < rgba[3, 3]


def test_sqm_to_rgba_never_darkens_the_map():
    # Faint glow must tint, not darken: every pixel's colour is at least the faintest glow colour, even where
    # alpha is ~0 (transparent pixels get averaged into neighbours when tiles are downsampled).
    rgba = sqm_to_rgba(np.linspace(15.0, 22.5, 400))
    faint = sqm_to_rgba(np.array([21.9]))[0]
    assert faint[3] > 0 and faint[:3].max() >= 100
    assert (rgba[:, :3].astype(int).max(axis=1) >= 100).all()


def test_red_ramp_is_red_only_and_matches_normal_alpha():
    sqm = np.linspace(15.0, 22.5, 400)
    red = sqm_to_rgba(sqm, RED_STOPS).astype(int)
    normal = sqm_to_rgba(sqm)
    visible = red[:, 3] > 0
    # Night-vision safe: red dominates green and blue by a wide margin wherever anything is drawn.
    assert (red[visible, 0] >= 3 * red[visible, 1]).all() and (red[visible, 0] >= 3 * red[visible, 2]).all()
    assert (red[:, 0] >= 100).all()  # never darkens the map (see test_sqm_to_rgba_never_darkens_the_map)
    assert (red[:, 3] == normal[:, 3]).all()  # same visibility, only the hue changes

